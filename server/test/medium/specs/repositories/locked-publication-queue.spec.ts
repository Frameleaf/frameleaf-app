import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { JobName, QueueName } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { QUEUE_TIMING, QueueClaim, QueueExecution, QueueIntent } from 'src/queue/types.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { getKyselyDB } from 'test/utils.js';

describe('Locked sealing after separate publications in one run', () => {
  let db: Kysely<any>;
  let store: SqlQueueStore;
  let repository: JobRepository;
  beforeAll(async () => {
    db = await getKyselyDB();
    store = new SqlQueueStore(db);
    repository = new JobRepository({} as never, {} as never, {} as never, { setContext: vi.fn() } as never, db);
    repository['handlers'][JobName.LockedSeal] = { queueName: QueueName.BackgroundTask } as never;
  });
  afterAll(async () => db?.destroy());

  const sealing = async (claim: QueueClaim): Promise<QueueIntent[]> => {
    const execution: QueueExecution = {
      claim,
      signal: new AbortController().signal,
      progress: vi.fn(),
      progressUnits: 0,
      adoptions: [],
      followups: [],
      buffering: false,
    };
    await queueExecution.run(execution, () =>
      repository.collectFollowups(() =>
        repository.queue({ name: JobName.LockedSeal, data: { id: String(claim.data.id) } }),
      ),
    );
    return execution.followups;
  };

  it.each(['completed', 'active'] as const)(
    'seals a later edited publication after the first seal is %s',
    async (state) => {
      const queue = `locked-publish-${randomUUID()}`,
        worker = randomUUID(),
        asset = randomUUID();
      await store.initialize([queue, QueueName.BackgroundTask], worker);
      const runId = await store.createRun('Forced thumbnails', {});
      const parent = (name: JobName): QueueIntent => ({
        queue,
        name,
        data: { id: asset },
        runId,
        itemKey: asset,
        rootItemKey: asset,
        safeToRetry: true,
        sensitive: false,
        deadlineMs: QUEUE_TIMING.opaqueDeadline,
      });
      await store.enqueue([parent(JobName.AssetGenerateThumbnails), parent(JobName.AssetEditThumbnailGeneration)]);
      const [first] = await store.claim(queue, worker, 1);
      expect(first).toBeDefined();
      expect(await store.complete(first, await sealing(first))).toBe(true);
      const [second] = await store.claim(queue, worker, 1);
      expect(second).toBeDefined();
      const [seal] = await store.claim(QueueName.BackgroundTask, worker);
      expect(seal).toMatchObject({ name: JobName.LockedSeal, data: { id: asset }, rootItemKey: asset });
      if (state === 'completed') expect(await store.complete(seal, [])).toBe(true);
      expect(await store.complete(second, await sealing(second))).toBe(true);
      if (state === 'active') expect(await store.complete(seal, [])).toBe(true);
      const next = await store.claim(QueueName.BackgroundTask, worker);
      expect(next).toHaveLength(1);
      expect(next[0]).toMatchObject({ name: JobName.LockedSeal, data: { id: asset }, rootItemKey: asset });
      expect(next[0].itemKey).not.toBe(seal.itemKey);
      expect(await store.complete(next[0], [])).toBe(true);
      expect(await store.complete(second, await sealing(second))).toBe(false);
      expect(await store.claim(QueueName.BackgroundTask, worker)).toEqual([]);
      const { rows } = await sql<{
        state: string;
        rootItemKey: string;
      }>`select state, "rootItemKey" from job_run_item where "runId"=${runId}::uuid and stage=${JobName.LockedSeal}`.execute(
        db,
      );
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.state === 'completed' && row.rootItemKey === asset)).toBe(true);
      // Ordinary same-run stages retain their once-only identity after a completed publication.
      await store.enqueue([parent(JobName.AssetGenerateThumbnails)]);
      expect(await store.claim(queue, worker)).toEqual([]);
    },
  );
});
