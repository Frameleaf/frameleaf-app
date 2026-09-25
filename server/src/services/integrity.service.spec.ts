import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { ChecksumAlgorithm, IntegrityReport, SystemMetadataKey } from 'src/enum.js';
import { IntegrityService } from 'src/services/integrity.service.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(IntegrityService.name, () => {
  let sut: IntegrityService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(IntegrityService));
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('Library care → Audit database and file references (FL-69)', () => {
    const config = (integrityAudit: boolean) =>
      ({
        integrityChecks: {
          untrackedFiles: { enabled: true, cronExpression: '0 03 * * *' },
          missingFiles: { enabled: true, cronExpression: '0 03 * * *' },
          checksumFiles: { enabled: true, cronExpression: '0 03 * * *' },
        },
        libraryCare: { integrityAudit },
      }) as never;

    beforeEach(() => {
      mocks.database.tryLock.mockResolvedValue(true);
      mocks.cron.create.mockReturnValue();
      mocks.cron.update.mockReturnValue();
    });

    it('stops the scheduled reference checks while the audit is off, keeping the checksum check', async () => {
      await sut.onConfigInit({ newConfig: config(false) });

      expect(mocks.cron.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'integrityUntrackedFiles', start: false }),
      );
      expect(mocks.cron.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'integrityMissingFiles', start: false }),
      );
      expect(mocks.cron.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'integrityChecksumFiles', start: true }),
      );
    });

    it('runs each reference check on its own switch while the audit is on', async () => {
      await sut.onConfigInit({ newConfig: config(true) });
      sut.onConfigUpdate({ newConfig: config(false) } as never);

      expect(mocks.cron.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'integrityMissingFiles', start: true }),
      );
      expect(mocks.cron.update).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'integrityMissingFiles', start: false }),
      );
    });
  });

  describe('handleChecksumFiles', () => {
    const contents = Buffer.from('the-file-bytes');
    const sha256 = createHash('sha256').update(contents).digest();
    const sha1 = createHash('sha1').update(contents).digest();

    const streamAsset = (checksum: Buffer, checksumAlgorithm: ChecksumAlgorithm) => {
      mocks.integrityReport.getAssetCount.mockResolvedValue({ count: 1 } as never);
      mocks.systemMetadata.get.mockResolvedValue(null);
      mocks.integrityReport.streamAssetChecksums.mockReturnValue(
        (function* () {
          yield {
            assetId: 'asset-1',
            originalPath: '/data/library/asset-1.jpg',
            checksum,
            checksumAlgorithm,
            createdAt: new Date(),
            reportId: null,
          };
        })() as never,
      );
      mocks.storage.createPlainReadStream.mockReturnValue(Readable.from([contents]) as never);
    };

    it('should backfill a sha1 for a verified sha256 asset', async () => {
      // Clients pre-check duplicates with sha1; assets uploaded before that
      // digest was recorded get one here, off the verification read.
      streamAsset(sha256, ChecksumAlgorithm.sha256File);

      await sut.handleChecksumFiles({});

      expect(mocks.forkSchema.recordAssetChecksums).toHaveBeenCalledWith({
        assetId: 'asset-1',
        sha1,
        sha256,
        sizeInBytes: contents.length,
        path: '/data/library/asset-1.jpg',
        source: 'integrity',
      });
    });

    it('should backfill a sha256 for a verified sha1 asset', async () => {
      streamAsset(sha1, ChecksumAlgorithm.sha1File);

      await sut.handleChecksumFiles({});

      expect(mocks.forkSchema.recordAssetChecksums).toHaveBeenCalledWith({
        assetId: 'asset-1',
        sha1,
        sha256,
        sizeInBytes: contents.length,
        path: '/data/library/asset-1.jpg',
        source: 'integrity',
      });
    });

    it('should not record digests when the file fails verification', async () => {
      streamAsset(createHash('sha256').update('different').digest(), ChecksumAlgorithm.sha256File);

      await sut.handleChecksumFiles({});

      expect(mocks.forkSchema.recordAssetChecksums).not.toHaveBeenCalled();
    });
  });

  describe('handleUntrackedRefresh', () => {
    beforeEach(() => {
      mocks.integrityReport.getTrackedPaths.mockResolvedValue([]);
    });

    it('should delete a report whose path is now referenced by an asset', async () => {
      const path = '/data/upload/admin/ab/asset.mov';
      mocks.integrityReport.getTrackedPaths.mockResolvedValue([{ path }] as never);

      await sut.handleUntrackedRefresh({ items: [{ reportId: 'report-id', path }] });

      expect(mocks.integrityReport.deleteByIds).toHaveBeenCalledWith(['report-id']);
      expect(mocks.storage.stat).not.toHaveBeenCalled();
    });

    it('should keep a report whose path is still untracked and present on disk', async () => {
      mocks.storage.stat.mockResolvedValue({} as never);

      await sut.handleUntrackedRefresh({ items: [{ reportId: 'report-id', path: '/data/upload/orphan.mov' }] });

      expect(mocks.integrityReport.deleteByIds).not.toHaveBeenCalled();
    });

    it('should not query for references when the batch is empty', async () => {
      await sut.handleUntrackedRefresh({ items: [] });

      expect(mocks.integrityReport.getTrackedPaths).not.toHaveBeenCalled();
      expect(mocks.integrityReport.deleteByIds).not.toHaveBeenCalled();
    });
  });

  describe('deleteIntegrityReport', () => {
    it('should not unlink a path that is now tracked', async () => {
      const path = '/data/upload/admin/ab/asset.mov';
      mocks.integrityReport.getById.mockResolvedValue({ path } as never);
      mocks.integrityReport.getTrackedPaths.mockResolvedValue([{ path }] as never);

      await sut.deleteIntegrityReport('user-id', 'report-id');

      expect(mocks.storage.unlink).not.toHaveBeenCalled();
      expect(mocks.integrityReport.deleteById).toHaveBeenCalledWith('report-id');
    });
  });

  describe('handleDeleteIntegrityReports', () => {
    it('should unlink only paths that are still untracked', async () => {
      const tracked = '/data/upload/admin/ab/asset.mov';
      const untracked = '/data/upload/orphan.mov';
      mocks.integrityReport.getTrackedPaths.mockResolvedValue([{ path: tracked }] as never);
      mocks.storage.unlink.mockResolvedValue();

      await sut.handleDeleteIntegrityReports({
        reports: [
          { id: 'tracked-report', path: tracked },
          { id: 'untracked-report', path: untracked },
        ] as never,
      });

      expect(mocks.storage.unlink).toHaveBeenCalledExactlyOnceWith(untracked);
      expect(mocks.integrityReport.deleteByIds).toHaveBeenCalledWith(['tracked-report', 'untracked-report']);
    });
  });

  describe('handleDeleteAllIntegrityReports', () => {
    beforeEach(() => {
      mocks.integrityReport.streamIntegrityReportsByProperty.mockReturnValue((function* () {})() as never);
    });

    it('should query all property types when no type specified', async () => {
      await sut.handleDeleteAllIntegrityReports({});

      expect(mocks.integrityReport.streamIntegrityReportsByProperty).toHaveBeenCalledWith(undefined, undefined);
      expect(mocks.integrityReport.streamIntegrityReportsByProperty).toHaveBeenCalledWith('assetId', undefined);
      expect(mocks.integrityReport.streamIntegrityReportsByProperty).toHaveBeenCalledWith('fileAssetId', undefined);
    });
  });

  describe('integrity check runs (FL-81 CC-21)', () => {
    it('reports when each check last ran, null for one that never has', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        [IntegrityReport.MissingFile]: { lastRunAt: '2026-09-20T10:00:00.000Z' },
      });

      await expect(sut.getIntegrityCheckRuns()).resolves.toEqual({
        [IntegrityReport.ChecksumFail]: null,
        [IntegrityReport.MissingFile]: '2026-09-20T10:00:00.000Z',
        [IntegrityReport.UntrackedFile]: null,
      });
      expect(mocks.systemMetadata.get).toHaveBeenCalledWith(SystemMetadataKey.IntegrityCheckRuns);
    });

    it('reports every check as never run before any run is recorded', async () => {
      mocks.systemMetadata.get.mockResolvedValue(null);

      await expect(sut.getIntegrityCheckRuns()).resolves.toEqual({
        [IntegrityReport.ChecksumFail]: null,
        [IntegrityReport.MissingFile]: null,
        [IntegrityReport.UntrackedFile]: null,
      });
    });

    it('starts a missing-file run and completes it once every batch is queued and finished', async () => {
      mocks.crypto.randomUUID.mockReturnValue('run-1');
      mocks.integrityReport.streamIntegrityReportsWithAssetChecksum.mockReturnValue((async function* () {})() as never);
      await sut.handleMissingFilesQueueAll({ refreshOnly: true });
      expect(mocks.systemMetadata.startIntegrityRun).not.toHaveBeenCalled();

      mocks.integrityReport.streamAssetPathsForMissingFiles.mockReturnValue(
        (function* () {
          yield { path: '/a', reportId: null, assetId: 'a', fileAssetId: null };
        })() as never,
      );
      // Queued, but the batch has not finished yet: not complete.
      mocks.systemMetadata.updateIntegrityRun.mockResolvedValueOnce({
        runId: 'run-1',
        startedAt: '',
        batches: 1,
        done: 0,
      });
      await sut.handleMissingFilesQueueAll();

      expect(mocks.systemMetadata.startIntegrityRun).toHaveBeenCalledWith(
        IntegrityReport.MissingFile,
        expect.objectContaining({ runId: 'run-1', batches: null, done: 0 }),
      );
      expect(mocks.job.queue).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ runId: 'run-1' }) }),
      );
      expect(mocks.systemMetadata.updateIntegrityRun).toHaveBeenCalledWith(IntegrityReport.MissingFile, 'run-1', {
        batches: 1,
      });
      expect(mocks.systemMetadata.completeIntegrityRun).not.toHaveBeenCalled();

      // The last batch finishes: the run completes.
      mocks.storage.stat.mockResolvedValue({} as never);
      mocks.systemMetadata.updateIntegrityRun.mockResolvedValueOnce({
        runId: 'run-1',
        startedAt: '',
        batches: 1,
        done: 1,
      });
      await sut.handleMissingFiles({
        runId: 'run-1',
        items: [{ path: '/a', reportId: null, assetId: 'a', fileAssetId: null }],
      });
      expect(mocks.systemMetadata.updateIntegrityRun).toHaveBeenLastCalledWith(IntegrityReport.MissingFile, 'run-1', {
        finished: 1,
      });
      expect(mocks.systemMetadata.completeIntegrityRun).toHaveBeenCalledWith(
        IntegrityReport.MissingFile,
        'run-1',
        expect.any(Date),
      );
    });

    it('completes an untracked-file run with no batches at once', async () => {
      mocks.crypto.randomUUID.mockReturnValue('run-2');
      mocks.integrityReport.streamIntegrityReportsWithAssetChecksum.mockReturnValue((async function* () {})() as never);
      mocks.storage.walk.mockReturnValue((async function* () {})() as never);
      mocks.systemMetadata.updateIntegrityRun.mockResolvedValue({ runId: 'run-2', startedAt: '', batches: 0, done: 0 });

      await sut.handleUntrackedFilesQueueAll();

      expect(mocks.systemMetadata.completeIntegrityRun).toHaveBeenCalledWith(
        IntegrityReport.UntrackedFile,
        'run-2',
        expect.any(Date),
      );
    });

    it('does not count a batch of a run that is no longer current, or one without a run', async () => {
      mocks.integrityReport.getAssetPathsByPaths.mockResolvedValue([]);
      mocks.integrityReport.getAssetFilePathsByPaths.mockResolvedValue([]);
      mocks.integrityReport.getPersonThumbnailPathsByPaths.mockResolvedValue([]);
      mocks.integrityReport.getVideoDuplicateFramePathsByPaths.mockResolvedValue([]);
      mocks.integrityReport.getDevelopRevisionPathsByPaths.mockResolvedValue([]);
      mocks.systemMetadata.updateIntegrityRun.mockResolvedValue(undefined);

      await sut.handleUntrackedFiles({ type: 'asset', paths: [], runId: 'stale' });
      await sut.handleUntrackedFiles({ type: 'asset', paths: [] });

      expect(mocks.systemMetadata.updateIntegrityRun).toHaveBeenCalledTimes(1);
      expect(mocks.systemMetadata.completeIntegrityRun).not.toHaveBeenCalled();
    });

    it('records a checksum pass that covered every asset, and not one stopped by its limits', async () => {
      mocks.crypto.randomUUID.mockReturnValue('run-3');
      mocks.integrityReport.getAssetCount.mockResolvedValue({ count: 0 } as never);
      mocks.systemMetadata.get.mockResolvedValue(null);
      mocks.integrityReport.streamAssetChecksums.mockReturnValue((function* () {})() as never);

      await sut.handleChecksumFiles();

      expect(mocks.systemMetadata.completeIntegrityRun).toHaveBeenCalledWith(
        IntegrityReport.ChecksumFail,
        'run-3',
        expect.any(Date),
      );
    });
  });
});
