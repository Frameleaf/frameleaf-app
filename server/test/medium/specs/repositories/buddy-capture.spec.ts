import { Kysely, sql } from 'kysely';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { BuddySettingsSchema } from 'src/dtos/buddy-backup.dto.js';
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
  UserMetadataKey,
} from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { BuddyBackupRepository, type BuddySettings } from 'src/repositories/buddy-backup.repository.js';
import { CloudBackupKeyRepository } from 'src/repositories/cloud-backup-key.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { InstanceIdentityRepository } from 'src/repositories/instance-identity.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { BUDDY_CAPTURE_LOCK, PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { BuddyBackupCaptureService, type BuddyCapture } from 'src/services/buddy-backup-capture.service.js';
import { BuddyBackupRecoveryService } from 'src/services/buddy-backup-recovery.service.js';
import { DatabaseBackupService } from 'src/services/database-backup.service.js';
import { BUDDY_BLOCK_BYTES, type BuddyKeyring, decryptBuddyBlock } from 'src/utils/buddy-backup-crypto.js';
import { buddyBackupCommand } from 'src/utils/buddy-backup-offline.js';
import { BuddyVault, buddySnapshotBytes } from 'src/utils/buddy-backup-vault.js';
import { backupKeyFile, keyFingerprint } from 'src/utils/cloud-backup.js';
import { checkStudioEnvelope, studioEnvelopeDigest } from 'src/utils/studio-project.js';
import { type MediumTestContext, newMediumService } from 'test/medium.factory.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { getKyselyDB } from 'test/utils.js';

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
    db = await getKyselyDB();
    ({ ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] }));
    ownerId = (await ctx.newUser()).user.id;
    const config = {
      getEnv: () =>
        mockEnvData({
          frameleafCloud: { ...mockEnvData({}).frameleafCloud, identityDir: join(root, 'identity') },
        }),
    } as ConfigRepository;
    repository = new BuddyBackupRepository(db, config);
    // Ordinary synthetic deployment identity, backed by an actual key in this test's private directory.
    // Recovery still reads the real database identity and captures its authority under C1.
    await new SystemMetadataRepository(db).set(
      SystemMetadataKey.FrameleafInstance,
      await new InstanceIdentityRepository().loadOrCreate(join(root, 'identity'), null),
    );
    physical = new PhysicalFileRepository(db);
    ring = { version: 1, vaultId: randomUUID(), current: 1, keys: { 1: randomBytes(32).toString('base64url') } };
    settings = {
      directory: join(root, 'vault'),
      quotaBytes: 20 * 1024 ** 3,
      uploadMbps: 10,
      downloadMbps: 10,
      schedule: '0 2 * * *',
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
        SELECT path, released, "deleteRequested" FROM public.buddy_backup_reference
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

  const derivedFixture = async () => {
    const video = await original('derived-video.mov', undefined, AssetType.Video);
    await mkdir(join(root, 'source', '.attempts', 'accepted-claim'), { recursive: true });
    const duplicate = await file('.attempts/accepted-claim/duplicate.jpg');
    const moment = await file('.attempts/accepted-claim/moment.jpg');
    const thumbnail = await file('.attempts/accepted-claim/person.jpg');
    const { person } = await ctx.newPerson({ ownerId });
    await db
      .updateTable('person')
      .set({ thumbnailPath: thumbnail.path })
      .where('ownerId', '=', ownerId)
      .where('personGroupId', '=', person.personGroupId)
      .execute();
    await db
      .insertInto('asset_video_duplicate_frame')
      .values({
        assetId: video.asset.id,
        frameIndex: 0,
        timestampMs: 1000,
        path: duplicate.path,
        embedding: `[${Array.from({ length: 512 }, () => 0).join(',')}]`,
      })
      .execute();
    await db
      .insertInto('video_moment_frame')
      .values({
        assetId: video.asset.id,
        frameIndex: 0,
        timestampMs: 1000,
        path: moment.path,
        width: 100,
        height: 80,
        score: 0.8,
        rank: 1,
      })
      .execute();
    return { video, person, duplicate, moment, thumbnail };
  };

  it('pins and encrypts canonical frame and owner-person paths, including accepted .attempts outputs', async () => {
    const own = await derivedFixture();
    const owner = await db
      .selectFrom('user')
      .select('clusterGroupId')
      .where('id', '=', ownerId)
      .executeTakeFirstOrThrow();
    const { user: other } = await ctx.newUser({ clusterGroupId: owner.clusterGroupId });
    const otherThumbnail = await file('other-owner-person.jpg');
    await ctx.newPerson({ ownerId: other.id, personGroupId: own.person.personGroupId });
    await db
      .updateTable('person')
      .set({ thumbnailPath: otherThumbnail.path })
      .where('ownerId', '=', other.id)
      .where('personGroupId', '=', own.person.personGroupId)
      .execute();
    const otherOriginal = await file('other-owner-video.mov');
    const { asset: otherAsset } = await ctx.newAsset({
      ownerId: other.id,
      type: AssetType.Video,
      originalPath: otherOriginal.path,
      checksum: createHash('sha256').update(otherOriginal.bytes).digest(),
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
    });
    const otherFrame = await file('other-owner-moment.jpg');
    await db
      .insertInto('video_moment_frame')
      .values({
        assetId: otherAsset.id,
        frameIndex: 0,
        timestampMs: 1000,
        path: otherFrame.path,
        width: 100,
        height: 80,
        score: 0.5,
        rank: 1,
      })
      .execute();
    settings.includeDerived = true;
    const run = options();
    const { capture } = fixture(async () => {
      const pinned = (await references(run.runId)).map((row) => row.path);
      expect(pinned).toEqual(
        expect.arrayContaining([
          own.duplicate.path,
          own.moment.path,
          own.thumbnail.path,
          otherThumbnail.path,
          otherFrame.path,
        ]),
      );
    });
    const result = await capture.capture(run);
    expect(result.derivedInventoryVersion).toBe(1);
    const ownedFiles = result.manifest.library.assets[own.video.asset.id].files;
    expect(ownedFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: own.duplicate.path, role: 'video-duplicate-frame' }),
        expect.objectContaining({ path: own.moment.path, role: 'video-moment-frame' }),
      ]),
    );
    expect(
      ownedFiles.some((entry) => [otherFrame.path, own.thumbnail.path, otherThumbnail.path].includes(entry.path)),
    ).toBe(false);
    expect(result.manifest.library.assets[otherAsset.id]).toMatchObject({
      owner: other.id,
      files: expect.arrayContaining([expect.objectContaining({ path: otherFrame.path, role: 'video-moment-frame' })]),
    });
    expect(result.manifest.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: own.thumbnail.path, role: 'person-thumbnail' }),
        expect.objectContaining({ path: otherThumbnail.path, role: 'person-thumbnail' }),
      ]),
    );
    const inventory = [
      ...Object.values(result.manifest.library.assets).flatMap((asset) => asset.files),
      ...result.manifest.dependencies,
    ];
    for (const source of [own.duplicate, own.moment, own.thumbnail, otherThumbnail, otherFrame]) {
      const entry = inventory.find((entry) => entry.path === source.path)!;
      expect(await restoreBytes(result, run.runId, entry.sha256)).toEqual(source.bytes);
    }
    await capture.release(run.runId);
  });

  it.each(['duplicate', 'moment', 'thumbnail'] as const)(
    'refuses a missing selected %s rather than publishing an incomplete derived inventory',
    async (kind) => {
      const source = await derivedFixture();
      await unlink(source[kind].path);
      settings.includeDerived = true;
      const run = options();
      const { capture, backups } = fixture();
      await expect(capture.capture(run)).rejects.toThrow('A selected Buddy derived file is missing');
      expect(backups.createDatabaseBackup).not.toHaveBeenCalled();
      expect(await capture.readCapture(run.runId)).toBeNull();
      // Excluding regenerable caches does not read or pin those paths, even if a cached row remains.
      settings.includeDerived = false;
      const excludedRun = options();
      const excluded = await capture.capture(excludedRun);
      const paths = [
        ...Object.values(excluded.manifest.library.assets).flatMap((asset) => asset.files),
        ...excluded.manifest.dependencies,
      ].map((entry) => entry.path);
      for (const file of [source.duplicate, source.moment, source.thumbnail]) expect(paths).not.toContain(file.path);
      expect((await references(excludedRun.runId)).map((entry) => entry.path)).not.toContain(source[kind].path);
      await capture.release(excludedRun.runId);
    },
  );

  it('rejects a person thumbnail that would include the Buddy vault in its own backup', async () => {
    const source = await derivedFixture();
    const privatePath = join(root, 'vault', 'private-ciphertext');
    await writeFile(privatePath, 'must not include');
    await db
      .updateTable('person')
      .set({ thumbnailPath: privatePath })
      .where('ownerId', '=', ownerId)
      .where('personGroupId', '=', source.person.personGroupId)
      .execute();
    settings.includeDerived = true;
    const { capture, backups } = fixture();
    const run = options();
    await expect(capture.capture(run)).rejects.toThrow('A backup contains a Buddy vault or server identity files');
    expect(backups.createDatabaseBackup).not.toHaveBeenCalled();
    expect(await capture.readCapture(run.runId)).toBeNull();
  });

  it('does not resume a pre-fix derived capture as a complete inventory', async () => {
    await derivedFixture();
    settings.includeDerived = true;
    const { capture } = fixture();
    const run = options();
    const completed = await capture.capture(run);
    delete completed.derivedInventoryVersion;
    const previous = JSON.stringify(completed);
    const path = join(capture.runDirectory(run.runId), 'capture.json');
    await writeFile(path, previous);
    await expect(capture.capture(run)).rejects.toThrow('Start a new backup');
    expect(await readFile(path, 'utf8')).toBe(previous);
    await capture.release(run.runId);
  });

  it('writes owner-specific people and empty album structure into the encrypted source manifest', async () => {
    const own = await original('own-person.jpg');
    const owner = await db
      .selectFrom('user')
      .select('clusterGroupId')
      .where('id', '=', ownerId)
      .executeTakeFirstOrThrow();
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
      ownerId,
      kind: AlbumKind.Collection,
      albumName: 'Empty collection',
    });
    const { album: child } = await ctx.newAlbum({
      ownerId,
      parentId: collection.id,
      icon: 'camera',
      sortOrder: 3,
      albumName: 'Empty child',
    });
    const { capture } = fixture();
    const run = options();
    const result = await capture.capture(run);
    expect(result.manifest.metadata?.peopleByOwner[ownerId][person.personGroupId].name).toBe('Own name');
    expect(result.manifest.metadata?.peopleByOwner[other.id][person.personGroupId].name).toBe('Other name');
    expect(result.manifest.metadata?.albums[child.id]).toMatchObject({
      ownerId,
      parentId: collection.id,
      kind: 'album',
      icon: 'camera',
      sortOrder: 3,
      sharedUsers: [],
    });
    expect(result.manifest.library.assets[own.asset.id].owner).toBe(ownerId);
    expect(result.manifest.library.assets[otherAsset.id].owner).toBe(other.id);
    await capture.release(run.runId);
  });

  it('captures unanchored Studio documents and their pinned imports from the same exported database snapshot', async () => {
    const source = await file('captions.srt', Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nSnapshot words\n'));
    const project = await db
      .insertInto('studio_project')
      .values({ ownerId, name: 'Snapshot project', currentRevision: 1 })
      .returningAll()
      .executeTakeFirstOrThrow();
    const empty = await db
      .insertInto('studio_project')
      .values({ ownerId, name: 'Metadata-only project' })
      .returningAll()
      .executeTakeFirstOrThrow();
    const importId = randomUUID();
    const envelope = {
      schemaVersion: 1,
      engine: 'freecut',
      engineRevision: 'fixture',
      graph: { captionsImportId: importId },
    };
    const checked = checkStudioEnvelope(envelope);
    if (!checked.ok) throw new Error(checked.detail);
    const saved = await db
      .insertInto('studio_project_revision')
      .values({
        projectId: project.id,
        revision: 1,
        authorId: ownerId,
        envelope,
        digest: studioEnvelopeDigest(envelope),
        graphBytes: checked.graphBytes,
        summary: {},
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const checksum = createHash('sha256').update(source.bytes).digest('hex');
    await sql`INSERT INTO public.studio_project_import
      ("projectId",id,"ownerId","contentType",checksum,"sizeBytes",path,"fileName","externalReferences")
      VALUES (${project.id}::uuid,${importId}::uuid,${ownerId}::uuid,'application/x-subrip',${checksum},
        ${source.bytes.length},${source.path},'captions.srt',NULL)`.execute(db);
    const input = options();
    const { capture, queue } = fixture(async () => {
      expect((await references(input.runId)).map((row) => row.path)).toContain(source.path);
      // The live project disappears after the export. Its retained file cannot disappear while
      // that same snapshot is being encrypted, and the deletion intent remains durable.
      await db.deleteFrom('studio_project').where('id', '=', project.id).execute();
      const remove = vi.fn(async () => unlink(source.path));
      expect(
        (
          await physical.deleteUnreferencedPath(source.path, remove, {
            orphanStudioImport: {
              projectId: project.id,
              id: importId,
              ownerId,
              checksum,
              sizeBytes: source.bytes.length,
            },
          })
        ).deleted,
      ).toBe(false);
      expect(remove).not.toHaveBeenCalled();
      await db.updateTable('studio_project').set({ name: 'Changed after export' }).where('id', '=', empty.id).execute();
    });
    const result = await capture.capture(input);
    const captured = result.manifest.studio!.projects[project.id];
    expect(captured).toMatchObject({
      name: 'Snapshot project',
      currentRevision: 1,
      revisions: [expect.objectContaining({ id: saved.id, digest: saved.digest })],
      imports: [expect.objectContaining({ id: importId, path: source.path, checksum })],
    });
    expect(result.manifest.studio!.projects[empty.id]).toMatchObject({
      name: 'Metadata-only project',
      currentRevision: 0,
    });
    expect(await restoreBytes(result, input.runId, checksum)).toEqual(source.bytes);
    queue.mockRejectedValueOnce(new Error('Queue unavailable'));
    await expect(capture.release(input.runId)).rejects.toThrow('Queue unavailable');
    expect((await references(input.runId)).filter((row) => row.path === source.path)).toEqual([
      expect.objectContaining({ released: true, deleteRequested: true }),
    ]);
    await capture.release(input.runId);
    expect(queue).toHaveBeenCalledWith(
      expect.objectContaining({ name: JobName.FileDelete, data: { files: [source.path] } }),
    );
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
    await sql`INSERT INTO public.asset_develop_revision
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
    await sql`INSERT INTO public.video_edit_version
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
      // This update commits after pg_export_snapshot(). Capture must retain the old version
      // metadata alongside the dump, even though it reads the per-asset records afterwards.
      await sql`UPDATE public.asset_develop_revision SET label='After snapshot'
        WHERE "assetId"=${first.asset.id}::uuid`.execute(db);
    });
    const result = await capture.capture(run);
    expect(result.manifest.cloudBackupKeys).toEqual([
      { fingerprint: keyFingerprint(cloudKey), content: cloudKeyContent },
    ]);
    expect(result.manifest.assetFidelity?.[first.asset.id].developRevisions[0]).toMatchObject({
      kind: 'external',
      status: 'rendered',
      label: null,
      masterPath: developed.path,
      previewPath: developedPreview.path,
    });
    expect(result.manifest.assetFidelity?.[first.asset.id].restorations[0]).toMatchObject({
      status: 'restored',
      resultPath: restored.path,
      resultPreviewPath: preview.path,
    });
    expect(result.manifest.assetFidelity?.[video.asset.id].files.map((file) => file.path)).toEqual(
      expect.arrayContaining([master.path, proxy.path, lineage.path]),
    );
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
        VALUES (${SystemMetadataKey.FrameleafCloudBackup}, ${JSON.stringify({ keyMode: 'server', keyFingerprint: fingerprint })}::text::jsonb)
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

  it('round-trips settings and replacement identity metadata as JSON objects through PostgreSQL', async () => {
    const recoveryConfig = { enabled: true, sequence: [1, 2] };
    const system = { server: { welcomeMessage: 'Recovered library' }, frameleafCloud: recoveryConfig };
    const preferences = { folders: { enabled: true }, tags: ['one', 'two'] };
    await sql`INSERT INTO system_metadata (key, value)
      VALUES (${SystemMetadataKey.SystemConfig}, ${JSON.stringify(system)}::text::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`.execute(db);
    await sql`INSERT INTO user_metadata ("userId", key, value)
      VALUES (${ownerId}::uuid, ${UserMetadataKey.Preferences}, ${JSON.stringify(preferences)}::text::jsonb)`.execute(
      db,
    );

    const { capture, backups, keys } = fixture();
    const input = options();
    const captured = await capture.capture(input);
    const { manifest } = captured;
    await repository.update((state) => ({ ...state, settings }));
    const recovery = new BuddyBackupRecoveryService(
      repository,
      { getEnv: () => ({}) } as unknown as ConfigRepository,
      backups,
      keys,
    );
    const id = randomUUID();
    const directory = join(repository.root(), 'recovery', id);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'prepared.json'),
      JSON.stringify({ version: 1, scope: 'settings', mode: 'replace', manifest, files: [] }),
    );
    await sql`UPDATE system_metadata SET value = '{}'::jsonb WHERE key = ${SystemMetadataKey.SystemConfig}`.execute(db);
    await sql`UPDATE user_metadata SET value = '{}'::jsonb WHERE "userId" = ${ownerId}::uuid`.execute(db);

    await recovery.settings(id, async () => {});
    expect(
      (
        await db
          .selectFrom('system_metadata')
          .select('value')
          .where('key', '=', SystemMetadataKey.SystemConfig)
          .executeTakeFirstOrThrow()
      ).value,
    ).toEqual(system);
    expect(
      (
        await db
          .selectFrom('user_metadata')
          .select('value')
          .where('userId', '=', ownerId)
          .where('key', '=', UserMetadataKey.Preferences)
          .executeTakeFirstOrThrow()
      ).value,
    ).toEqual(preferences);

    const serverId = randomUUID();
    const serverDirectory = join(repository.root(), 'recovery', serverId);
    await mkdir(serverDirectory, { recursive: true });
    await writeFile(
      join(serverDirectory, 'prepared.json'),
      JSON.stringify({ version: 1, scope: 'server', mode: 'replace', manifest, files: [] }),
    );
    const replacement = {
      status: 'unlinked' as const,
      cloudUrl: 'https://synthetic-replacement.invalid',
      instanceId: randomUUID(),
      heartbeat: { failures: 0, cloneSuspected: false },
    };
    await new SystemMetadataRepository(db).set(SystemMetadataKey.FrameleafCloudLink, replacement);
    const dump = manifest.library.database!;
    await writeFile(join(serverDirectory, 'database.sql.gz'), await restoreBytes(captured, input.runId, dump.sha256));
    backups.verifyDatabaseBackup = vi.fn<DatabaseBackupService['verifyDatabaseBackup']>().mockResolvedValue();
    await recovery.prepare(serverId, async () => {});
    const maintenance = {
      isMaintenanceMode: true,
      action: { restoreBackupFilename: `buddy-restore-${serverId}-${basename(manifest.library.database!.key)}` },
    };
    // The dump importer is outside this case; exercise the real post-import metadata transaction.
    await recovery.restore(
      serverId,
      async () => {},
      maintenance as never,
      async () => {},
    );
    expect(
      (
        await db
          .selectFrom('system_metadata')
          .select('value')
          .where('key', '=', SystemMetadataKey.FrameleafCloudLink)
          .executeTakeFirstOrThrow()
      ).value,
    ).toEqual(replacement);
    expect(
      (
        await db
          .selectFrom('system_metadata')
          .select('value')
          .where('key', '=', SystemMetadataKey.MaintenanceMode)
          .executeTakeFirstOrThrow()
      ).value,
    ).toEqual(maintenance);
  }, 20_000);

  it.each([
    { scope: 'settings', mode: 'keep' },
    { scope: 'settings', mode: 'replace' },
    { scope: 'server', mode: 'keep' },
    { scope: 'server', mode: 'replace' },
  ] as const)(
    'captures all Buddy settings and safely recovers $scope with $mode',
    async ({ scope, mode }) => {
      const sourceConfig = await file('source.conf');
      const destinationConfig = await file('destination.conf');
      settings = {
        ...settings,
        quotaBytes: 60 * 1024 ** 3,
        uploadMbps: 7,
        downloadMbps: 9,
        schedule: '0 4 * * *',
        timezone: 'America/Edmonton',
        windowStart: '02:00',
        windowEnd: '07:00',
        pausedReceiving: true,
        includeDerived: true,
        configurationFiles: [sourceConfig.path],
      };
      const { capture, backups, keys } = fixture();
      const input = options();
      const captured = await capture.capture(input);
      const { manifest } = captured;
      expect(manifest.settings.buddy).toEqual({ version: 1, settings });
      const destination = {
        ...settings,
        directory: join(root, 'replacement-vault'),
        quotaBytes: 20 * 1024 ** 3,
        uploadMbps: 31,
        downloadMbps: 32,
        schedule: '0 2 * * *',
        timezone: 'UTC',
        windowStart: '00:00',
        windowEnd: '00:00',
        pausedSending: true,
        pausedReceiving: false,
        includeDerived: false,
        configurationFiles: [destinationConfig.path],
      };
      await mkdir(destination.directory);
      const authority = {
        pairing: { pairId: randomUUID(), state: 'blocked' } as never,
        recoveryVerified: false,
        probeVerified: false,
        lastSequence: 42,
      };
      await repository.update((state) => ({ ...state, settings: destination, ...authority }));
      const identity = join(root, 'identity', 'instance-key.pem');
      const grants = join(repository.root(), 'grant.json');
      const replacementKey = await readFile(identity);
      await writeFile(grants, 'replacement grant');
      const recovery = new BuddyBackupRecoveryService(
        repository,
        { getEnv: () => ({}) } as unknown as ConfigRepository,
        backups,
        keys,
      );
      const id = randomUUID();
      const directory = join(repository.root(), 'recovery', id);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, 'prepared.json'),
        JSON.stringify({ version: 1, scope, mode, manifest, files: [] }),
      );
      if (scope === 'server') {
        // Use the real preimage writer: an empty key list is never produced by server preparation.
        const dump = manifest.library.database!;
        const staged = join(directory, 'database.sql.gz');
        await writeFile(staged, await restoreBytes(captured, input.runId, dump.sha256));
        // The fixture's dump process supplies synthetic bytes; prepare still verifies their hash and size.
        backups.verifyDatabaseBackup = vi.fn<DatabaseBackupService['verifyDatabaseBackup']>().mockResolvedValue();
        expect(await recovery.prepare(id, async () => {})).toBe(`buddy-restore-${id}-${basename(dump.key)}`);
        expect(backups.verifyDatabaseBackup).toHaveBeenCalledWith(staged);
        const replacement = JSON.parse(await readFile(join(directory, 'replacement.json'), 'utf8'));
        expect(replacement.keys).toEqual(
          expect.arrayContaining([
            SystemMetadataKey.FrameleafInstance,
            SystemMetadataKey.FrameleafServerId,
            SystemMetadataKey.FrameleafCloudLink,
          ]),
        );
      }
      const restore = vi.fn(async () => {});
      const run = () =>
        scope === 'settings'
          ? recovery.settings(id, async () => {})
          : recovery.restore(
              id,
              restore,
              {
                isMaintenanceMode: true,
                action: { restoreBackupFilename: `buddy-restore-${id}-${basename(manifest.library.database!.key)}` },
              } as never,
              async () => {},
            );
      if (mode === 'replace') {
        vi.spyOn(repository, 'locked').mockRejectedValueOnce(new Error('interrupted local settings write'));
        await expect(run()).rejects.toThrow('interrupted local settings write');
        expect(JSON.parse(await readFile(join(directory, 'publication.json'), 'utf8')).state).toBe('database-ready');
      }
      await run();
      const restored = await repository.state();
      expect(restored).toMatchObject(authority);
      expect(restored.settings).toEqual(
        mode === 'keep'
          ? destination
          : {
              ...settings,
              directory: destination.directory,
              quotaBytes: destination.quotaBytes,
              configurationFiles: destination.configurationFiles,
              pausedSending: true,
            },
      );
      expect(await readFile(identity)).toEqual(replacementKey);
      expect(await readFile(grants, 'utf8')).toBe('replacement grant');
      await repository.update((state) => ({ ...state, settings: { ...state.settings!, uploadMbps: 333 } }));
      await run();
      expect((await repository.state()).settings!.uploadMbps).toBe(333);
      expect(restore).toHaveBeenCalledTimes(scope === 'server' ? 1 : 0);
    },
    20_000,
  );

  it('rejects invalid Buddy capture preferences before pinning or staging backup files', async () => {
    const { capture, backups } = fixture();
    for (const invalid of [{ uploadMbps: 0 }, { schedule: 'manual' }]) {
      const run = options();
      await expect(capture.capture({ ...run, settings: { ...settings, ...invalid } })).rejects.toThrow();
      expect(await references(run.runId)).toEqual([]);
      expect(await capture.readCapture(run.runId)).toBeNull();
    }
    expect(backups.createDatabaseBackup).not.toHaveBeenCalled();
  });

  it('captures only declared typed boot inputs and stages them privately after loss of the original server', async () => {
    const declaration = {
      version: 1,
      environmentKeys: [
        'FRAMELEAF_PORT',
        'DB_PASSWORD',
        'FRAMELEAF_IMPORT_ROOTS',
        'FRAMELEAF_EDGE_SECRET',
        'FRAMELEAF_IDENTITY_DIR',
      ],
    };
    const checked = BuddySettingsSchema.safeParse({ ...settings, bootConfiguration: declaration });
    // A valid declaration must enter through the real settings contract, never a cast or schema bypass.
    expect(checked.success).toBe(true);
    if (!checked.success) throw new Error('Declared boot configuration was rejected');
    const secret = randomBytes(32).toString('base64url');
    const undeclared = randomBytes(32).toString('base64url');
    vi.stubEnv('FRAMELEAF_PORT', '2284');
    vi.stubEnv('DB_PASSWORD', secret);
    vi.stubEnv('FRAMELEAF_EDGE_SECRET', secret);
    vi.stubEnv('FRAMELEAF_IMPORT_ROOTS', ' /synthetic/import-one, /synthetic/import-two ');
    vi.stubEnv('BUDDY_UNDECLARED_FIXTURE', undeclared);
    vi.stubEnv('NODE_OPTIONS', 'forbidden-runtime-fixture');
    const historicalIdentity = join(root, 'forbidden-historical-identity');
    vi.stubEnv('FRAMELEAF_IDENTITY_DIR', historicalIdentity);
    const media = await original('declared-boot.jpg');
    const run = { ...options(), settings: checked.data };
    const { capture } = fixture();
    const captured = await capture.capture(run);
    expect(JSON.stringify(captured.manifest).includes(undeclared)).toBe(false);
    const vaultRoot = join(root, 'encrypted-source');
    const vault = new BuddyVault(vaultRoot, ring.vaultId);
    const capacity = { quotaBytes: 20 * 1024 ** 3, freeBytes: 100e9, totalBytes: 200e9 };
    for (const receipt of captured.objects)
      await vault.put(receipt, await readFile(capture.blockPath(receipt.id, run.runId)), capacity);
    const now = Date.now();
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const jwk = publicKey.export({ format: 'jwk' });
    if (!jwk.x) throw new Error('Fixture signing key is missing its public coordinate');
    const snapshot = {
      version: 1 as const,
      vaultId: ring.vaultId,
      id: captured.manifest.snapshotId,
      sequence: 1,
      previous: null,
      keyVersion: ring.current,
      createdAt: new Date(now).toISOString(),
      retainUntil: new Date(now + 31 * 86_400_000).toISOString(),
      objects: captured.objects,
      manifest: captured.manifestBlocks,
    };
    await vault.commit(
      { snapshot, signature: sign(null, buddySnapshotBytes(snapshot), privateKey).toString('base64url') },
      { kty: 'OKP', crv: 'Ed25519', x: jwk.x },
      now,
      capacity,
    );
    const kit = join(root, 'independent-kit.json');
    await writeFile(kit, JSON.stringify(ring), { mode: 0o600 });
    const exported = join(root, 'exported');
    await buddyBackupCommand(['export', '--vault', join(vaultRoot, ring.vaultId), '--output', exported]);
    await rm(vaultRoot, { recursive: true });
    await rm(join(root, 'source'), { recursive: true });
    await rm(join(root, 'identity'), { recursive: true });
    const output = join(root, 'replacement-stage');
    await buddyBackupCommand(['recover', '--vault', join(exported, ring.vaultId), '--kit', kit, '--output', output]);
    const directory = join(output, 'recovery', snapshot.id);
    const artifact = JSON.parse(await readFile(join(directory, 'boot-configuration.json'), 'utf8'));
    expect(artifact.version).toBe(1);
    expect(artifact.snapshotId).toBe(snapshot.id);
    expect((await stat(join(directory, 'boot-configuration.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect(artifact.entries.map((entry: { key: string }) => entry.key).sort()).toEqual([
      'DB_PASSWORD',
      'FRAMELEAF_EDGE_SECRET',
      'FRAMELEAF_IDENTITY_DIR',
      'FRAMELEAF_IMPORT_ROOTS',
      'FRAMELEAF_PORT',
    ]);
    const rootsEntry = artifact.entries.find((entry: { key: string }) => entry.key === 'FRAMELEAF_IMPORT_ROOTS');
    expect(rootsEntry).toEqual({
      key: 'FRAMELEAF_IMPORT_ROOTS',
      state: 'value',
      value: ['/synthetic/import-one', '/synthetic/import-two'],
    });
    const portEntry = artifact.entries.find((entry: { key: string }) => entry.key === 'FRAMELEAF_PORT');
    expect(portEntry?.state === 'value' && portEntry.value === 2284).toBe(true);
    const secretEntry = artifact.entries.find((entry: { key: string }) => entry.key === 'DB_PASSWORD');
    // Boolean assertions keep synthetic secret values out of failed-test diagnostics.
    expect(secretEntry?.state === 'value' && secretEntry.value === secret).toBe(true);
    const edgeEntry = artifact.entries.find((entry: { key: string }) => entry.key === 'FRAMELEAF_EDGE_SECRET');
    expect(edgeEntry?.state === 'value' && edgeEntry.value === secret).toBe(true);
    expect(artifact.entries.find((entry: { key: string }) => entry.key === 'FRAMELEAF_IDENTITY_DIR')).toEqual({
      key: 'FRAMELEAF_IDENTITY_DIR',
      state: 'value',
      value: historicalIdentity,
    });
    expect(JSON.stringify(artifact).includes(undeclared)).toBe(false);
    const prepared = JSON.parse(await readFile(join(directory, 'prepared.json'), 'utf8'));
    expect(prepared.manifest.bootConfiguration.version).toBe(1);
    expect(JSON.stringify(prepared.manifest.bootConfiguration.entries) === JSON.stringify(artifact.entries)).toBe(true);
    expect(
      Object.keys(prepared.manifest.environment ?? {}).every((key) => declaration.environmentKeys.includes(key)),
    ).toBe(true);
    await expect(readFile(media.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(historicalIdentity, 'instance-key.pem'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(process.env.FRAMELEAF_PORT).toBe('2284');
    expect(process.env.DB_PASSWORD === secret).toBe(true);
    expect(process.env.FRAMELEAF_EDGE_SECRET === secret).toBe(true);
    expect(process.env.FRAMELEAF_IDENTITY_DIR).toBe(historicalIdentity);
    expect(process.env.BUDDY_UNDECLARED_FIXTURE === undeclared).toBe(true);
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
      await sql`INSERT INTO public.buddy_backup_reference ("runId", path)
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
    await sql`INSERT INTO public.video_edit_version
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
    await sql`DELETE FROM public.video_edit_version WHERE "assetId" = ${own.asset.id}::uuid`.execute(db);

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
    await sql`INSERT INTO public.buddy_backup_reference ("runId", path)
      VALUES (${randomUUID()}::uuid, ${output.path})`.execute(db);
    await expect(
      physical.withOwnerRestorePath(output.path, own.asset.id, ownerId, overwrite, derivative),
    ).rejects.toThrow('Owner restore destination unavailable');
    expect(await readFile(output.path, 'utf8')).toBe('restored owned derivative');
  });
});
