import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { SqlQueueStore } from 'src/queue/store.js';
import { QUEUE_TIMING, QueueIntent } from 'src/queue/types.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-1265: a held job waits at `availableAt = 'infinity'`; only releasing its run's hold lets it run. */
describe('queue holds', () => {
  let db: Kysely<any>;
  let store: SqlQueueStore;
  let queue: string;
  let worker: string;
  const intent = (runId: string, itemKey: string, name = 'AssetGenerateThumbnails'): QueueIntent => ({
    queue,
    name,
    data: { id: itemKey },
    safeToRetry: true,
    sensitive: false,
    deadlineMs: QUEUE_TIMING.opaqueDeadline,
    runId,
    itemKey,
    rootItemKey: itemKey,
  });
  const held = async (runId: string) =>
    (
      await sql<{ itemKey: string; held: boolean }>`select "itemKey", "availableAt" = 'infinity' held from job
        where "runId" = ${runId}::uuid order by "itemKey"`.execute(db)
    ).rows;

  beforeAll(async () => {
    db = await getKyselyDB();
    store = new SqlQueueStore(db);
  });
  afterAll(async () => {
    await db.destroy();
  });
  beforeEach(async () => {
    queue = `holds-${randomUUID()}`;
    worker = randomUUID();
    await store.initialize([queue], worker);
  });

  it('never claims or starts a held job, and runs it once the run is released', async () => {
    const runId = await store.createRun('immich-import-derived', {});
    await store.setRunHolds(runId, { AssetGenerateThumbnails: 'setup' }, db);
    await store.enqueue([intent(runId, 'a'), intent(runId, 'b', 'AssetExtractMetadata')]);
    expect(await held(runId)).toEqual([
      { itemKey: 'a', held: true },
      { itemKey: 'b', held: false },
    ]);
    const [metadata] = await store.claim(queue, worker);
    expect(metadata.itemKey).toBe('b');
    expect(await store.claim(queue, worker)).toEqual([]);
    const [{ id }] = (
      await sql<{ id: string }>`select id from job where "runId" = ${runId}::uuid and "itemKey" = 'a'`.execute(db)
    ).rows;
    expect(await store.startNow(queue, id)).toBe(false);
    expect(await store.hasUnfinishedWork(queue, false)).toBe(true); // the claimed metadata job
    await store.complete(metadata, []);
    expect(await store.hasUnfinishedWork(queue, false)).toBe(false);
    expect(await store.hasUnfinishedWork(queue)).toBe(true);
    expect(await store.counts(queue)).toMatchObject({ paused: 1, waiting: 0, delayed: 0 });
    // An import is released only once its journal is activated.
    expect(await store.releaseRun(runId)).toBe('import_not_activated');
    // A Release also drops the holds the upgrade saved, so setup cannot put them back.
    await sql`update job_run set kind = 'AssetGenerateThumbnailsQueueAll',
      selection = selection || '{"authorityHeld":{"AssetGenerateThumbnails":"setup"}}' where id = ${runId}::uuid`.execute(
      db,
    );
    expect(await store.releaseRun(runId)).toBe('released');
    expect(
      (
        await sql<{
          saved: boolean;
        }>`select selection ? 'authorityHeld' saved from job_run where id = ${runId}::uuid`.execute(db)
      ).rows[0].saved,
    ).toBe(false);
    expect(await store.reconcileHolds(1000)).toBe(1);
    expect(await held(runId)).toEqual([
      { itemKey: 'a', held: false },
      { itemKey: 'b', held: false },
    ]);
    expect((await store.claim(queue, worker)).map(({ itemKey }) => itemKey)).toEqual(['a']);
    expect(await store.releaseRun(runId)).toBe('not_held');
    expect(await store.releaseRun(randomUUID())).toBe('not_found');
  });

  it('holds and releases jobs already queued when the descriptor changes, and finishes a pass across pages', async () => {
    const runId = await store.createRun('library-import-derived', {});
    await store.enqueue(Array.from({ length: 2500 }, (_, index) => intent(runId, String(index).padStart(4, '0'))));
    await store.setRunHolds(runId, { AssetGenerateThumbnails: 'paused' }, db);
    expect(await store.reconcileHolds(10_000)).toBe(2500);
    expect(await store.claim(queue, worker)).toEqual([]);
    const {
      rows: [run],
    } = await sql<{
      selection: Record<string, unknown>;
    }>`select selection from job_run where id = ${runId}::uuid`.execute(db);
    expect(run.selection).toEqual({ holds: { AssetGenerateThumbnails: 'paused' } });
    // An unchanged descriptor is not written again.
    await store.setRunHolds(runId, { AssetGenerateThumbnails: 'paused' }, db);
    expect(await store.reconcileHolds(1000)).toBe(0);
    await store.setRunHolds(runId, {}, db);
    expect(await store.reconcileHolds(10_000)).toBe(2500);
    expect(await store.claim(queue, worker, 1)).toHaveLength(1);
  });

  it('keeps held work through Empty and Resume, while Empty cancels work that could run', async () => {
    const runId = await store.createRun('immich-import-derived', {});
    await store.setRunHolds(runId, { AssetGenerateThumbnails: 'setup' }, db);
    await store.enqueue([intent(runId, 'held'), intent(runId, 'free', 'AssetExtractMetadata')]);
    await store.pause(queue, true);
    await store.clear(queue, ['pending', 'waiting']);
    await store.pause(queue, false);
    const { rows } = await sql<{ itemKey: string; state: string; held: boolean }>`select "itemKey", state,
      "availableAt" = 'infinity' held from job where "runId" = ${runId}::uuid order by "itemKey"`.execute(db);
    expect(rows).toEqual([
      { itemKey: 'free', state: 'cancelled', held: false },
      { itemKey: 'held', state: 'pending', held: true },
    ]);
    expect(await store.claim(queue, worker)).toEqual([]);
    // A parked stage does not keep the run open.
    await store.setRunHolds(runId, { AssetGenerateThumbnails: 'parked' }, db);
    expect(await store.runHasLiveWork(runId, { ignoreParked: true })).toBe(false);
    expect(await store.runHasLiveWork(runId)).toBe(true);
  });

  it('starts quiet hours without pausing: only work started by hand runs until the schedule opens', async () => {
    const runId = await store.createRun('AssetGenerateThumbnailsQueueAll', {});
    await store.enqueue([intent(runId, 'a'), intent(runId, 'b')]);
    await store.setConcurrency(queue, 5);
    await store.setSchedule(queue, new Date(Date.now() + 3_600_000));
    expect(await store.getSchedule(queue)).toBeInstanceOf(Date);
    expect(await store.isPaused(queue)).toBe(false);
    expect(await store.claim(queue, worker)).toEqual([]);
    const [{ id }] = (
      await sql<{ id: string }>`select id from job where "runId" = ${runId}::uuid and "itemKey" = 'b'`.execute(db)
    ).rows;
    expect(await store.startNow(queue, id)).toBe(true);
    expect((await store.claim(queue, worker)).map(({ itemKey }) => itemKey)).toEqual(['b']);
    await store.setSchedule(queue, null);
    expect(await store.getSchedule(queue)).toBeNull();
    expect((await store.claim(queue, worker, 1)).map(({ itemKey }) => itemKey)).toEqual(['a']);
  });
});
