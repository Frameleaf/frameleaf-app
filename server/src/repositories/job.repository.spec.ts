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

  it('deduplicates palette work per source revision and backfill cursor', async () => {
    await sut.queue({ name: JobName.AssetPaletteExtract, data: { id: 'asset', sourceRevision: 'rev1' } });
    await sut.queue({ name: JobName.AssetPaletteExtract, data: { id: 'asset', sourceRevision: 'rev2' } });
    await sut.queue({ name: JobName.AssetPaletteQueueAll, data: { afterId: 'cursor' } });
    expect(enqueue.mock.calls.map(([items]) => items[0].options)).toEqual([
      { deduplication: { id: 'AssetPaletteExtract:asset:rev1' } },
      { deduplication: { id: 'AssetPaletteExtract:asset:rev2' } },
      { deduplication: { id: 'AssetPaletteQueueAll:cursor:false' } },
    ]);
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

  it('keys same-subject jobs with their own identity as separate run items', async () => {
    const execution = context();
    await queueExecution.run(execution, () =>
      sut.collectFollowups(() =>
        sut.queueAll([
          { name: JobName.WorkflowAssetTrigger, data: { workflowId: 'w1', assetId: 'asset', executionId: 'e1' } },
          { name: JobName.WorkflowAssetTrigger, data: { workflowId: 'w2', assetId: 'asset', executionId: 'e2' } },
          { name: JobName.NotifyAlbumUpdate, data: { id: 'album', recipientId: 'u1' } },
          { name: JobName.NotifyAlbumUpdate, data: { id: 'album', recipientId: 'u2' } },
          { name: JobName.AssetGenerateThumbnails, data: { id: 'asset' } },
        ] as never),
      ),
    );
    expect(execution.followups.map(({ itemKey }) => itemKey)).toEqual([
      'asset/workflow-e1',
      'asset/workflow-e2',
      'album/album/u1',
      'album/album/u2',
      'asset',
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
      { name: JobName.PartnerBackfill, data: { sharedById: 'owner', sharedWithId: 'partner' } },
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

    it('defers a late operation-owned claim after shutdown without starting its handler', async () => {
      const late = { ...claim(4), data: { operationId: 'late-operation' } };
      sut['eventRepository'].emit = vi.fn().mockResolvedValue(undefined);
      await sut.stopWorkers(0);
      await sut['execute'](late, new AbortController());
      expect(sut['eventRepository'].emit).not.toHaveBeenCalled();
      expect(sut['store'].complete).not.toHaveBeenCalled();
      expect(sut['store'].defer).toHaveBeenCalledExactlyOnceWith(late, 'local-capacity');
      expect(attemptEvidence.recordStoppedAttempt).toHaveBeenCalledWith(sut['store'].db, late.id, late.token);
    });

    it('warns once per queue and reason when dependency refusals defer jobs, instead of logging each as a failure', async () => {
      sut['eventRepository'].emit = vi.fn().mockImplementation(() => {
        queueExecution.getStore()!.dependencyReason = 'destination-unavailable';
        return Promise.reject(new Error('Machine learning destination refused'));
      });
      for (let index = 0; index < 3; index++) {
        await sut['execute'](claim(index), new AbortController());
      }
      expect(sut['store'].defer).toHaveBeenCalledTimes(3);
      expect(sut['store'].fail).not.toHaveBeenCalled();
      expect(sut['logger'].error).not.toHaveBeenCalled();
      expect(sut['logger'].warn).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining(`${QueueName.BackgroundTask} queue are waiting (destination-unavailable)`),
      );
    });

    it('releases local admission and settles execution while committed observers are pending', async () => {
      const observer = Promise.withResolvers<void>();
      const held = await Promise.all(
        Array.from({ length: QUEUE_EXECUTION_CAPACITY - 1 }, () =>
          queueAdmission(sut['store'].db).execution.acquire(new AbortController().signal),
        ),
      );
      sut['eventRepository'].emit = vi.fn().mockImplementation(() => {
        if (queueExecution.getStore()!.claim.id === '1') {
          queueExecution.getStore()!.afterCommit = [() => observer.promise];
        }
        return Promise.resolve();
      });
      const settled = vi.fn();
      const first = sut['execute'](claim(1), new AbortController()).finally(settled);
      const second = sut['execute'](claim(2), new AbortController());
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toHaveBeenCalledOnce();
        expect(sut['eventRepository'].emit).toHaveBeenCalledTimes(2);
        expect(sut['store'].complete).toHaveBeenCalledTimes(2);
        expect(sut['store'].fail).not.toHaveBeenCalled();
      } finally {
        observer.resolve();
        for (const release of held) release();
        await Promise.all([first, second]);
      }
    });

    it('reserves post-commit capacity before starting handlers and eventually delivers every callback', async () => {
      const pending = Promise.withResolvers<void>();
      const delivered: string[] = [];
      sut['eventRepository'].emit = vi.fn().mockImplementation(() => {
        const execution = queueExecution.getStore()!;
        execution.afterCommit = [
          () => pending.promise,
          () => {
            delivered.push(execution.claim.id);
            return Promise.resolve();
          },
        ];
        return Promise.resolve();
      });
      const executions = Array.from({ length: 24 }, (_, index) => sut['execute'](claim(index), new AbortController()));
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(sut['eventRepository'].emit).toHaveBeenCalledTimes(16);
        expect(sut['store'].complete).toHaveBeenCalledTimes(16);
        expect(delivered).toEqual([]);
      } finally {
        pending.resolve();
        await Promise.all(executions);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(new Set(delivered)).toEqual(new Set(Array.from({ length: 24 }, (_, index) => String(index))));
      expect(sut['store'].fail).not.toHaveBeenCalled();
    });

    it('drains cleanup observers registered by active jobs during shutdown', async () => {
      const handler = Promise.withResolvers<void>();
      const cleanup = Promise.withResolvers<void>();
      sut['eventRepository'].emit = vi.fn().mockImplementation(async () => {
        await handler.promise;
        queueExecution.getStore()!.afterCommit = [() => cleanup.promise];
      });
      const abort = new AbortController();
      const execution = sut['execute'](claim(1), abort).finally(() => sut['active'].delete('1'));
      sut['active'].set('1', { abort, finished: execution.then(() => {}) });
      const finished = vi.fn();
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        const stopping = sut.stopWorkers(1000).then(finished);
        handler.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(finished).not.toHaveBeenCalled();
        expect(sut['active'].size).toBe(0);
        cleanup.resolve();
        await stopping;
        expect(finished).toHaveBeenCalledOnce();
      } finally {
        handler.resolve();
        cleanup.resolve();
        await execution;
      }
    });

    it('bounds shutdown waiting for a pending committed observer by the grace period', async () => {
      const observer = Promise.withResolvers<void>();
      sut['eventRepository'].emit = vi.fn().mockImplementation(() => {
        queueExecution.getStore()!.afterCommit = [() => observer.promise];
        return Promise.resolve();
      });
      const execution = sut['execute'](claim(1), new AbortController());
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        await sut.stopWorkers(0);
        expect(sut['store'].fail).not.toHaveBeenCalled();
      } finally {
        observer.resolve();
        await execution;
      }
    });

    it('contains rejected observers and failed warning logging after a durable completion', async () => {
      sut['eventRepository'].emit = vi.fn().mockImplementation(() => {
        queueExecution.getStore()!.afterCommit = [() => Promise.reject(new Error('offline'))];
        return Promise.resolve();
      });
      vi.mocked(sut['logger'].warn).mockImplementation(() => {
        throw new Error('logging unavailable');
      });
      await expect(sut['execute'](claim(1), new AbortController())).resolves.toBeUndefined();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(sut['store'].complete).toHaveBeenCalledOnce();
      expect(sut['store'].fail).not.toHaveBeenCalled();
      expect(sut['store'].defer).not.toHaveBeenCalled();
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
        await new Promise<void>((resolve) => setImmediate(resolve));
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
