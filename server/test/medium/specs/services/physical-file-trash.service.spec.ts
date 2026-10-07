import { Kysely } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
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

beforeAll(async () => {
  database = await getKyselyDB();
  StorageCore.setMediaLocation('/data');
});

afterAll(async () => {
  StorageCore.reset();
  await database?.destroy();
});

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
