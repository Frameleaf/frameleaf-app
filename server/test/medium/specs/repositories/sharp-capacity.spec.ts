import { sql } from 'kysely';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { JobItem } from 'src/types.js';
import { JobName, JobStatus, QueueName } from 'src/enum.js';
import { publishJobResult } from 'src/queue/context.js';
import { SharpProcessPool } from 'src/queue/sharp-pool.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { QUEUE_TIMING } from 'src/queue/types.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { getKyselyDB } from 'test/utils.js';

/** Real PostgreSQL admission/claim/settlement with a bounded synthetic child; image semantics live in unit regressions. */
describe('local Sharp capacity deferral', () => {
  it('refunds admission attempts and dispatches again when capacity frees, preserving the single genuine retry', async () => {
    const db = await getKyselyDB();
    const store = new SqlQueueStore(db);
    const queue = `sharp-capacity-${randomUUID()}`;
    const worker = randomUUID();
    await store.initialize([queue], worker);
    const pool = new SharpProcessPool({
      workers: 1,
      pending: 0,
      deadlineMs: 10_000,
      graceMs: 30,
      createChild: () =>
        fork(new URL('../../../fixtures/sharp/pool-child.mjs', import.meta.url), [], {
          serialization: 'advanced',
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          execArgv: [],
        }),
    });
    const abort = new AbortController();
    let occupying: Promise<unknown> | undefined;
    try {
      await pool.run('getImageMetadata', ['warm']);
      occupying = pool.run('getImageMetadata', ['hang'], abort.signal).catch(() => {});
      const runId = await store.createRun('sharp-capacity-fixture', {});
      const id = randomUUID();
      await store.enqueue([
        {
          queue,
          name: JobName.AssetGenerateThumbnails,
          data: { id },
          safeToRetry: true,
          sensitive: false,
          deadlineMs: QUEUE_TIMING.opaqueDeadline,
          runId,
          itemKey: id,
          rootItemKey: id,
        },
      ]);
      const adopted = vi.fn();
      let genuineFailures = 0;
      const executor: JobRepository = new JobRepository(
        {} as never,
        {} as never,
        { emit: async (_event: string, _queue: string, item: JobItem) => executor.run(item) } as never,
        { setContext: vi.fn(), error: vi.fn() } as never,
        db,
      );
      executor['handlers'][JobName.AssetGenerateThumbnails] = {
        queueName: queue as QueueName,
        handler: async () => {
          await pool.run('getImageMetadata', ['fixture image']);
          if (genuineFailures++ === 0) {
            throw new Error('genuine media failure');
          }
          await publishJobResult(() => {
            adopted();
            return Promise.resolve();
          });
          return JobStatus.Success;
        },
      } as never;
      const [first] = await store.claim(queue, worker);
      await executor['execute'](first, new AbortController());
      const {
        rows: [deferred],
      } = await sql<{ state: string; base: number; reason: string }>`select state,
        "retryBaseAttempt" base, "dependencyReason" reason from job where id = ${first.id}::uuid`.execute(db);
      expect(deferred).toEqual({ state: 'pending', base: 1, reason: 'local-capacity' });
      expect(genuineFailures).toBe(0);
      expect(adopted).not.toHaveBeenCalled();
      abort.abort();
      await occupying; // Capacity becomes reusable only after the hung child closes.
      for (let attempt = 2; attempt <= 3; attempt++) {
        // Advance only the availability clock; the facade owns every outcome transition.
        await sql`update job set "availableAt" = now() where id = ${first.id}::uuid`.execute(db);
        const [claim] = await store.claim(queue, worker);
        expect(claim.attempt).toBe(attempt);
        await executor['execute'](claim, new AbortController());
      }
      const {
        rows: [settled],
      } = await sql<{ state: string; base: number; attempt: number }>`select state,
        "retryBaseAttempt" base, attempt from job where id = ${first.id}::uuid`.execute(db);
      expect(settled).toEqual({ state: 'completed', base: 1, attempt: 3 });
      expect(adopted).toHaveBeenCalledTimes(1);
      expect(genuineFailures).toBe(2);
    } finally {
      abort.abort();
      await occupying;
      await pool.close();
    }
  }, 20_000);
});
