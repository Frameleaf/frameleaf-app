import { Kysely, sql } from 'kysely';
import { DateTime } from 'luxon';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { StorageCore } from 'src/cores/storage.core.js';
import {
  AssetFileType,
  AssetPathType,
  ChecksumAlgorithm,
  IntegrityReport,
  JobName,
  JobStatus,
  SystemMetadataKey,
} from 'src/enum.js';
import { AssetChecksumRepository } from 'src/repositories/asset-checksum.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { IntegrityRepository } from 'src/repositories/integrity.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { IntegrityService } from 'src/services/integrity.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB, makeStream } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  return newMediumService(IntegrityService, {
    database: db || defaultDatabase,
    real: [
      IntegrityRepository,
      LibraryRepository,
      AssetRepository,
      ConfigRepository,
      SystemMetadataRepository,
      AssetChecksumRepository,
      PhysicalFileRepository,
      // FL-81: a full run gets an id for its batches (`startCheckRun`).
      CryptoRepository,
    ],
    mock: [LoggingRepository, EventRepository, StorageRepository, JobRepository],
  });
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
  StorageCore.setMediaLocation('/path/to/file');
});

afterAll(() => {
  StorageCore.reset();
});

describe(IntegrityService.name, () => {
  beforeEach(async () => {
    await defaultDatabase.deleteFrom('asset_file').execute();
    await defaultDatabase.deleteFrom('asset').execute();
    await defaultDatabase.deleteFrom('integrity_report').execute();
  });

  it('should work', () => {
    const { sut } = setup();
    expect(sut).toBeDefined();
  });

  describe('getIntegrityReportSummary', () => {
    it('gets summary', async () => {
      const { sut } = setup();

      await expect(sut.getIntegrityReportSummary()).resolves.toEqual({
        checksum_mismatch: 0,
        missing_file: 0,
        untracked_file: 0,
      });
    });
  });

  describe('getIntegrityReport', () => {
    it('gets report', async () => {
      const { sut } = setup();

      await expect(sut.getIntegrityReport({ type: IntegrityReport.ChecksumFail })).resolves.toEqual({
        items: [],
        nextCursor: undefined,
      });
    });

    it("names a photo's finding by the file name it came with, and a stray file by nothing (FL-737)", async () => {
      const { sut, ctx } = setup();
      const {
        result: { id: ownerId },
      } = await ctx.newUser();
      const { asset } = await ctx.newAsset({
        ownerId,
        originalPath: '/upload/0b/fb/0bfb.jpg',
        originalFileName: 'beach.jpg',
      });
      await ctx.get(IntegrityRepository).create([
        { type: IntegrityReport.MissingFile, path: '/upload/0b/fb/0bfb.jpg', assetId: asset.id },
        { type: IntegrityReport.UntrackedFile, path: '/upload/ab/cd/extra.jpg' },
      ]);

      await expect(sut.getIntegrityReport({ type: IntegrityReport.MissingFile })).resolves.toEqual({
        items: [expect.objectContaining({ path: '/upload/0b/fb/0bfb.jpg', originalFileName: 'beach.jpg' })],
        nextCursor: undefined,
      });
      await expect(sut.getIntegrityReport({ type: IntegrityReport.UntrackedFile })).resolves.toEqual({
        items: [expect.objectContaining({ path: '/upload/ab/cd/extra.jpg', originalFileName: null })],
        nextCursor: undefined,
      });
    });
  });

  describe('getIntegrityReportCsv', () => {
    it('gets report as csv', async () => {
      const { sut, ctx } = setup();

      const { id } = await ctx.get(IntegrityRepository).create({
        type: IntegrityReport.ChecksumFail,
        path: '/path/to/file',
      });

      await expect(text(sut.getIntegrityReportCsv(IntegrityReport.ChecksumFail))).resolves.toMatchInlineSnapshot(`
          "id,type,assetId,fileAssetId,path
          ${id},checksum_mismatch,null,null,"/path/to/file"
          "
        `);
    });
  });

  describe('getIntegrityReportFile', () => {
    it('gets report file', async () => {
      const { sut, ctx } = setup();

      const { id } = await ctx.get(IntegrityRepository).create({
        type: IntegrityReport.ChecksumFail,
        path: '/path/to/file',
      });

      await expect(sut.getIntegrityReportFile(id)).resolves.toEqual({
        path: '/path/to/file',
        fileName: 'file',
        contentType: 'application/octet-stream',
        cacheControl: 'private_without_cache',
      });
    });
  });

  describe('getIntegrityOverview (FL-520)', () => {
    it('counts a photo both checkers report once, and RAW originals among the missing', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(StorageRepository).stat.mockResolvedValue({} as never);
      const {
        result: { id: ownerId },
      } = await ctx.newUser();
      const { asset: both } = await ctx.newAsset({ ownerId, originalFileName: 'IMG_1.CR2' });
      const { asset: healthOnly } = await ctx.newAsset({ ownerId, originalFileName: 'IMG_2.JPG' });
      const { asset: damaged } = await ctx.newAsset({ ownerId, originalFileName: 'IMG_3.JPG' });
      await ctx.get(IntegrityRepository).create([
        { type: IntegrityReport.MissingFile, path: '/a', assetId: both.id },
        { type: IntegrityReport.ChecksumFail, path: '/c', assetId: damaged.id },
        { type: IntegrityReport.UntrackedFile, path: '/stray' },
      ]);
      const health = (assetId: string, category: string, status: string) =>
        sql`INSERT INTO public.asset_health ("assetId", category, status, severity, "originalPath", "originalFileName", evidence, resolution, "checkedAt")
          VALUES (${assetId}, ${category}, ${status}, 'warning', '/x', 'x', '{}', '{}', now())`.execute(
          defaultDatabase,
        );
      await health(both.id, 'missing', 'missing');
      await health(healthOnly.id, 'missing', 'candidate');
      await health(damaged.id, 'corrupt', 'corrupt_confirmed');

      await expect(sut.getIntegrityOverview()).resolves.toEqual(
        expect.objectContaining({ missing: 2, damaged: 1, stray: 1, rawToMatch: 1, unreachable: [] }),
      );
      await expect(sut.getFindingAssetIds({ kind: 'missing' })).resolves.toEqual({
        assetIds: [both.id, healthOnly.id].toSorted(),
      });
      await sql`DELETE FROM public.asset_health`.execute(defaultDatabase);
    });
  });

  describe('deleteIntegrityReport', () => {
    it('deletes asset if one is present', async () => {
      const { sut, ctx } = setup();
      const events = ctx.getMock(EventRepository);
      events.emit.mockResolvedValue(void 0);

      const {
        result: { id: ownerId },
      } = await ctx.newUser();

      const {
        result: { id: assetId },
      } = await ctx.newAsset({ ownerId });

      const { id } = await ctx.get(IntegrityRepository).create({
        type: IntegrityReport.ChecksumFail,
        path: '/path/to/file',
        assetId,
      });

      await sut.deleteIntegrityReport(ownerId, id);

      await expect(ctx.get(AssetRepository).getById(assetId)).resolves.toEqual(
        expect.objectContaining({
          status: 'trashed',
        }),
      );

      expect(events.emit).toHaveBeenCalledWith('AssetTrashAll', {
        assetIds: [assetId],
        userId: ownerId,
      });

      await expect(sut.getIntegrityReport({ type: IntegrityReport.ChecksumFail })).resolves.toEqual({
        items: [],
        nextCursor: undefined,
      });
    });

    it('deletes file asset if one is present', async () => {
      const { sut, ctx } = setup();

      const {
        result: { id: ownerId },
      } = await ctx.newUser();

      const {
        result: { id: assetId },
      } = await ctx.newAsset({ ownerId });

      const fileAssetId = randomUUID();
      await ctx.newAssetFile({ id: fileAssetId, assetId, type: AssetFileType.Thumbnail, path: '/path/to/file' });

      const { id } = await ctx.get(IntegrityRepository).create({
        type: IntegrityReport.ChecksumFail,
        path: '/path/to/file',
        fileAssetId,
      });

      await sut.deleteIntegrityReport('userId', id);

      await expect(ctx.get(AssetRepository).getForThumbnail(assetId, AssetFileType.Thumbnail, false)).resolves.toEqual(
        expect.objectContaining({
          path: null,
        }),
      );
    });

    it('deletes untracked file', async () => {
      const { sut, ctx } = setup();
      const storage = ctx.getMock(StorageRepository);
      storage.unlink.mockResolvedValue(void 0);

      const {
        result: { id: userId },
      } = await ctx.newUser();

      const { id } = await ctx.get(IntegrityRepository).create({
        type: IntegrityReport.ChecksumFail,
        path: '/path/to/file',
      });

      await sut.deleteIntegrityReport(userId, id);

      expect(storage.unlink).toHaveBeenCalledWith('/path/to/file');
    });

    it('keeps a file a row references when its stray-file report is stale', async () => {
      const { sut, ctx } = setup();
      const storage = ctx.getMock(StorageRepository);
      storage.unlink.mockResolvedValue(void 0);

      const {
        result: { id: ownerId },
      } = await ctx.newUser();
      const {
        result: { id: assetId },
      } = await ctx.newAsset({ ownerId });

      const framePath = `/thumbs/${ownerId}/${assetId}_moment_abc_0.jpeg`;
      await ctx.database
        .insertInto('video_moment_frame')
        .values({ assetId, frameIndex: 0, timestampMs: 1000, path: framePath, score: 1, rank: 1 })
        .execute();
      const { id } = await ctx
        .get(IntegrityRepository)
        .create({ type: IntegrityReport.UntrackedFile, path: framePath });

      await sut.deleteIntegrityReport(ownerId, id);

      expect(storage.unlink).not.toHaveBeenCalled();
    });
  });

  describe('handleUntrackedFilesQueueAll', () => {
    it('should succeed', async () => {
      const { sut, ctx } = setup();
      const storage = ctx.getMock(StorageRepository);
      const job = ctx.getMock(JobRepository);

      job.queue.mockResolvedValue(void 0);
      storage.walk.mockImplementation(() => makeStream([['/path/to/file', '/path/to/file2'], ['/path/to/batch2']]));

      await expect(sut.handleUntrackedFilesQueueAll({ refreshOnly: false })).resolves.toBe(JobStatus.Success);
    });

    it('queues jobs for all detected files', async () => {
      const { sut, ctx } = setup();
      const storage = ctx.getMock(StorageRepository);
      const job = ctx.getMock(JobRepository);

      job.queue.mockResolvedValue(void 0);

      storage.walk.mockReturnValueOnce(makeStream([['/path/to/file', '/path/to/file2'], ['/path/to/batch2']]));
      storage.walk.mockReturnValueOnce(makeStream([['/path/to/file3', '/path/to/file4'], ['/path/to/batch4']]));

      await sut.handleUntrackedFilesQueueAll({ refreshOnly: false });

      expect(job.queue).toBeCalledTimes(4);
      expect(job.queue).toBeCalledWith({
        name: JobName.IntegrityUntrackedFiles,
        data: {
          type: 'asset',
          // FL-81: every batch carries its run, so the last one to finish records "Last run".
          runId: expect.any(String),
          paths: expect.arrayContaining(['/path/to/file']),
        },
      });

      expect(job.queue).toBeCalledWith({
        name: JobName.IntegrityUntrackedFiles,
        data: {
          type: 'asset_file',
          // FL-81: every batch carries its run, so the last one to finish records "Last run".
          runId: expect.any(String),
          paths: expect.arrayContaining(['/path/to/file3']),
        },
      });
    });

    it('queues jobs to refresh reports', async () => {
      const { sut, ctx } = setup();
      const storage = ctx.getMock(StorageRepository);
      const job = ctx.getMock(JobRepository);

      job.queue.mockResolvedValue(void 0);
      storage.walk.mockImplementation(() => makeStream([['/path/to/file', '/path/to/file2'], ['/path/to/batch2']]));

      const { id } = await ctx.get(IntegrityRepository).create({
        type: IntegrityReport.UntrackedFile,
        path: '/path/to/file',
      });

      await sut.handleUntrackedFilesQueueAll({ refreshOnly: true });

      expect(job.queue).toBeCalledTimes(1);
      expect(job.queue).toBeCalledWith({
        name: JobName.IntegrityUntrackedFilesRefresh,
        data: {
          items: expect.arrayContaining([
            {
              path: '/path/to/file',
              reportId: id,
            },
          ]),
        },
      });
    });
  });

  describe('handleUntrackedFiles', () => {
    it('should detect untracked asset files', async () => {
      const { sut, ctx } = setup();

      const {
        result: { id: ownerId },
      } = await ctx.newUser();

      const { asset } = await ctx.newAsset({ ownerId, originalPath: '/path/to/file1' });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.EncodedVideo, path: '/path/to/file2' });

      await sut.handleUntrackedFiles({
        type: 'asset',
        paths: ['/path/to/file1', '/path/to/file2', '/path/to/untracked'],
      });

      await expect(
        ctx.get(IntegrityRepository).getIntegrityReport(
          {
            limit: 100,
          },
          IntegrityReport.UntrackedFile,
        ),
      ).resolves.toEqual({
        items: [
          expect.objectContaining({
            path: '/path/to/untracked',
          }),
        ],
        nextCursor: undefined,
      });
    });

    it('should not report sidecar asset_file paths from the asset-folder walk as untracked', async () => {
      const { sut, ctx } = setup();

      const {
        result: { id: ownerId },
      } = await ctx.newUser();

      const { asset } = await ctx.newAsset({ ownerId, originalPath: '/upload/photo.jpg' });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Sidecar, path: '/upload/photo.xmp' });

      await sut.handleUntrackedFiles({
        type: 'asset',
        paths: ['/upload/photo.jpg', '/upload/photo.xmp', '/upload/untracked.jpg'],
      });

      await expect(
        ctx.get(IntegrityRepository).getIntegrityReport(
          {
            limit: 100,
          },
          IntegrityReport.UntrackedFile,
        ),
      ).resolves.toEqual({
        items: [
          expect.objectContaining({
            path: '/upload/untracked.jpg',
          }),
        ],
        nextCursor: undefined,
      });
    });

    it('should not report video moment frames as untracked', async () => {
      const { sut, ctx } = setup();

      const {
        result: { id: ownerId },
      } = await ctx.newUser();

      const {
        result: { id: assetId },
      } = await ctx.newAsset({ ownerId });

      const framePath = `/thumbs/${ownerId}/${assetId}_moment_abc_0.jpeg`;
      await ctx.database
        .insertInto('video_moment_frame')
        .values({ assetId, frameIndex: 0, timestampMs: 1000, path: framePath, score: 1, rank: 1 })
        .execute();

      await sut.handleUntrackedFiles({
        type: 'asset_file',
        paths: [framePath, '/thumbs/untracked.jpeg'],
      });

      await expect(
        ctx.get(IntegrityRepository).getIntegrityReport({ limit: 100 }, IntegrityReport.UntrackedFile),
      ).resolves.toEqual({
        items: [expect.objectContaining({ path: '/thumbs/untracked.jpeg' })],
        nextCursor: undefined,
      });
    });

    it('should not report a file only the shared reference count knows about', async () => {
      const { sut, ctx } = setup();

      const {
        result: { id: ownerId },
      } = await ctx.newUser();
      const profilePath = `/profile/${ownerId}/avatar.jpg`;
      await ctx.database.updateTable('user').set({ profileImagePath: profilePath }).where('id', '=', ownerId).execute();

      await sut.handleUntrackedFiles({ type: 'asset_file', paths: [profilePath, '/profile/untracked.jpg'] });

      await expect(
        ctx.get(IntegrityRepository).getIntegrityReport({ limit: 100 }, IntegrityReport.UntrackedFile),
      ).resolves.toEqual({
        items: [expect.objectContaining({ path: '/profile/untracked.jpg' })],
        nextCursor: undefined,
      });
    });

    it('should not report either end or the staged copy of an interrupted move', async () => {
      const { sut, ctx } = setup();

      const [{ id }] = await ctx.database
        .insertInto('move_history')
        .values({
          entityId: randomUUID(),
          pathType: AssetPathType.Original,
          oldPath: '/upload/a/old.jpg',
          newPath: '/library/a/new.jpg',
        })
        .returning('id')
        .execute();
      const staged = `/library/a/new.jpg.${id}.moving`;

      await sut.handleUntrackedFiles({
        type: 'asset',
        paths: ['/upload/a/old.jpg', '/library/a/new.jpg', staged, '/library/a/untracked.jpg'],
      });

      await expect(
        ctx.get(IntegrityRepository).getIntegrityReport({ limit: 100 }, IntegrityReport.UntrackedFile),
      ).resolves.toEqual({
        items: [expect.objectContaining({ path: '/library/a/untracked.jpg' })],
        nextCursor: undefined,
      });
      await ctx.database.deleteFrom('move_history').where('id', '=', id).execute();
    });

    it('checks a full batch of paths without exceeding the bind parameter limit', async () => {
      const { ctx } = setup();
      const paths = Array.from({ length: 10_000 }, (_, index) => `/thumbs/batch/${index}.jpeg`);

      await expect(ctx.get(IntegrityRepository).getDevelopRevisionPathsByPaths(paths)).resolves.toEqual([]);
      await expect(ctx.get(IntegrityRepository).getInFlightPathsByPaths(paths)).resolves.toEqual([]);
    });

    it('should detect untracked asset_file files', async () => {
      const { sut, ctx } = setup();

      const {
        result: { id: ownerId },
      } = await ctx.newUser();

      const {
        result: { id: assetId },
      } = await ctx.newAsset({ ownerId });

      await ctx.newAssetFile({ assetId, type: AssetFileType.Thumbnail, path: '/path/to/file1' });

      await sut.handleUntrackedFiles({
        type: 'asset_file',
        paths: ['/path/to/file1', '/path/to/untracked'],
      });

      await expect(
        ctx.get(IntegrityRepository).getIntegrityReport(
          {
            limit: 100,
          },
          IntegrityReport.UntrackedFile,
        ),
      ).resolves.toEqual({
        items: [
          expect.objectContaining({
            path: '/path/to/untracked',
          }),
        ],
        nextCursor: undefined,
      });
    });
  });

  describe('handleUntrackedRefresh', () => {
    it('should succeed', async () => {
      const { sut } = setup();
      await expect(sut.handleUntrackedRefresh({ items: [] })).resolves.toBe(JobStatus.Success);
    });

    it('should delete reports for files that no longer exist', async () => {
      const { sut, ctx } = setup();
      const integrity = ctx.get(IntegrityRepository);
      const storage = ctx.getMock(StorageRepository);

      const report1 = await integrity.create({
        type: IntegrityReport.UntrackedFile,
        path: '/path/to/missing1',
      });

      const report2 = await integrity.create({
        type: IntegrityReport.UntrackedFile,
        path: '/path/to/existing',
      });

      storage.stat
        .mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
        .mockResolvedValueOnce({} as never);

      await sut.handleUntrackedRefresh({
        items: [
          { reportId: report1.id, path: report1.path },
          { reportId: report2.id, path: report2.path },
        ],
      });

      await expect(
        ctx.get(IntegrityRepository).getIntegrityReport(
          {
            limit: 100,
          },
          IntegrityReport.UntrackedFile,
        ),
      ).resolves.toEqual({
        items: [
          expect.objectContaining({
            path: '/path/to/existing',
          }),
        ],
        nextCursor: undefined,
      });
    });
  });

  describe('handleMissingFilesQueueAll', () => {
    it('should succeed', async () => {
      const { sut } = setup();
      await expect(sut.handleMissingFilesQueueAll()).resolves.toBe(JobStatus.Success);
    });

    it('should queue jobs', async () => {
      const { sut, ctx } = setup();
      const job = ctx.getMock(JobRepository);
      job.queue.mockResolvedValue(void 0);

      const {
        result: { id: ownerId },
      } = await ctx.newUser();

      const {
        result: { id: assetId },
      } = await ctx.newAsset({ ownerId, originalPath: '/path/to/file1' });

      const {
        result: { id: assetId2 },
      } = await ctx.newAsset({ ownerId, originalPath: '/path/to/file2' });

      const { id: reportId } = await ctx.get(IntegrityRepository).create({
        type: IntegrityReport.MissingFile,
        path: '/path/to/file2',
        assetId: assetId2,
      });

      await sut.handleMissingFilesQueueAll({ refreshOnly: false });

      expect(job.queue).toHaveBeenCalledWith({
        name: JobName.IntegrityMissingFiles,
        data: {
          runId: expect.any(String),
          items: expect.arrayContaining([
            { path: '/path/to/file1', assetId, fileAssetId: null, reportId: null },
            { path: '/path/to/file2', assetId: assetId2, fileAssetId: null, reportId },
          ]),
        },
      });

      expect(job.queue).not.toHaveBeenCalledWith(
        expect.objectContaining({
          name: JobName.IntegrityMissingFilesRefresh,
        }),
      );
    });

    it('should queue refresh jobs when refreshOnly is set', async () => {
      const { sut, ctx } = setup();
      const job = ctx.getMock(JobRepository);
      job.queue.mockResolvedValue(void 0);

      const { id: reportId } = await ctx.get(IntegrityRepository).create({
        type: IntegrityReport.MissingFile,
        path: '/path/to/file1',
      });

      await sut.handleMissingFilesQueueAll({ refreshOnly: true });

      expect(job.queue).toHaveBeenCalledWith({
        name: JobName.IntegrityMissingFilesRefresh,
        data: {
          items: expect.arrayContaining([{ reportId, path: '/path/to/file1' }]),
        },
      });

      expect(job.queue).not.toHaveBeenCalledWith(
        expect.objectContaining({
          name: JobName.IntegrityMissingFiles,
        }),
      );
    });
  });

  describe('handleMissingFiles', () => {
    it('should succeed', async () => {
      const { sut } = setup();
      await expect(sut.handleMissingFiles({ items: [] })).resolves.toBe(JobStatus.Success);
    });

    it('should detect missing files and remove outdated reports', async () => {
      const { sut, ctx } = setup();
      const integrity = ctx.get(IntegrityRepository);
      const storage = ctx.getMock(StorageRepository);

      const {
        result: { id: ownerId },
      } = await ctx.newUser();

      const {
        result: { id: assetId },
      } = await ctx.newAsset({ ownerId, originalPath: '/path/to/file1' });

      const { id: restoredId } = await integrity.create({
        type: IntegrityReport.MissingFile,
        path: '/path/to/restored',
        assetId,
      });

      storage.stat
        .mockResolvedValueOnce({} as never)
        .mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
        .mockResolvedValueOnce({} as never);

      await sut.handleMissingFiles({
        items: [
          { path: '/path/to/existing', assetId, fileAssetId: null, reportId: null },
          { path: '/path/to/missing', assetId, fileAssetId: null, reportId: null },
          { path: '/path/to/restored', assetId, fileAssetId: null, reportId: restoredId },
        ],
      });

      await expect(
        ctx.get(IntegrityRepository).getIntegrityReport(
          {
            limit: 100,
          },
          IntegrityReport.MissingFile,
        ),
      ).resolves.toEqual({
        items: [
          expect.objectContaining({
            path: '/path/to/missing',
          }),
        ],
        nextCursor: undefined,
      });
    });
  });

  describe('handleMissingRefresh', () => {
    it('should succeed', async () => {
      const { sut } = setup();
      await expect(sut.handleMissingRefresh({ items: [] })).resolves.toBe(JobStatus.Success);
    });

    it('should remove outdated reports', async () => {
      const { sut, ctx } = setup();
      const integrity = ctx.get(IntegrityRepository);
      const storage = ctx.getMock(StorageRepository);

      const { id: restoredId } = await integrity.create({
        type: IntegrityReport.MissingFile,
        path: '/path/to/restored',
      });

      storage.stat
        .mockResolvedValueOnce({} as never)
        .mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
        .mockResolvedValueOnce({} as never);

      await sut.handleMissingRefresh({
        items: [
          { path: '/path/to/existing', reportId: null },
          { path: '/path/to/missing', reportId: null },
          { path: '/path/to/restored', reportId: restoredId },
        ],
      });

      await expect(
        ctx.get(IntegrityRepository).getIntegrityReport(
          {
            limit: 100,
          },
          IntegrityReport.MissingFile,
        ),
      ).resolves.toEqual({
        items: [],
        nextCursor: undefined,
      });
    });
  });

  describe('handleChecksumFiles', () => {
    it('should succeed', async () => {
      const { sut } = setup();
      await expect(sut.handleChecksumFiles({ refreshOnly: false })).resolves.toBe(JobStatus.Success);
    });

    it('should queue refresh jobs when refreshOnly', async () => {
      const { sut, ctx } = setup();
      const job = ctx.getMock(JobRepository);
      job.queue.mockResolvedValue(void 0);

      const {
        result: { id: ownerId },
      } = await ctx.newUser();

      const {
        result: { id: assetId },
      } = await ctx.newAsset({ ownerId, originalPath: '/path/to/file1', checksum: Buffer.from('a') });

      const { id: reportId } = await ctx.get(IntegrityRepository).create({
        type: IntegrityReport.ChecksumFail,
        path: '/path/to/file1',
        assetId,
      });

      await sut.handleChecksumFiles({ refreshOnly: true });

      expect(job.queue).toHaveBeenCalledWith({
        name: JobName.IntegrityChecksumFilesRefresh,
        data: {
          items: [{ reportId, path: '/path/to/file1', checksum: '61', checksumAlgorithm: ChecksumAlgorithm.sha1File }],
        },
      });
    });

    it('should create report for checksum mismatch and delete when fixed', async () => {
      const { sut, ctx } = setup();
      const storage = ctx.getMock(StorageRepository);
      const job = ctx.getMock(JobRepository);
      job.queue.mockResolvedValue(void 0);

      const {
        result: { id: ownerId },
      } = await ctx.newUser();

      const {
        result: { id: assetId },
      } = await ctx.newAsset({ ownerId, originalPath: '/path/to/file1', checksum: Buffer.from('mismatched') });

      const fileContent1 = Buffer.from('test content');
      await ctx.newAsset({
        ownerId,
        originalPath: '/path/to/file2',
        checksum: createHash('sha1').update(fileContent1).digest(),
      });

      const fileContent2 = Buffer.from('test content 2');
      const {
        result: { id: assetId3 },
      } = await ctx.newAsset({
        ownerId,
        originalPath: '/path/to/file3',
        checksum: createHash('sha1').update(fileContent2).digest(),
      });

      await ctx.get(IntegrityRepository).create({
        type: IntegrityReport.ChecksumFail,
        path: '/path/to/file3',
        assetId: assetId3,
      });

      storage.createPlainReadStream.mockImplementation((path) =>
        Readable.from(
          path === '/path/to/file2' ? fileContent1 : path === '/path/to/file3' ? fileContent2 : 'garbage data',
        ),
      );

      await sut.handleChecksumFiles({ refreshOnly: false });

      await expect(
        ctx.get(IntegrityRepository).getIntegrityReport(
          {
            limit: 100,
          },
          IntegrityReport.ChecksumFail,
        ),
      ).resolves.toEqual({
        items: [
          expect.objectContaining({
            assetId,
            path: '/path/to/file1',
          }),
        ],
        nextCursor: undefined,
      });
    });

    it('should skip missing files', async () => {
      const { sut, ctx } = setup();
      const storage = ctx.getMock(StorageRepository);
      const job = ctx.getMock(JobRepository);
      job.queue.mockResolvedValue(void 0);

      const {
        result: { id: ownerId },
      } = await ctx.newUser();

      await ctx.newAsset({ ownerId, originalPath: '/path/to/file1', checksum: Buffer.from('a') });

      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      storage.createPlainReadStream.mockImplementation(() => {
        throw error;
      });

      await sut.handleChecksumFiles({ refreshOnly: false });

      await expect(
        ctx.get(IntegrityRepository).getIntegrityReport(
          {
            limit: 100,
          },
          IntegrityReport.ChecksumFail,
        ),
      ).resolves.toEqual({
        items: [],
        nextCursor: undefined,
      });
    });

    it('should skip external library files', async () => {
      const { sut, ctx } = setup();
      const job = ctx.getMock(JobRepository);
      job.queue.mockResolvedValue(void 0);

      const { user } = await ctx.newUser();

      await ctx.newAsset({ ownerId: user.id, isExternal: true });

      await sut.handleChecksumFiles({ refreshOnly: false });

      await expect(
        ctx.get(IntegrityRepository).getIntegrityReport({ limit: 100 }, IntegrityReport.ChecksumFail),
      ).resolves.toEqual({ items: [], nextCursor: undefined });
    });

    it('should continue from checkpoint', async () => {
      const { sut, ctx } = setup();
      const job = ctx.getMock(JobRepository);
      job.queue.mockResolvedValue();

      const { user } = await ctx.newUser();

      await ctx.newAsset({
        ownerId: user.id,
        createdAt: DateTime.now().minus({ days: 1 }).toISO(),
        originalPath: '/foo/bar',
      });
      await ctx.newAsset({ ownerId: user.id, originalPath: '/foo/baz' });

      await ctx
        .get(SystemMetadataRepository)
        .set(SystemMetadataKey.IntegrityChecksumCheckpoint, { date: DateTime.now().minus({ minutes: 5 }).toISO() });

      await sut.handleChecksumFiles({ refreshOnly: false });

      expect(ctx.getMock(StorageRepository).createPlainReadStream).not.toHaveBeenCalledWith('/foo/bar');
      expect(ctx.getMock(StorageRepository).createPlainReadStream).toHaveBeenCalledWith('/foo/baz');
    });
  });

  describe('handleChecksumRefresh', () => {
    it('should succeed', async () => {
      const { sut } = setup();
      await expect(sut.handleChecksumRefresh({ items: [] })).resolves.toBe(JobStatus.Success);
    });

    it('should delete reports when checksum now matches, file is missing, or asset is now missing', async () => {
      const { sut, ctx } = setup();
      const integrity = ctx.get(IntegrityRepository);
      const storage = ctx.getMock(StorageRepository);
      const job = ctx.getMock(JobRepository);
      job.queue.mockResolvedValue(void 0);

      const fileContent = Buffer.from('test content');
      const correctChecksum = createHash('sha1').update(fileContent).digest();

      const {
        result: { id: ownerId },
      } = await ctx.newUser();

      const {
        result: { id: fixedAssetId },
      } = await ctx.newAsset({ ownerId, originalPath: '/path/to/fixed', checksum: correctChecksum });

      const { id: fixedReportId } = await integrity.create({
        type: IntegrityReport.ChecksumFail,
        path: '/path/to/fixed',
        assetId: fixedAssetId,
      });

      const {
        result: { id: missingAssetId },
      } = await ctx.newAsset({ ownerId, originalPath: '/path/to/missing', checksum: Buffer.from('1') });

      const { id: missingReportId } = await integrity.create({
        type: IntegrityReport.ChecksumFail,
        path: '/path/to/missing',
        assetId: missingAssetId,
      });

      const {
        result: { id: badAssetId },
      } = await ctx.newAsset({ ownerId, originalPath: '/path/to/bad', checksum: Buffer.from('2') });

      const { id: badReportId } = await integrity.create({
        type: IntegrityReport.ChecksumFail,
        path: '/path/to/bad',
        assetId: badAssetId,
      });

      const { id: missingAssetReportId } = await integrity.create({
        type: IntegrityReport.ChecksumFail,
        path: '/path/to/missing-asset',
      });

      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';

      storage.createPlainReadStream.mockImplementation((path) => {
        if (path === '/path/to/missing') {
          throw error;
        }
        return Readable.from(fileContent);
      });

      await sut.handleChecksumRefresh({
        items: [
          { reportId: fixedReportId, path: '/path/to/fixed', checksum: correctChecksum.toString('hex') },
          { reportId: missingReportId, path: '/path/to/missing', checksum: 'abc123' },
          { reportId: badReportId, path: '/path/to/bad', checksum: 'wrongchecksum' },
          { reportId: missingAssetReportId, path: '/path/to/missing-asset', checksum: null },
        ],
      });

      await expect(
        ctx.get(IntegrityRepository).getIntegrityReport(
          {
            limit: 100,
          },
          IntegrityReport.ChecksumFail,
        ),
      ).resolves.toEqual({
        items: [
          expect.objectContaining({
            id: badReportId,
            assetId: badAssetId,
            path: '/path/to/bad',
          }),
        ],
        nextCursor: undefined,
      });
    });
  });

  describe('handleDeleteAllIntegrityReports', () => {
    it('should succeed', async () => {
      const { sut } = setup();
      await expect(sut.handleDeleteAllIntegrityReports({})).resolves.toBe(JobStatus.Success);
    });

    it('should queue delete jobs for checksum fail reports', async () => {
      const { sut, ctx } = setup();
      const integrity = ctx.get(IntegrityRepository);
      const job = ctx.getMock(JobRepository);
      job.queue.mockResolvedValue(void 0);

      const {
        result: { id: ownerId },
      } = await ctx.newUser();

      const {
        result: { id: assetId },
      } = await ctx.newAsset({ ownerId, originalPath: '/path/to/file1' });

      const { id: reportId } = await integrity.create({
        type: IntegrityReport.ChecksumFail,
        path: '/path/to/file1',
        assetId,
      });

      await sut.handleDeleteAllIntegrityReports({ type: IntegrityReport.ChecksumFail });

      expect(job.queue).toHaveBeenCalledWith({
        name: JobName.IntegrityDeleteReports,
        data: {
          reports: [{ id: reportId, assetId, path: '/path/to/file1', fileAssetId: null }],
        },
      });
    });

    it('should queue delete jobs for missing file reports by assetId and fileAssetId', async () => {
      const { sut, ctx } = setup();
      const integrity = ctx.get(IntegrityRepository);
      const job = ctx.getMock(JobRepository);
      job.queue.mockResolvedValue(void 0);

      const {
        result: { id: ownerId },
      } = await ctx.newUser();

      const {
        result: { id: assetId },
      } = await ctx.newAsset({ ownerId, originalPath: '/path/to/file1' });

      const { id: assetReportId } = await integrity.create({
        type: IntegrityReport.MissingFile,
        path: '/path/to/file1',
        assetId,
      });

      const {
        result: { id: assetId2 },
      } = await ctx.newAsset({ ownerId, originalPath: '/path/to/file2' });

      const fileAssetId = randomUUID();
      await ctx.newAssetFile({
        id: fileAssetId,
        assetId: assetId2,
        path: '/path/to/file3',
        type: AssetFileType.Thumbnail,
      });

      const { id: fileAssetReportId } = await integrity.create({
        type: IntegrityReport.MissingFile,
        path: '/path/to/file3',
        fileAssetId,
      });

      await sut.handleDeleteAllIntegrityReports({ type: IntegrityReport.MissingFile });

      expect(job.queue).toHaveBeenCalledTimes(2);

      expect(job.queue).toHaveBeenCalledWith({
        name: JobName.IntegrityDeleteReports,
        data: {
          reports: [{ id: assetReportId, assetId, path: '/path/to/file1', fileAssetId: null }],
        },
      });

      expect(job.queue).toHaveBeenCalledWith({
        name: JobName.IntegrityDeleteReports,
        data: {
          reports: [{ id: fileAssetReportId, assetId: null, path: '/path/to/file3', fileAssetId }],
        },
      });
    });

    it('should queue delete jobs for untracked file reports', async () => {
      const { sut, ctx } = setup();
      const integrity = ctx.get(IntegrityRepository);
      const job = ctx.getMock(JobRepository);
      job.queue.mockResolvedValue(void 0);

      const { id: reportId } = await integrity.create({
        type: IntegrityReport.UntrackedFile,
        path: '/path/to/untracked',
      });

      await sut.handleDeleteAllIntegrityReports({ type: IntegrityReport.UntrackedFile });

      expect(job.queue).toHaveBeenCalledWith({
        name: JobName.IntegrityDeleteReports,
        data: {
          reports: [{ id: reportId, path: '/path/to/untracked', assetId: null, fileAssetId: null }],
        },
      });
    });
  });

  describe('handleDeleteIntegrityReports', () => {
    it('should succeed', async () => {
      const { sut } = setup();
      await expect(sut.handleDeleteIntegrityReports({ reports: [] })).resolves.toBe(JobStatus.Success);
    });

    it('should handle all report types', async () => {
      const { sut, ctx } = setup();
      const integrity = ctx.get(IntegrityRepository);
      const storage = ctx.getMock(StorageRepository);
      const events = ctx.getMock(EventRepository);

      storage.unlink.mockResolvedValue(void 0);
      events.emit.mockResolvedValue(void 0);

      const {
        result: { id: ownerId },
      } = await ctx.newUser();

      const {
        result: { id: assetId1 },
      } = await ctx.newAsset({ ownerId, originalPath: '/path/to/file1' });

      const { id: reportId1 } = await integrity.create({
        path: '/path/to/file1',
        type: IntegrityReport.ChecksumFail,
        assetId: assetId1,
      });

      const {
        result: { id: assetId2 },
      } = await ctx.newAsset({ ownerId, originalPath: '/path/to/file2' });

      const { id: reportId2 } = await integrity.create({
        path: '/path/to/file2',
        type: IntegrityReport.MissingFile,
        assetId: assetId2,
      });

      const {
        result: { id: assetId3 },
      } = await ctx.newAsset({ ownerId, originalPath: '/path/to/file3' });

      const fileAssetId = randomUUID();
      await ctx.newAssetFile({
        id: fileAssetId,
        assetId: assetId3,
        path: '/path/to/file4',
        type: AssetFileType.Thumbnail,
      });

      const { id: reportId3 } = await integrity.create({
        path: '/path/to/file4',
        type: IntegrityReport.MissingFile,
        fileAssetId,
      });

      const { id: reportId4 } = await integrity.create({
        path: '/path/to/untracked',
        type: IntegrityReport.UntrackedFile,
      });

      await sut.handleDeleteIntegrityReports({
        reports: [
          { id: reportId1, assetId: assetId1, fileAssetId: null, path: '/path/to/file1' },
          { id: reportId2, assetId: assetId2, fileAssetId: null, path: '/path/to/file2' },
          { id: reportId3, assetId: null, fileAssetId, path: '/path/to/file4' },
          { id: reportId4, assetId: null, fileAssetId: null, path: '/path/to/untracked' },
        ],
      });

      expect(events.emit).toHaveBeenCalledWith('AssetTrashAll', {
        assetIds: [assetId1, assetId2],
        userId: '',
      });

      expect(storage.unlink).toHaveBeenCalledWith('/path/to/untracked');

      await expect(ctx.get(AssetRepository).getByIds([assetId1, assetId2, assetId3])).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: assetId1,
            status: 'trashed',
          }),
          expect.objectContaining({
            id: assetId2,
            status: 'trashed',
          }),
          expect.objectContaining({
            id: assetId3,
            status: 'active',
          }),
        ]),
      );

      await expect(defaultDatabase.selectFrom('asset_file').execute()).resolves.toEqual([]);
      await expect(defaultDatabase.selectFrom('integrity_report').execute()).resolves.toEqual([]);
    });
  });
});
