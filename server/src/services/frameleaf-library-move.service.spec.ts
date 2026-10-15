import { ConflictException } from '@nestjs/common';
import { ImmichWorker, QueueName, SystemMetadataKey } from 'src/enum.js';
import {
  FrameleafLibraryMoveService,
  LIBRARY_MOVE_LEASE_MS,
  LIBRARY_MOVE_RESTART_GRACE_MS,
} from 'src/services/frameleaf-library-move.service.js';
import { libraryMoveFence } from 'src/utils/frameleaf-library-move-fence.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(FrameleafLibraryMoveService.name, () => {
  let sut: FrameleafLibraryMoveService;
  let mocks: ServiceMocks;
  let metadata: Map<string, unknown>;
  let paused: Set<string>;
  let active: Partial<Record<QueueName, number>>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date('2026-10-14T12:00:00Z'));
    ({ sut, mocks } = newTestService(FrameleafLibraryMoveService));
    metadata = new Map();
    paused = new Set([QueueName.SmartSearch]); // an administrator's own pause
    active = {};
    mocks.systemMetadata.get.mockImplementation((key) => Promise.resolve((metadata.get(key) as any) ?? null));
    mocks.systemMetadata.set.mockImplementation((key, value) => {
      metadata.set(key, structuredClone(value));
      return Promise.resolve();
    });
    mocks.systemMetadata.delete.mockImplementation((key) => {
      metadata.delete(key);
      return Promise.resolve();
    });
    mocks.job.isPaused.mockImplementation((name) => Promise.resolve(paused.has(name)));
    mocks.job.pause.mockImplementation((name) => {
      paused.add(name);
      return Promise.resolve();
    });
    mocks.job.resume.mockImplementation((name) => {
      paused.delete(name);
      return Promise.resolve();
    });
    mocks.job.getJobCounts.mockImplementation((name) =>
      Promise.resolve({ active: active[name] ?? 0, completed: 0, failed: 0, delayed: 0, waiting: 0, paused: 0 }),
    );
  });

  afterEach(async () => {
    await sut.resume();
    sut.onShutdown();
    vi.useRealTimers();
  });

  it('pauses every queue, raises the write fence and stores the pause durably', async () => {
    const status = await sut.pause('op-1');

    expect(paused).toEqual(new Set(Object.values(QueueName)));
    expect(libraryMoveFence.active).toBe(true);
    expect(status).toMatchObject({ paused: true, operationId: 'op-1', drained: true, activeJobs: 0 });
    const stored = metadata.get(SystemMetadataKey.FrameleafLibraryMovePause) as any;
    expect(stored.queues).not.toContain(QueueName.SmartSearch);
    expect(stored.leaseExpiresAt).toBe(new Date(Date.now() + LIBRARY_MOVE_LEASE_MS).toISOString());
  });

  it('is not drained while a job or a write request is still in flight', async () => {
    active[QueueName.ThumbnailGeneration] = 2;
    const release = libraryMoveFence.admit('POST', '/api/assets');
    expect(release).not.toBe(false);

    const status = await sut.pause('op-1');
    expect(status).toMatchObject({
      drained: false,
      activeJobs: 2,
      activeQueues: [QueueName.ThumbnailGeneration],
      writesInFlight: 1,
    });

    active[QueueName.ThumbnailGeneration] = 0;
    (release as () => void)();
    await expect(sut.status('op-1')).resolves.toMatchObject({ drained: true, writesInFlight: 0 });
  });

  it('refuses new writes while paused but lets reads, sign-in, sync, search and the move itself through', async () => {
    await sut.pause('op-1');
    expect(libraryMoveFence.admit('POST', '/api/assets')).toBe(false);
    expect(libraryMoveFence.admit('PUT', '/api/assets/1/original')).toBe(false);
    expect(libraryMoveFence.admit('DELETE', '/api/assets')).toBe(false);
    for (const [method, path] of [
      ['GET', '/api/assets/1/original'],
      ['POST', '/api/auth/login'],
      ['POST', '/api/sync/stream'],
      ['POST', '/api/search/metadata'],
      ['POST', '/api/server/library-move/manager/resume'],
      ['POST', '/api/admin/library-move/resume'],
    ]) {
      expect(libraryMoveFence.admit(method, path)).toBeTypeOf('function');
    }
  });

  it('renews an existing pause idempotently and refuses another operation', async () => {
    await sut.pause('op-1');
    const first = metadata.get(SystemMetadataKey.FrameleafLibraryMovePause) as any;
    vi.advanceTimersByTime(60_000);
    await sut.pause('op-1');
    const renewed = metadata.get(SystemMetadataKey.FrameleafLibraryMovePause) as any;
    expect(renewed.pausedAt).toBe(first.pausedAt);
    expect(renewed.queues).toEqual(first.queues);
    expect(Date.parse(renewed.leaseExpiresAt)).toBeGreaterThan(Date.parse(first.leaseExpiresAt));

    await expect(sut.pause('op-2')).rejects.toBeInstanceOf(ConflictException);
    await expect(sut.resume('op-2')).rejects.toBeInstanceOf(ConflictException);
  });

  it('resumes only the queues it paused and lowers the fence', async () => {
    await sut.pause('op-1');
    const status = await sut.resume('op-1');

    expect(status.paused).toBe(false);
    expect(paused).toEqual(new Set([QueueName.SmartSearch]));
    expect(libraryMoveFence.active).toBe(false);
    expect(metadata.has(SystemMetadataKey.FrameleafLibraryMovePause)).toBe(false);
    await expect(sut.resume('op-1')).resolves.toMatchObject({ paused: false });
  });

  it('keeps the pause across a restart, with a grace period that ignores time spent stopped', async () => {
    await sut.pause('op-1');
    const stored = metadata.get(SystemMetadataKey.FrameleafLibraryMovePause) as any;
    libraryMoveFence.lower(); // the process died
    for (const name of stored.queues) paused.delete(name); // even if a queue pause were lost

    vi.setSystemTime(Date.now() + 10 * LIBRARY_MOVE_LEASE_MS); // a long copy while stopped
    await sut.onBootstrap();

    expect(libraryMoveFence.active).toBe(true);
    expect(paused).toEqual(new Set(Object.values(QueueName)));
    const kept = metadata.get(SystemMetadataKey.FrameleafLibraryMovePause) as any;
    expect(kept.queues).toEqual(stored.queues);
    expect(kept.leaseExpiresAt).toBe(new Date(Date.now() + LIBRARY_MOVE_RESTART_GRACE_MS).toISOString());
  });

  it('lifts the pause by itself when the lease runs out without a renewal', async () => {
    await sut.pause('op-1');
    await vi.advanceTimersByTimeAsync(LIBRARY_MOVE_LEASE_MS + 2000);

    expect(metadata.has(SystemMetadataKey.FrameleafLibraryMovePause)).toBe(false);
    expect(libraryMoveFence.active).toBe(false);
    expect(paused).toEqual(new Set([QueueName.SmartSearch]));
  });

  it('does nothing at boot without a pause, or outside the API worker', async () => {
    await sut.onBootstrap();
    expect(libraryMoveFence.active).toBe(false);

    metadata.set(SystemMetadataKey.FrameleafLibraryMovePause, {
      operationId: 'op-1',
      pausedAt: new Date().toISOString(),
      leaseExpiresAt: new Date().toISOString(),
      queues: [],
    });
    mocks.config.getWorker.mockReturnValue(ImmichWorker.Microservices);
    await sut.onBootstrap();
    expect(libraryMoveFence.active).toBe(false);
    mocks.config.getWorker.mockReturnValue(ImmichWorker.Api);
  });
});
