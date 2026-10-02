import { Kysely, sql } from 'kysely';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import {
  AlbumKind,
  AssetFileType,
  AssetPathType,
  AssetType,
  ChecksumAlgorithm,
  JobName,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  PhysicalFileType,
  SystemMetadataKey,
} from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { BuddyBackupRepository, type BuddySettings } from 'src/repositories/buddy-backup.repository.js';
import { CloudBackupKeyRepository } from 'src/repositories/cloud-backup-key.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { BUDDY_CAPTURE_LOCK, PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { BuddyBackupCaptureService, type BuddyCapture } from 'src/services/buddy-backup-capture.service.js';
import { DatabaseBackupService } from 'src/services/database-backup.service.js';
import { BUDDY_BLOCK_BYTES, type BuddyKeyring, decryptBuddyBlock } from 'src/utils/buddy-backup-crypto.js';
import { backupKeyFile, keyFingerprint } from 'src/utils/cloud-backup.js';
import { type MediumTestContext, newMediumService } from 'test/medium.factory.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { getActiveForkKyselyDB } from 'test/utils.js';

// CI's temporary volume may be below the production 10 GiB/10% reserve. Keep all file I/O real;
// only supply enough reported free space for these small fixtures when that reserve would reject them.
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    statfs: async (path: Parameters<typeof fs.statfs>[0]) => {
      const stats = await fs.statfs(path);
      const reserve = Math.max(10 * 1024 ** 3, stats.blocks * stats.bsize * 0.1);
      return { ...stats, bavail: Math.max(stats.bavail, Math.ceil((reserve + 64 * 1024 ** 2) / stats.bsize)) };
    },
  };
});

describe('Buddy capture preservation and interrupted-run cleanup', () => {
  let db: Kysely<DB>;
  let ctx: MediumTestContext;
  let root: string;
  let repository: BuddyBackupRepository;
  let physical: PhysicalFileRepository;
  let settings: BuddySettings;
  let ring: BuddyKeyring;
  let ownerId: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'buddy-capture-medium-')));
    for (const directory of ['identity', 'vault', 'source']) await mkdir(join(root, directory));
    StorageCore.setMediaLocation(join(root, 'source'));
    db = await getActiveForkKyselyDB();
    ({ ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] }));
    ownerId = (await ctx.newUser()).user.id;
    const config = {
      getEnv: () =>
        mockEnvData({
          frameleafCloud: { ...mockEnvData({}).frameleafCloud, identityDir: join(root, 'identity') },
        }),
    } as ConfigRepository;
    repository = new BuddyBackupRepository(db, config);
    physical = new PhysicalFileRepository(db);
    ring = { version: 1, vaultId: randomUUID(), current: 1, keys: { 1: randomBytes(32).toString('base64url') } };
    settings = {
      directory: join(root, 'vault'),
      quotaBytes: 1024 ** 3,
      uploadMbps: 10,
      downloadMbps: 10,
      schedule: 'manual',
      timezone: 'UTC',
      windowStart: '00:00',
      windowEnd: '23:59',
      pausedSending: false,
      pausedReceiving: false,
      includeDerived: false,
      configurationFiles: [],
    };
    vi.stubEnv('FRAMELEAF_CONFIG_FILE', undefined);
  }, 30_000);

  afterEach(async () => {
    StorageCore.reset();
    vi.unstubAllEnvs();
    await db?.destroy();
    if (root) await rm(root, { recursive: true, force: true });
  });

  const file = async (name: string, bytes: Buffer = Buffer.from(name)) => {
    const path = join(root, 'source', name);
    await writeFile(path, bytes);
    return { path, bytes };
  };
  const original = async (name: string, bytes?: Buffer, type = AssetType.Image) => {
    const source = await file(name, bytes);
    const { asset } = await ctx.newAsset({
      ownerId,
      type,
      originalPath: source.path,
      checksum: createHash('sha256').update(source.bytes).digest(),
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
    });
    return { ...source, asset };
  };
  const options = (runId = randomUUID()) => ({
    runId,
    instanceId: randomUUID(),
    sequence: 1,
    previous: null,
    ring,
    settings,
    checkpoint: async () => {},
  });
  const fixture = (beforeDump: (snapshot: string) => Promise<void> = async () => {}) => {
    const queue = vi.fn<JobRepository['queue']>().mockResolvedValue(undefined);
    const createDatabaseBackup = vi.fn<DatabaseBackupService['createDatabaseBackup']>(async (_prefix, input) => {
      expect(input).toMatchObject({ verify: true, snapshot: expect.stringMatching(/^[\da-f]+-[\da-f]+-\d+$/i) });
      await beforeDump(input?.snapshot ?? '');
      return (await file('database.sql.gz', Buffer.from('fake pg_dump bytes'))).path;
    });
    const backups = { createDatabaseBackup } as unknown as DatabaseBackupService;
    const jobs = { queue } as unknown as JobRepository;
    const keys = new CloudBackupKeyRepository(LoggingRepository.create());
    return { capture: new BuddyBackupCaptureService(repository, backups, jobs, keys), backups, jobs, keys, queue };
  };
  const references = async (runId: string) =>
    (
      await sql<{ path: string; released: boolean; deleteRequested: boolean }>`
        SELECT path, released, "deleteRequested" FROM immich_fork.buddy_backup_reference
        WHERE "runId" = ${runId}::uuid ORDER BY path`.execute(db)
    ).rows;
  const restoreBytes = async (capture: BuddyCapture, runId: string, sha256: string) => {
    const content = capture.manifest.contents[sha256];
    expect(content).toBeDefined();
    const key = Buffer.from(ring.keys[content.keyVersion], 'base64url');
    return Buffer.concat(
      await Promise.all(
        content.blocks.map(async (id) =>
          decryptBuddyBlock(
            key,
            { vaultId: ring.vaultId, id, keyVersion: content.keyVersion },
            await readFile(join(repository.root(), 'runs', runId, 'blocks', id)),
          ),
        ),
      ),
    );
  };

  it('writes owner-specific people and empty album structure into the encrypted source manifest', async () => {
    const own = await original('own-person.jpg');
    const owner = await db.selectFrom('user').select('clusterGroupId').where('id', '=', ownerId).executeTakeFirstOrThrow();
    const { user: other } = await ctx.newUser({ clusterGroupId: owner.clusterGroupId });
    const otherFile = await file('other-person.jpg');
    const { asset: otherAsset } = await ctx.newAsset({
      ownerId: other.id,
      originalPath: otherFile.path,
      checksum: createHash('sha256').update(otherFile.bytes).digest(),
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
    });
    const { person } = await ctx.newPerson({ ownerId, name: 'Own name' });
    await ctx.newPerson({ ownerId: other.id, personGroupId: person.personGroupId, name: 'Other name' });
    for (const assetId of [own.asset.id, otherAsset.id]) {
      await ctx.newAssetFace({
        assetId,
        personGroupId: person.personGroupId,
        imageWidth: 100,
        imageHeight: 80,
        boundingBoxX1: 1,
        boundingBoxY1: 2,
        boundingBoxX2: 30,
        boundingBoxY2: 40,
      });
    }
    const { album: collection } = await ctx.newAlbum({
      ownerId, kind: AlbumKind.Collection, albumName: 'Empty collection',
    });
    const { album: child } = await ctx.newAlbum({
      ownerId, parentId: collection.id, icon: 'camera', sortOrder: 3, albumName: 'Empty child',
    });
    const { capture } = fixture();
    const run = options();
    const result = await capture.capture(run);
    expect(result.manifest.metadata?.peopleByOwner[ownerId][person.personGroupId].name).toBe('Own name');
    expect(result.manifest.metadata?.peopleByOwner[other.id][person.personGroupId].name).toBe('Other name');
    expect(result.manifest.metadata?.albums[child.id]).toMatchObject({
      ownerId, parentId: collection.id, kind: 'album', icon: 'camera', sortOrder: 3, sharedUsers: [],
    });
    expect(result.manifest.library.assets[own.asset.id].owner).toBe(ownerId);
    expect(result.manifest.library.assets[otherAsset.id].owner).toBe(other.id);
    await capture.release(run.runId);
  });

  it('pins retained versions before the dump and preserves them through later moves and deletes', async () => {
    const first = await original('first.jpg');
    const later = await original('later.jpg');
    const video = await original('video.mp4', undefined, AssetType.Video);
    const restored = await file('restored.jpg');
    const preview = await file('restored-preview.jpg');
    const still = await file('edited-still.jpg');
    const stillLineage = await file('edited-still.jpg.lineage.json');
    const master = await file('edited-video.mp4');
    const proxy = await file('edited-video-proxy.mp4');
    const lineage = await file('edited-video.mp4.lineage.json');
    const cloudKey = randomBytes(32);
    const cloudKeyContent = JSON.stringify(
      backupKeyFile({ key: cloudKey, instanceId: randomUUID(), bucket: 'test', mode: 'server', createdAt: new Date() }),
    );
    await writeFile(join(root, 'identity', `cloud-backup-${keyFingerprint(cloudKey)}.key`), cloudKeyContent);
    await writeFile(join(root, 'identity', 'instance-key.pem'), 'must not be captured');
    const developed = await file('external-developed.jpg');
    const developedPreview = await file('external-developed-preview.jpg');
    await sql`INSERT INTO immich_fork.asset_develop_revision
      ("assetId", "ownerId", revision, recipe, kind, status, "masterPath", "previewPath")
      VALUES (${first.asset.id}::uuid, ${ownerId}::uuid, 1, '{}'::jsonb, 'external', 'rendered',
        ${developed.path}, ${developedPreview.path})`.execute(db);
    await ctx.newAssetFile({ assetId: first.asset.id, type: AssetFileType.FullSize, path: still.path, isEdited: true });
    await db
      .insertInto('asset_restoration')
      .values({
        assetId: first.asset.id,
        ownerId,
        revision: 1,
        status: 'restored',
        isCurrent: true,
        mode: 'faithful',
        workload: 'restoration-faithful',
        destinationKind: 'local',
        destinationName: 'Local',
        sourceType: 'image',
        sourceChecksum: first.asset.checksum,
        sourceWidth: 32,
        sourceHeight: 32,
        previewRegion: { x: 0, y: 0, w: 1, h: 1 },
        resultPath: restored.path,
        resultPreviewPath: preview.path,
      })
      .execute();
    await sql`INSERT INTO immich_fork.video_edit_version
      ("assetId", "ownerId", "sourcePath", "sourceChecksum", recipe, purpose, status, "masterPath", "proxyPath")
      VALUES (${video.asset.id}::uuid, ${ownerId}::uuid, ${video.path}, ${video.asset.checksum},
        '[]'::jsonb, 'save', 'ready', ${master.path}, ${proxy.path})`.execute(db);
    const run = options();
    const expected = [
      first,
      later,
      video,
      restored,
      preview,
      still,
      stillLineage,
      master,
      proxy,
      lineage,
      developed,
      developedPreview,
    ];
    const assets = ctx.get(AssetRepository);
    const movedPath = join(root, 'source', 'moved.jpg');
    const move = {
      moveId: randomUUID(),
      assetId: first.asset.id,
      pathType: AssetPathType.Original,
      from: first.path,
      source: first.path,
      to: movedPath,
    };
    const operations = {
      rename: async () => {
        await rename(first.path, movedPath);
        return true;
      },
      undo: () => rename(movedPath, first.path),
      finish: async () => {},
    };
    const { capture, queue } = fixture(async () => {
      expect(new Set((await references(run.runId)).map(({ path }) => path))).toEqual(
        new Set(expected.map(({ path }) => path)),
      );
      await db.transaction().execute(async (trx) => {
        const { rows } = await sql<{ available: boolean }>`
          SELECT pg_try_advisory_xact_lock(${BUDDY_CAPTURE_LOCK}::bigint) AS available`.execute(trx);
        expect(rows[0].available).toBe(true);
      });
      await expect(assets.moveFile(move, operations)).resolves.toBe('deferred');
      await assets.remove(
        { id: later.asset.id },
        {
          files: ({ originalPath }) => [originalPath],
          queue: (files) => queue({ name: JobName.FileDelete, data: { files } }),
        },
      );
      expect(queue).toHaveBeenCalledWith({ name: JobName.FileDelete, data: { files: [later.path] } });
      await expect(physical.deleteUnreferencedPath(later.path, () => unlink(later.path))).resolves.toEqual({
        deleted: false,
        references: 1,
      });
      expect(await readFile(later.path)).toEqual(later.bytes);
    });
    const result = await capture.capture(run);
    expect(result.manifest.cloudBackupKeys).toEqual([
      { fingerprint: keyFingerprint(cloudKey), content: cloudKeyContent },
    ]);
    const recorded = [
      ...Object.values(result.manifest.library.assets).flatMap(({ files }) => files),
      ...result.manifest.dependencies,
    ];
    for (const source of expected) {
      const entry = recorded.find(({ path }) => path === source.path);
      expect(entry, source.path).toBeDefined();
      expect(await restoreBytes(result, run.runId, entry!.sha256)).toEqual(source.bytes);
    }
    expect(result.manifest.library.assets[later.asset.id]).toBeDefined();
    expect(
      await db.selectFrom('asset').select('id').where('id', '=', later.asset.id).executeTakeFirst(),
    ).toBeUndefined();
    await capture.release(run.runId);
    await expect(assets.moveFile(move, operations)).resolves.toBe('moved');
    expect(await readFile(movedPath)).toEqual(first.bytes);
    const unavailable = options();
    await unlink(preview.path);
    await expect(capture.capture(unavailable)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await capture.readCapture(unavailable.runId)).toBeNull();
  }, 20_000);

  it('keeps concurrent Cloud setup outside the database view and refuses a missing claimed key', async () => {
    const key = randomBytes(32);
    const fingerprint = keyFingerprint(key);
    const content = JSON.stringify(
      backupKeyFile({ key, instanceId: randomUUID(), bucket: 'test', mode: 'server', createdAt: new Date() }),
    );
    const { capture, keys } = fixture(async (snapshot) => {
      await db
        .transaction()
        .setIsolationLevel('repeatable read')
        .execute(async (trx) => {
          await sql`SET TRANSACTION SNAPSHOT ${sql.lit(snapshot)}`.execute(trx);
          expect(
            await trx
              .selectFrom('system_metadata')
              .select('value')
              .where('key', '=', SystemMetadataKey.FrameleafCloudBackup)
              .executeTakeFirst(),
          ).toBeUndefined();
        });
    });
    await db.deleteFrom('system_metadata').where('key', '=', SystemMetadataKey.FrameleafCloudBackup).execute();
    const readAll = keys.readAll.bind(keys);
    vi.spyOn(keys, 'readAll').mockImplementationOnce(async (directory) => {
      const previous = await readAll(directory);
      await keys.write(directory, fingerprint, content);
      await sql`INSERT INTO system_metadata (key, value)
        VALUES (${SystemMetadataKey.FrameleafCloudBackup}, ${JSON.stringify({ keyMode: 'server', keyFingerprint: fingerprint })}::jsonb)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`.execute(db);
      return previous;
    });
    expect((await capture.capture(options())).manifest.cloudBackupKeys).toEqual([]);
    const next = fixture();
    expect((await next.capture.capture(options())).manifest.cloudBackupKeys).toEqual([{ fingerprint, content }]);
    await keys.remove(join(root, 'identity'), fingerprint);
    const missing = options();
    await expect(next.capture.capture(missing)).rejects.toThrow('Stored Cloud Backup recovery key is missing');
    expect(await next.capture.readCapture(missing.runId)).toBeNull();
  }, 20_000);

  it('reclaims an interrupted multi-block capture before capture.json exists', async () => {
    await original('large.jpg', Buffer.alloc(BUDDY_BLOCK_BYTES + 1, 7));
    const run = options();
    const { capture } = fixture();
    await db
      .insertInto('media_operation')
      .values({
        id: run.runId,
        ownerId,
        kind: MediaOperationKind.BuddyBackup,
        destination: MediaOperationDestination.Local,
        label: 'Interrupted Buddy capture',
        status: MediaOperationStatus.Preparing,
        snapshot: {},
        settings: {},
      })
      .execute();
    await expect(
      capture.capture({
        ...run,
        checkpoint: async () => {
          const staged = await readdir(join(capture.runDirectory(run.runId), 'blocks')).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') throw error;
              return [];
            },
          );
          if (staged.length > 0) throw new Error('Interrupted after staging a block');
        },
      }),
    ).rejects.toThrow('Interrupted after staging a block');
    expect(await capture.readCapture(run.runId)).toBeNull();
    const staged = await readdir(join(capture.runDirectory(run.runId), 'blocks'));
    expect(staged).toHaveLength(1);
    expect(await references(run.runId)).not.toHaveLength(0);
    await db
      .updateTable('media_operation')
      .set({ status: MediaOperationStatus.Failed })
      .where('id', '=', run.runId)
      .execute();
    await capture.reconcile();
    expect(await references(run.runId)).toEqual([]);
    await expect(readdir(capture.runDirectory(run.runId))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(join(repository.root(), 'nonces'))).toContain(staged[0]);
  }, 20_000);

  it('reconciles abandoned runs and retries the deletion outbox without releasing resumable claims', async () => {
    const { capture, backups, jobs, keys, queue } = fixture();
    const terminal: string[] = [];
    const retained: string[] = [];
    for (const [status, claimed] of [
      [MediaOperationStatus.Failed, false],
      [MediaOperationStatus.Cancelled, false],
      [MediaOperationStatus.Completed, false],
      [MediaOperationStatus.Paused, false],
      [MediaOperationStatus.Completed, true],
    ] as const) {
      const runId = randomUUID();
      await db
        .insertInto('media_operation')
        .values({
          id: runId,
          ownerId,
          kind: MediaOperationKind.BuddyBackup,
          destination: MediaOperationDestination.Local,
          label: 'Buddy cleanup fixture',
          status,
          claimToken: claimed ? randomUUID() : null,
          snapshot: {},
          settings: {},
        })
        .execute();
      (status === MediaOperationStatus.Paused || claimed ? retained : terminal).push(runId);
    }
    const missing = randomUUID();
    for (const runId of [...terminal, ...retained, missing]) {
      const source = await file(`${runId}.jpg`);
      await sql`INSERT INTO immich_fork.buddy_backup_reference ("runId", path)
        VALUES (${runId}::uuid, ${source.path})`.execute(db);
      await mkdir(join(capture.runDirectory(runId), 'blocks'), { recursive: true });
      await writeFile(join(capture.runDirectory(runId), 'blocks', 'partial'), 'interrupted staging');
    }
    // No DB row at all: directory discovery must also reclaim this crash before reference insertion.
    const directoryOnly = randomUUID();
    await mkdir(capture.runDirectory(directoryOnly), { recursive: true });
    const deferred = join(root, 'source', `${missing}.jpg`);
    await expect(physical.deleteUnreferencedPath(deferred, () => unlink(deferred))).resolves.toEqual({
      deleted: false,
      references: 1,
    });
    queue.mockRejectedValueOnce(new Error('queue unavailable'));
    await expect(capture.release(missing)).rejects.toThrow('queue unavailable');
    expect(await references(missing)).toEqual([{ path: deferred, released: true, deleteRequested: true }]);
    expect(await readFile(deferred)).toEqual(Buffer.from(`${missing}.jpg`));

    const restarted = new BuddyBackupCaptureService(repository, backups, jobs, keys);
    await restarted.reconcile();
    expect(queue.mock.calls).toEqual([
      [{ name: JobName.FileDelete, data: { files: [deferred] } }],
      [{ name: JobName.FileDelete, data: { files: [deferred] } }],
    ]);
    for (const runId of [...terminal, missing, directoryOnly]) {
      expect(await references(runId)).toEqual([]);
      await expect(readdir(capture.runDirectory(runId))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    for (const runId of retained) {
      expect(await references(runId)).toHaveLength(1);
      expect(await readdir(join(capture.runDirectory(runId), 'blocks'))).toEqual(['partial']);
    }
    // Execute the accepted FileDelete through its real reference guard; a duplicate delivery is safe.
    const remove = () => rm(deferred, { force: true });
    await expect(physical.deleteUnreferencedPath(deferred, remove)).resolves.toEqual({ deleted: true, references: 0 });
    await expect(physical.deleteUnreferencedPath(deferred, remove)).resolves.toEqual({ deleted: true, references: 0 });
    await expect(readFile(deferred)).rejects.toMatchObject({ code: 'ENOENT' });
    await restarted.reconcile();
    expect(queue).toHaveBeenCalledTimes(2);
  }, 20_000);

  it('restores only the exact owned derivative and refuses shared or Buddy-pinned outputs', async () => {
    const own = await original('own.jpg');
    const output = await file('own-edited.jpg');
    const stored = await physical.upsertPhysicalFile({
      canonicalAssetId: own.asset.id,
      checksum: createHash('sha256').update(output.bytes).digest(),
      path: output.path,
      sizeInBytes: output.bytes.length,
      type: PhysicalFileType.FullSize,
    });
    const derivative = { type: AssetFileType.FullSize, isEdited: true };
    await ctx.newAssetFile({
      assetId: own.asset.id,
      path: output.path,
      physicalFileId: stored.id,
      ...derivative,
    });
    const publish = () => writeFile(output.path, 'restored owned derivative');
    await expect(physical.withOwnerRestorePath(output.path, own.asset.id, ownerId, publish)).rejects.toThrow(
      'Owner restore destination unavailable',
    );
    await expect(
      physical.withOwnerRestorePath(output.path, own.asset.id, ownerId, publish, { ...derivative, isEdited: false }),
    ).rejects.toThrow('Owner restore destination unavailable');
    expect(await readFile(output.path)).toEqual(output.bytes);
    await physical.withOwnerRestorePath(output.path, own.asset.id, ownerId, publish, derivative);
    expect(await readFile(output.path, 'utf8')).toBe('restored owned derivative');

    // Retained history permits inspection/no-op restore but still forbids replacing shared bytes.
    await sql`INSERT INTO immich_fork.video_edit_version
      ("assetId", "ownerId", "sourcePath", "sourceChecksum", recipe, purpose, status, "masterPath", "proxyPath")
      VALUES (${own.asset.id}::uuid, ${ownerId}::uuid, ${own.path}, ${own.asset.checksum},
        '[]'::jsonb, 'save', 'ready', ${output.path}, ${output.path + '.proxy.mp4'})`.execute(db);
    await physical.inspectOwnerRestorePath(output.path, own.asset.id, ownerId, derivative);
    await expect(
      physical.withOwnerRestorePath(
        output.path,
        own.asset.id,
        ownerId,
        () => writeFile(output.path, 'must never replace retained history'),
        derivative,
      ),
    ).rejects.toThrow('Owner restore destination unavailable');
    await sql`DELETE FROM immich_fork.video_edit_version WHERE "assetId" = ${own.asset.id}::uuid`.execute(db);

    const other = await original('same-owner-other-asset.jpg');
    await ctx.newAssetFile({
      assetId: other.asset.id,
      path: output.path,
      physicalFileId: stored.id,
      ...derivative,
    });
    const overwrite = () => writeFile(output.path, 'must never publish');
    await expect(
      physical.withOwnerRestorePath(output.path, own.asset.id, ownerId, overwrite, derivative),
    ).rejects.toThrow('Owner restore destination unavailable');
    await ctx.get(AssetRepository).remove({ id: other.asset.id });
    await physical.withOwnerRestorePath(output.path, own.asset.id, ownerId, publish, derivative);
    await sql`INSERT INTO immich_fork.buddy_backup_reference ("runId", path)
      VALUES (${randomUUID()}::uuid, ${output.path})`.execute(db);
    await expect(
      physical.withOwnerRestorePath(output.path, own.asset.id, ownerId, overwrite, derivative),
    ).rejects.toThrow('Owner restore destination unavailable');
    expect(await readFile(output.path, 'utf8')).toBe('restored owned derivative');
  });
});
