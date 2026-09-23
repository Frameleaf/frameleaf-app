import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import {
  MEDIA_OPERATION_LEASE_EXPIRED,
  MEDIA_OPERATION_SWEEP_MS,
  MediaOperationSweepService,
} from 'src/services/media-operation-sweep.service.js';
import { getMocks } from 'test/utils.js';

const nothing = { requeued: 0, retried: 0, failed: 0, abandonedCancels: 0 };

describe(MediaOperationSweepService.name, () => {
  let sut: MediaOperationSweepService;
  let operations: { recoverExpiredClaims: ReturnType<typeof vi.fn> };
  let logger: ReturnType<typeof getMocks>['logger'];

  beforeEach(() => {
    logger = getMocks().logger;
    operations = { recoverExpiredClaims: vi.fn().mockResolvedValue(nothing) };
    sut = new MediaOperationSweepService(logger as never, operations as unknown as MediaOperationRepository);
  });

  afterEach(async () => {
    await sut.onShutdown();
    vi.useRealTimers();
  });

  describe('sweep', () => {
    it('recovers every kind in one pass, with no kind filter', async () => {
      await sut.sweep();

      expect(operations.recoverExpiredClaims).toHaveBeenCalledTimes(1);
      expect(operations.recoverExpiredClaims).toHaveBeenCalledWith(MEDIA_OPERATION_LEASE_EXPIRED);
      expect(operations.recoverExpiredClaims.mock.calls[0][0]).not.toHaveProperty('kinds');
    });

    it('reports what it recovered, automatic retries included', async () => {
      const recovered = { requeued: 2, retried: 1, failed: 1, abandonedCancels: 1 };
      operations.recoverExpiredClaims.mockResolvedValue(recovered);

      await expect(sut.sweep()).resolves.toEqual(recovered);
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('1 retrying'));
    });

    it('stays quiet when there was nothing to recover', async () => {
      await sut.sweep();

      expect(logger.log).not.toHaveBeenCalled();
    });
  });

  describe('tick', () => {
    it('never runs two passes at once', async () => {
      let release!: (value: typeof nothing) => void;
      operations.recoverExpiredClaims.mockReturnValue(new Promise((resolve) => (release = resolve)));

      const first = sut.tick();
      const second = sut.tick();
      release(nothing);

      await expect(first).resolves.toEqual(nothing);
      await expect(second).resolves.toEqual(nothing);
      expect(operations.recoverExpiredClaims).toHaveBeenCalledTimes(1);
    });

    it('logs a failed pass instead of throwing, and runs again next time', async () => {
      operations.recoverExpiredClaims.mockRejectedValueOnce(new Error('database went away'));

      await expect(sut.tick()).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('database went away'));

      await expect(sut.tick()).resolves.toEqual(nothing);
    });
  });

  describe('onBootstrap', () => {
    it('sweeps at once and then on its interval', async () => {
      vi.useFakeTimers();

      sut.onBootstrap();
      await vi.advanceTimersByTimeAsync(0);
      expect(operations.recoverExpiredClaims).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(MEDIA_OPERATION_SWEEP_MS);
      expect(operations.recoverExpiredClaims).toHaveBeenCalledTimes(2);
    });

    it('stops sweeping on shutdown', async () => {
      vi.useFakeTimers();

      sut.onBootstrap();
      await vi.advanceTimersByTimeAsync(0);
      await sut.onShutdown();
      await vi.advanceTimersByTimeAsync(MEDIA_OPERATION_SWEEP_MS * 2);

      expect(operations.recoverExpiredClaims).toHaveBeenCalledTimes(1);
    });
  });
});
