import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, readdir, realpath, rm, statfs } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { FrameleafCloudBackup } from 'src/types.js';
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
import { CloudBackupIndexRepository } from 'src/repositories/cloud-backup-index.repository.js';
import { CloudBackupKeyRepository } from 'src/repositories/cloud-backup-key.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { BUDDY_CAPTURE_LOCK, lockFilePath } from 'src/repositories/physical-file.repository.js';
import { DatabaseBackupService } from 'src/services/database-backup.service.js';
import {
  BUDDY_BLOCK_BYTES,
  type BuddyKeyring,
  buddyObjectId,
  decryptBuddyBlock,
  encryptBuddyBlock,
} from 'src/utils/buddy-backup-crypto.js';
import { type BuddyAssetFidelity, readBuddyAssetFidelity } from 'src/utils/buddy-backup-fidelity.js';
import { type BuddySettingsSnapshot, readBuddySettingsSnapshot } from 'src/utils/buddy-backup-settings.js';
import { type BuddyReceipt, BuddyVault, createBuddyDirectory, writeBuddyFile } from 'src/utils/buddy-backup-vault.js';
import { type BuddyBootConfiguration, captureBuddyBootConfiguration } from 'src/utils/buddy-boot-configuration.js';
import {
  CLOUD_BACKUP_MANIFEST_FORMAT,
  type CloudBackupManifest,
  type CloudBackupManifestFile,
  keyFingerprint,
  parseBackupKey,
} from 'src/utils/cloud-backup.js';
import { withDatabaseCleanup } from 'src/utils/execution-database.js';
import { advanceExecutionProgress, assertExecutionActive, executionSignal } from 'src/utils/execution-signal.js';
import { TERMINAL_MEDIA_OPERATION_STATUSES } from 'src/utils/media-operation.js';
import { getEditedMasterLineagePath } from 'src/utils/media-policy.js';

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

type DerivedBackupPath = { path: string; role: string; assetId: string | null };

/** Read from the same exported snapshot as the dump, never from directory names or temporary-file globs. */
const derivedPaths = sql<DerivedBackupPath>`
  SELECT p."thumbnailPath" AS path, 'person-thumbnail'::text AS role, NULL::uuid AS "assetId"
  FROM public.person p WHERE p."thumbnailPath" <> ''
  UNION ALL SELECT f.path, 'video-duplicate-frame'::text, f."assetId"
  FROM public.asset_video_duplicate_frame f JOIN public.asset a ON a.id = f."assetId"
  WHERE a.status IN (${AssetStatus.Active}, ${AssetStatus.Trashed})
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
        const sealed = encryptBuddyBlock(key, { vaultId: ring.vaultId, id, keyVersion: ring.current }, bytes, nonce);
        journal = {
          nonce: nonce.toString('base64url'),
          digest: BuddyVault.receipt(id, sealed).digest,
          bytes: sealed.length,
        };
        await writeBuddyFile(journalPath, JSON.stringify(journal), true);
      }
      encrypted = encryptBuddyBlock(
        key,
        { vaultId: ring.vaultId, id, keyVersion: ring.current },
        bytes,
        Buffer.from(journal.nonce, 'base64url'),
      );
      if (encrypted.length !== journal.bytes || BuddyVault.receipt(id, encrypted).digest !== journal.digest)
        throw new Error('Buddy encryption journal does not match the immutable source object', { cause: error });
      await createBuddyDirectory(dirname(path));
      const fs = await statfs(this.repository.root());
      if (fs.bavail * fs.bsize - encrypted.length < Math.max(10 * 1024 ** 3, fs.blocks * fs.bsize * 0.1))
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
        albums: {},
        people: {},
      },
    };
    const hostRoot = await realpath(settings.directory);
    const sourceRoot = await realpath(dirname(this.repository.root()));
    const pinnedPaths = new Map<string, string>();
    const configurationPaths = [
      ...new Set(
        [
          ...settings.configurationFiles,
          ...(process.env.FRAMELEAF_CONFIG_FILE ? [process.env.FRAMELEAF_CONFIG_FILE] : []),
        ].map((path) => resolve(path)),
      ),
    ];

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
        const hash = createHash('sha256');
        const recorded =
          expected && expected.algorithm !== ChecksumAlgorithm.sha1Path ? createHash(expected.algorithm) : null;
        const blocks: string[] = [];
        let bytes = 0;
        const buffer = Buffer.alloc(BUDDY_BLOCK_BYTES);
        while (true) {
          assertExecutionActive();
          const { bytesRead } = await file.read(buffer, 0, buffer.length, bytes);
          assertExecutionActive();
          advanceExecutionProgress(bytesRead);
          if (!bytesRead) break;
          const piece = buffer.subarray(0, bytesRead);
          hash.update(piece);
          recorded?.update(piece);
          const receipt = await this.block(ring, piece, options.runId);
          objects.set(receipt.id, receipt);
          blocks.push(receipt.id);
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
        const sha256 = hash.digest('hex');
        manifest.contents[sha256] = { blocks, keyVersion: ring.current, bytes };
        return { role, path, sha256, size: bytes, mtime: new Date(Number(before.mtimeNs / 1_000_000n)).toISOString() };
      } finally {
        await file.close();
      }
    };

    await this.repository.db.connection().execute(async (connection) => {
      // ponytail: one short global barrier during inventory/pinning; copying and network transfer never hold it.
      let barrier = true;
      try {
        await sql`SELECT pg_advisory_lock(${BUDDY_CAPTURE_LOCK}::bigint)`.execute(connection);
        await this.repository.db
          .transaction()
          .setIsolationLevel('repeatable read')
          .execute(async (trx) => {
            const { rows } = await sql<{ snapshot: string }>`SELECT pg_export_snapshot() AS snapshot`.execute(trx);
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
            const dependencies = (await dependencyPaths.execute(trx)).rows;
            const derived = settings.includeDerived ? (await derivedPaths.execute(trx)).rows : [];
            const derivedByAsset = new Map<string, DerivedBackupPath[]>();
            const derivedRoleByPath = new Map(derived.map((entry) => [entry.path, entry.role]));
            for (const entry of derived) {
              if (!entry.assetId) continue;
              const entries = derivedByAsset.get(entry.assetId) ?? [];
              entries.push(entry);
              derivedByAsset.set(entry.assetId, entries);
            }
            const lineageCandidates = await sql<{
              path: string;
            }>`SELECT "masterPath" AS path FROM public.video_edit_version
          WHERE "masterPath" IS NOT NULL UNION SELECT path FROM public.asset_file WHERE "isEdited"`.execute(trx);
            for (const { path } of lineageCandidates.rows) {
              const lineage = getEditedMasterLineagePath(path);
              try {
                await realpath(lineage);
                dependencies.push({ path: lineage });
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
              }
            }
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
            const required = await sql<{ path: string }>`SELECT "originalPath" AS path FROM public.asset
          WHERE status IN (${AssetStatus.Active}, ${AssetStatus.Trashed})
          UNION SELECT f.path FROM public.asset_file f JOIN public.asset a ON a.id=f."assetId"
          WHERE a.status IN (${AssetStatus.Active}, ${AssetStatus.Trashed}) AND (f."isEdited" OR f.type = ANY(${types}::text[]))
          UNION SELECT "profileImagePath" AS path FROM public.user WHERE "profileImagePath" <> '' AND "deletedAt" IS NULL`.execute(
              trx,
            );
            for (const path of new Set([
              ...[...required.rows, ...dependencies, ...derived].map((entry) => entry.path).filter(Boolean),
              ...configurationPaths,
            ])) {
              const canonical = await realpath(path).catch((error: NodeJS.ErrnoException) => {
                if (error.code === 'ENOENT' && derivedRoleByPath.has(path))
                  throw new Error(
                    `A selected Buddy derived file is missing (${derivedRoleByPath.get(path)}). Regenerate the cache or remove its stale reference before retrying the backup.`,
                  );
                throw error;
              });
              if (inside(hostRoot, canonical) || inside(sourceRoot, canonical))
                throw new Error('A backup contains a Buddy vault or server identity files');
              pinnedPaths.set(path, canonical);
            }
            const paths = [...new Set([...pinnedPaths.keys(), ...pinnedPaths.values()])];
            for (let offset = 0; offset < paths.length; offset += 1000)
              await sql`INSERT INTO public.buddy_backup_reference ("runId", path)
            SELECT ${options.runId}::uuid, path FROM unnest(${paths.slice(offset, offset + 1000)}::text[]) AS path
            ON CONFLICT DO NOTHING`.execute(connection);
            await withDatabaseCleanup(() =>
              sql`SELECT pg_advisory_unlock(${BUDDY_CAPTURE_LOCK}::bigint)`.execute(connection),
            );
            barrier = false;
            const index = new CloudBackupIndexRepository(trx);
            const fidelity = new BuddyBackupFidelityRepository(trx);
            const studio = new BuddyBackupStudioRepository(trx);
            manifest.studio = await studio.capture();
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
            // pg_dump imports precisely this view. Internet transfer starts only after this transaction ends.
            const dump = await this.backups.createDatabaseBackup(`buddy-${options.runId}-`, {
              snapshot: rows[0].snapshot,
              signal: executionSignal(),
              progress: advanceExecutionProgress,
              verify: true,
            });
            try {
              let afterId: string | null = null;
              const albums = new Set<string>();
              const people = new Map<string, { ownerId: string; personId: string }>();
              while (true) {
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
                  const files = [
                    await captureFile(asset.originalPath, 'original', {
                      checksum: original.checksum,
                      algorithm: original.checksumAlgorithm,
                    }),
                  ];
                  for (const file of asset.files) files.push(await captureFile(file.path, file.type));
                  for (const file of derivedByAsset.get(asset.id) ?? [])
                    if (files.every((entry) => entry.path !== file.path))
                      files.push(await captureFile(file.path, file.role));
                  // Edited outputs and recorded version files are non-regenerable dependencies even with caches disabled.
                  const edited = await trx
                    .selectFrom('asset_file')
                    .select(['path', 'type'])
                    .where('assetId', '=', asset.id)
                    .where('isEdited', '=', true)
                    .execute();
                  for (const file of edited)
                    if (files.every((entry) => entry.path !== file.path))
                      files.push(await captureFile(file.path, file.type));
                  manifest.assetLinks[asset.id] = {
                    livePhotoVideoId: original.livePhotoVideoId,
                    libraryId: original.libraryId,
                    isExternal: original.isExternal,
                  };
                  manifest.assetFiles[asset.id] = (
                    await trx
                      .selectFrom('asset_file')
                      .select(['path', 'type', 'isEdited', 'isProgressive', 'isTransparent'])
                      .where('assetId', '=', asset.id)
                      .execute()
                  ).filter((file) => files.some((entry) => entry.path === file.path));
                  manifest.library.assets[asset.id] = {
                    owner: asset.ownerId,
                    files,
                    ...metadata.record,
                    details: metadata.details,
                  };
                  manifest.assetFidelity![asset.id] = await fidelity.capture(
                    asset.id,
                    files[0].sha256,
                    manifest.assetFiles[asset.id]
                      .filter((file) => file.isEdited)
                      .map((file) => ({ ...file, isEdited: true as const })),
                    metadata.details.edits,
                  );
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
              for (const profile of await index.listProfileImages())
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
                [
                  ...Object.values(manifest.library.assets).flatMap((asset) => asset.files),
                  ...manifest.dependencies,
                ].map((file) => [file.path, file]),
              );
              for (const state of Object.values(manifest.assetFidelity!)) {
                fidelity.bindFiles(state, inventory);
                readBuddyAssetFidelity(manifest, state.assetId);
              }
              for (const project of Object.values(manifest.studio.projects)) studio.bindFiles(project, inventory);
              for (const path of configurationPaths)
                manifest.configurationFiles.push(await captureFile(path, 'configuration'));
              const database = await captureFile(dump, 'database', undefined, true);
              manifest.library.database = { key: basename(dump), sha256: database.sha256, size: database.size };
            } finally {
              await rm(dump, { force: true });
            }
          });
      } finally {
        if (barrier) await sql`SELECT pg_advisory_unlock(${BUDDY_CAPTURE_LOCK}::bigint)`.execute(connection);
      }
    });

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

  async release(runId: string) {
    const { rows } = await sql<{ path: string }>`SELECT path FROM public.buddy_backup_reference
      WHERE "runId" = ${runId}::uuid ORDER BY path`.execute(this.repository.db);
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
      if (deferred) await this.jobs.queue({ name: JobName.FileDelete, data: { files: [path] } });
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
