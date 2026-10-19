import { Kysely, sql } from 'kysely';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetLockReason, AssetType, AssetVisibility, ChecksumAlgorithm } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhysicalFileTrashRepository } from 'src/repositories/physical-file-trash.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { IntegrityService } from 'src/services/integrity.service.js';
import { PhysicalFileTrashService } from 'src/services/physical-file-trash.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB, newTestService } from 'test/utils.js';

let database: Kysely<DB>;
const directories: string[] = [];

beforeAll(async () => {
  database = await getKyselyDB();
  StorageCore.setMediaLocation('/data');
});

afterAll(async () => {
  StorageCore.reset();
  await database?.destroy();
});

afterEach(async () => {
  await sql`DELETE FROM public.physical_file_trash`.execute(database);
  for (const directory of directories) {
    await rm(directory, { recursive: true, force: true });
  }
  directories.length = 0;
  StorageCore.setMediaLocation('/data');
});

const setup = async () => {
  const { sut, ctx } = newMediumService(PhysicalFileTrashService, {
    database,
    real: [AssetRepository, PhysicalFileRepository, PhysicalFileTrashRepository, UserRepository],
    mock: [CryptoRepository, EventRepository, JobRepository, LoggingRepository, StorageRepository],
  });
  const { user } = await ctx.newUser();
  const directory = await mkdtemp(join(tmpdir(), 'frameleaf-trash-restore-'));
  directories.push(directory);
  StorageCore.setMediaLocation(directory);
  const id = randomUUID();
  const path = join(directory, 'original.jpg');
  const bytes = randomBytes(128);
  const checksum = createHash('sha256').update(bytes).digest();
  await writeFile(path, bytes);
  await sql`INSERT INTO public.physical_file_trash
    (id, path, checksum, "sizeInBytes", "lastOwnerId", "originalFileName")
    VALUES (${id}::uuid, ${path}, ${checksum}, ${bytes.length}, ${user.id}::uuid, 'original.jpg')`.execute(database);
  const trash = ctx.get(PhysicalFileTrashRepository);
  const entry = (await trash.getById(id))!;
  const storage = ctx.getMock(StorageRepository);
  storage.mkdirSync.mockImplementation((path) => {
    mkdirSync(path, { recursive: true });
  });
  storage.rename.mockImplementation(rename);
  storage.stat.mockImplementation((path) => stat(path));
  ctx.getMock(CryptoRepository).randomUUID.mockImplementation(randomUUID);
  ctx.getMock(JobRepository).queue.mockResolvedValue();
  ctx.getMock(EventRepository).emit.mockResolvedValue();
  return { sut, ctx, storage, trash, entry, bytes, user };
};

// FL-412: a stored file is stood in for by its path: proven to hold the content, with a fixed identity
const ownerAuth = (ownerId: string) => ({
  ...authStub.adminWithElevatedPermission,
  user: { ...authStub.admin.user, id: ownerId },
});
const onDisk = (path: string) => Promise.resolve(`identity:${path}`);

const setupMotionTrash = async (locked = true) => {
  const fixture = await setup();
  const { ctx, entry, user } = fixture;
  const { asset: motion } = await ctx.newAsset({
    ownerId: user.id,
    type: AssetType.Video,
    visibility: AssetVisibility.Hidden,
    checksum: entry.checksum,
    originalPath: `/data/upload/${randomUUID()}.mp4`,
  });
  const { asset: photo } = await ctx.newAsset({
    ownerId: user.id,
    livePhotoVideoId: motion.id,
    originalPath: `/data/upload/${randomUUID()}.jpg`,
  });
  if (locked) {
    await database
      .insertInto('asset_lock')
      .values({ assetId: photo.id, reason: AssetLockReason.Marked, lockedBy: user.id })
      .execute();
  }
  await sql`UPDATE public.physical_file_trash SET "lastAssetId"=${motion.id}::uuid WHERE id=${entry.id}::uuid`.execute(
    database,
  );
  return { ...fixture, motion, photo };
};

describe(PhysicalFileTrashService.name, () => {
  it('keeps an active motion original private when its still supplies the lock', async () => {
    const { entry, trash } = await setupMotionTrash();
    await expect(trash.getById(entry.id)).resolves.toMatchObject({ wasLocked: true });
  });
  it('retains the deleted still lock while the motion deletion remains queued', async () => {
    const { sut, ctx, entry, user, trash, bytes, storage, photo, motion } = await setupMotionTrash();
    const assets = ctx.get(AssetRepository);
    await assets.remove({ id: photo.id });
    await expect(
      database.selectFrom('asset_backup_deletion').selectAll().where('assetId', '=', photo.id).executeTakeFirst(),
    ).resolves.toMatchObject({ ownerId: user.id, livePhotoVideoId: motion.id, wasLocked: true, evidenceVersion: 1 });
    await expect(
      database.selectFrom('asset_lock').selectAll().where('assetId', '=', motion.id).execute(),
    ).resolves.toEqual([]);
    await expect(trash.getById(entry.id)).resolves.toMatchObject({ wasLocked: true });
    const ordinary = { ...authStub.admin, user: { ...authStub.admin.user, id: user.id } };
    for (const auth of [ordinary, ownerAuth(randomUUID())]) {
      await expect(sut.list(auth, { page: 1, size: 100 })).resolves.toMatchObject({
        items: [],
        total: 0,
        totalBytes: 0,
      });
      await expect(sut.purge(auth, entry.id)).rejects.toThrow('File not found');
      await expect(sut.restore(auth, entry.id)).rejects.toThrow('File not found');
    }
    expect(storage.rename).not.toHaveBeenCalled();
    expect(storage.unlink).not.toHaveBeenCalled();
    await expect(readFile(entry.path)).resolves.toEqual(bytes);
    await expect(sut.list(ownerAuth(user.id), { page: 1, size: 100 })).resolves.toMatchObject({
      items: [expect.objectContaining({ id: entry.id })],
      total: 1,
      totalBytes: entry.sizeInBytes,
    });

    // Once the queued motion deletion finishes, its capture must carry the same parent lock into restore.
    await assets.remove({ id: motion.id });
    await expect(trash.getById(entry.id)).resolves.toMatchObject({ wasLocked: true });
    const { assetId } = await sut.restore(ownerAuth(user.id), entry.id);
    await expect(
      database.selectFrom('asset_lock').select('reason').where('assetId', '=', assetId).execute(),
    ).resolves.toEqual([{ reason: AssetLockReason.Marked }]);
    const access = new AccessRepository(database);
    await expect(access.asset.checkOwnerAccess(user.id, new Set([assetId]), false)).resolves.toEqual(new Set());
    await expect(access.asset.checkOwnerAccess(user.id, new Set([assetId]), true)).resolves.toEqual(new Set([assetId]));
  });
  it.each(
    ['live', 'deleted'].flatMap((state) =>
      ['owner', 'version', 'missing', 'stale motion'].map((kind) => ({ state, kind })),
    ),
  )('keeps $state ambiguous hidden motion private with $kind parent evidence', async ({ state, kind }) => {
    const { sut, ctx, entry, user, trash, storage, photo, motion } = await setupMotionTrash();
    await ctx.get(AssetRepository).remove({ id: photo.id });
    if (kind === 'stale motion') {
      const parent = await database
        .selectFrom('asset_backup_deletion')
        .selectAll()
        .where('assetId', '=', photo.id)
        .executeTakeFirstOrThrow();
      await database
        .insertInto('asset_backup_deletion')
        .values({ ...parent, assetId: motion.id, checksum: entry.checksum, livePhotoVideoId: null, wasLocked: false })
        .execute();
    }
    if (kind === 'missing' || kind === 'stale motion') {
      await database.deleteFrom('asset_backup_deletion').where('assetId', '=', photo.id).execute();
    } else {
      await database
        .updateTable('asset_backup_deletion')
        .set(kind === 'owner' ? { ownerId: randomUUID() } : { evidenceVersion: 0 })
        .where('assetId', '=', photo.id)
        .execute();
    }
    if (state === 'deleted') {
      await ctx.get(AssetRepository).remove({ id: motion.id });
      await expect(
        database.selectFrom('asset_backup_deletion').selectAll().where('assetId', '=', motion.id).executeTakeFirst(),
      ).resolves.toMatchObject({
        ownerId: user.id,
        checksum: entry.checksum,
        visibility: AssetVisibility.Hidden,
        evidenceVersion: 1,
      });
    }
    await expect(trash.getById(entry.id)).resolves.toMatchObject({ wasLocked: null });
    const ordinary = { ...authStub.admin, user: { ...authStub.admin.user, id: user.id } };
    for (const auth of [ordinary, ownerAuth(randomUUID())]) {
      await expect(sut.list(auth, { page: 1, size: 100 })).resolves.toMatchObject({
        items: [],
        total: 0,
        totalBytes: 0,
      });
      await expect(sut.purge(auth, entry.id)).rejects.toThrow('File not found');
      await expect(sut.restore(auth, entry.id)).rejects.toThrow('File not found');
    }
    expect(storage.rename).not.toHaveBeenCalled();
    expect(storage.unlink).not.toHaveBeenCalled();
    await expect(sut.list(ownerAuth(user.id), { page: 1, size: 100 })).resolves.toMatchObject({ total: 1 });
    if (state === 'deleted') {
      const { assetId } = await sut.restore(ownerAuth(user.id), entry.id);
      await expect(
        database.selectFrom('asset_lock').select('reason').where('assetId', '=', assetId).execute(),
      ).resolves.toEqual([{ reason: AssetLockReason.Marked }]);
      const access = new AccessRepository(database);
      await expect(access.asset.checkOwnerAccess(user.id, new Set([assetId]), false)).resolves.toEqual(new Set());
      await expect(access.asset.checkOwnerAccess(user.id, new Set([assetId]), true)).resolves.toEqual(
        new Set([assetId]),
      );
    }
  });
  it('keeps known unlocked motion recoverable after its still is deleted', async () => {
    const { sut, ctx, entry, user, trash, photo, motion } = await setupMotionTrash(false);
    const assets = ctx.get(AssetRepository);
    await assets.remove({ id: photo.id });
    await expect(trash.getById(entry.id)).resolves.toMatchObject({ wasLocked: false });
    const ordinary = { ...authStub.admin, user: { ...authStub.admin.user, id: user.id } };
    await expect(sut.list(ordinary, { page: 1, size: 100 })).resolves.toMatchObject({
      items: [expect.objectContaining({ id: entry.id })],
      total: 1,
      totalBytes: entry.sizeInBytes,
    });
    await assets.remove({ id: motion.id });
    const { assetId } = await sut.restore(ordinary, entry.id);
    await expect(
      database.selectFrom('asset_lock').selectAll().where('assetId', '=', assetId).execute(),
    ).resolves.toEqual([]);
    const access = new AccessRepository(database);
    await expect(access.asset.checkOwnerAccess(user.id, new Set([assetId]), false)).resolves.toEqual(
      new Set([assetId]),
    );
  });
  it('retains a deleted motion own lock when its parent evidence is unlocked', async () => {
    const { ctx, entry, user, trash, photo, motion } = await setupMotionTrash(false);
    await database
      .insertInto('asset_lock')
      .values({ assetId: motion.id, reason: AssetLockReason.Marked, lockedBy: user.id })
      .execute();
    const assets = ctx.get(AssetRepository);
    await assets.remove({ id: photo.id });
    await assets.remove({ id: motion.id });
    await expect(trash.getById(entry.id)).resolves.toMatchObject({ wasLocked: true });
  });
  it.each(['owner', 'checksum'])('does not trust deletion evidence for a different %s', async (mismatch) => {
    const { ctx, entry, user, trash } = await setup();
    const { user: other } = await ctx.newUser();
    const { asset } = await ctx.newAsset({
      ownerId: mismatch === 'owner' ? other.id : user.id,
      checksum: mismatch === 'checksum' ? randomBytes(32) : entry.checksum,
      originalPath: `/data/upload/${randomUUID()}.jpg`,
    });
    await ctx.get(AssetRepository).remove({ id: asset.id });
    await sql`UPDATE public.physical_file_trash SET "lastAssetId"=${asset.id}::uuid WHERE id=${entry.id}::uuid`.execute(
      database,
    );
    await expect(trash.getById(entry.id)).resolves.toMatchObject({ wasLocked: null });
  });
  it.each([true, null])('keeps deleted Locked or unknown originals private through restore (%s)', async (locked) => {
    const { sut, ctx, entry, user, trash } = await setup();
    if (locked) {
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        checksum: entry.checksum,
        originalPath: `/data/upload/${randomUUID()}.jpg`,
      });
      await ctx.get(AssetRepository).lock([asset.id], AssetLockReason.Marked, user.id);
      await ctx.get(AssetRepository).remove({ id: asset.id });
      await sql`UPDATE public.physical_file_trash SET "lastAssetId"=${asset.id}::uuid WHERE id=${entry.id}::uuid`.execute(
        database,
      );
    }
    await expect(trash.getById(entry.id)).resolves.toMatchObject({ wasLocked: locked });
    const ordinary = { ...authStub.admin, user: { ...authStub.admin.user, id: user.id } },
      elevated = ownerAuth(user.id);
    await expect(sut.list(ordinary, { page: 1, size: 100 })).resolves.toMatchObject({
      items: [],
      total: 0,
      totalBytes: 0,
    });
    await expect(sut.restore(ordinary, entry.id)).rejects.toThrow('File not found');
    await expect(sut.restore(ownerAuth(randomUUID()), entry.id)).rejects.toThrow('File not found');
    await expect(sut.list(elevated, { page: 1, size: 100 })).resolves.toMatchObject({
      total: 1,
      totalBytes: entry.sizeInBytes,
    });
    const { assetId } = await sut.restore(elevated, entry.id);
    await expect(
      database.selectFrom('asset_lock').select('reason').where('assetId', '=', assetId).execute(),
    ).resolves.toEqual([{ reason: AssetLockReason.Marked }]);
    const access = new AccessRepository(database);
    await expect(access.asset.checkOwnerAccess(user.id, new Set([assetId]), false)).resolves.toEqual(new Set());
    await expect(access.asset.checkOwnerAccess(user.id, new Set([assetId]), true)).resolves.toEqual(new Set([assetId]));
  });

  it.each([
    ['imported-photo.jpg', 'sha1', ChecksumAlgorithm.sha1File],
    ['extracted-motion.mp4', 'sha1', ChecksumAlgorithm.sha1File],
    ['uploaded-photo.jpg', 'sha256', ChecksumAlgorithm.sha256File],
  ])(
    'keeps %s healthy and deduplicated through delete, trash and restore',
    async (name, algorithm, checksumAlgorithm) => {
      const { sut, ctx } = newMediumService(PhysicalFileTrashService, {
        database,
        real: [AssetRepository, UserRepository, CryptoRepository, PhysicalFileRepository, PhysicalFileTrashRepository],
        mock: [StorageRepository, LoggingRepository, JobRepository, EventRepository],
      });
      const contents = Buffer.from(`original media bytes for ${name}`);
      const checksum = createHash(algorithm).update(contents).digest();
      const { user } = await ctx.newUser();
      const { asset: original } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: `/data/upload/${randomUUID()}/${name}`,
        originalFileName: name,
        checksum,
        checksumAlgorithm,
      });
      await ctx.newExif({ assetId: original.id, fileSizeInByte: contents.length });
      const files = ctx.get(PhysicalFileRepository);
      await files.ensureOriginalPhysicalFile(original.id);
      await ctx.get(AssetRepository).remove({ id: original.id });
      const unlink = vi.fn();
      await expect(
        files.deleteUnreferencedPath(original.originalPath, unlink, {
          removedAssetId: original.id,
          trash: {
            move: vi.fn().mockResolvedValue(undefined),
            original: {
              checksum,
              sizeInBytes: contents.length,
              ownerId: user.id,
              assetId: original.id,
              originalFileName: name,
            },
          },
        }),
      ).resolves.toMatchObject({ trashed: true });
      expect(unlink).not.toHaveBeenCalled();
      const trash = ctx.get(PhysicalFileTrashRepository);
      const entry = (await trash.findByChecksum(checksum, contents.length))!;
      expect(entry.checksum).toEqual(checksum);
      const storage = ctx.getMock(StorageRepository);
      storage.mkdirSync.mockReturnValue(undefined);
      storage.rename.mockResolvedValue(undefined);
      storage.stat.mockResolvedValue({ mtime: new Date() } as never);
      ctx.getMock(JobRepository).queue.mockResolvedValue(undefined);
      ctx.getMock(EventRepository).emit.mockResolvedValue(undefined);
      const { assetId } = await sut.restore(ownerAuth(user.id), entry.id);
      const restored = await database
        .selectFrom('asset')
        .selectAll()
        .where('id', '=', assetId)
        .executeTakeFirstOrThrow();
      expect(restored).toMatchObject({ checksum, checksumAlgorithm });
      await expect(trash.getById(entry.id)).resolves.toBeUndefined();
      const physical = (await files.getPhysicalFile(restored.physicalOriginalFileId!))!;
      expect(physical).toMatchObject({ checksum, canonicalAssetId: assetId, path: restored.originalPath });

      // Verify actual file bytes with the persisted restored algorithm, including the corruption control.
      const { sut: integrity, mocks } = newTestService(IntegrityService);
      mocks.integrityReport.getAssetCount.mockResolvedValue({ count: 1 } as never);
      mocks.systemMetadata.get.mockResolvedValue(null);
      mocks.integrityReport.recordVerification.mockResolvedValue(true);
      mocks.integrityReport.streamAssetChecksums.mockImplementation(
        () =>
          (function* () {
            yield { ...restored, assetId, reportId: null };
          })() as never,
      );
      mocks.storage.createPlainReadStream.mockImplementation(() => Readable.from([contents]) as never);
      await integrity.handleChecksumFiles({});
      expect(mocks.integrityReport.recordVerification).toHaveBeenLastCalledWith(
        expect.objectContaining({ assetId, checksumAlgorithm, expectedChecksum: checksum, result: 'passed' }),
      );
      mocks.storage.createPlainReadStream.mockImplementation(() => Readable.from([Buffer.from('corrupt')]) as never);
      await integrity.handleChecksumFiles({});
      expect(mocks.integrityReport.recordVerification).toHaveBeenLastCalledWith(
        expect.objectContaining({ assetId, result: 'mismatched' }),
      );

      const { user: partner } = await ctx.newUser();
      const { asset: duplicate } = await ctx.newAsset({
        ownerId: partner.id,
        originalPath: `/data/upload/${randomUUID()}/${name}`,
        checksum,
        checksumAlgorithm,
      });
      await ctx.newExif({ assetId: duplicate.id, fileSizeInByte: contents.length });
      await expect(
        files.linkUploadedOriginal(
          duplicate.id,
          { checksum, sizeInBytes: contents.length },
          { verify: onDisk, identify: onDisk },
        ),
      ).resolves.toMatchObject({ linked: true, physicalFile: { id: physical.id } });
    },
  );
});

describe(PhysicalFileTrashService.name, () => {
  it('rolls back rejected inspection with the original row and bytes, then restores the same ID', async () => {
    const { sut, storage, trash, entry, bytes, user } = await setup();
    const inspectionError = new Error('inspection failed');
    storage.stat.mockRejectedValueOnce(inspectionError);

    await expect(sut.restore(ownerAuth(user.id), entry.id)).rejects.toBe(inspectionError);

    await expect(trash.getById(entry.id)).resolves.toEqual(entry);
    await expect(readFile(entry.path)).resolves.toEqual(bytes);
    await expect(database.selectFrom('asset').select('id').where('ownerId', '=', user.id).execute()).resolves.toEqual(
      [],
    );

    const { assetId } = await sut.restore(ownerAuth(user.id), entry.id);
    const asset = await database.selectFrom('asset').selectAll().where('id', '=', assetId).executeTakeFirstOrThrow();
    await expect(trash.getById(entry.id)).resolves.toBeUndefined();
    await expect(readFile(asset.originalPath)).resolves.toEqual(bytes);
    expect(asset.ownerId).toBe(entry.lastOwnerId);
    expect(asset.checksum).toEqual(entry.checksum);
    expect(asset.originalFileName).toBe(entry.originalFileName);
    expect(asset.physicalOriginalFileId).not.toBeNull();
    const physical = await database
      .selectFrom('physical_file')
      .selectAll()
      .where('id', '=', asset.physicalOriginalFileId!)
      .executeTakeFirstOrThrow();
    expect(physical).toMatchObject({ canonicalAssetId: assetId, path: asset.originalPath, checksum: entry.checksum });
  });

  it('retains moved bytes and original trash identity when compensation also fails', async () => {
    const { sut, ctx, storage, trash, entry, bytes, user } = await setup();
    const inspectionError = new Error('inspection failed');
    const compensationError = new Error('move back failed');
    storage.stat.mockRejectedValueOnce(inspectionError);
    // the move back keeps failing: the inline compensation and the journal's own recovery attempt
    storage.rename.mockImplementationOnce(rename).mockRejectedValue(compensationError);

    await expect(sut.restore(ownerAuth(user.id), entry.id)).rejects.toMatchObject({
      errors: [inspectionError, compensationError],
      cause: compensationError,
    });
    storage.rename.mockImplementation(rename);

    const target = storage.rename.mock.calls[0][1];
    await expect(trash.getById(entry.id)).resolves.toEqual(entry);
    await expect(readFile(target)).resolves.toEqual(bytes);
    // the journalled move stays (raw SQL, as the repository writes it), so a later recovery returns
    // the bytes to the trash path
    const { rows: journal } = await sql<{ oldPath: string; newPath: string }>`
      SELECT "oldPath", "newPath" FROM public.move_history
      WHERE "pathType" = 'file_trash' AND "oldPath" = ${entry.path}`.execute(database);
    expect(journal).toEqual([{ oldPath: entry.path, newPath: target }]);
    await expect(database.selectFrom('asset').select('id').where('ownerId', '=', user.id).execute()).resolves.toEqual(
      [],
    );
    expect(storage.unlink).not.toHaveBeenCalled();
    expect(ctx.getMock(JobRepository).queue).not.toHaveBeenCalled();
    expect(ctx.getMock(EventRepository).emit).not.toHaveBeenCalled();
    expect(ctx.getMock(LoggingRepository).error).toHaveBeenCalledWith('File-trash inspection failed', inspectionError);
    expect(ctx.getMock(LoggingRepository).error).toHaveBeenCalledWith('File-trash move-back failed', compensationError);
  });
});
