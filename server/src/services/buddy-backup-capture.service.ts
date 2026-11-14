import { LOCKED_MAGIC } from '@frameleaf/locked-crypto';
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { appendFile, open, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { FrameleafCloudBackup, IDeleteFilesJob } from 'src/types.js';
import type { BuddyMetadata } from 'src/utils/buddy-backup-metadata.js';
import type { BuddyStudioSnapshot } from 'src/utils/buddy-backup-studio.js';
import { serverVersion } from 'src/constants.js';
import { StorageCore } from 'src/cores/storage.core.js';
import {
  AssetFileType,
  AssetStatus,
  ChecksumAlgorithm,
  JobName,
  SystemMetadataKey,
  UserMetadataKey,
} from 'src/enum.js';
import { BuddyBackupFidelityRepository } from 'src/repositories/buddy-backup-fidelity.repository.js';
import { BuddyBackupMetadataRepository } from 'src/repositories/buddy-backup-metadata.repository.js';
import { BuddyBackupStudioRepository } from 'src/repositories/buddy-backup-studio.repository.js';
import { BuddyBackupRepository, type BuddySettings } from 'src/repositories/buddy-backup.repository.js';
import { type CloudBackupAsset, CloudBackupIndexRepository } from 'src/repositories/cloud-backup-index.repository.js';
import { CloudBackupKeyRepository } from 'src/repositories/cloud-backup-key.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { BUDDY_CAPTURE_LOCK, lockFilePath } from 'src/repositories/physical-file.repository.js';
import { DatabaseBackupService } from 'src/services/database-backup.service.js';
import {
  BUDDY_BLOCK_BYTES,
  type BuddyKeyring,
  buddyObjectId,
  decryptBuddyBlock,
  sealBuddyBlock,
} from 'src/utils/buddy-backup-crypto.js';
import { type BuddyAssetFidelity, readBuddyAssetFidelity } from 'src/utils/buddy-backup-fidelity.js';
import { type BuddySettingsSnapshot, readBuddySettingsSnapshot } from 'src/utils/buddy-backup-settings.js';
import { type BuddyReceipt, BuddyVault, createBuddyDirectory, writeBuddyFile } from 'src/utils/buddy-backup-vault.js';
import { type BuddyBootConfiguration, captureBuddyBootConfiguration } from 'src/utils/buddy-boot-configuration.js';
import {
  CLOUD_BACKUP_MANIFEST_FORMAT,
  type CloudBackupAssetDetails,
  type CloudBackupAssetRecord,
  type CloudBackupManifest,
  type CloudBackupManifestFile,
  backupRecordFor,
  keyFingerprint,
  parseBackupKey,
} from 'src/utils/cloud-backup.js';
import { getDiskUsage } from 'src/utils/disk-usage.js';
import { readAliasedEnv } from 'src/utils/env-aliases.js';
import { withDatabaseCleanup } from 'src/utils/execution-database.js';
import { advanceExecutionProgress, assertExecutionActive, executionSignal } from 'src/utils/execution-signal.js';
import {
  LOCKED_KEY_BACKUP_ROLE,
  lockedKeyBackupFiles,
  lockedKeyFileKeyId,
  lockedKeyGaps,
  lockedKeyOwners,
  pathsBeingReplaced,
  sealedOwnerKeyIdOrUnreadable,
} from 'src/utils/locked-backup.js';
import { TERMINAL_MEDIA_OPERATION_STATUSES } from 'src/utils/media-operation.js';
import { getEditedMasterLineagePath } from 'src/utils/media-policy.js';

const LOCKED_MAGIC_BYTES = Buffer.from(LOCKED_MAGIC, 'ascii');

export type BuddyContent = { blocks: string[]; keyVersion: number; bytes: number };
export type BuddyManifest = {
  version: 1;
  vaultId: string;
  snapshotId: string;
  sequence: number;
  previous: string | null;
  frameleafVersion: string;
  library: CloudBackupManifest;
  metadata?: BuddyMetadata;
  contents: Record<string, BuddyContent>;
  assetLinks: Record<string, { livePhotoVideoId: string | null; libraryId: string | null; isExternal: boolean }>;
  assetFiles: Record<
    string,
    Array<{ path: string; type: AssetFileType; isEdited: boolean; isProgressive: boolean; isTransparent: boolean }>
  >;
  /** Absent on older snapshots. Per-asset retained work; never a replay of background jobs. */
  assetFidelity?: Record<string, BuddyAssetFidelity>;
  /** Durable project archive components, encrypted with the snapshot; no upload/job/lease records. */
  studio?: BuddyStudioSnapshot;
  dependencies: CloudBackupManifestFile[];
  configurationFiles: CloudBackupManifestFile[];
  cloudBackupKeys?: Array<{ fingerprint: string; content: string }>;
  environment: Record<string, string | undefined>;
  bootConfiguration?: BuddyBootConfiguration;
  storageRoot: string;
  storageRoots: string[];
  settings: {
    system: unknown;
    users: Array<{ userId: string; key: string; value: unknown }>;
    buddy?: BuddySettingsSnapshot;
  };
};
export type BuddyCapture = {
  manifest: BuddyManifest;
  manifestBlocks: string[];
  objects: BuddyReceipt[];
  /** Complete canonical derived-path inventory, absent on older interrupted captures. */
  derivedInventoryVersion?: 1;
};

type PinnedOriginal = NonNullable<IDeleteFilesJob['original']>;
type DerivedBackupPath = { path: string; role: string; assetId: string | null };
/** One asset's records from the exported snapshot, read before any of its files. */
type AssetPlan = {
  asset: CloudBackupAsset;
  metadata: { record: CloudBackupAssetRecord; details: CloudBackupAssetDetails };
  original: {
    checksum: Buffer;
    checksumAlgorithm: string;
    livePhotoVideoId: string | null;
    libraryId: string | null;
    isExternal: boolean;
  };
  edited: Array<{ path: string; type: AssetFileType }>;
  assetFiles: BuddyManifest['assetFiles'][string];
  fidelity: BuddyAssetFidelity;
};
/** One line of a run's `progress.jsonl`: a file whose blocks are already staged in that run. */
type StagedFile = {
  path: string;
  /** Canonical path, device, inode, size, mtime and ctime when it was read. */
  identity: string;
  /** The recorded checksum it was verified against, if any. */
  checksum: string | null;
  sha256: string;
  size: number;
  mtime: string;
  content: BuddyContent;
  receipts: BuddyReceipt[];
  sealed: boolean;
};
/** Stands in for an original's SHA-256 until its bytes are read; replaced before the manifest is sealed. */
const UNBOUND_SHA256 = '0'.repeat(64);

/** Read from the same exported snapshot as the dump, never from directory names or temporary-file globs. */
const derivedPaths = sql<DerivedBackupPath>`
  SELECT p."thumbnailPath" AS path, 'person-thumbnail'::text AS role, NULL::uuid AS "assetId"
  FROM public.person p WHERE p."thumbnailPath" <> ''
  UNION ALL SELECT f.path, 'video-moment-frame'::text, f."assetId"
  FROM public.video_moment_frame f JOIN public.asset a ON a.id = f."assetId"
  WHERE a.status IN (${AssetStatus.Active}, ${AssetStatus.Trashed})`;

const inside = (directory: string, path: string) => {
  const child = relative(resolve(directory), resolve(path));
  return !child || (!child.startsWith(`..${sep}`) && child !== '..' && !child.startsWith(sep));
};

const dependencyPaths = sql<{ path: string }>`SELECT path FROM public.studio_project_import
  UNION SELECT path FROM public.studio_generated_resource
  UNION SELECT path FROM public.asset_develop_artifact
  UNION SELECT "masterPath" AS path FROM public.asset_develop_revision WHERE "masterPath" IS NOT NULL
  UNION SELECT "previewPath" AS path FROM public.asset_develop_revision WHERE "previewPath" IS NOT NULL
  UNION SELECT "hdrMasterPath" AS path FROM public.asset_develop_revision WHERE "hdrMasterPath" IS NOT NULL
  UNION SELECT "hdrPreviewPath" AS path FROM public.asset_develop_revision WHERE "hdrPreviewPath" IS NOT NULL
  UNION SELECT "masterPath" AS path FROM public.video_edit_version WHERE "masterPath" IS NOT NULL
  UNION SELECT "proxyPath" AS path FROM public.video_edit_version WHERE "proxyPath" IS NOT NULL
  UNION SELECT f->>'path' AS path FROM public.video_edit_version, jsonb_array_elements(files) f
  UNION SELECT "outputPath" AS path FROM public.studio_export_version WHERE "outputPath" IS NOT NULL AND "outputRemovedAt" IS NULL
  UNION SELECT "resultPath" AS path FROM public.asset_restoration WHERE "resultPath" IS NOT NULL
  UNION SELECT "resultPreviewPath" AS path FROM public.asset_restoration WHERE "resultPreviewPath" IS NOT NULL`;

@Injectable()
export class BuddyBackupCaptureService {
  private logger = LoggingRepository.create('BuddyBackupCaptureService');

  constructor(
    private repository: BuddyBackupRepository,
    private backups: DatabaseBackupService,
    private jobs: JobRepository,
    private keys: CloudBackupKeyRepository,
  ) {}

  runDirectory(runId: string) {
    return join(this.repository.root(), 'runs', runId);
  }
  blockPath(id: string, runId: string) {
    return join(this.runDirectory(runId), 'blocks', id);
  }

  /** Encrypted staging is also the retry journal. Its nonce/ciphertext survives every network retry. */
  private async block(ring: BuddyKeyring, bytes: Buffer, runId: string): Promise<BuddyReceipt> {
    const key = Buffer.from(ring.keys[ring.current], 'base64url');
    const id = buddyObjectId(key, ring.vaultId, bytes);
    const path = this.blockPath(id, runId);
    let encrypted: Buffer;
    try {
      encrypted = await readFile(path);
      decryptBuddyBlock(key, { vaultId: ring.vaultId, id, keyVersion: ring.current }, encrypted);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const journalPath = join(this.repository.root(), 'nonces', id);
      let journal: { nonce: string; digest: string; bytes: number };
      try {
        journal = JSON.parse(await readFile(journalPath, 'utf8'));
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code !== 'ENOENT') throw readError;
        const nonce = randomBytes(12);
        const sealed = sealBuddyBlock(key, { vaultId: ring.vaultId, id, keyVersion: ring.current }, bytes, nonce);
        journal = {
          nonce: nonce.toString('base64url'),
          digest: BuddyVault.receipt(id, sealed).digest,
          bytes: sealed.length,
        };
        await writeBuddyFile(journalPath, JSON.stringify(journal), true);
      }
      encrypted = sealBuddyBlock(
        key,
        { vaultId: ring.vaultId, id, keyVersion: ring.current },
        bytes,
        Buffer.from(journal.nonce, 'base64url'),
      );
      if (encrypted.length !== journal.bytes || BuddyVault.receipt(id, encrypted).digest !== journal.digest)
        throw new Error('Buddy encryption journal does not match the immutable source object', { cause: error });
      await createBuddyDirectory(dirname(path));
      const fs = await getDiskUsage(this.repository.root());
      if (fs.available - encrypted.length < Math.max(10 * 1024 ** 3, fs.total * 0.1))
        throw new Error('Local Buddy staging needs more free disk space', { cause: error });
      await writeBuddyFile(path, encrypted, true);
    }
    return BuddyVault.receipt(id, encrypted);
  }

  async readCapture(runId: string): Promise<BuddyCapture | null> {
    try {
      return JSON.parse(await readFile(join(this.runDirectory(runId), 'capture.json'), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return null;
    }
  }

  /** FL-1602: files a run stopped by its window already staged. Reused only while the file is unchanged. */
  private async readProgress(path: string) {
    const staged = new Map<string, StagedFile>();
    const handle = await open(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (!handle) return staged;
    // readLines closes the handle at the end of the file.
    for await (const line of handle.readLines()) {
      try {
        const entry = JSON.parse(line) as StagedFile;
        staged.set(entry.path, entry);
      } catch {
        // A line torn by a crash only means that file is read again.
      }
    }
    return staged;
  }

  async capture(options: {
    runId: string;
    instanceId: string;
    sequence: number;
    previous: string | null;
    ring: BuddyKeyring;
    settings: BuddySettings;
    checkpoint: () => Promise<void>;
  }): Promise<BuddyCapture> {
    const previousCapture = await this.readCapture(options.runId);
    if (previousCapture) {
      if (options.settings.includeDerived && previousCapture.derivedInventoryVersion !== 1)
        throw new Error('This interrupted Buddy capture predates complete derived-file inventory. Start a new backup.');
      return previousCapture;
    }
    const { ring, settings } = options;
    const started = Date.now();
    const objects = new Map<string, BuddyReceipt>();
    const manifest: BuddyManifest = {
      version: 1,
      vaultId: ring.vaultId,
      snapshotId: randomUUID(),
      sequence: options.sequence,
      previous: options.previous,
      frameleafVersion: serverVersion.toString(),
      contents: {},
      assetLinks: {},
      assetFiles: {},
      assetFidelity: {},
      dependencies: [],
      configurationFiles: [],
      environment: {},
      ...(settings.bootConfiguration && {
        bootConfiguration: captureBuddyBootConfiguration(settings.bootConfiguration),
      }),
      storageRoot: StorageCore.getMediaLocation(),
      storageRoots: [],
      settings: { system: null, users: [], buddy: readBuddySettingsSnapshot({ version: 1, settings }) },
      library: {
        format: CLOUD_BACKUP_MANIFEST_FORMAT,
        version: 2,
        instanceId: options.instanceId,
        createdAt: new Date(started).toISOString(),
        database: null,
        assets: {},
        profiles: {},
        lockedKeys: {},
        albums: {},
        people: {},
      },
    };
    const hostRoot = await realpath(settings.directory);
    const sourceRoot = await realpath(dirname(this.repository.root()));
    const pinnedPaths = new Map<string, string>();
    const configurationFile = readAliasedEnv('FRAMELEAF_CONFIG_FILE');
    const configurationPaths = [
      ...new Set(
        [...settings.configurationFiles, ...(configurationFile ? [configurationFile] : [])].map((path) =>
          resolve(path),
        ),
      ),
    ];
    // FL-1602: a run the window stopped keeps its staged blocks. Its new snapshot reuses each file
    // whose identity and recorded checksum are unchanged instead of reading and encrypting it again.
    const progressPath = join(this.runDirectory(options.runId), 'progress.jsonl');
    const staged = await this.readProgress(progressPath);

    /** FL-721: the captured paths that are encrypted Locked files (`FLLK`). */
    const sealedPaths = new Set<string>();
    const record = (entry: StagedFile, role: string): CloudBackupManifestFile => {
      manifest.contents[entry.sha256] = entry.content;
      for (const receipt of entry.receipts) objects.set(receipt.id, receipt);
      if (entry.sealed) sealedPaths.add(entry.path);
      return { role, path: entry.path, sha256: entry.sha256, size: entry.size, mtime: entry.mtime };
    };
    const captureFile = async (
      path: string,
      role: string,
      expected?: { checksum: Buffer; algorithm: string },
      allowNew = false,
    ): Promise<CloudBackupManifestFile> => {
      await options.checkpoint();
      const actual = await realpath(path);
      if (inside(hostRoot, actual) || inside(sourceRoot, actual))
        throw new Error(
          'A backup contains a Buddy vault or server identity files; remove that ingestion or configuration path',
        );
      if (!allowNew && pinnedPaths.get(path) !== actual)
        throw new Error('A required backup path changed after snapshot ownership was captured');
      const file = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await file.stat({ bigint: true });
        if (!before.isFile() || (!allowNew && Number(before.ctimeNs / 1_000_000n) > started))
          throw new Error('A required backup file changed after capture started');
        const identity = `${actual}:${before.dev}:${before.ino}:${before.size}:${before.mtimeNs}:${before.ctimeNs}`;
        const checksum = expected ? `${expected.algorithm}:${expected.checksum.toString('hex')}` : null;
        const previous = staged.get(path);
        if (
          previous?.identity === identity &&
          previous.checksum === checksum &&
          previous.content.keyVersion === ring.current
        )
          return record(previous, role);
        const hash = createHash('sha256');
        let recorded =
          expected && expected.algorithm !== ChecksumAlgorithm.sha1Path ? createHash(expected.algorithm) : null;
        const receipts: BuddyReceipt[] = [];
        let sealed = false;
        let bytes = 0;
        const buffer = Buffer.alloc(BUDDY_BLOCK_BYTES);
        while (true) {
          assertExecutionActive();
          const { bytesRead } = await file.read(buffer, 0, buffer.length, bytes);
          assertExecutionActive();
          advanceExecutionProgress(bytesRead);
          if (!bytesRead) break;
          const piece = buffer.subarray(0, bytesRead);
          // FL-721: an encrypted Locked file is copied as it is. Its recorded checksum is the plaintext's,
          // so it is never compared; the AEAD tags and the SHA-256 below vouch for the ciphertext.
          if (bytes === 0 && piece.subarray(0, LOCKED_MAGIC_BYTES.length).equals(LOCKED_MAGIC_BYTES)) {
            recorded = null;
            sealed = true;
          }
          hash.update(piece);
          recorded?.update(piece);
          receipts.push(await this.block(ring, piece, options.runId));
          bytes += bytesRead;
          await options.checkpoint();
        }
        const after = await file.stat({ bigint: true });
        if (
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs ||
          bytes !== Number(before.size) ||
          (recorded && expected && !recorded.digest().equals(expected.checksum))
        )
          throw new Error('A required backup file changed or failed its recorded checksum');
        const entry: StagedFile = {
          path,
          identity,
          checksum,
          sha256: hash.digest('hex'),
          size: bytes,
          mtime: new Date(Number(before.mtimeNs / 1_000_000n)).toISOString(),
          content: { blocks: receipts.map((receipt) => receipt.id), keyVersion: ring.current, bytes },
          receipts,
          sealed,
        };
        // Not fsynced: a lost line only means that file is read again after a crash.
        await createBuddyDirectory(dirname(progressPath));
        await appendFile(progressPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
        return record(entry, role);
      } finally {
        await file.close();
      }
    };

    // FL-1602: everything the copy needs is read from the exported snapshot first. The global barrier
    // covers only pinning the snapshot's paths; the snapshot itself ends before any media is read.
    const plans: AssetPlan[] = [];
    const albums = new Set<string>();
    const people = new Map<string, { ownerId: string; personId: string }>();
    const lockedKeyIds = new Set<string>();
    const derivedByAsset = new Map<string, DerivedBackupPath[]>();
    const offline = new Set<string>();
    let derived: DerivedBackupPath[] = [];
    let dependencies: Array<{ path: string }> = [];
    let profiles: Array<{ userId: string; path: string }> = [];
    let dump: string | undefined;
    const present = (path: string) => !offline.has(path) || pinnedPaths.has(path);
    try {
      await this.repository.db.connection().execute(async (connection) => {
        let barrier = true;
        try {
          await sql`SELECT pg_advisory_lock(${BUDDY_CAPTURE_LOCK}::bigint)`.execute(connection);
          await this.repository.db
            .transaction()
            .setIsolationLevel('repeatable read')
            .execute(async (trx) => {
              const { rows } = await sql<{ snapshot: string }>`SELECT pg_export_snapshot() AS snapshot`.execute(trx);
              const snapshot = rows[0].snapshot;
              const types = [
                AssetFileType.Sidecar,
                ...(settings.includeDerived
                  ? [
                      AssetFileType.FullSize,
                      AssetFileType.Preview,
                      AssetFileType.Thumbnail,
                      AssetFileType.HdrPreview,
                      AssetFileType.HdrFullSize,
                      AssetFileType.EncodedVideo,
                    ]
                  : []),
              ];
              const required = sql<{ path: string }>`SELECT "originalPath" AS path FROM public.asset
                WHERE status IN (${AssetStatus.Active}, ${AssetStatus.Trashed})
                UNION SELECT f.path FROM public.asset_file f JOIN public.asset a ON a.id=f."assetId"
                WHERE a.status IN (${AssetStatus.Active}, ${AssetStatus.Trashed}) AND (f."isEdited" OR f.type = ANY(${types}::text[]))
                UNION SELECT "profileImagePath" AS path FROM public.user WHERE "profileImagePath" <> '' AND "deletedAt" IS NULL`;
              // The only work under the barrier: one statement pins every path of this exact view, committed on
              // the barrier's own session, so a deletion that resumes after the unlock already sees its reference.
              await sql`BEGIN ISOLATION LEVEL REPEATABLE READ`.execute(connection);
              try {
                await sql`SET TRANSACTION SNAPSHOT ${sql.lit(snapshot)}`.execute(connection);
                await sql`INSERT INTO public.buddy_backup_reference ("runId", path)
                  SELECT ${options.runId}::uuid, path FROM (
                    SELECT path FROM (${required}) r UNION SELECT path FROM (${dependencyPaths}) d
                    ${settings.includeDerived ? sql`UNION SELECT path FROM (${derivedPaths}) v` : sql``}
                  ) paths WHERE path IS NOT NULL AND path <> '' ON CONFLICT DO NOTHING`.execute(connection);
                await sql`COMMIT`.execute(connection);
              } catch (error) {
                await withDatabaseCleanup(() => sql`ROLLBACK`.execute(connection));
                throw error;
              }
              await withDatabaseCleanup(() =>
                sql`SELECT pg_advisory_unlock(${BUDDY_CAPTURE_LOCK}::bigint)`.execute(connection),
              );
              barrier = false;
              // Cloud setup publishes its immutable key before the claim. Enumerate only after fixing the database view.
              const claim = (
                await trx
                  .selectFrom('system_metadata')
                  .select('value')
                  .where('key', '=', SystemMetadataKey.FrameleafCloudBackup)
                  .executeTakeFirst()
              )?.value as FrameleafCloudBackup | undefined;
              manifest.cloudBackupKeys = await this.keys.readAll(sourceRoot);
              for (const key of manifest.cloudBackupKeys)
                if (keyFingerprint(parseBackupKey(key.content)) !== key.fingerprint)
                  throw new Error('Stored Cloud Backup recovery key failed verification');
              if (
                claim &&
                claim.keyMode !== 'own-memory' &&
                manifest.cloudBackupKeys.every((key) => key.fingerprint !== claim.keyFingerprint)
              )
                throw new Error('Stored Cloud Backup recovery key is missing');
              dependencies = (await dependencyPaths.execute(trx)).rows;
              derived = settings.includeDerived ? (await derivedPaths.execute(trx)).rows : [];
              const derivedRoleByPath = new Map(derived.map((entry) => [entry.path, entry.role]));
              for (const entry of derived) {
                if (!entry.assetId) continue;
                const entries = derivedByAsset.get(entry.assetId) ?? [];
                entries.push(entry);
                derivedByAsset.set(entry.assetId, entries);
              }
              const pinnedBySnapshot = [...(await required.execute(trx)).rows, ...dependencies, ...derived]
                .map((entry) => entry.path)
                .filter(Boolean);
              const lineageCandidates = await sql<{
                path: string;
              }>`SELECT "masterPath" AS path FROM public.video_edit_version
                WHERE "masterPath" IS NOT NULL UNION SELECT path FROM public.asset_file WHERE "isEdited"`.execute(trx);
              const lineages: string[] = [];
              for (const { path } of lineageCandidates.rows) {
                const lineage = getEditedMasterLineagePath(path);
                try {
                  await realpath(lineage);
                  lineages.push(lineage);
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                }
              }
              dependencies.push(...lineages.map((path) => ({ path })));
              // A library scan marks a vanished file offline and trashes it with its status unchanged.
              // Like Cloud Backup, such an item is left out of the snapshot instead of failing it.
              for (const { path } of (
                await sql<{ path: string }>`SELECT "originalPath" AS path FROM public.asset
                  WHERE "isOffline" AND status IN (${AssetStatus.Active}, ${AssetStatus.Trashed})
                  UNION SELECT f.path FROM public.asset_file f JOIN public.asset a ON a.id=f."assetId"
                  WHERE a."isOffline" AND a.status IN (${AssetStatus.Active}, ${AssetStatus.Trashed})`.execute(trx)
              ).rows)
                offline.add(path);
              // Outside the barrier: imports and file locks proceed while each path is resolved. A path read
              // from the snapshot is already pinned; only lineage files, configuration files and canonical
              // spellings that differ are added here, in chunks.
              // ponytail: a canonical spelling deleted before its chunk lands fails this run at copy time
              // (ENOENT/changed path), never silently; pin it in SQL if symlinked libraries make that common.
              const extra = new Set([...lineages, ...configurationPaths]);
              const paths = [...new Set([...pinnedBySnapshot, ...lineages, ...configurationPaths])];
              for (let offset = 0; offset < paths.length; offset += 1000) {
                const added: string[] = [];
                for (const path of paths.slice(offset, offset + 1000)) {
                  const canonical = await realpath(path).catch((error: NodeJS.ErrnoException) => {
                    if (error.code === 'ENOENT' && offline.has(path)) return null;
                    if (error.code === 'ENOENT' && derivedRoleByPath.has(path))
                      throw new Error(
                        `A selected Buddy derived file is missing (${derivedRoleByPath.get(path)}). Regenerate the cache or remove its stale reference before retrying the backup.`,
                      );
                    throw error;
                  });
                  if (canonical === null) continue;
                  if (inside(hostRoot, canonical) || inside(sourceRoot, canonical))
                    throw new Error('A backup contains a Buddy vault or server identity files');
                  pinnedPaths.set(path, canonical);
                  if (extra.has(path)) added.push(path);
                  if (canonical !== path) added.push(canonical);
                }
                if (added.length > 0)
                  await sql`INSERT INTO public.buddy_backup_reference ("runId", path)
                    SELECT ${options.runId}::uuid, path FROM unnest(${added}::text[]) AS path
                    ON CONFLICT DO NOTHING`.execute(connection);
              }
              // A deletion this run holds back is replayed on release, after the asset row is gone. Record
              // who held each pinned original first, so the replay can still put it in the file trash.
              const originals = await trx
                .selectFrom('asset')
                .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
                .select([
                  'asset.id',
                  'asset.ownerId',
                  'asset.originalPath',
                  'asset.originalFileName',
                  'asset.checksum',
                  'asset_exif.fileSizeInByte',
                ])
                .where('asset.status', 'in', [AssetStatus.Active, AssetStatus.Trashed])
                .execute();
              await writeBuddyFile(
                this.originalsPath(options.runId),
                JSON.stringify(
                  originals
                    .filter((row) => pinnedPaths.has(row.originalPath))
                    .map((row): PinnedOriginal => ({
                      path: row.originalPath,
                      ownerId: row.ownerId,
                      assetId: row.id,
                      originalFileName: row.originalFileName,
                      checksum: Buffer.from(row.checksum).toString('hex'),
                      sizeInBytes: row.fileSizeInByte ?? 0,
                    })),
                ),
              );
              const index = new CloudBackupIndexRepository(trx);
              const fidelity = new BuddyBackupFidelityRepository(trx);
              manifest.studio = await new BuddyBackupStudioRepository(trx).capture();
              manifest.storageRoots = [
                StorageCore.getMediaLocation(),
                ...(await trx.selectFrom('library').select('importPaths').execute()).flatMap(
                  (library) => library.importPaths,
                ),
              ];
              manifest.settings.system =
                (
                  await trx
                    .selectFrom('system_metadata')
                    .select('value')
                    .where('key', '=', SystemMetadataKey.SystemConfig)
                    .executeTakeFirst()
                )?.value ?? {};
              manifest.settings.users = await trx
                .selectFrom('user_metadata')
                .select(['userId', 'key', 'value'])
                .where('key', 'in', [
                  UserMetadataKey.Preferences,
                  UserMetadataKey.PinnedCollections,
                  UserMetadataKey.PhotographyWorkspace,
                  UserMetadataKey.Onboarding,
                ])
                .execute();
              // FL-721: every Locked key file as it is (wrapped; no secret opens anything without it), first,
              // before the dump and any media: turning encryption off deletes the key file once its files are
              // plain, so a copy taken later could miss the key that this snapshot's ciphertext needs. A key
              // file is replaced atomically, so it is read as it is now; one already removed is left out.
              // The key ids (hex) of the captured key files: each encrypted file's owner key must be one of them.
              for (const { userId, path } of await lockedKeyBackupFiles(StorageCore.getMediaLocation())) {
                try {
                  manifest.library.lockedKeys![userId] = await captureFile(
                    path,
                    LOCKED_KEY_BACKUP_ROLE,
                    undefined,
                    true,
                  );
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                  continue;
                }
                const id = await lockedKeyFileKeyId(path, userId);
                if (id) lockedKeyIds.add(id);
              }
              // pg_dump imports precisely this view. Internet transfer starts only after this transaction ends.
              dump = await this.backups.createDatabaseBackup(`buddy-${options.runId}-`, {
                snapshot,
                signal: executionSignal(),
                progress: advanceExecutionProgress,
                verify: true,
              });
              // Each asset's records, in pages, from the same view. No media is read until the view is closed.
              let afterId: string | null = null;
              while (true) {
                await options.checkpoint();
                const assets = await index.listAssets({
                  afterId,
                  limit: 100,
                  includeExternal: true,
                  includeThumbs: settings.includeDerived,
                  includeEncodedVideo: settings.includeDerived,
                });
                if (assets.length === 0) break;
                const details = await index.getAssetDetails(assets.map((asset) => asset.id));
                const originals = await trx
                  .selectFrom('asset')
                  .select(['id', 'checksum', 'checksumAlgorithm', 'livePhotoVideoId', 'libraryId', 'isExternal'])
                  .where(
                    'id',
                    'in',
                    assets.map((asset) => asset.id),
                  )
                  .execute();
                for (const asset of assets) {
                  const metadata = details.get(asset.id);
                  const original = originals.find((row) => row.id === asset.id);
                  if (!metadata || !original) throw new Error('Snapshot inventory is incomplete');
                  if (!present(asset.originalPath)) continue;
                  // Edited outputs and recorded version files are non-regenerable dependencies even with caches disabled.
                  const edited = await trx
                    .selectFrom('asset_file')
                    .select(['path', 'type'])
                    .where('assetId', '=', asset.id)
                    .where('isEdited', '=', true)
                    .execute();
                  const assetFiles = await trx
                    .selectFrom('asset_file')
                    .select(['path', 'type', 'isEdited', 'isProgressive', 'isTransparent'])
                    .where('assetId', '=', asset.id)
                    .execute();
                  // The source hash and projection are bound once the files are read.
                  const state = await fidelity.capture(asset.id, UNBOUND_SHA256, [], metadata.details.edits);
                  plans.push({ asset, metadata, original, edited, assetFiles, fidelity: state });
                  for (const album of metadata.details.albums) albums.add(album.id);
                  for (const face of metadata.details.faces)
                    if (face.personId)
                      people.set(`${asset.ownerId}:${face.personId}`, {
                        ownerId: asset.ownerId,
                        personId: face.personId,
                      });
                }
                afterId = assets.at(-1)!.id;
              }
              manifest.library.albums = Object.fromEntries(await index.getAlbumRecords([...albums]));
              manifest.library.people = Object.fromEntries(await index.getPersonRecords(people.values().toArray()));
              manifest.metadata = await new BuddyBackupMetadataRepository(trx).capture(people.values().toArray());
              profiles = await index.listProfileImages();
            });
        } finally {
          if (barrier) await sql`SELECT pg_advisory_unlock(${BUDDY_CAPTURE_LOCK}::bigint)`.execute(connection);
        }
      });

      // No transaction from here on: vacuum runs while the library is read, hashed and encrypted.
      // ponytail: every asset plan stays in memory, like the manifest it becomes; spool it if 2M+ libraries strain the heap.
      // FL-721 pre-flight: a file a seal, unseal or rewrap is replacing now is left for the next run
      const lockedOwners = await lockedKeyOwners(StorageCore.getMediaLocation());
      // FL-721: the owner key ids (first recipient, spec §5) of the captured encrypted files; each must be
      // a key file in this snapshot. A partner copy points at its owner's file: the owner's key, not the
      // partner's. A header that cannot be read stands for a key no snapshot has.
      const sealedKeyIds = new Set<string>();
      for (let offset = 0; offset < plans.length; offset += 100) {
        const page = plans.slice(offset, offset + 100);
        const busy =
          lockedOwners.size > 0
            ? await pathsBeingReplaced(
                page
                  .filter(({ asset }) => lockedOwners.has(asset.ownerId))
                  .flatMap(({ asset }) => [
                    asset.originalPath,
                    ...asset.files.map((file) => file.path),
                    ...(derivedByAsset.get(asset.id) ?? []).map((file) => file.path),
                  ]),
              )
            : new Set<string>();
        for (const { asset, metadata, original, edited, assetFiles, fidelity: state } of page) {
          if (busy.has(asset.originalPath)) continue;
          const files = [
            await captureFile(asset.originalPath, 'original', {
              checksum: original.checksum,
              algorithm: original.checksumAlgorithm,
            }),
          ];
          for (const file of asset.files)
            if (present(file.path) && !busy.has(file.path)) files.push(await captureFile(file.path, file.type));
          for (const file of derivedByAsset.get(asset.id) ?? [])
            if (present(file.path) && !busy.has(file.path) && files.every((entry) => entry.path !== file.path))
              files.push(await captureFile(file.path, file.role));
          for (const file of edited)
            if (present(file.path) && !busy.has(file.path) && files.every((entry) => entry.path !== file.path))
              files.push(await captureFile(file.path, file.type));
          for (const file of files)
            if (sealedPaths.has(file.path)) sealedKeyIds.add(await sealedOwnerKeyIdOrUnreadable(file.path));
          manifest.assetLinks[asset.id] = {
            livePhotoVideoId: original.livePhotoVideoId,
            libraryId: original.libraryId,
            isExternal: original.isExternal,
          };
          manifest.assetFiles[asset.id] = assetFiles.filter((file) => files.some((entry) => entry.path === file.path));
          manifest.library.assets[asset.id] = {
            owner: asset.ownerId,
            files,
            // FL-738: the item's checksum is kept only for an encrypted original
            ...backupRecordFor(metadata.record, sealedPaths.has(asset.originalPath)),
            details: metadata.details,
          };
          manifest.assetFidelity![asset.id] = {
            ...state,
            source: { ...state.source, sha256: files[0].sha256 },
            projection: manifest.assetFiles[asset.id]
              .filter((file) => file.isEdited)
              .map((file) => ({ ...file, isEdited: true as const })),
          };
        }
      }
      // A key file that appeared or went during the capture (encryption turned on or off) would leave
      // ciphertext no key in this snapshot opens. Never hidden: the snapshot fails, and the previous
      // snapshots, with their key files, stay as they are. The next run captures a consistent pair.
      // A key id that matches no live key file is an item restored under an older key (spec §9):
      // reported, never a failure, since no snapshot could ever capture its key file.
      const { keyless, older, unreadable } = await lockedKeyGaps(
        sealedKeyIds,
        lockedKeyIds,
        StorageCore.getMediaLocation(),
      );
      if (unreadable.length > 0)
        this.logger.warn(
          `Buddy capture ${options.runId}: ${unreadable.length} file(s) start like an encrypted Locked file but cannot be read as one; captured as they are: ${unreadable.slice(0, 5).join(', ')}`,
        );
      if (older.length > 0)
        this.logger.warn(
          `Buddy capture ${options.runId}: encrypted Locked files under ${older.length} older key(s) that no key file opens; they are captured as they are`,
        );
      if (keyless.length > 0)
        throw new Error(
          `This backup found encrypted Locked files for ${keyless.length} person(s) whose key file was not there when it started. Their encryption changed during the backup; the next backup includes it.`,
        );
      for (const profile of profiles)
        manifest.library.profiles[profile.userId] = await captureFile(profile.path, 'profile');
      // Person groups can be shared across owners. Their thumbnails belong only to the
      // whole-server archive, never to an asset selected through that shared group.
      for (const entry of [
        ...derived.filter((entry) => entry.assetId === null),
        ...[...new Set(dependencies.map((entry) => entry.path).filter(Boolean))].map((path) => ({
          path,
          role: 'project' as const,
        })),
      ])
        manifest.dependencies.push(await captureFile(entry.path, entry.role));
      const inventory = new Map(
        [...Object.values(manifest.library.assets).flatMap((asset) => asset.files), ...manifest.dependencies].map(
          (file) => [file.path, file],
        ),
      );
      const fidelity = new BuddyBackupFidelityRepository(this.repository.db);
      for (const state of Object.values(manifest.assetFidelity!)) {
        fidelity.bindFiles(state, inventory);
        readBuddyAssetFidelity(manifest, state.assetId);
      }
      const studio = new BuddyBackupStudioRepository(this.repository.db);
      for (const project of Object.values(manifest.studio!.projects)) studio.bindFiles(project, inventory);
      for (const path of configurationPaths) manifest.configurationFiles.push(await captureFile(path, 'configuration'));
      const database = await captureFile(dump!, 'database', undefined, true);
      manifest.library.database = { key: basename(dump!), sha256: database.sha256, size: database.size };
    } finally {
      if (dump) await rm(dump, { force: true });
    }

    const encoded = Buffer.from(JSON.stringify(manifest));
    const manifestBlocks: string[] = [];
    for (let offset = 0; offset < encoded.length; offset += BUDDY_BLOCK_BYTES) {
      const receipt = await this.block(ring, encoded.subarray(offset, offset + BUDDY_BLOCK_BYTES), options.runId);
      objects.set(receipt.id, receipt);
      manifestBlocks.push(receipt.id);
    }
    const capture: BuddyCapture = {
      manifest,
      manifestBlocks,
      objects: objects.values().toArray(),
      ...(settings.includeDerived && { derivedInventoryVersion: 1 as const }),
    };
    await writeBuddyFile(join(this.runDirectory(options.runId), 'capture.json'), JSON.stringify(capture), true);
    return capture;
  }

  private originalsPath(runId: string) {
    return join(this.runDirectory(runId), 'originals.json');
  }

  async release(runId: string) {
    const { rows } = await sql<{ path: string }>`SELECT path FROM public.buddy_backup_reference
      WHERE "runId" = ${runId}::uuid ORDER BY path`.execute(this.repository.db);
    let originals: Map<string, PinnedOriginal> | undefined;
    for (const { path } of rows) {
      const deferred = await this.repository.db.transaction().execute(async (trx) => {
        await lockFilePath(trx, path);
        const released = await sql<{ deleteRequested: boolean }>`UPDATE public.buddy_backup_reference
          SET released = true WHERE "runId" = ${runId}::uuid AND path = ${path}
          RETURNING "deleteRequested"`.execute(trx);
        return released.rows[0]?.deleteRequested ?? false;
      });
      // A released row is a durable outbox until the existing durable queue accepts the deletion.
      // Retrying after a crash can enqueue twice; FileDelete's reference check is idempotent.
      if (deferred) {
        originals ??= new Map(
          (
            JSON.parse(
              await readFile(this.originalsPath(runId), 'utf8').catch((error: NodeJS.ErrnoException) => {
                if (error.code !== 'ENOENT') throw error;
                return '[]';
              }),
            ) as PinnedOriginal[]
          ).map((entry) => [entry.path, entry]),
        );
        const original = originals.get(path);
        const removed =
          original &&
          !(await this.repository.db
            .selectFrom('asset')
            .select('id')
            .where('id', '=', original.assetId)
            .executeTakeFirst());
        await this.jobs.queue({
          name: JobName.FileDelete,
          data: removed ? { files: [path], removedAssetId: original.assetId, original } : { files: [path] },
        });
      }
      await sql`DELETE FROM public.buddy_backup_reference
        WHERE "runId" = ${runId}::uuid AND path = ${path} AND released`.execute(this.repository.db);
    }
    // Per-run staging can be reclaimed even when capture.json was never completed.
    // The small immutable nonce/receipt journal remains available for subsequent runs.
    await rm(this.runDirectory(runId), { recursive: true, force: true });
  }

  async reconcile() {
    const { rows } = await sql<{
      runId: string;
    }>`SELECT DISTINCT "runId" FROM public.buddy_backup_reference`.execute(this.repository.db);
    const directories = await readdir(join(this.repository.root(), 'runs')).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return [] as string[];
    });
    for (const runId of new Set([...rows.map((row) => row.runId), ...directories])) {
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(runId)) continue;
      const operation = await this.repository.db
        .selectFrom('media_operation')
        .select(['status', 'claimToken'])
        .where('id', '=', runId)
        .executeTakeFirst();
      // Terminal rows never become active again. Missing rows cannot own a claim or be resumed.
      if (!operation || (!operation.claimToken && TERMINAL_MEDIA_OPERATION_STATUSES.includes(operation.status)))
        await this.release(runId);
    }
  }
}
