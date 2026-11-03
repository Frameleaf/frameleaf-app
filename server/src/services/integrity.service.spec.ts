import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { ChecksumAlgorithm, IntegrityReport, JobStatus, SystemMetadataKey } from 'src/enum.js';
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

    it('starts none of the checks on a timer of its own: the overnight schedule runs them (FL-363)', async () => {
      await sut.onConfigInit({ newConfig: config(true) });
      sut.onConfigUpdate({ newConfig: config(false) } as never);

      for (const name of ['integrityUntrackedFiles', 'integrityMissingFiles', 'integrityChecksumFiles']) {
        expect(mocks.cron.create).toHaveBeenCalledWith(expect.objectContaining({ name, start: false }));
        expect(mocks.cron.update).toHaveBeenCalledWith(expect.objectContaining({ name, start: false }));
      }
    });
  });

  describe('handleChecksumFiles', () => {
    const contents = Buffer.from('the-file-bytes');
    const sha256 = createHash('sha256').update(contents).digest();
    const sha1 = createHash('sha1').update(contents).digest();

    const streamAsset = (checksum: Buffer, checksumAlgorithm: ChecksumAlgorithm) => {
      mocks.integrityReport.recordVerification.mockResolvedValue(true);
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
      // Upstream Immich clients pre-check duplicates with sha1; assets uploaded
      // before that digest was recorded get one here, off the verification read.
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

    it('moves a verified sha1 upload to its sha256 and keeps it verified under that checksum', async () => {
      streamAsset(sha1, ChecksumAlgorithm.sha1File);
      mocks.forkSchema.promoteToSha256.mockResolvedValue(true);

      await expect(sut.handleChecksumFiles({})).resolves.toBe(JobStatus.Success);

      expect(mocks.forkSchema.promoteToSha256).toHaveBeenCalledWith({ assetId: 'asset-1', sha1, sha256 });
      // the sha1 is recorded first, so upstream clients' sha1 pre-checks still translate once it moved
      expect(mocks.forkSchema.recordAssetChecksums.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.forkSchema.promoteToSha256.mock.invocationCallOrder[0],
      );
      expect(mocks.integrityReport.recordVerification).toHaveBeenCalledTimes(2);
      expect(mocks.integrityReport.recordVerification).toHaveBeenLastCalledWith({
        assetId: 'asset-1',
        originalPath: '/data/library/asset-1.jpg',
        expectedChecksum: sha256,
        checksumAlgorithm: ChecksumAlgorithm.sha256File,
        actualSha256: sha256.toString('hex'),
        result: 'passed',
      });
    });

    it.each([ChecksumAlgorithm.sha256File, ChecksumAlgorithm.sha1Path])('leaves a %s asset', async (algorithm) => {
      streamAsset(algorithm === ChecksumAlgorithm.sha256File ? sha256 : sha1, algorithm);

      await expect(sut.handleChecksumFiles({})).resolves.toBe(JobStatus.Success);

      expect(mocks.forkSchema.promoteToSha256).not.toHaveBeenCalled();
    });

    it('does not move a sha1 asset whose file fails verification', async () => {
      streamAsset(createHash('sha1').update('different').digest(), ChecksumAlgorithm.sha1File);

      await sut.handleChecksumFiles({});

      expect(mocks.forkSchema.recordAssetChecksums).not.toHaveBeenCalled();
      expect(mocks.forkSchema.promoteToSha256).not.toHaveBeenCalled();
      expect(mocks.integrityReport.create).toHaveBeenCalledWith(
        expect.objectContaining({ type: IntegrityReport.ChecksumFail, assetId: 'asset-1' }),
      );
    });

    it('keeps a sha1 asset when another upload of its owner holds that sha256, and still succeeds', async () => {
      streamAsset(sha1, ChecksumAlgorithm.sha1File);
      // what the repository answers on UQ_assets_owner_checksum: a real duplicate, left for duplicate review
      mocks.forkSchema.promoteToSha256.mockResolvedValue(false);

      await expect(sut.handleChecksumFiles({})).resolves.toBe(JobStatus.Success);

      expect(mocks.forkSchema.recordAssetChecksums).toHaveBeenCalledWith({
        assetId: 'asset-1',
        sha1,
        sha256,
        sizeInBytes: contents.length,
        path: '/data/library/asset-1.jpg',
        source: 'integrity',
      });
      expect(mocks.forkSchema.promoteToSha256).toHaveBeenCalledWith({ assetId: 'asset-1', sha1, sha256 });
      expect(mocks.integrityReport.recordVerification).toHaveBeenCalledTimes(1);
      expect(mocks.integrityReport.recordVerification).toHaveBeenCalledWith(
        expect.objectContaining({ expectedChecksum: sha1, checksumAlgorithm: ChecksumAlgorithm.sha1File }),
      );
      expect(mocks.integrityReport.create).not.toHaveBeenCalled();
    });

    it('should not record digests when the file fails verification', async () => {
      streamAsset(createHash('sha256').update('different').digest(), ChecksumAlgorithm.sha256File);

      await sut.handleChecksumFiles({});

      expect(mocks.forkSchema.recordAssetChecksums).not.toHaveBeenCalled();
      expect(mocks.integrityReport.recordVerification).toHaveBeenCalledWith(
        expect.objectContaining({ result: 'mismatched', actualSha256: sha256.toString('hex') }),
      );
    });

    it.each([
      ['missing', 'ENOENT'],
      ['unreadable', 'EACCES'],
    ])('records an actual %s outcome without inventing a digest', async (result, code) => {
      streamAsset(sha256, ChecksumAlgorithm.sha256File);
      mocks.storage.createPlainReadStream.mockImplementation(() => {
        throw Object.assign(new Error(code), { code });
      });
      await sut.handleChecksumFiles({});
      expect(mocks.integrityReport.recordVerification).toHaveBeenCalledWith(
        expect.objectContaining({ result, actualSha256: null }),
      );
      expect(mocks.forkSchema.recordAssetChecksums).not.toHaveBeenCalled();
    });

    it('records repeated successful checks independently of the immutable baseline', async () => {
      streamAsset(sha256, ChecksumAlgorithm.sha256File);
      await sut.handleChecksumFiles({});
      streamAsset(sha256, ChecksumAlgorithm.sha256File);
      await sut.handleChecksumFiles({});
      expect(mocks.integrityReport.recordVerification).toHaveBeenCalledTimes(2);
      expect(mocks.integrityReport.recordVerification).toHaveBeenLastCalledWith({
        assetId: 'asset-1',
        originalPath: '/data/library/asset-1.jpg',
        expectedChecksum: sha256,
        checksumAlgorithm: ChecksumAlgorithm.sha256File,
        actualSha256: sha256.toString('hex'),
        result: 'passed',
      });
    });

    it('does not publish a stale check into baseline or failure reports', async () => {
      streamAsset(sha256, ChecksumAlgorithm.sha256File);
      mocks.integrityReport.recordVerification.mockResolvedValue(false);
      await sut.handleChecksumFiles({});
      expect(mocks.forkSchema.recordAssetChecksums).not.toHaveBeenCalled();
      expect(mocks.integrityReport.create).not.toHaveBeenCalled();
    });

    it('does not move a sha1 asset whose check went stale', async () => {
      streamAsset(sha1, ChecksumAlgorithm.sha1File);
      mocks.integrityReport.recordVerification.mockResolvedValue(false);
      await sut.handleChecksumFiles({});
      expect(mocks.forkSchema.promoteToSha256).not.toHaveBeenCalled();
    });

    it('counts an encrypted Locked original as encrypted and never reads or reports it (FL-721)', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'integrity-locked-'));
      const sealed = join(directory, 'sealed.jpg');
      await writeFile(sealed, Buffer.concat([Buffer.from('FLLK'), Buffer.alloc(64, 1)]));
      try {
        streamAsset(sha256, ChecksumAlgorithm.sha256File);
        mocks.integrityReport.streamAssetChecksums.mockReturnValue(
          (function* () {
            yield {
              assetId: 'asset-1',
              originalPath: sealed,
              checksum: sha256,
              checksumAlgorithm: ChecksumAlgorithm.sha256File,
              createdAt: new Date(),
              reportId: 'report-1',
            };
          })() as never,
        );
        mocks.systemMetadata.completeIntegrityRun.mockResolvedValue(true);
        mocks.integrityReport.getIntegrityReportSummary.mockResolvedValue({} as never);

        await sut.handleChecksumFiles({});

        expect(mocks.storage.createPlainReadStream).not.toHaveBeenCalled();
        expect(mocks.integrityReport.recordVerification).not.toHaveBeenCalled();
        expect(mocks.integrityReport.create).not.toHaveBeenCalled();
        expect(mocks.integrityReport.deleteById).not.toHaveBeenCalled();
        expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.IntegrityCheckHistory, {
          entries: [expect.objectContaining({ type: IntegrityReport.ChecksumFail, checked: 0, encrypted: 1 })],
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it('propagates proof persistence failures without misreporting a file failure', async () => {
      streamAsset(sha256, ChecksumAlgorithm.sha256File);
      mocks.integrityReport.recordVerification.mockRejectedValue(new Error('database unavailable'));
      await expect(sut.handleChecksumFiles({})).rejects.toThrow('database unavailable');
      expect(mocks.integrityReport.create).not.toHaveBeenCalled();
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
    it('unlinks an untracked path only through the reference-counted guard', async () => {
      const path = '/data/upload/orphan.mov';
      mocks.integrityReport.getById.mockResolvedValue({ path } as never);
      mocks.integrityReport.getTrackedPaths.mockResolvedValue([]);
      mocks.physicalFile.deleteUnreferencedPath.mockImplementation(async (_path, unlink) => {
        await unlink();
        return { deleted: true, references: 0 };
      });

      await sut.deleteIntegrityReport('user-id', 'report-id');

      expect(mocks.physicalFile.deleteUnreferencedPath).toHaveBeenCalledWith(path, expect.any(Function), {
        trash: { move: expect.any(Function) },
      });
      expect(mocks.storage.unlink).toHaveBeenCalledExactlyOnceWith(path);
      expect(mocks.integrityReport.deleteById).toHaveBeenCalledWith('report-id');
    });

    it('moves a registered original to the file trash, never unlinking it (FL-412)', async () => {
      const path = '/data/upload/user/stored.jpg';
      mocks.integrityReport.getById.mockResolvedValue({ path } as never);
      mocks.integrityReport.getTrackedPaths.mockResolvedValue([]);
      mocks.physicalFile.deleteUnreferencedPath.mockImplementation(async (_path, _unlink, options) => {
        await options!.trash!.move(path, '/data/file-trash/id/stored.jpg');
        return { deleted: true, references: 0, trashed: true };
      });

      await sut.deleteIntegrityReport('user-id', 'report-id');

      expect(mocks.storage.rename).toHaveBeenCalledWith(path, '/data/file-trash/id/stored.jpg');
      expect(mocks.storage.unlink).not.toHaveBeenCalled();
    });

    it('never unlinks a path something references, such as a shared original', async () => {
      const path = '/data/library/primary/shared.jpg';
      mocks.integrityReport.getById.mockResolvedValue({ path } as never);
      mocks.integrityReport.getTrackedPaths.mockResolvedValue([]);
      mocks.physicalFile.deleteUnreferencedPath.mockResolvedValue({ deleted: false, references: 2 });

      await sut.deleteIntegrityReport('user-id', 'report-id');

      expect(mocks.storage.unlink).not.toHaveBeenCalled();
      expect(mocks.integrityReport.deleteById).toHaveBeenCalledWith('report-id');
    });
  });

  describe('encrypted Locked files (FL-721, spec §8.3)', () => {
    let directory: string;
    let sealed: string;

    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), 'integrity-locked-delete-'));
      sealed = join(directory, 'sealed.jpg');
      await writeFile(sealed, Buffer.concat([Buffer.from('FLLK'), Buffer.alloc(64, 1)]));
    });

    afterEach(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    it('Delete never trashes an item whose original is sealed, and drops the stale report', async () => {
      mocks.integrityReport.getById.mockResolvedValue({ id: 'report-id', path: sealed, assetId: 'asset-id' } as never);
      mocks.asset.getByIds.mockResolvedValue([{ id: 'asset-id', originalPath: sealed }] as never);

      await sut.deleteIntegrityReport('user-id', 'report-id');

      expect(mocks.asset.updateAll).not.toHaveBeenCalled();
      expect(mocks.event.emit).not.toHaveBeenCalledWith('AssetTrashAll', expect.anything());
      expect(mocks.integrityReport.deleteById).toHaveBeenCalledWith('report-id');
    });

    it('Delete checks the original the item has now, not only the reported path', async () => {
      mocks.integrityReport.getById.mockResolvedValue({
        id: 'report-id',
        path: '/data/library/moved-away.jpg',
        assetId: 'asset-id',
      } as never);
      mocks.asset.getByIds.mockResolvedValue([{ id: 'asset-id', originalPath: sealed }] as never);

      await sut.deleteIntegrityReport('user-id', 'report-id');

      expect(mocks.asset.updateAll).not.toHaveBeenCalled();
    });

    it('Delete all trashes only the items whose originals are not sealed', async () => {
      mocks.asset.getByIds.mockResolvedValue([
        { id: 'sealed-asset', originalPath: sealed },
        { id: 'plain-asset', originalPath: '/data/library/plain.jpg' },
      ] as never);
      mocks.integrityReport.getTrackedPaths.mockResolvedValue([]);

      await sut.handleDeleteIntegrityReports({
        reports: [
          { id: 'sealed-report', assetId: 'sealed-asset', fileAssetId: null, path: sealed },
          { id: 'plain-report', assetId: 'plain-asset', fileAssetId: null, path: '/data/library/plain.jpg' },
          { id: 'orphan-report', assetId: null, fileAssetId: null, path: sealed },
        ],
      });

      expect(mocks.asset.updateAll).toHaveBeenCalledExactlyOnceWith(['plain-asset'], expect.anything());
      expect(mocks.event.emit).toHaveBeenCalledWith('AssetTrashAll', { assetIds: ['plain-asset'], userId: '' });
      expect(mocks.integrityReport.deleteByIds).toHaveBeenCalledWith(['sealed-report']);
      expect(mocks.integrityReport.deleteByIds).toHaveBeenCalledWith(['plain-report']);
      // an untracked sealed file is never unlinked or moved
      expect(mocks.physicalFile.deleteUnreferencedPath).not.toHaveBeenCalled();
    });

    it('Delete never removes an untracked sealed file', async () => {
      mocks.integrityReport.getById.mockResolvedValue({ id: 'report-id', path: sealed } as never);
      mocks.integrityReport.getTrackedPaths.mockResolvedValue([]);

      await sut.deleteIntegrityReport('user-id', 'report-id');

      expect(mocks.physicalFile.deleteUnreferencedPath).not.toHaveBeenCalled();
      expect(mocks.storage.unlink).not.toHaveBeenCalled();
    });

    it('the report refresh drops a checksum report on a sealed file without reading it', async () => {
      await sut.handleChecksumRefresh({
        items: [
          {
            reportId: 'report-1',
            path: sealed,
            checksum: Buffer.alloc(32).toString('hex'),
            checksumAlgorithm: ChecksumAlgorithm.sha256File,
          },
        ],
      });

      expect(mocks.storage.createPlainReadStream).not.toHaveBeenCalled();
      expect(mocks.integrityReport.deleteByIds).toHaveBeenCalledWith(['report-1']);
    });
  });

  describe('clearIntegrityReports (FL-366)', () => {
    it('empties the list and touches no file or photo', async () => {
      mocks.integrityReport.deleteByType.mockResolvedValue(4);

      await expect(sut.clearIntegrityReports(IntegrityReport.MissingFile)).resolves.toEqual({ cleared: 4 });

      expect(mocks.integrityReport.deleteByType).toHaveBeenCalledWith(IntegrityReport.MissingFile);
      expect(mocks.asset.updateAll).not.toHaveBeenCalled();
      expect(mocks.asset.deleteFiles).not.toHaveBeenCalled();
      expect(mocks.storage.unlink).not.toHaveBeenCalled();
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });
  });

  describe('dismissIntegrityReport (FL-366)', () => {
    it('forgets one finding without trashing its photo', async () => {
      mocks.integrityReport.getById.mockResolvedValue({ path: '/data/a.jpg', assetId: 'asset-id' } as never);

      await sut.dismissIntegrityReport('report-id');

      expect(mocks.integrityReport.deleteById).toHaveBeenCalledWith('report-id');
      expect(mocks.asset.updateAll).not.toHaveBeenCalled();
      expect(mocks.storage.unlink).not.toHaveBeenCalled();
    });
  });

  describe('handleDeleteIntegrityReports', () => {
    it('unlinks report paths only through the reference-counted guard', async () => {
      const referenced = '/data/upload/admin/ab/asset.mov';
      const untracked = '/data/upload/orphan.mov';
      mocks.storage.unlink.mockResolvedValue();
      mocks.integrityReport.getTrackedPaths.mockResolvedValue([]);
      mocks.physicalFile.deleteUnreferencedPath.mockImplementation(async (path, unlink) => {
        if (path === referenced) {
          return { deleted: false, references: 1 };
        }
        await unlink();
        return { deleted: true, references: 0 };
      });

      await sut.handleDeleteIntegrityReports({
        reports: [
          { id: 'tracked-report', path: referenced },
          { id: 'untracked-report', path: untracked },
        ] as never,
      });

      expect(mocks.physicalFile.deleteUnreferencedPath).toHaveBeenCalledTimes(2);
      // FL-412: a registered original among them would go to the file trash
      expect(mocks.physicalFile.deleteUnreferencedPath).toHaveBeenCalledWith(untracked, expect.any(Function), {
        trash: { move: expect.any(Function) },
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

    it('finishes a missing-file batch when one path cannot be read, and leaves that path unjudged', async () => {
      mocks.storage.stat.mockImplementation((path) => {
        if (path === '/denied') {
          return Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
        }
        if (path === '/under-a-file/a.jpg') {
          return Promise.reject(Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' }));
        }
        return Promise.resolve({} as never);
      });
      mocks.systemMetadata.updateIntegrityRun.mockResolvedValueOnce({
        runId: 'run-3',
        startedAt: '',
        batches: 1,
        done: 1,
      });
      await expect(
        sut.handleMissingFiles({
          runId: 'run-3',
          items: [
            { path: '/denied', reportId: 'stale', assetId: 'a', fileAssetId: null },
            { path: '/under-a-file/a.jpg', reportId: null, assetId: 'b', fileAssetId: null },
            { path: '/fine', reportId: 'fixed', assetId: 'c', fileAssetId: null },
          ],
        }),
      ).resolves.toBe(JobStatus.Success);
      expect(mocks.integrityReport.create).not.toHaveBeenCalled();
      expect(mocks.integrityReport.deleteByIds).toHaveBeenCalledWith(['fixed']);
      expect(mocks.systemMetadata.completeIntegrityRun).toHaveBeenCalledWith(
        IntegrityReport.MissingFile,
        'run-3',
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
      mocks.integrityReport.getTrackedPaths.mockResolvedValue([]);
      mocks.systemMetadata.updateIntegrityRun.mockResolvedValue(undefined);

      await sut.handleUntrackedFiles({ type: 'asset', paths: [], runId: 'stale' });
      await sut.handleUntrackedFiles({ type: 'asset', paths: [] });

      expect(mocks.systemMetadata.updateIntegrityRun).toHaveBeenCalledTimes(1);
      expect(mocks.systemMetadata.completeIntegrityRun).not.toHaveBeenCalled();
    });

    it('never reports a registered stored file as untracked, even while no asset names it (FL-412)', async () => {
      const registered = '/data/upload/user/stored.jpg';
      const orphan = '/data/upload/user/orphan.jpg';
      mocks.integrityReport.getTrackedPaths.mockResolvedValue([{ path: registered }]);

      await sut.handleUntrackedFiles({ type: 'asset', paths: [registered, orphan] });

      expect(mocks.integrityReport.getTrackedPaths).toHaveBeenCalledWith([registered, orphan]);
      expect(mocks.integrityReport.create).toHaveBeenCalledExactlyOnceWith([
        { type: IntegrityReport.UntrackedFile, path: orphan },
      ]);
    });

    it('keeps a checksum pass stopped by its limits as paused in Recent checks, not completed (FL-520)', async () => {
      mocks.crypto.randomUUID.mockReturnValue('run-4');
      mocks.integrityReport.getAssetCount.mockResolvedValue({ count: 10 } as never);
      mocks.integrityReport.recordVerification.mockResolvedValue(true);
      mocks.integrityReport.getIntegrityReportSummary.mockResolvedValue({
        [IntegrityReport.ChecksumFail]: 0,
        [IntegrityReport.MissingFile]: 0,
        [IntegrityReport.UntrackedFile]: 0,
      });
      mocks.systemMetadata.get.mockImplementation(((key: SystemMetadataKey) =>
        Promise.resolve(
          key === SystemMetadataKey.SystemConfig
            ? { integrityChecks: { checksumFiles: { percentageLimit: 0.1 } } }
            : null,
        )) as never);
      mocks.systemMetadata.clearIntegrityRun.mockResolvedValue(true);
      mocks.storage.createPlainReadStream.mockImplementation(() => Readable.from([Buffer.from('x')]) as never);
      mocks.integrityReport.streamAssetChecksums.mockReturnValue(
        (function* () {
          for (let index = 0; index < 5; index++) {
            yield {
              assetId: `asset-${index}`,
              originalPath: `/data/library/${index}.jpg`,
              checksum: Buffer.alloc(20),
              checksumAlgorithm: ChecksumAlgorithm.sha1File,
              createdAt: new Date(2026, 0, index + 1),
              reportId: null,
            };
          }
        })() as never,
      );

      // A tenth of the library each night: the second file reaches the limit.
      await sut.handleChecksumFiles();

      expect(mocks.systemMetadata.updateIntegrityRun).toHaveBeenCalledWith(IntegrityReport.ChecksumFail, 'run-4', {
        batches: 1,
      });
      expect(mocks.systemMetadata.completeIntegrityRun).not.toHaveBeenCalled();
      expect(mocks.systemMetadata.clearIntegrityRun).toHaveBeenCalledWith(IntegrityReport.ChecksumFail, 'run-4');
      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.IntegrityCheckHistory, {
        entries: [expect.objectContaining({ type: IntegrityReport.ChecksumFail, outcome: 'paused', checked: 2 })],
      });
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
  describe('file checks overview, history and Stop (FL-520)', () => {
    const summary = {
      [IntegrityReport.ChecksumFail]: 1,
      [IntegrityReport.MissingFile]: 4,
      [IntegrityReport.UntrackedFile]: 0,
    };

    it('says one count per kind, the folders that cannot be reached, what runs now and the recent checks', async () => {
      mocks.integrityReport.getFindingsOverview.mockResolvedValue({ missing: 4, damaged: 1, stray: 0, rawToMatch: 2 });
      mocks.integrityReport.countMissingUnder.mockResolvedValue([4]);
      mocks.library.getAll.mockResolvedValue([
        { name: 'Taylor’s 2024 photos', importPaths: ['/mnt/photos/2024/'] },
        { name: 'Shared', importPaths: ['/mnt/shared'] },
      ] as never);
      mocks.storage.stat.mockImplementation(((path: string) =>
        path === '/mnt/photos/2024/'
          ? Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' }))
          : Promise.resolve({})) as never);
      const entry = {
        type: IntegrityReport.MissingFile,
        startedAt: '2026-10-22T03:00:00.000Z',
        finishedAt: '2026-10-22T03:04:00.000Z',
        outcome: 'completed' as const,
        found: 4,
        checked: null,
      };
      mocks.systemMetadata.get.mockImplementation(((key: SystemMetadataKey) => {
        if (key === SystemMetadataKey.IntegrityCheckRuns) {
          return Promise.resolve({
            [IntegrityReport.ChecksumFail]: {
              current: { runId: 'r', startedAt: '2026-10-22T03:05:00.000Z', batches: 100, done: 37 },
            },
          });
        }
        return Promise.resolve(key === SystemMetadataKey.IntegrityCheckHistory ? { entries: [entry] } : null);
      }) as never);

      await expect(sut.getIntegrityOverview()).resolves.toEqual({
        missing: 4,
        damaged: 1,
        stray: 0,
        rawToMatch: 2,
        unreachable: [{ kind: 'library', name: 'Taylor’s 2024 photos', path: '/mnt/photos/2024', missing: 4 }],
        running: [{ type: IntegrityReport.ChecksumFail, startedAt: '2026-10-22T03:05:00.000Z', done: 37, total: 100 }],
        history: [entry],
      });
      expect(mocks.integrityReport.countMissingUnder).toHaveBeenCalledWith(['/mnt/photos/2024/']);
      expect(mocks.integrityReport.getFindingsOverview).toHaveBeenCalledWith(expect.arrayContaining(['.dng', '.cr2']));
    });

    it('stops: waiting checks leave the queue, the running ones end as stopped, findings stay', async () => {
      mocks.integrityReport.getFindingsOverview.mockResolvedValue({ missing: 4, damaged: 1, stray: 0, rawToMatch: 0 });
      mocks.integrityReport.countMissingUnder.mockResolvedValue([]);
      mocks.integrityReport.getIntegrityReportSummary.mockResolvedValue(summary);
      mocks.library.getAll.mockResolvedValue([]);
      mocks.storage.stat.mockResolvedValue({} as never);
      mocks.systemMetadata.clearIntegrityRun.mockResolvedValue(true);
      mocks.systemMetadata.get.mockImplementation(((key: SystemMetadataKey) =>
        Promise.resolve(
          key === SystemMetadataKey.IntegrityCheckRuns
            ? { [IntegrityReport.MissingFile]: { current: { runId: 'm', startedAt: 'then', batches: 3, done: 1 } } }
            : null,
        )) as never);

      await sut.stopIntegrityChecks();

      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.IntegrityCheckStop, {
        requestedAt: expect.any(String),
      });
      expect(mocks.job.empty).toHaveBeenCalledWith('integrityCheck');
      expect(mocks.systemMetadata.clearIntegrityRun).toHaveBeenCalledExactlyOnceWith(IntegrityReport.MissingFile, 'm');
      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.IntegrityCheckHistory, {
        entries: [
          expect.objectContaining({
            type: IntegrityReport.MissingFile,
            startedAt: 'then',
            outcome: 'stopped',
            found: 4,
          }),
        ],
      });
      expect(mocks.integrityReport.deleteByType).not.toHaveBeenCalled();
    });

    it('adds a completed check to Recent checks, newest first', async () => {
      mocks.integrityReport.getIntegrityReportSummary.mockResolvedValue(summary);
      mocks.storage.stat.mockResolvedValue({} as never);
      const older = {
        type: IntegrityReport.ChecksumFail,
        startedAt: 'a',
        finishedAt: 'b',
        outcome: 'paused',
        found: 1,
        checked: 5,
      };
      mocks.systemMetadata.get.mockResolvedValue({ entries: [older] } as never);
      mocks.systemMetadata.updateIntegrityRun.mockResolvedValue({
        runId: 'm',
        startedAt: 'start',
        batches: 1,
        done: 1,
      });
      mocks.systemMetadata.completeIntegrityRun.mockResolvedValue(true);

      await sut.handleMissingFiles({ runId: 'm', items: [] });

      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.IntegrityCheckHistory, {
        entries: [
          expect.objectContaining({
            type: IntegrityReport.MissingFile,
            startedAt: 'start',
            outcome: 'completed',
            found: 4,
          }),
          older,
        ],
      });
    });

    it('lists the photos behind missing findings for a restore, capped at the restore limit', async () => {
      mocks.integrityReport.getFindingAssetIds.mockResolvedValue(['a']);
      await expect(sut.getFindingAssetIds({ kind: 'missing' })).resolves.toEqual({ assetIds: ['a'] });
      expect(mocks.integrityReport.getFindingAssetIds).toHaveBeenCalledWith('missing', 10_000);
    });
  });
});
