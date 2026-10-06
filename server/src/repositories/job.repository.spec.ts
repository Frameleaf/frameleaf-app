import { ModuleRef } from '@nestjs/core';
import { Kysely } from 'kysely';
import { JobName, JobStatus, QueueName } from 'src/enum.js';
import { QUEUE_EXECUTION_CAPACITY, queueAdmission } from 'src/queue/admission.js';
import { queueExecution } from 'src/queue/context.js';
import { QUEUE_TIMING, QueueClaim, QueueExecution } from 'src/queue/types.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import * as attemptEvidence from 'src/utils/attempt-evidence.js';

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
      { setContext: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as LoggingRepository,
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

  it('admits routine database backups with the audited one-retry policy', async () => {
    sut['handlers'][JobName.DatabaseBackup]!.queueName = QueueName.BackupDatabase;
    await sut.queue({ name: JobName.DatabaseBackup });
    expect(enqueue.mock.calls[0][0][0]).toMatchObject({
      name: JobName.DatabaseBackup,
      queue: QueueName.BackupDatabase,
      safeToRetry: true,
    });
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
    await expect(
      queueExecution.run(execution, () => sut.queue({ name: JobName.VersionCheck, data: {} })),
    ).rejects.toThrow('cancelled');
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('retries fenced media publication and the non-destructive forced CLIP producer', async () => {
    for (const item of [
      { name: JobName.AssetExtractMetadata, data: { id: 'asset' } },
      { name: JobName.AssetDetectFaces, data: { id: 'asset' } },
      { name: JobName.SmartSearchQueueAll, data: { force: true } },
    ] as const) {
      await sut.queue(item);
      expect(enqueue.mock.lastCall?.[0][0].safeToRetry).toBe(true);
    }
  });

  it('delivers observers only after accepted adoption and never when the token was rejected', async () => {
    const recordStopped = vi.spyOn(attemptEvidence, 'recordStoppedAttempt').mockResolvedValue(undefined);
    const notify = vi.fn();
    const abort = new AbortController();
    const claim = {
      ...context().claim,
      name: JobName.VersionCheck,
      queue: QueueName.BackgroundTask,
      data: {},
      startedAt: new Date(),
    };
    sut['eventRepository'].emit = vi.fn().mockImplementation(() => {
      const execution = queueExecution.getStore()!;
      execution.afterCommit = [notify];
      return Promise.resolve();
    });
    sut['store'].complete = vi.fn().mockResolvedValue(false);
    sut['store'].fail = vi.fn().mockResolvedValue(true);
    await sut['execute'](claim, abort);
    expect(sut['store'].complete).toHaveBeenCalledOnce();
    expect(sut['store'].fail).toHaveBeenCalledWith(
      claim,
      'Job deadline or cancellation requested',
      undefined,
      expect.objectContaining({ stopRequestedOnly: true }),
    );
    expect(recordStopped.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sut['store'].fail).mock.invocationCallOrder[0],
    );
    expect(notify).not.toHaveBeenCalled();
    sut['store'].complete = vi.fn().mockImplementation(() => {
      expect(notify).not.toHaveBeenCalled();
      return Promise.resolve(true);
    });
    await sut['execute'](claim, abort);
    expect(recordStopped).toHaveBeenCalledTimes(2);
    expect(recordStopped).toHaveBeenLastCalledWith(sut['store'].db, claim.id, claim.token);
    expect(recordStopped.mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(sut['store'].complete).mock.invocationCallOrder[0],
    );
    expect(notify).toHaveBeenCalledOnce();
  });

  it.each([
    ['Prepared output source changed', 'prepared_output_source_changed'],
    ['Thumbnail source changed before publication', 'thumbnail_source_changed'],
    ['Video version changed before publication', 'video_version_changed'],
    ['video_version_invalid_paths', 'video_version_invalid_paths'],
    ['Edit operation lost its claim before publication', 'edit_operation_claim_lost'],
    ['Publication lease expired before commit', 'publication_lease_expired'],
    ['private-fixture-value', 'other_error'],
    ['Prepared output source changed: private-fixture-value', 'other_error'],
    ['toString', 'other_error'],
  ])('classifies deferred publication failure without private diagnostics: %s', async (message, reasonCode) => {
    vi.spyOn(attemptEvidence, 'recordStoppedAttempt').mockResolvedValue(undefined);
    const privateValue = 'private-fixture-value';
    const error = Object.assign(new Error(message, { cause: new Error(privateValue) }), {
      code: '23505',
      detail: privateValue,
      query: privateValue,
      parameters: [privateValue],
    });
    Object.defineProperty(error, 'stack', { value: privateValue });
    const claim = {
      ...context().claim,
      id: '11111111-1111-4111-8111-111111111111',
      name: JobName.AssetVideoEditGeneration,
      queue: QueueName.VideoConversion,
      attempt: 1,
      data: { privateValue },
      startedAt: new Date(),
    };
    sut['eventRepository'].emit = vi.fn().mockImplementation(() => {
      queueExecution.getStore()!.adoptions.push(() => Promise.reject(error));
      return Promise.resolve();
    });
    sut['store'].complete = vi.fn().mockImplementation((_claim, _followups, adopt) => adopt({}));
    sut['store'].fail = vi.fn().mockResolvedValue(true);
    await sut['execute'](claim, new AbortController());
    expect(sut['logger'].error).toHaveBeenCalledExactlyOnceWith('Queue execution failed', {
      jobName: JobName.AssetVideoEditGeneration,
      queue: QueueName.VideoConversion,
      attempt: 1,
      jobId: claim.id,
      phase: 'deferred_publication',
      category: 'database',
      reasonCode,
      sqlState: '23505',
      aborted: false,
    });
    expect(JSON.stringify(vi.mocked(sut['logger'].error).mock.calls)).not.toContain(privateValue);
    expect(sut['store'].fail).toHaveBeenCalledWith(claim, message, undefined, expect.any(Object));

    vi.mocked(sut['logger'].error).mockClear();
    error.code = privateValue;
    claim.id = privateValue;
    await sut['execute'](claim, new AbortController());
    expect(sut['logger'].error).toHaveBeenCalledExactlyOnceWith('Queue execution failed', {
      jobName: JobName.AssetVideoEditGeneration,
      queue: QueueName.VideoConversion,
      attempt: 1,
      jobId: null,
      phase: 'deferred_publication',
      category: 'error',
      reasonCode,
      sqlState: null,
      aborted: false,
    });
    expect(JSON.stringify(vi.mocked(sut['logger'].error).mock.calls)).not.toContain(privateValue);
  });

  describe('database admission', () => {
    const claim = (index: number): QueueClaim => ({
      id: String(index),
      token: `token-${index}`,
      workerId: 'worker',
      attempt: 1,
      runId: null,
      itemKey: null,
      data: {},
      name: JobName.SendMail,
      queue: QueueName.BackgroundTask,
      startedAt: new Date(),
      deadlineMs: 60_000,
      safeToRetry: false,
    });

    beforeEach(() => {
      vi.spyOn(attemptEvidence, 'recordStoppedAttempt').mockResolvedValue(undefined);
      sut['store'].complete = vi.fn().mockResolvedValue(true);
      sut['store'].fail = vi.fn().mockResolvedValue(true);
      sut['store'].defer = vi.fn().mockResolvedValue(true);
    });

    it('backpressures 128 claimed handlers before they can exhaust the ten-session execution pool', async () => {
      const work = Promise.withResolvers<void>();
      let active = 0;
      let peak = 0;
      let completed = 0;
      sut['eventRepository'].emit = vi.fn().mockImplementation(async () => {
        active++;
        peak = Math.max(peak, active);
        await work.promise;
        active--;
        completed++;
      });
      const other = new JobRepository(
        {} as ModuleRef,
        {} as ConfigRepository,
        sut['eventRepository'],
        sut['logger'],
        sut['store'].db,
      );
      other['store'].complete = sut['store'].complete;
      other['store'].fail = sut['store'].fail;
      other['store'].defer = sut['store'].defer;
      const executions = Array.from({ length: 128 }, (_, index) =>
        (index % 2 ? sut : other)['execute'](claim(index), new AbortController()),
      );
      try {
        await Promise.resolve();
        expect(peak).toBeGreaterThan(0);
        expect(peak).toBeLessThan(10);
      } finally {
        work.resolve();
        await Promise.all(executions);
      }
      expect(completed).toBe(128);
      expect(sut['store'].complete).toHaveBeenCalledTimes(128);
      expect(sut['store'].fail).not.toHaveBeenCalled();
      expect(sut['store'].defer).not.toHaveBeenCalled();
    });

    it('waits outside SQL for publication and never reruns external work after an outcome error', async () => {
      const publication = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      let running = 0;
      let peak = 0;
      const sent = new Set<string>();
      sut['eventRepository'].emit = vi.fn().mockImplementation(() => {
        const id = queueExecution.getStore()!.claim.id;
        expect(sent.has(id)).toBe(false);
        sent.add(id);
        return Promise.resolve();
      });
      sut['store'].complete = vi.fn().mockImplementation(async () => {
        running++;
        peak = Math.max(peak, running);
        entered.resolve();
        await publication.promise;
        running--;
        throw new Error('Outcome unavailable after external work');
      });
      const executions = [
        sut['execute'](claim(1), new AbortController()),
        sut['execute'](claim(2), new AbortController()),
      ];
      try {
        await entered.promise;
        await Promise.resolve();
        expect(peak).toBe(1);
      } finally {
        publication.resolve();
        await Promise.all(executions);
      }
      expect(sent).toEqual(new Set(['1', '2']));
      expect(sut['store'].complete).toHaveBeenCalledTimes(2);
      expect(sut['store'].fail).toHaveBeenCalledTimes(2);
      expect(sut['store'].defer).not.toHaveBeenCalled();
    });

    it.each([true, false])(
      'never starts a cancelled waiter, including when immediate deferral is fenced (%s)',
      async (deferred) => {
        const admission = queueAdmission(sut['store'].db);
        const held = await Promise.all(
          Array.from({ length: QUEUE_EXECUTION_CAPACITY }, () =>
            admission.execution.acquire(new AbortController().signal),
          ),
        );
        sut['store'].defer = vi.fn().mockResolvedValue(deferred);
        sut['eventRepository'].emit = vi.fn();
        const postMessage = vi.fn();
        sut['coordinator'] = { postMessage } as never;
        const abort = new AbortController();
        const execution = sut['execute'](claim(3), abort);
        abort.abort(new Error('Queue deadline reached'));
        await execution;
        for (const release of held) release();
        await Promise.resolve();
        expect(sut['eventRepository'].emit).not.toHaveBeenCalled();
        expect(postMessage).not.toHaveBeenCalled();
        expect(sut['store'].complete).not.toHaveBeenCalled();
        expect(sut['store'].fail).toHaveBeenCalledTimes(deferred ? 0 : 1);
        if (!deferred) {
          expect(sut['store'].fail).toHaveBeenCalledWith(
            expect.objectContaining({ id: '3', token: 'token-3' }),
            'Job deadline or cancellation requested',
            undefined,
            expect.objectContaining({ stopRequestedOnly: true }),
          );
        }
        expect(sut['store'].defer).toHaveBeenCalledWith(
          expect.objectContaining({ id: '3', token: 'token-3' }),
          'local-capacity',
        );
        expect(attemptEvidence.recordStoppedAttempt).toHaveBeenCalledWith(sut['store'].db, '3', 'token-3');
      },
    );
  });
});
