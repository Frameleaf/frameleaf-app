import { SchedulerRegistry } from '@nestjs/schedule';
import { CronRepository } from 'src/repositories/cron.repository.js';
import { ArchiveOperationService } from 'src/services/archive-operation.service.js';
import { getConfig } from 'src/utils/config.js';

vi.mock('src/utils/config.js', () => ({ getConfig: vi.fn() }));

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};
const setup = () => {
  const repository = {
    create: vi.fn().mockResolvedValue('recorded'),
    get: vi.fn().mockResolvedValue({ id: 'recorded', pending: 2 }),
    pending: vi.fn().mockResolvedValue([]),
    processNext: vi.fn().mockResolvedValue(false),
    command: vi.fn(),
  };
  const cron = { create: vi.fn(), update: vi.fn() };
  const logger = { warn: vi.fn(), error: vi.fn(), setContext: vi.fn() };
  const service = new ArchiveOperationService(
    repository as never,
    cron as never,
    {} as never,
    {} as never,
    {} as never,
    logger as never,
  );
  return { service, repository, cron, logger };
};
beforeEach(() => {
  vi.mocked(getConfig).mockResolvedValue({ machineLearning: { nsfwDetection: { hideFromLibrary: false } } } as never);
});

it('commits API receipts without dispatch and recovers existing work on worker startup', async () => {
  const { service, repository, cron } = setup();
  expect(await service.create({ user: { id: 'owner' } } as never, {} as never)).toEqual({ id: 'recorded', pending: 2 });
  await service.dispatchPending();
  expect(repository.pending).not.toHaveBeenCalled();
  repository.pending.mockResolvedValue(['recorded']);
  repository.processNext.mockResolvedValueOnce(true).mockResolvedValue(false);
  await service.bootstrap();
  await service.bootstrap();
  expect(cron.create).toHaveBeenCalledOnce();
  expect(cron.create).toHaveBeenCalledWith(expect.objectContaining({ expression: '* * * * * *' }));
  expect(repository.processNext).toHaveBeenCalledTimes(2);
  expect(repository.create).toHaveBeenCalledOnce();
  await service.shutdown();
});
it('ignores overlapping ticks and bounds one tick to 100 item attempts across operations', async () => {
  const { service, repository } = setup();
  await service.bootstrap();
  const pending = deferred<string[]>();
  repository.pending.mockReturnValueOnce(pending.promise);
  repository.processNext.mockResolvedValue(true);
  const tick = service.dispatchPending();
  await service.dispatchPending();
  expect(repository.pending).toHaveBeenCalledTimes(2);
  pending.resolve(['a', 'b']);
  await tick;
  expect(repository.processNext).toHaveBeenCalledTimes(100);
  expect(repository.processNext.mock.calls.slice(0, 4).map(([id]) => id)).toEqual(['a', 'b', 'a', 'b']);
  await service.shutdown();
});
it('continues other operations after a failure and retries durable work on the next tick', async () => {
  const { service, repository, logger } = setup();
  repository.pending.mockResolvedValue(['failed', 'healthy']);
  repository.processNext.mockRejectedValueOnce(new Error('transient database failure')).mockResolvedValue(false);
  await service.bootstrap();
  expect(repository.processNext.mock.calls.map(([id]) => id)).toEqual(['failed', 'healthy']);
  expect(logger.warn).toHaveBeenCalledOnce();
  repository.pending.mockResolvedValue(['failed']);
  await service.dispatchPending();
  expect(repository.processNext.mock.calls.at(-1)?.[0]).toBe('failed');
  await service.shutdown();
});
it('recovers after a failed pending lookup without leaving the overlap guard stuck', async () => {
  const { service, repository, logger } = setup();
  repository.pending.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(['recorded']);
  await service.bootstrap();
  expect(logger.warn).toHaveBeenCalledOnce();
  await service.dispatchPending();
  expect(repository.processNext).toHaveBeenCalledOnce();
  await service.shutdown();
});
it.each(['cancel', 'retry', 'undo'] as const)(
  'leaves %s receipt commands under durable repository authority',
  async (command) => {
    const { service, repository } = setup();
    const auth = { user: { id: 'owner' } } as never;
    await service.command(auth, 'recorded', command);
    expect(repository.command).toHaveBeenCalledWith(auth, 'recorded', command);
    expect(repository.processNext).not.toHaveBeenCalled();
  },
);
it('stops scheduling, waits for the current item, and leaves remaining work for restart', async () => {
  const { service, repository, cron } = setup();
  await service.bootstrap();
  repository.pending.mockResolvedValue(['recorded']);
  const pending = deferred<boolean>();
  repository.processNext.mockReturnValueOnce(pending.promise);
  const tick = service.dispatchPending();
  await vi.waitFor(() => expect(repository.processNext).toHaveBeenCalledOnce());
  let stopped = false;
  const shutdown = service.shutdown().then(() => (stopped = true));
  await Promise.resolve();
  expect(stopped).toBe(false);
  expect(cron.update).toHaveBeenCalledWith({ name: 'archive-operations', start: false });
  pending.resolve(true);
  await Promise.all([tick, shutdown]);
  await service.dispatchPending();
  expect(repository.processNext).toHaveBeenCalledOnce();
});
it('stops the real scheduler job and rejects late ticks after shutdown', async () => {
  const { repository, logger } = setup();
  const scheduler = new SchedulerRegistry();
  const cron = new CronRepository(scheduler, logger as never);
  const service = new ArchiveOperationService(
    repository as never,
    cron,
    {} as never,
    {} as never,
    {} as never,
    logger as never,
  );
  await service.bootstrap();
  const job = scheduler.getCronJob('archive-operations');
  expect(job.isActive).toBe(true);
  await service.shutdown();
  expect(job.isActive).toBe(false);
  await job.fireOnTick();
  expect(repository.pending).toHaveBeenCalledOnce();
  scheduler.deleteCronJob('archive-operations');
});
