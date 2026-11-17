import { type BackupResult, type Repository, backup } from '@frameleaf/backup-core';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import type { CloudBackupAsset, CloudBackupIndexRepository } from 'src/repositories/cloud-backup-index.repository.js';
import type { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  CATALOG_PATH,
  CLOUD_BACKUP_CATALOG_VERSION,
  catalogFiles,
  databaseTreePath,
  fileTreePath,
  lockedKeyTreePath,
  treeKey,
} from 'src/utils/cloud-backup-catalog.js';
import { BackupSource, type BackupSourceFile } from 'src/utils/cloud-backup-source.js';
import { readVaultCatalog } from 'src/utils/cloud-backup-vault.js';
import {
  CLOUD_BACKUP_MANIFEST_FORMAT,
  type CloudBackupAssetDetails,
  type CloudBackupAssetRecord,
  type CloudBackupManifest,
  type CloudBackupManifestFile,
  backupRecordFor,
  isSha256Hex,
} from 'src/utils/cloud-backup.js';
import { compareCodeUnits } from 'src/utils/compare.js';
import {
  LOCKED_KEY_BACKUP_ROLE,
  lockedKeyBackupFiles,
  lockedKeyFileKeyId,
  lockedKeyGaps,
  lockedKeyOwners,
  pathsBeingReplaced,
  sealedFileOwnerKeyId,
  sealedOwnerKeyIdOrUnreadable,
} from 'src/utils/locked-backup.js';

/** Assets read from the library per query while the run's list of files is made. */
const ASSET_PAGE = 500;
/** Items whose record and details are read per query while the catalog is written. */
const DETAILS_PAGE = 1000;

/** One file a run means to back up, as the library names it. */
type RunFile = {
  /** Names the file within the catalog (`<assetId>:original`, `profile:<userId>`, …); files of one item sort together. */
  fileKey: string;
  assetId: string | null;
  ownerId: string | null;
  role: string;
  path: string;
  tree: string;
  /** The checksum on record for it, trusted only when it was verified at this very path. */
  recorded: string | null;
};

/** What a finished backup holds, for this server's own records of it. Also read back from a stored catalog. */
export type CloudBackupRunSummary = {
  assets: number;
  files: number;
  bytes: number;
  /** Every item whose original is in the backup, with the hash of what was stored. */
  originals: Array<{ assetId: string; sha256: string }>;
  database: { key: string; sha256: string; size: number } | null;
};

export type CloudBackupRunOutcome = {
  stored: BackupResult;
  summary: CloudBackupRunSummary;
  /** Files read and sent now, and files taken from the previous backup without reading them. */
  uploaded: number;
  skipped: number;
  /** Files that were gone, and files that changed or could not be read; the next run backs those up. */
  missing: number;
  changed: number;
  lockedKeyOwners: string[];
  lockedKeyIds: string[];
  sealedKeyIds: string[];
};

/** What this server records of a backup, worked out from its catalog. */
export const summarizeCatalog = (catalog: CloudBackupManifest): CloudBackupRunSummary => {
  const files = catalogFiles(catalog);
  return {
    assets: Object.keys(catalog.assets).length,
    files: files.length,
    bytes: files.reduce((total, file) => total + file.size, 0),
    originals: Object.entries(catalog.assets).flatMap(([assetId, asset]) => {
      const original = asset.files.find((file) => file.role === 'original');
      return original ? [{ assetId, sha256: original.sha256 }] : [];
    }),
    database: catalog.database,
  };
};

/** The length of a gzipped file once uncompressed, by reading it through. */
const gunzippedSize = async (path: string, signal?: AbortSignal) => {
  let size = 0;
  for await (const part of createReadStream(path).pipe(createGunzip())) {
    signal?.throwIfAborted();
    size += (part as Buffer).length;
  }
  return size;
};

/**
 * One cloud backup run on the backup engine (FL-1676): everything the run decided on, offered to the engine
 * as one tree, and the catalog of it written last (see `cloud-backup-catalog.ts`). The engine reads each
 * file once, cuts it into chunks, sends only the chunks storage does not hold, and takes a file that has
 * not changed since the previous backup from that backup without reading it.
 *
 * Nothing on this server is changed by a run except its own temporary files. Locked media is backed up
 * like any other (backend work reaches it), and nothing a run reads is shown to anybody.
 *
 * ponytail: a run that is stopped stores no snapshot, so the next one reads every file that is not in an
 * earlier backup again. Nothing is sent twice (the engine keeps what it stored), but a first backup of a
 * very large library that is paused every night reads from the start each time. The cure is a checkpoint
 * tree in the engine.
 */
export class CloudBackupRunner {
  constructor(
    private index: Pick<
      CloudBackupIndexRepository,
      'listAssets' | 'listProfileImages' | 'getAssetDetails' | 'getAlbumRecords' | 'getPersonRecords'
    >,
    private logger: LoggingRepository,
    private hashFile: (path: string) => Promise<string>,
  ) {}

  async run(options: {
    repository: Repository;
    runId: string;
    instanceId: string;
    createdAt: string;
    /** The backup's place in the signed history, and the id its name ends in: together they fix its name. */
    sequence: number;
    snapshotId: string;
    mediaLocation: string;
    /** Where the catalog is written before it is stored; emptied again when the run ends. */
    scratch: string;
    /** The dump made for this run (`.sql.gz`); stored uncompressed, so that daily dumps share most chunks. */
    dump: string;
    include: { thumbs: boolean; encodedVideo: boolean };
    /** FL-362: the run's own decision, when it has one; otherwise everything `mayUpload` allows. */
    decisionRunId?: string;
    mayUpload: (ownerId: string | null) => boolean;
    signal: AbortSignal;
    /** Stops the run with this as its reason. */
    fail: (error: unknown) => void;
    onProgress?: (progress: { files: number; filesTotal: number; bytes: number; storedBytes: number }) => void;
  }): Promise<CloudBackupRunOutcome> {
    const { repository, signal } = options;
    const outcome = {
      uploaded: 0,
      skipped: 0,
      missing: 0,
      changed: 0,
      lockedKeyOwners: [] as string[],
      lockedKeyIds: [] as string[],
      sealedKeyIds: [] as string[],
    };

    // FL-721: every Locked key file as it is (wrapped; no secret opens anything without it), read first:
    // turning encryption off deletes the key file once its files are plain, so a copy taken later could miss
    // the key this backup's ciphertext needs.
    const keys: RunFile[] = (await lockedKeyBackupFiles(options.mediaLocation))
      .filter(({ userId }) => options.mayUpload(userId))
      .map(({ userId, path }) => ({
        fileKey: `locked-key:${userId}`,
        assetId: null,
        ownerId: userId,
        role: LOCKED_KEY_BACKUP_ROLE,
        path,
        tree: treeKey(lockedKeyTreePath(userId)),
        recorded: null,
      }));

    const files = await this.libraryFiles(options, outcome);
    signal.throwIfAborted();

    const dumpName = basename(options.dump);
    const database: BackupSourceFile = {
      treePath: databaseTreePath(dumpName),
      path: options.dump,
      open: () => createReadStream(options.dump).pipe(createGunzip()),
      size: await gunzippedSize(options.dump, signal),
      required: true,
    };
    const databaseKey = treeKey(database.treePath);
    const catalogPath = join(options.scratch, `catalog-${options.runId}.json`);
    await mkdir(options.scratch, { recursive: true, mode: 0o700 });

    let summary: CloudBackupRunSummary | undefined;
    const filesTotal = keys.length + files.length + 2;
    const source: BackupSource = new BackupSource(
      [
        { name: 'locked-keys', files: keys.map(({ path, tree }) => ({ treePath: tree.split('/'), path })) },
        { name: 'database', files: [database] },
        { name: 'files', files: files.map(({ path, tree }) => ({ treePath: tree.split('/'), path })) },
        {
          name: 'catalog',
          files: async () => {
            summary = await this.writeCatalog(catalogPath, source, [...keys, ...files], databaseKey, options, outcome);
            return [{ treePath: CATALOG_PATH, path: catalogPath, required: true }];
          },
        },
      ],
      options.fail,
    );

    try {
      const stored = await backup(repository, source, {
        sequence: options.sequence,
        snapshotId: options.snapshotId,
        time: new Date(options.createdAt),
        signal,
        onProgress: ({ files: done, bytes, storedBytes }) =>
          options.onProgress?.({ files: done, filesTotal, bytes, storedBytes }),
      });
      if (!summary) {
        throw new Error('The backup was stored without its catalog.');
      }
      const unreadable = stored.problems.filter(({ path }) => path[0] === 'files').length;
      if (unreadable > 0) {
        this.logger.warn(
          `Cloud backup run ${options.runId}: ${unreadable} file(s) could not be read or changed while they were read; the next run backs them up`,
        );
      }
      return { stored, summary, ...outcome };
    } finally {
      await rm(catalogPath, { force: true });
    }
  }

  /** Every file of every item the run keeps, and the profile pictures: what `files/` will hold. */
  private async libraryFiles(
    options: Parameters<CloudBackupRunner['run']>[0],
    outcome: { changed: number },
  ): Promise<RunFile[]> {
    const lockedOwners = await lockedKeyOwners(options.mediaLocation);
    const files: RunFile[] = [];
    let afterId: string | null = null;
    while (true) {
      options.signal.throwIfAborted();
      const page: CloudBackupAsset[] = await this.index.listAssets({
        afterId,
        limit: ASSET_PAGE,
        includeThumbs: options.include.thumbs,
        includeEncodedVideo: options.include.encodedVideo,
        ...(options.decisionRunId && { decisionRunId: options.decisionRunId }),
      });
      if (page.length === 0) {
        break;
      }
      afterId = page.at(-1)!.id;
      // FL-362: an account the licence does not cover keeps its library here; none of it is uploaded
      const listed = page.filter((asset) => options.mayUpload(asset.ownerId)).flatMap((asset) => this.filesOf(asset));
      // FL-721: a file a seal, unseal or rewrap is replacing now (a `.fllk.tmp` sibling) is left for the
      // next run. Only people with a Locked key file can have one.
      const busy =
        lockedOwners.size > 0
          ? await pathsBeingReplaced(
              listed.filter(({ ownerId }) => ownerId && lockedOwners.has(ownerId)).map(({ path }) => path),
            )
          : new Set<string>();
      if (busy.size > 0) {
        this.logger.log(
          `Cloud backup run ${options.runId}: ${busy.size} Locked files are being encrypted now; the next run backs them up`,
        );
        outcome.changed += busy.size;
      }
      files.push(...listed.filter(({ path }) => !busy.has(path)));
    }
    for (const { userId, path } of await this.index.listProfileImages()) {
      if (options.mayUpload(userId)) {
        files.push({
          fileKey: `profile:${userId}`,
          assetId: null,
          ownerId: userId,
          role: 'profile',
          path,
          tree: treeKey(fileTreePath(path)),
          recorded: null,
        });
      }
    }
    return files;
  }

  private filesOf(asset: CloudBackupAsset): RunFile[] {
    return [
      {
        fileKey: `${asset.id}:original`,
        assetId: asset.id,
        ownerId: asset.ownerId,
        role: 'original',
        path: asset.originalPath,
        tree: treeKey(fileTreePath(asset.originalPath)),
        // trusted only when it was verified at this very path
        recorded:
          asset.sha256 && isSha256Hex(asset.sha256) && asset.checksumSize !== null && asset.checksumPathVerified
            ? asset.sha256
            : null,
      },
      ...asset.files.map((file) => ({
        fileKey: `${asset.id}:${file.type}:${file.path}`,
        assetId: asset.id,
        ownerId: asset.ownerId,
        role: file.type as string,
        path: file.path,
        tree: treeKey(fileTreePath(file.path)),
        recorded: null,
      })),
    ];
  }

  /**
   * The catalog, written to a file once the engine has been through everything else. For each file the
   * run listed it records what the snapshot holds: the hash of what the engine read, or, for a file the
   * engine took from the previous backup unread, the hash the previous catalog has for it. A file that was
   * gone, or that could not be read to its end, is left out and counted. Memory holds one page of item
   * details at a time.
   */
  private async writeCatalog(
    path: string,
    source: BackupSource,
    files: RunFile[],
    databaseKey: string,
    options: Parameters<CloudBackupRunner['run']>[0],
    outcome: Omit<CloudBackupRunOutcome, 'stored' | 'summary'>,
  ): Promise<CloudBackupRunSummary> {
    const { repository, signal } = options;
    const dump = source.hashed.get(databaseKey);
    if (!dump) {
      throw new Error('The database dump could not be read into the backup.');
    }
    const database = { key: databaseKey, sha256: dump.sha256, size: dump.size };

    // Read only when something was taken from the previous backup unread. The engine's index is loaded by now.
    let previous: Map<string, { sha256: string; size: number }> | undefined;
    const earlier = async (tree: string) => {
      if (!previous) {
        previous = new Map();
        const last = (await repository.listSnapshots()).at(-1);
        if (last) {
          const catalog = await readVaultCatalog(repository, await repository.readSnapshot(last.key));
          for (const file of catalogFiles(catalog)) {
            previous.set(file.objectKey!, { sha256: file.sha256, size: file.size });
          }
        }
      }
      return previous.get(tree);
    };

    const stored = async (file: RunFile): Promise<CloudBackupManifestFile | null> => {
      const listed = source.listed.get(file.tree);
      if (!listed) {
        // gone when its folder was listed, or it could not be looked at
        outcome[source.missing.has(file.tree) ? 'missing' : 'changed']++;
        return null;
      }
      let read: { sha256: string; size: number } | undefined = source.hashed.get(file.tree);
      let sealed: string | null;
      if (source.opened.has(file.tree)) {
        const hashed = source.hashed.get(file.tree);
        if (!hashed) {
          outcome.changed++;
          return null;
        }
        // FL-738: encrypted or not as stored, whatever the file on disk is by now
        sealed =
          file.role !== LOCKED_KEY_BACKUP_ROLE && hashed.sealed ? await sealedOwnerKeyIdOrUnreadable(file.path) : null;
        outcome.uploaded++;
        // FL-721: an encrypted Locked file is copied as it is; its recorded checksum is the plaintext's, so
        // a difference is not a change.
        if (file.recorded && file.recorded !== read.sha256 && sealed === null) {
          outcome.changed++;
        }
      } else {
        // not read this run: the file is as the last backup stored it, so it is what the disk holds
        sealed = file.role === LOCKED_KEY_BACKUP_ROLE ? null : await sealedFileOwnerKeyId(file.path);
        const before = await earlier(file.tree);
        read = before?.size === listed.size ? before : { sha256: await this.hashFile(file.path), size: listed.size };
        outcome.skipped++;
      }
      if (sealed && !outcome.sealedKeyIds.includes(sealed)) {
        outcome.sealedKeyIds.push(sealed);
      }
      if (file.role === 'original' && file.assetId) {
        sealedOriginals.set(file.assetId, sealed !== null);
      }
      return {
        role: file.role,
        path: file.path,
        objectKey: file.tree,
        sha256: read.sha256,
        size: read.size,
        mtime: new Date(listed.mtime).toISOString(),
      };
    };
    const sealedOriginals = new Map<string, boolean>();

    const summary: CloudBackupRunSummary = { assets: 0, files: 0, bytes: 0, originals: [], database };
    const count = (file: CloudBackupManifestFile) => {
      summary.files++;
      summary.bytes += file.size;
    };
    const profiles: string[] = [];
    const lockedKeys: string[] = [];
    const albumIds = new Set<string>();
    const people = new Map<string, { ownerId: string; personId: string }>();
    const byItem = files
      .filter((file): file is RunFile & { assetId: string } => file.assetId !== null)
      .toSorted((a, b) => compareCodeUnits(a.fileKey, b.fileKey));
    const index = this.index;

    async function* chunks(): AsyncGenerator<string> {
      const header = {
        format: CLOUD_BACKUP_MANIFEST_FORMAT,
        version: CLOUD_BACKUP_CATALOG_VERSION,
        instanceId: options.instanceId,
        createdAt: options.createdAt,
        database,
      };
      yield `${JSON.stringify(header).slice(0, -1)},"assets":{`;

      for (let at = 0; at < byItem.length;) {
        signal.throwIfAborted();
        // A page of whole items: one item's files are never split across two pages.
        let end = at;
        const ids = new Set<string>();
        while (end < byItem.length && (ids.size < DETAILS_PAGE || ids.has(byItem[end].assetId))) {
          ids.add(byItem[end].assetId);
          end++;
        }
        const details = await index.getAssetDetails([...ids]);
        for (const assetId of ids) {
          const own = byItem.slice(at, end).filter((file) => file.assetId === assetId);
          const kept: CloudBackupManifestFile[] = [];
          for (const file of own) {
            const entry = await stored(file);
            if (entry) {
              kept.push(entry);
              count(entry);
            }
          }
          if (kept.length === 0) {
            continue;
          }
          const original = kept.find((file) => file.role === 'original');
          if (original) {
            summary.originals.push({ assetId, sha256: original.sha256 });
          }
          const known: { record: CloudBackupAssetRecord; details: CloudBackupAssetDetails } | undefined =
            details.get(assetId);
          if (known) {
            for (const album of known.details.albums) {
              albumIds.add(album.id);
            }
            for (const face of known.details.faces) {
              if (face.personId && own[0].ownerId) {
                people.set(`${own[0].ownerId}:${face.personId}`, { ownerId: own[0].ownerId, personId: face.personId });
              }
            }
          }
          const body = JSON.stringify({
            owner: own[0].ownerId,
            files: kept,
            ...(known && {
              // FL-738: the item's checksum is kept only for an original that is encrypted in this backup
              ...backupRecordFor(known.record, !!original && (sealedOriginals.get(assetId) ?? false)),
              details: known.details,
            }),
          });
          yield `${summary.assets > 0 ? ',' : ''}${JSON.stringify(assetId)}:${body}`;
          summary.assets++;
        }
        at = end;
      }

      for (const file of files) {
        if (file.assetId !== null) {
          continue;
        }
        const entry = await stored(file);
        if (!entry || !file.ownerId) {
          continue;
        }
        count(entry);
        if (file.role === LOCKED_KEY_BACKUP_ROLE) {
          lockedKeys.push(`${JSON.stringify(file.ownerId)}:${JSON.stringify(entry)}`);
          outcome.lockedKeyOwners.push(file.ownerId);
          const id = await lockedKeyFileKeyId(file.path, file.ownerId);
          if (id) {
            outcome.lockedKeyIds.push(id);
          }
        } else {
          profiles.push(`${JSON.stringify(file.ownerId)}:${JSON.stringify(entry)}`);
        }
      }
      const albums = await index.getAlbumRecords([...albumIds]);
      const persons = await index.getPersonRecords(people.values().toArray());
      // FL-721: only when someone has a key file
      const keys = lockedKeys.length > 0 ? `,"lockedKeys":{${lockedKeys.join(',')}}` : '';
      yield `},"profiles":{${profiles.join(',')}}${keys},"albums":${JSON.stringify(Object.fromEntries(albums))},"people":${JSON.stringify(Object.fromEntries(persons))}}`;
    }

    await pipeline(Readable.from(chunks()), createWriteStream(path, { mode: 0o600 }), { signal });

    // FL-721: encrypted files whose owner had no key file when the run started (encryption turned on, or
    // off and on, during the run) would make a backup no secret can open. Never hidden: the run fails
    // before its snapshot, and the earlier backups, with their key files, stay as they are. The owner is
    // the file's first recipient, so a partner copy needs the owner's key file, never the partner's.
    // A key id that matches no live key file is an item restored under an older key (spec §9): reported,
    // never a failure, since no backup could ever capture its key file.
    const { keyless, older, unreadable } = await lockedKeyGaps(
      outcome.sealedKeyIds,
      new Set(outcome.lockedKeyIds),
      options.mediaLocation,
    );
    if (unreadable.length > 0) {
      this.logger.warn(
        `Cloud backup run ${options.runId}: ${unreadable.length} file(s) start like an encrypted Locked file but cannot be read as one; backed up as they are: ${unreadable.slice(0, 5).join(', ')}`,
      );
    }
    if (older.length > 0) {
      this.logger.warn(
        `Cloud backup run ${options.runId}: encrypted Locked files under ${older.length} older key(s) that no key file opens; they are backed up as they are`,
      );
    }
    if (keyless.length > 0) {
      this.logger.warn(
        `Cloud backup run ${options.runId}: encrypted Locked files of ${keyless.length} person(s) had no key file when the run started`,
      );
      throw new Error(
        `This backup found encrypted Locked files for ${keyless.length} person(s) whose key file was not there when it started. Their encryption changed during the backup; the next backup includes it.`,
      );
    }
    return summary;
  }
}

/** SHA-256 of a file on disk, for the rare file the engine reused whose hash no earlier catalog holds. */
export const sha256OfFile = async (path: string) => {
  const hash = createHash('sha256');
  for await (const part of createReadStream(path)) {
    hash.update(part as Buffer);
  }
  return hash.digest('hex');
};
