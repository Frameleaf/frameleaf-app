import { Kysely, sql } from 'kysely';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { StorageCore } from 'src/cores/storage.core.js';
import { ChecksumAlgorithm } from 'src/enum.js';
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

describe(PhysicalFileTrashService.name, () => {
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
      const { assetId } = await sut.restore(entry.id);
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
          { exists: () => Promise.resolve(true) },
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

    await expect(sut.restore(entry.id)).rejects.toBe(inspectionError);

    await expect(trash.getById(entry.id)).resolves.toEqual(entry);
    await expect(readFile(entry.path)).resolves.toEqual(bytes);
    await expect(database.selectFrom('asset').select('id').where('ownerId', '=', user.id).execute()).resolves.toEqual(
      [],
    );

    const { assetId } = await sut.restore(entry.id);
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
    storage.rename.mockImplementationOnce(rename).mockRejectedValueOnce(compensationError);

    await expect(sut.restore(entry.id)).rejects.toMatchObject({
      errors: [inspectionError, compensationError],
      cause: compensationError,
    });

    const target = storage.rename.mock.calls[0][1];
    await expect(trash.getById(entry.id)).resolves.toEqual(entry);
    await expect(readFile(target)).resolves.toEqual(bytes);
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
