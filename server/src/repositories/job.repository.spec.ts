import { ModuleRef } from '@nestjs/core';
import { Kysely } from 'kysely';
import { JobName, JobStatus, QueueName } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { QUEUE_TIMING, QueueClaim, QueueExecution } from 'src/queue/types.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';

/** Facade behavior; actual locking, retries, accounting and rollback are tested with PostgreSQL. */
describe(JobRepository.name, () => {
  let sut: JobRepository;
  const enqueue = vi.fn();
  const context = (): QueueExecution => ({
    claim: { id: 'parent', token: 'claim-token', runId: 'run', itemKey: 'asset' } as QueueClaim,
    signal: new AbortController().signal,
    progress: vi.fn(),
    progressUnits: 0,
    followups: [],
    adoptions: [],
    buffering: false,
  });
  beforeEach(() => {
    enqueue.mockReset().mockResolvedValue(undefined);
    sut = new JobRepository(
      {} as ModuleRef,
      {} as ConfigRepository,
      {} as EventRepository,
      { setContext: vi.fn(), error: vi.fn() } as unknown as LoggingRepository,
      {} as Kysely<any>,
    );
    sut['store'].enqueue = enqueue;
    for (const name of Object.values(JobName)) {
      sut['handlers'][name] = {
        jobName: name,
        queueName: QueueName.ThumbnailGeneration,
        handler: vi.fn().mockResolvedValue(JobStatus.Success),
        label: 'fixture',
      } as never;
    }
  });

  it('retains delay and latest-pending deduplication options', async () => {
    await sut.queue({ name: JobName.ICloudSync, data: { id: 'account' } });
    expect(enqueue.mock.calls[0][0][0].options).toEqual({
      deduplication: { id: `${JobName.ICloudSync}:account`, keepLastIfActive: true },
    });
    await sut.queue({ name: JobName.NotifyAlbumUpdate, data: { id: 'album', recipientId: 'user', delay: 3000 } });
    expect(enqueue.mock.calls[1][0][0].options).toEqual({ jobId: 'album/user', delay: 3000 });
  });

  it('buffers success follow-ups for the final outcome transaction with run and dependency lineage', async () => {
    const execution = context();
    await queueExecution.run(execution, () =>
      sut.collectFollowups(() => sut.queue({ name: JobName.AssetGenerateThumbnails, data: { id: 'asset' } })),
    );
    expect(enqueue).not.toHaveBeenCalled();
    expect(execution.followups).toEqual([
      expect.objectContaining({ runId: 'run', itemKey: 'asset', parentId: 'parent' }),
    ]);
  });

  it('does not silently turn an explicit Failed result into success', async () => {
    sut['handlers'][JobName.AssetGenerateThumbnails]!.handler = vi.fn().mockResolvedValue(JobStatus.Failed);
    const execution = context();
    const outcome = await queueExecution.run(execution, () =>
      sut.run({ name: JobName.AssetGenerateThumbnails, data: { id: 'asset' } }),
    );
    expect(outcome).toBe(JobStatus.Failed);
    expect(execution.outcome).toBe('failed');
  });

  it('assigns ML the thirty-minute deadline and never independently replays an operation-owned render', async () => {
    sut['handlers'][JobName.SmartSearch]!.queueName = QueueName.SmartSearch;
    await sut.queue({ name: JobName.SmartSearch, data: { id: 'asset' } });
    expect(enqueue.mock.calls[0][0][0].deadlineMs).toBe(QUEUE_TIMING.mlDeadline);
    await sut.queue({ name: JobName.AssetDevelopRender, data: { id: 'asset', operationId: 'operation' } });
    expect(enqueue.mock.calls[1][0][0].safeToRetry).toBe(false);
  });

  it('never automatically replays notification side effects and redacts sensitive history', async () => {
    await sut.queue({ name: JobName.SendMail, data: {} } as never);
    expect(enqueue.mock.calls[0][0][0]).toMatchObject({ safeToRetry: false, sensitive: true });
  });

  it('rejects enqueueing after cancellation before writing any intent', async () => {
    const execution = context();
    const abort = new AbortController();
    abort.abort(new Error('cancelled'));
    execution.signal = abort.signal;
    await expect(queueExecution.run(execution, () => sut.queue({ name: JobName.VersionCheck }))).rejects.toThrow(
      'cancelled',
    );
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('does not automatically replay metadata, faces or destructive forced CLIP rebuilding', async () => {
    for (const item of [
      { name: JobName.AssetExtractMetadata, data: { id: 'asset' } },
      { name: JobName.AssetDetectFaces, data: { id: 'asset' } },
      { name: JobName.SmartSearchQueueAll, data: { force: true } },
    ] as const) {
      await sut.queue(item);
      expect(enqueue.mock.lastCall?.[0][0].safeToRetry).toBe(false);
    }
  });

  it('delivers observers only after accepted adoption and never when the token was rejected', async () => {
    const notify = vi.fn();
    const abort = new AbortController();
    const claim = {
      ...context().claim,
      name: JobName.VersionCheck,
      queue: QueueName.BackgroundTask,
      data: {},
      startedAt: new Date(),
    };
    sut['eventRepository'].emit = vi.fn().mockImplementation(async () => {
      const execution = queueExecution.getStore()!;
      execution.afterCommit = [notify];
    });
    sut['store'].complete = vi.fn().mockResolvedValue(false);
    await sut['execute'](claim, abort);
    expect(notify).not.toHaveBeenCalled();
    sut['store'].complete = vi.fn().mockImplementation(async () => {
      expect(notify).not.toHaveBeenCalled();
      return true;
    });
    await sut['execute'](claim, abort);
    expect(notify).toHaveBeenCalledOnce();
  });
});
