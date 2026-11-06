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

  it.each([
    { state: 'completed', frozen: false },
    { state: 'active', frozen: false },
    { state: 'pending', frozen: false },
    { state: 'pending', frozen: true },
    { state: 'latest', frozen: true },
    { state: 'clear', frozen: true },
  ])('seals every later publication after the first seal is $state, frozen: $frozen', async ({ state, frozen }) => {
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
    const parents = [parent(JobName.AssetGenerateThumbnails), parent(JobName.AssetEditThumbnailGeneration)];
    if (state === 'latest' || state === 'clear') parents.push(parent(JobName.AssetExtractMetadata));
    if (frozen) {
      for (const intent of parents)
        await db
          .transaction()
          .execute((tx) =>
            store.insertSelectionPage(
              { ...intent, runId },
              db.selectFrom(sql<{ id: string }>`(select ${asset}::text id)`.as('selected')).select('id'),
              null,
              10,
              tx,
            ),
          );
    } else {
      await store.enqueue(parents);
    }
    await store.finishEnumeration(runId);
    const [first] = await store.claim(queue, worker, 1);
    expect(first).toBeDefined();
    const firstSeal = await sealing(first);
    expect(await store.complete(first, firstSeal)).toBe(true);
    const [second] = await store.claim(queue, worker, 1);
    expect(second).toBeDefined();
    const seal = state === 'pending' ? undefined : (await store.claim(QueueName.BackgroundTask, worker))[0];
    if (seal) expect(seal).toMatchObject({ name: JobName.LockedSeal, data: { id: asset }, rootItemKey: asset });
    if (state === 'completed') expect(await store.complete(seal!, [])).toBe(true);
    expect(await store.complete(second, await sealing(second))).toBe(true);
    if (state === 'latest' || state === 'clear') {
      const [third] = await store.claim(queue, worker, 1);
      expect(await store.complete(third, await sealing(third))).toBe(true);
    }
    if (['active', 'latest', 'clear'].includes(state)) expect(await store.complete(seal!, [])).toBe(true);
    if (state === 'clear') {
      await store.clear(QueueName.BackgroundTask, ['pending'], [asset]);
      expect(await store.claim(QueueName.BackgroundTask, worker)).toEqual([]);
      expect((await store.listRuns(100, 0)).find((run) => run.id === runId)).toMatchObject({
        state: 'cancelled',
        // FL-1265: the later request replaced the earlier one while the seal ran; only it became a job
        stageTotals: { cancelled: 1 },
      });
      return;
    }
    const next = await store.claim(QueueName.BackgroundTask, worker);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ name: JobName.LockedSeal, data: { id: asset }, rootItemKey: asset });
    if (seal) expect(next[0].itemKey).not.toBe(seal.itemKey);
    if (state === 'pending') expect(next[0].itemKey).toBe(firstSeal[0].itemKey);
    expect(await store.complete(next[0], [])).toBe(true);
    expect(await store.complete(second, await sealing(second))).toBe(false);
    expect(await store.claim(QueueName.BackgroundTask, worker)).toEqual([]);
    const { rows } = await sql<{
      state: string;
      rootItemKey: string;
    }>`select state, "rootItemKey" from job where "runId"=${runId}::uuid and name=${JobName.LockedSeal}`.execute(db);
    // FL-1265: a seal that coalesced into a pending one is that one job; a run counts only its own jobs
    expect(rows).toHaveLength(state === 'pending' ? 1 : 2);
    expect(rows.every((row) => row.state === 'completed' && row.rootItemKey === asset)).toBe(true);
    expect((await store.listRuns(100, 0)).find((run) => run.id === runId)).toMatchObject({
      state: 'completed',
      stageTotals: { cancelled: 0 },
    });
    // Ordinary same-run stages retain their once-only identity after a completed publication.
    await store.enqueue([parent(JobName.AssetGenerateThumbnails)]);
    expect(await store.claim(queue, worker)).toEqual([]);
  });
});
