import { MediaOperationKind, MediaOperationStatus } from 'src/enum.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { MEDIA_HEALTH_SCAN_BATCH, MediaHealthOperationService } from 'src/services/media-health-operation.service.js';
import { MediaHealthService } from 'src/services/media-health.service.js';
import { ServiceMocks, getMocks } from 'test/utils.js';

const scanSnapshot = { mode: 'scan', userId: 'user-1', missingRunId: 'missing-run', corruptRunId: 'corrupt-run' };
const locateSnapshot = {
  mode: 'locate',
  userId: 'user-1',
  runId: 'run-1',
  findingIds: ['health-1', 'health-2'],
  rootIds: ['managed'],
  anyOwner: false,
};

const operationOf = (snapshot: Record<string, unknown>, overrides: Partial<MediaOperation> = {}): MediaOperation =>
  ({
    id: '0195e2a0-0000-7000-8000-0000000000e1',
    ownerId: 'user-1',
    kind: MediaOperationKind.MediaHealth,
    status: MediaOperationStatus.Preparing,
    snapshot,
    result: null,
    ...overrides,
  }) as unknown as MediaOperation;

const page = (checked: number, lastId: string | null, { missing = 0, corrupt = 0 } = {}) => ({
  checked,
  lastId,
  missing,
  corrupt,
});

describe(MediaHealthOperationService.name, () => {
  let sut: MediaHealthOperationService;
  let mocks: ServiceMocks;
  let operations: MediaOperationRepository;
  let mediaHealth: {
    countScanAssets: any;
    scanPage: any;
    restoreUntracked: any;
    setRunState: any;
    locateStep: any;
  };

  const running = { status: MediaOperationStatus.Rendering, cancelRequestedAt: null, pauseRequestedAt: null };

  beforeEach(() => {
    mocks = getMocks();
    operations = {
      claimNext: vi.fn().mockResolvedValue(undefined),
      reportProgress: vi.fn().mockResolvedValue(true),
      setBulkResult: vi.fn().mockResolvedValue(running),
      beginValidation: vi.fn().mockResolvedValue(true),
      complete: vi.fn().mockResolvedValue(true),
      fail: vi.fn().mockResolvedValue('retrying'),
      acknowledgeCancel: vi.fn().mockResolvedValue(true),
      settlePause: vi.fn().mockResolvedValue(true),
    } as unknown as MediaOperationRepository;
    mediaHealth = {
      countScanAssets: vi.fn().mockResolvedValue(30),
      scanPage: vi.fn(),
      restoreUntracked: vi.fn().mockResolvedValue(undefined),
      setRunState: vi.fn().mockResolvedValue(undefined),
      locateStep: vi.fn(),
    };
    sut = new MediaHealthOperationService(
      mocks.logger as never,
      operations,
      mediaHealth as unknown as MediaHealthService,
    );
  });

  describe('scan', () => {
    it('works through the owner’s assets a batch at a time, then restores untracked files and completes', async () => {
      mediaHealth.scanPage
        .mockResolvedValueOnce(page(MEDIA_HEALTH_SCAN_BATCH, 'asset-25', { missing: 1, corrupt: 0 }))
        .mockResolvedValueOnce(page(5, 'asset-30', { missing: 0, corrupt: 2 }));

      await sut.run(operationOf(scanSnapshot), 'token');

      expect(mediaHealth.scanPage).toHaveBeenNthCalledWith(1, scanSnapshot, null, MEDIA_HEALTH_SCAN_BATCH);
      expect(mediaHealth.scanPage).toHaveBeenNthCalledWith(2, scanSnapshot, 'asset-25', MEDIA_HEALTH_SCAN_BATCH);
      expect(mediaHealth.restoreUntracked).toHaveBeenCalledTimes(1);
      expect(operations.setBulkResult).toHaveBeenLastCalledWith(
        expect.any(String),
        'token',
        expect.objectContaining({
          result: { cursor: 'asset-30', total: 30, checked: 30, missing: 1, corrupt: 2, restored: true },
          processedUnits: 30,
          totalUnits: 30,
        }),
      );
      expect(mediaHealth.setRunState).toHaveBeenLastCalledWith(
        scanSnapshot,
        'completed',
        expect.objectContaining({ checked: 30, missing: 1, corrupt: 2 }),
      );
      expect(operations.complete).toHaveBeenCalledWith(expect.any(String), 'token', { resultAssetId: null });
    });

    it('resumes from the recorded cursor after a restart, without counting assets twice', async () => {
      mediaHealth.scanPage.mockResolvedValueOnce(page(3, 'asset-28'));
      const resumed = operationOf(scanSnapshot, {
        result: { cursor: 'asset-25', total: 28, checked: 25, missing: 1, corrupt: 0, restored: false },
      } as never);

      await sut.run(resumed, 'token');

      expect(mediaHealth.countScanAssets).not.toHaveBeenCalled();
      expect(mediaHealth.scanPage).toHaveBeenCalledWith(scanSnapshot, 'asset-25', MEDIA_HEALTH_SCAN_BATCH);
      expect(operations.setBulkResult).toHaveBeenCalledWith(
        expect.any(String),
        'token',
        expect.objectContaining({ result: expect.objectContaining({ checked: 28, missing: 1 }) }),
      );
    });

    it('stops at a batch boundary when paused, and records the pause on its runs', async () => {
      mediaHealth.scanPage.mockResolvedValue(page(MEDIA_HEALTH_SCAN_BATCH, 'asset-25'));
      vi.mocked(operations.setBulkResult).mockResolvedValueOnce({ ...running, pauseRequestedAt: new Date() });

      await sut.run(operationOf(scanSnapshot), 'token');

      expect(mediaHealth.scanPage).toHaveBeenCalledTimes(1);
      expect(operations.settlePause).toHaveBeenCalledWith(expect.any(String), 'token');
      expect(mediaHealth.setRunState).toHaveBeenLastCalledWith(scanSnapshot, 'paused', expect.anything());
      expect(mediaHealth.restoreUntracked).not.toHaveBeenCalled();
      expect(operations.complete).not.toHaveBeenCalled();
    });

    it('acknowledges a cancel and keeps the findings it has already written', async () => {
      mediaHealth.scanPage.mockResolvedValue(page(MEDIA_HEALTH_SCAN_BATCH, 'asset-25'));
      vi.mocked(operations.setBulkResult).mockResolvedValueOnce({
        ...running,
        status: MediaOperationStatus.Cancelling,
        cancelRequestedAt: new Date(),
      });

      await sut.run(operationOf(scanSnapshot), 'token');

      expect(operations.acknowledgeCancel).toHaveBeenCalledWith(expect.any(String), 'token', { released: false });
      expect(mediaHealth.setRunState).toHaveBeenLastCalledWith(scanSnapshot, 'cancelled', expect.anything());
      expect(operations.complete).not.toHaveBeenCalled();
    });

    it('stops writing when its claim was taken away', async () => {
      mediaHealth.scanPage.mockResolvedValue(page(MEDIA_HEALTH_SCAN_BATCH, 'asset-25'));
      vi.mocked(operations.setBulkResult).mockResolvedValueOnce(undefined);

      await sut.run(operationOf(scanSnapshot), 'token');

      expect(mediaHealth.scanPage).toHaveBeenCalledTimes(1);
      expect(operations.complete).not.toHaveBeenCalled();
      expect(operations.fail).not.toHaveBeenCalled();
    });

    it('hands a failure to the automatic retry and says so on its runs', async () => {
      mediaHealth.scanPage.mockRejectedValue(new Error('disk offline'));

      await sut.run(operationOf(scanSnapshot), 'token');

      expect(operations.fail).toHaveBeenCalledWith(expect.any(String), 'token', {
        error: 'disk offline',
        errorCode: 'media_health_failed',
      });
      expect(mediaHealth.setRunState).toHaveBeenLastCalledWith(
        scanSnapshot,
        'retrying',
        expect.anything(),
        'disk offline',
      );
    });

    it('reports the failure once its automatic retry is spent', async () => {
      mediaHealth.scanPage.mockRejectedValue(new Error('disk offline'));
      vi.mocked(operations.fail).mockResolvedValueOnce('failed');

      await sut.run(operationOf(scanSnapshot), 'token');

      expect(mediaHealth.setRunState).toHaveBeenLastCalledWith(
        scanSnapshot,
        'failed',
        expect.anything(),
        'disk offline',
      );
    });

    it('fails a job whose snapshot cannot be read, without touching any run', async () => {
      await sut.run(operationOf({ mode: 'scan' }), 'token');

      expect(operations.fail).toHaveBeenCalledWith(
        expect.any(String),
        'token',
        expect.objectContaining({ errorCode: 'media_health_snapshot_invalid' }),
      );
      expect(mediaHealth.setRunState).not.toHaveBeenCalled();
    });
  });

  describe('search for originals', () => {
    it('carries the directory cursor from step to step until the walk is complete', async () => {
      const continuation = { cursor: [{ path: '/data/upload/user-2', after: 'b' }], matches: {} };
      mediaHealth.locateStep
        .mockResolvedValueOnce({ checkedAssets: 2, foundAssets: 0, continuation })
        .mockResolvedValueOnce({ checkedAssets: 2, foundAssets: 1 });

      await sut.run(operationOf(locateSnapshot), 'token');

      expect(mediaHealth.locateStep).toHaveBeenNthCalledWith(1, locateSnapshot, null);
      expect(mediaHealth.locateStep).toHaveBeenNthCalledWith(2, locateSnapshot, continuation);
      expect(operations.setBulkResult).toHaveBeenNthCalledWith(
        1,
        expect.any(String),
        'token',
        expect.objectContaining({ result: expect.objectContaining({ managedSearch: continuation }), progress: 0 }),
      );
      expect(mediaHealth.setRunState).toHaveBeenLastCalledWith(
        locateSnapshot,
        'completed',
        expect.objectContaining({ checked: 2, found: 1 }),
      );
      expect(operations.complete).toHaveBeenCalled();
    });

    it('resumes a paused search from where the walk stopped', async () => {
      const continuation = { cursor: [{ path: '/data/upload/user-2', after: 'c' }], matches: {} };
      mediaHealth.locateStep.mockResolvedValueOnce({ checkedAssets: 2, foundAssets: 2 });

      const paused = { result: { managedSearch: continuation, checked: 0, found: 0, steps: 3 } };
      await sut.run(operationOf(locateSnapshot, paused as never), 'token');

      expect(mediaHealth.locateStep).toHaveBeenCalledWith(locateSnapshot, continuation);
    });
  });

  describe('drain', () => {
    it('claims only Library Care jobs', async () => {
      await sut.drain();

      expect(operations.claimNext).toHaveBeenCalledWith(
        expect.objectContaining({ kinds: [MediaOperationKind.MediaHealth] }),
      );
    });
  });
});
