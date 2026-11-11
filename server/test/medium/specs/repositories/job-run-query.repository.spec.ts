import { Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { getRun, listRunItems, listRuns, observeQueueRun } from 'src/queue/run-query.js';
import { finishRuns } from 'src/queue/run-summary.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<any>;
beforeAll(async () => {
  db = (await getKyselyDB()) as unknown as Kysely<any>;
});
afterAll(async () => {
  await db?.destroy();
});
beforeEach(async () => {
  await sql`truncate job_attempt, job, job_run, job_worker, job_queue cascade`.execute(db);
  await sql`insert into job_queue(name) values ('test'), ('other'), ('paused'), ('closed')`.execute(db);
  await sql`update job_queue set paused = true where name = 'paused'`.execute(db);
  await sql`update job_queue set "closedUntil" = now() + interval '1 hour' where name = 'closed'`.execute(db);
  await sql`insert into job_worker(id) values (${randomUUID()}::uuid)`.execute(db);
});

const run = async (
  options: { enumerationDone?: boolean; kind?: string; holds?: Record<string, string>; id?: string } = {},
) => {
  const id = options.id ?? randomUUID();
  const selection = { mediaNames: ['private-name'], ...(options.holds && { holds: options.holds }) };
  await sql`insert into job_run(id, kind, selection, "enumerationDone", "createdAt")
    values (${id}::uuid, ${options.kind ?? 'test'}, ${JSON.stringify(selection)}::text::jsonb,
      ${options.enumerationDone ?? true}, now() - interval '5 minutes')`.execute(db);
  return id;
};
type JobOptions = {
  state?: string;
  queue?: string;
  held?: boolean;
  delay?: boolean;
  retry?: boolean;
  dependency?: string;
  finishedAgo?: number;
};
const job = async (runId: string, root: string | null, name: string, options: JobOptions = {}) => {
  const id = randomUUID();
  const state = options.state ?? 'pending';
  const token = state === 'active' ? randomUUID() : null;
  const terminal = !['pending', 'waiting', 'active'].includes(state);
  await sql`insert into job(id, queue, name, data, "safeToRetry", sensitive, "deadlineMs", "runId", "itemKey", "rootItemKey",
      state, token, "availableAt", attempt, "dependencyReason", "createdAt", "startedAt", "finishedAt")
    values (${id}::uuid, ${options.queue ?? 'test'}, ${name}, '{"filename":"private-name"}', true, false, 1000,
      ${runId}::uuid, ${randomUUID()}, ${root}, ${state}, ${token}::uuid,
      case when ${options.held ?? false} then 'infinity'::timestamptz
        else now() + ${options.delay ? 60 : -1} * interval '1 minute' end,
      ${options.retry ? 1 : 0}, ${options.dependency ?? null}, now() - interval '5 minutes',
      case when ${state} = 'active' then now() end,
      case when ${terminal} then now() - ${options.finishedAgo ?? 1} * interval '1 minute' end)`.execute(db);
  return id;
};
const read = async (id: string) => (await getRun(db, id))!;

it('counts photos by their most pressing task, and tasks by stage, leaving bookkeeping out of the photos', async () => {
  const id = await run();
  await job(id, 'a', 'Thumbnail', { state: 'completed' });
  await job(id, 'a', 'Faces', { state: 'active' });
  await job(id, 'b', 'Thumbnail', { state: 'completed' });
  await job(id, 'b', 'Faces', { state: 'failed' });
  await job(id, 'c', 'Thumbnail', { state: 'completed' });
  await job(id, 'c', 'Faces', { state: 'needs_attention' });
  await job(id, 'd', 'Thumbnail', { state: 'completed' });
  await job(id, 'e', 'Thumbnail');
  await job(id, 'e', 'Faces', { state: 'cancelled' });
  await job(id, null, 'Producer', { state: 'completed' });

  const summary = await read(id);
  expect(summary).toMatchObject({
    countsPhotos: true,
    total: 5,
    active: 1,
    failed: 1,
    needsAttention: 1,
    completed: 1,
    waiting: 1,
    state: 'running',
    stageTotals: { total: 10, completed: 5, active: 1, failed: 1, needsAttention: 1, cancelled: 1, waiting: 1 },
    failedQueues: ['test'],
    canRelease: false,
    held: 0,
  });
  expect(summary.reasons).toEqual(expect.arrayContaining(['needs_attention', 'stage_failed']));
  expect(JSON.stringify(summary)).not.toMatch(/private-name|mediaNames|selection|itemKey/);
});

it('counts tasks when no job of the run is about a photo', async () => {
  const id = await run();
  await job(id, null, 'Cleanup', { state: 'completed' });
  await job(id, null, 'Cleanup', { state: 'failed' });
  await job(id, null, 'Cleanup');
  expect(await read(id)).toMatchObject({
    countsPhotos: false,
    total: 3,
    completed: 1,
    failed: 1,
    waiting: 1,
    failedQueues: ['test'],
  });
});

it('says why pending work is not running: a paused or closed queue, a dependency, a held setup', async () => {
  const paused = await run();
  await job(paused, 'a', 'Faces', { queue: 'paused' });
  expect(await read(paused)).toMatchObject({ state: 'paused', paused: 1, reasons: ['queue_paused'] });

  const closed = await run();
  await job(closed, 'a', 'Faces', { queue: 'closed' });
  expect(await read(closed)).toMatchObject({ state: 'delayed', delayed: 1, reasons: ['scheduled_delay'] });

  const dependency = await run();
  await job(dependency, 'a', 'Capacity', { dependency: 'destination-capacity' });
  await job(dependency, 'b', 'Locked', { dependency: 'locked-key-unavailable' });
  const blocked = await read(dependency);
  expect(blocked).toMatchObject({ state: 'blocked', stageTotals: { blocked: 2, waiting: 0 } });
  expect(blocked.reasons).toEqual(['dependency_unavailable', 'destination-unavailable']);
  const {
    rows: [stored],
  } = await sql<{ reason: string }>`select "dependencyReason" reason from job
    where "runId" = ${dependency}::uuid and name = 'Capacity'`.execute(db);
  expect(stored.reason).toBe('destination-capacity');
});

it('says a run whose only unfinished photo waits out a retry is retrying, not running (FL-1430)', async () => {
  const id = await run();
  for (const root of ['a', 'b', 'c']) await job(id, root, 'Sidecar', { state: 'completed' });
  await job(id, 'c', 'Metadata', { retry: true, delay: true });
  expect(await read(id)).toMatchObject({
    state: 'retrying',
    total: 3,
    completed: 2,
    retrying: 1,
    waiting: 0,
    stageTotals: { retrying: 1, waiting: 0 },
  });
  expect((await read(id)).reasons).toContain('retry_backoff');

  // work that is simply ready keeps waiting
  const ready = await run();
  await job(ready, 'a', 'Metadata');
  expect(await read(ready)).toMatchObject({ state: 'waiting', waiting: 1, retrying: 0 });
});

it('reports a held setup as blocked, a paused setup as paused, and leaves parked stages out', async () => {
  const setup = await run({ holds: { Faces: 'setup', Smart: 'parked' } });
  await job(setup, 'a', 'Thumbnail', { state: 'completed' });
  await job(setup, 'a', 'Faces', { held: true });
  await job(setup, 'b', 'Thumbnail', { state: 'completed' });
  await job(setup, 'b', 'Smart', { held: true });
  expect(await read(setup)).toMatchObject({
    state: 'blocked',
    reasons: ['first_setup_pending'],
    held: 1,
    canRelease: true,
    total: 2,
    blocked: 1,
    completed: 1,
    stageTotals: { total: 3 },
  });

  const paused = await run({ holds: { Faces: 'paused' } });
  await job(paused, 'a', 'Thumbnail', { state: 'active' });
  await job(paused, 'a', 'Faces', { held: true });
  expect(await read(paused)).toMatchObject({ state: 'paused', held: 1, canRelease: true });
});

it.each([
  ['immich-import-derived', 'frameleaf_immich_import'],
  ['library-import-derived', 'frameleaf_library_import'],
])('offers Release on a held %s run only once its import is activated', async (kind, journal) => {
  await sql`truncate frameleaf_immich_import, frameleaf_library_import cascade`.execute(db);
  const id = await run({ kind, holds: { Faces: 'setup' } });
  await job(id, 'a', 'Faces', { held: true });
  expect(await read(id)).toMatchObject({ canRelease: false, held: 1, state: 'blocked' });
  if (journal === 'frameleaf_immich_import') {
    await sql`insert into frameleaf_immich_import(source_fingerprint, config_fingerprint, source_version, status)
      values ('s', 'c', 'v', 'activated')`.execute(db);
  } else {
    const operationId = randomUUID();
    await sql`insert into frameleaf_library_import(operation_id, binding, status)
      values (${operationId}::uuid, ${JSON.stringify({ operationId })}::text::jsonb, 'activated')`.execute(db);
  }
  expect(await read(id)).toMatchObject({ canRelease: true });
});

it('warns about a stuck backlog only when ready work has had no progress for two minutes', async () => {
  const id = await run();
  await job(id, 'a', 'Thumbnail');
  const stuck = await read(id);
  expect(stuck).toMatchObject({ noDispatchBacklog: true, state: 'waiting' });
  expect(stuck.reasons).toContain('no_dispatch_backlog');
  await job(id, 'b', 'Thumbnail', { state: 'completed', finishedAgo: 0 });
  expect(await read(id)).toMatchObject({ noDispatchBacklog: false, lastStage: 'Thumbnail' });
});

it('finishes a run once, from its jobs, and then reads the stored summary', async () => {
  const id = await run();
  await job(id, 'a', 'Thumbnail', { state: 'completed' });
  await job(id, 'a', 'Faces', { state: 'failed' });
  const live = await job(id, 'b', 'Thumbnail', { state: 'active' });
  expect(await finishRuns(db, 10)).toBe(0);

  await sql`update job set state = 'completed', token = null, "finishedAt" = now() where id = ${live}::uuid`.execute(
    db,
  );
  expect(await finishRuns(db, 10)).toBe(1);
  expect(await finishRuns(db, 10)).toBe(0);
  const finished = await read(id);
  expect(finished).toMatchObject({
    state: 'completed_with_errors',
    total: 2,
    failed: 1,
    completed: 1,
    countsPhotos: true,
    failedQueues: ['test'],
  });
  expect(finished.finishedAt).toBeInstanceOf(Date);
  const {
    rows: [stamp],
  } = await sql<{
    valid: boolean;
  }>`select (summary->>'finishedAt')::timestamptz = "finishedAt" and summary->>'complete' = 'true' valid
    from job_run where id = ${id}::uuid`.execute(db);
  expect(stamp.valid).toBe(true);

  // Pruned history keeps its counts.
  await sql`delete from job where "runId" = ${id}::uuid`.execute(db);
  expect(await read(id)).toMatchObject({ total: 2, failed: 1, state: 'completed_with_errors' });

  // A reopened run is counted from its jobs again and finished again.
  await sql`update job_run set "finishedAt" = null where id = ${id}::uuid`.execute(db);
  await job(id, 'c', 'Thumbnail');
  expect(await read(id)).toMatchObject({ total: 1, waiting: 1, finishedAt: null });
  expect(await finishRuns(db, 10)).toBe(0);
});

it('finishes a run whose only unfinished work is a parked stage, and repairs a stale summary', async () => {
  const parked = await run({ holds: { Smart: 'parked' } });
  await job(parked, 'a', 'Thumbnail', { state: 'completed' });
  await job(parked, 'a', 'Smart', { held: true });
  const open = await run({ enumerationDone: false });
  await job(open, 'a', 'Thumbnail', { state: 'completed' });
  const stale = await run();
  await job(stale, 'a', 'Thumbnail', { state: 'completed' });
  await sql`update job_run set "finishedAt" = now() - interval '1 minute', summary = '{"final":false}'
    where id = ${stale}::uuid`.execute(db);
  const {
    rows: [before],
  } = await sql<{ at: Date }>`select "finishedAt" at from job_run where id = ${stale}::uuid`.execute(db);

  expect(await finishRuns(db, 10)).toBe(2);
  expect(await read(parked)).toMatchObject({ state: 'completed', total: 1, completed: 1 });
  expect(await read(open)).toMatchObject({ finishedAt: null, enumerationDone: false, reasons: ['enumerating'] });
  const repaired = await read(stale);
  expect(repaired).toMatchObject({ state: 'completed', total: 1 });
  expect(repaired.finishedAt?.getTime()).toBe(before.at.getTime());
});

it('lists unfinished runs first and pages them; an unknown run reads as missing', async () => {
  const finished = await run();
  await job(finished, 'a', 'Thumbnail', { state: 'completed' });
  await finishRuns(db, 10);
  await sql`insert into job_run(id, kind, selection, "enumerationDone", "finishedAt", summary)
    select uuid_generate_v4(), 'newer', '{}', true, now(), null from generate_series(1, 3)`.execute(db);
  const unfinished = await run();
  await job(unfinished, 'a', 'Thumbnail');
  const page = await listRuns(db, 25, 0);
  expect(page[0].id).toBe(unfinished);
  expect(page).toHaveLength(5);
  expect(await listRuns(db, 2, 1)).toHaveLength(2);
  expect(await getRun(db, randomUUID())).toBeUndefined();
  expect(await listRunItems(db, randomUUID(), 25, 0)).toBeUndefined();
});

it('pages a run’s photos in root order with opaque ids and per-photo outcomes', async () => {
  const id = await run({ holds: { Smart: 'parked', Faces: 'setup' } });
  await job(id, 'a', 'Thumbnail', { state: 'completed' });
  await job(id, 'a', 'Faces', { held: true });
  await job(id, 'b', 'Thumbnail', { retry: true, delay: true });
  await job(id, 'c', 'Thumbnail', { dependency: 'destination-capacity' });
  await job(id, 'd', 'Thumbnail', { queue: 'paused' });
  await job(id, 'e', 'Smart', { held: true });
  await job(id, null, 'Producer', { state: 'active' });

  const items = (await listRunItems(db, id, 10, 0))!;
  expect(items.map((item) => item.id)).toEqual(
    ['a', 'b', 'c', 'd'].map((root) => createHash('md5').update(`${id}:${root}`).digest('hex')),
  );
  expect(items.map((item) => item.outcome)).toEqual(['blocked', 'retrying', 'blocked', 'paused']);
  expect(items[0]).toMatchObject({ stageTotals: { total: 2, completed: 1, blocked: 1 }, lastStage: 'Thumbnail' });
  expect(items[2].reasons).toEqual(['dependency_unavailable', 'destination-unavailable']);
  expect(items[3].reasons).toEqual(['queue_paused']);
  expect(await listRunItems(db, id, 2, 3)).toHaveLength(1);
  expect(JSON.stringify(items)).not.toMatch(/private-name|"a"|itemKey|rootItemKey/);
});

it('reads an unfinished run’s photos from the progress index without a sort', async () => {
  const id = await run();
  await sql`insert into job(id, queue, name, data, "safeToRetry", sensitive, "deadlineMs", "runId", "itemKey", "rootItemKey", state)
    select gen_random_uuid(), 'test', stage, '{}', true, false, 1000, ${id}::uuid, root || ':' || stage, root,
      case when n % 3 = 0 then 'completed' else 'pending' end
    from generate_series(1, 20000) n, lateral (select 'root-' || lpad(n::text, 6, '0') root) r,
      unnest(array['Thumbnail','Faces','Smart']) stage`.execute(db);
  await sql`vacuum (analyze) job`.execute(db);
  const { rows } = await sql<{ 'QUERY PLAN': unknown }>`explain (format json)
    select "rootItemKey" is not null rooted, max(case when state = 'active' then 10 else 1 end) top,
      array_agg(distinct name) filter (where state in ('pending','waiting')) live
    from job where "runId" = ${id}::uuid and not (state in ('pending','waiting') and name = any(${[]}::text[]))
    group by "rootItemKey"`.execute(db);
  const plan = JSON.stringify(rows[0]['QUERY PLAN']);
  expect(plan).toContain('job_run_progress');
  expect(plan).not.toContain('"Node Type":"Sort"');
  expect(await read(id)).toMatchObject({ total: 20_000, countsPhotos: true, stageTotals: { total: 60_000 } });
});

it('counts jobs outside a run that finished since the oldest waiting one was queued (FL-588)', async () => {
  const loose = (state: string, createdAgo: number, finishedAgo: number | null) =>
    sql`insert into job(id, queue, name, data, "safeToRetry", sensitive, "deadlineMs", state, token, "createdAt", "finishedAt")
      values (${randomUUID()}::uuid, 'test', 'Thumbnail', '{}', true, false, 1000, ${state},
        ${state === 'active' ? randomUUID() : null}::uuid, now() - ${createdAgo} * interval '1 minute',
        case when ${finishedAgo}::int is null then null else now() - ${finishedAgo}::int * interval '1 minute' end)`.execute(
      db,
    );
  await loose('completed', 120, 100);
  await loose('completed', 10, 9);
  await loose('completed', 10, 8);
  await loose('active', 10, null);
  await loose('pending', 10, null);
  expect(await observeQueueRun(db, 'test')).toMatchObject({ active: 1, waiting: 1, processed: 2 });
});

it('counts live queue jobs of a run already marked finished', async () => {
  const id = await run();
  await job(id, 'root', 'Thumbnail', { state: 'active' });
  await job(id, 'root-2', 'Thumbnail');
  await sql`update job_run set "finishedAt" = now() where id = ${id}::uuid`.execute(db);
  expect(await observeQueueRun(db, 'test')).toMatchObject({ active: 1, waiting: 1 });
});

it('reads edit deliveries through their media operation, as the queue counts do', async () => {
  const ownerId = randomUUID();
  const groupId = randomUUID();
  await sql`insert into cluster_group(id) values (${groupId}::uuid)`.execute(db);
  await sql`insert into "user"(id, name, email, "clusterGroupId")
    values (${ownerId}::uuid, 'edit owner', ${`${ownerId}@example.test`}, ${groupId}::uuid)`.execute(db);
  await sql`insert into job_queue(name) values ('editor')`.execute(db);
  const delivery = async (status: string, rawState: string, age = 1) => {
    const operationId = randomUUID();
    const assetId = randomUUID();
    const name = 'AssetEditThumbnailGeneration';
    await sql`insert into media_operation(id, "ownerId", kind, status, destination, label, snapshot, settings)
      values (${operationId}::uuid, ${ownerId}::uuid, 'quick_edit', ${status}, 'local', 'Edit',
        ${JSON.stringify({ executor: 'job_queue', job: { name, data: { id: assetId } } })}::text::jsonb, '{}')`.execute(
      db,
    );
    const insert = async (state: string, minutes: number) => {
      const token = state === 'active' ? randomUUID() : null;
      await sql`insert into job(id, queue, name, data, "safeToRetry", sensitive, "deadlineMs", state, token, "createdAt", "finishedAt")
        values (${randomUUID()}::uuid, 'editor', ${name}, ${JSON.stringify({ id: assetId, operationId })}::text::jsonb, true, false, 1000, ${state},
          ${token}::uuid, now() - ${minutes} * interval '1 minute',
          case when ${state} in ('completed','failed','cancelled') then now() end)`.execute(db);
    };
    await insert(rawState, age);
    return insert;
  };
  await delivery('paused', 'completed');
  const rendering = await delivery('rendering', 'pending');
  await rendering('pending', 3);
  await delivery('cancelled', 'pending');

  const counts = await new SqlQueueStore(db).counts('editor');
  expect(counts).toMatchObject({ active: 1, paused: 1, waiting: 0 });
  expect(await observeQueueRun(db, 'editor')).toMatchObject({ active: 1, waiting: 1, paused: 1 });
});

describe('Recent work (FL-1349)', () => {
  const night = async (daysAgo: number, failedRoots: string[], doneRoots: string[] = []) => {
    const id = await run({ kind: 'OvernightSequence' });
    await sql`update job_run set "createdAt" = now() - ${daysAgo} * interval '1 day' where id = ${id}::uuid`.execute(
      db,
    );
    await job(id, null, 'OvernightSequence', { state: 'completed' });
    for (const root of failedRoots) await job(id, root, 'Thumbnail', { state: 'failed' });
    for (const root of doneRoots) await job(id, root, 'Thumbnail', { state: 'completed' });
    return id;
  };

  it('folds three nightly runs into the newest, with two earlier nights', async () => {
    const oldest = await night(3, ['a'], ['b', 'c']);
    const middle = await night(2, ['a', 'b'], ['c']);
    const newest = await night(1, ['a'], ['b']);
    const manual = await run();
    await job(manual, 'a', 'Thumbnail', { state: 'completed' });
    await finishRuns(db, 10);

    const folded = await listRuns(db, 25, 0, true);
    expect(folded.map(({ id }) => id)).toEqual([manual, newest]);
    expect(folded[0]).toMatchObject({ nightly: false });
    expect(folded[0].earlierRuns).toBeUndefined();
    expect(folded[1]).toMatchObject({
      nightly: true,
      earlierRuns: [
        { id: middle, total: 3, leftOver: 2, finishedAt: expect.any(Date) },
        { id: oldest, total: 3, leftOver: 1, finishedAt: expect.any(Date) },
      ],
    });
  });

  it('the same photos left over 2 nights in a row; a third night with fewer ends the streak', async () => {
    await night(3, ['a'], ['b']);
    await night(2, ['a', 'b', 'c']);
    const newest = await night(1, ['a', 'b'], ['c']);
    await finishRuns(db, 10);
    const [card] = await listRuns(db, 25, 0, true);
    expect(card).toMatchObject({ id: newest, leftOverStreak: { photos: 2, nights: 2, capped: false } });

    // pruned history can only shorten it
    await sql`delete from job where "runId" = ${newest}::uuid`.execute(db);
    const [pruned] = await listRuns(db, 25, 0, true);
    expect(pruned.leftOverStreak).toBeUndefined();
  });

  it('says the streak may be longer once it counts back through every night it reads', async () => {
    for (let daysAgo = 8; daysAgo >= 1; daysAgo--) await night(daysAgo, ['a']);
    await finishRuns(db, 20);
    const [card] = await listRuns(db, 25, 0, true);
    expect(card).toMatchObject({ leftOverStreak: { photos: 1, nights: 7, capped: true }, leftOver: 1 });
  });

  it('names the paused step’s queue for Resume', async () => {
    const id = await run();
    await job(id, 'a', 'Thumbnail', { state: 'active' });
    await job(id, 'b', 'Faces', { queue: 'paused' });
    await job(id, 'c', 'Smart', { queue: 'closed' });
    expect(await read(id)).toMatchObject({ pausedQueues: ['paused'] });
    const other = await run();
    await job(other, 'a', 'Thumbnail');
    expect(await read(other)).toMatchObject({ pausedQueues: [] });
  });

  it('names the external library a deferred import waits for', async () => {
    const { ctx } = newMediumService(BaseService, {
      database: db as unknown as Kysely<DB>,
      real: [],
      mock: [LoggingRepository],
    });
    const { user } = await ctx.newUser();
    const libraryId = randomUUID();
    await sql`insert into library(id, name, "ownerId", "importPaths", "exclusionPatterns")
      values (${libraryId}::uuid, 'Holiday drive', ${user.id}::uuid, '{/mnt/a}', '{}')`.execute(db);
    const { asset } = await ctx.newAsset({ ownerId: user.id, libraryId });
    const { asset: upload } = await ctx.newAsset({ ownerId: user.id });
    const id = await run({ kind: 'library-import-derived' });
    await job(id, asset.id, 'Smart', { dependency: 'source-unavailable' });
    await job(id, upload.id, 'Smart', { dependency: 'source-unavailable' });
    expect(await read(id)).toMatchObject({ unreachableLibraries: ['Holiday drive'] });
    const plain = await run();
    await job(plain, 'a', 'Thumbnail');
    expect((await read(plain)).unreachableLibraries).toBeUndefined();
  });

  describe('a whole night is one card (FL-1430)', () => {
    const NIGHT_ONE = '2026-11-11T02:33:00.226Z';
    const NIGHT_TWO = '2026-11-12T02:40:05.635Z';
    /** A run opened `minutesAgo` minutes ago, marked with a night (or a person's Run now night), or unmarked. */
    const opened = async (
      kind: string,
      minutesAgo: number,
      night?: { startedAt: string; manual?: boolean },
      selection: Record<string, unknown> = {},
    ) => {
      const id = randomUUID();
      const marked = night ? { ...selection, night: { manual: false, ...night } } : selection;
      await sql`insert into job_run(id, kind, selection, "enumerationDone", "createdAt")
        values (${id}::uuid, ${kind}, ${JSON.stringify(marked)}::text::jsonb, true,
          now() - ${minutesAgo} * interval '1 minute')`.execute(db);
      return id;
    };
    const finishAll = async () => {
      await finishRuns(db, 100);
    };
    beforeEach(async () => {
      await sql`delete from system_metadata where key = 'overnight-sequence'`.execute(db);
    });

    it("one card per night, numbered by the night's real work, newest night on the card", async () => {
      // the first night: the overnight run, server processing, a folder scan and an empty catch-up
      const wrapperOne = await opened('OvernightSequence', 600, { startedAt: NIGHT_ONE });
      await job(wrapperOne, null, 'OvernightSequence', { state: 'completed' });
      const serverOne = await opened('AssetGenerateThumbnailsQueueAll', 599, { startedAt: NIGHT_ONE });
      await job(serverOne, null, 'AssetGenerateThumbnailsQueueAll', { state: 'completed' });
      await job(serverOne, null, 'profile-image-repair', { state: 'completed' });
      const scanOne = await opened('library_scan', 598, { startedAt: NIGHT_ONE });
      await job(scanOne, 'a', 'Metadata', { state: 'failed' });
      await job(scanOne, 'b', 'Metadata', { state: 'completed' });
      await job(scanOne, 'c', 'Metadata', { state: 'completed' });
      await opened('AssetExtractMetadata', 597, { startedAt: NIGHT_ONE });
      // a person ran server processing in between: not the night's
      const manual = await opened('AssetGenerateThumbnailsQueueAll', 300);
      await job(manual, null, 'AssetGenerateThumbnailsQueueAll', { state: 'completed' });
      // a Run now night stays apart too
      const runNow = await opened('OvernightSequence', 250, { startedAt: '2026-11-11T12:00:00.000Z', manual: true });
      await job(runNow, null, 'OvernightSequence', { state: 'completed' });
      // the second night: server processing, a scan that left the same photo over, and one still going
      const serverTwo = await opened('AssetGenerateThumbnailsQueueAll', 60, { startedAt: NIGHT_TWO });
      await job(serverTwo, null, 'AssetGenerateThumbnailsQueueAll', { state: 'completed' });
      const scanTwo = await opened('library_scan', 59, { startedAt: NIGHT_TWO });
      await job(scanTwo, 'a', 'Metadata', { state: 'failed' });
      await job(scanTwo, 'd', 'Metadata', { state: 'completed' });
      await finishAll();

      const page = await listRuns(db, 25, 0, true);
      expect(page.map(({ id }) => id)).toEqual([scanTwo, runNow, manual]);
      const [card] = page;
      expect(card).toMatchObject({
        nightly: true,
        kind: 'OvernightSequence',
        state: 'completed_with_errors',
        countsPhotos: true,
        total: 2,
        completed: 1,
        failed: 1,
        leftOver: 1,
        failureCauses: [{ cause: 'other', count: 1 }],
        leftOverStreak: { photos: 1, nights: 2, capped: false },
      });
      expect(card.finishedAt).toBeInstanceOf(Date);
      expect(card.earlierRuns).toEqual([
        { id: expect.any(String), createdAt: expect.any(Date), finishedAt: expect.any(Date), total: 3, leftOver: 1 },
      ]);
      expect(page[1]).toMatchObject({ nightly: true });
      expect(page[1].earlierRuns).toBeUndefined();

      // something of the night still going: the card is still going
      const late = await opened('library_scan', 30, { startedAt: NIGHT_TWO });
      await job(late, 'e', 'Metadata', { state: 'active' });
      const [going] = await listRuns(db, 25, 0, true);
      expect(going).toMatchObject({ id: late, nightly: true, state: 'running', finishedAt: null, total: 3, active: 1 });
    });

    it('folds runs from before nights were marked by the nights the schedule recorded', async () => {
      const { ctx } = newMediumService(BaseService, {
        database: db as unknown as Kysely<DB>,
        real: [],
        mock: [LoggingRepository],
      });
      const { user } = await ctx.newUser();
      const scan = async (minutesAgo: number, trigger: 'manual' | 'automatic') => {
        const id = await opened('library_scan', minutesAgo);
        await sql`insert into media_operation(id, "ownerId", kind, status, destination, label, snapshot, settings)
          values (${id}::uuid, ${user.id}::uuid, 'library_scan', 'completed', 'local', 'Scan',
            ${JSON.stringify({ libraryId: randomUUID(), trigger })}::text::jsonb, '{}')`.execute(db);
        await job(id, 'a', 'Metadata', { state: 'completed' });
        return id;
      };
      await sql`delete from system_metadata where key = 'overnight-sequence'`.execute(db);
      const startedAt = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
      await sql`insert into system_metadata(key, value) values ('overnight-sequence', ${JSON.stringify({
        run: null,
        nights: [{ startedAt: startedAt(100), finishedAt: startedAt(70), manual: false, results: {} }],
      })}::text::jsonb)`.execute(db);
      const catchUp = await opened('AssetExtractMetadata', 95);
      await job(catchUp, null, 'AssetExtractMetadata', { state: 'completed' });
      const automatic = await scan(90, 'automatic');
      const byHand = await scan(85, 'manual');
      const outside = await opened('AssetExtractMetadata', 20);
      await job(outside, null, 'AssetExtractMetadata', { state: 'completed' });
      await finishAll();

      const page = await listRuns(db, 25, 0, true);
      expect(page.map(({ id }) => id).toSorted()).toEqual([automatic, byHand, outside].toSorted());
      expect(page.find(({ id }) => id === automatic)).toMatchObject({ nightly: true, total: 1 });
      await sql`delete from system_metadata where key = 'overnight-sequence'`.execute(db);
    });

    it('leaves out finished runs with no work at all, and pages what is left without gaps', async () => {
      for (let n = 0; n < 4; n++) await opened('AssetEncodeVideo', 50 + n);
      const kept: string[] = [];
      for (let n = 0; n < 3; n++) {
        const id = await opened('test', 40 + n);
        await job(id, 'a', 'Thumbnail', { state: 'completed' });
        kept.push(id);
      }
      // still finding its work: not empty
      const enumerating = await run({ enumerationDone: false });
      await finishAll();

      const page = await listRuns(db, 25, 0, true);
      expect(page.map(({ id }) => id)).toEqual([enumerating, ...kept]);
      const pages = [await listRuns(db, 2, 0, true), await listRuns(db, 2, 2, true), await listRuns(db, 2, 4, true)];
      expect(pages.map((items) => items.map(({ id }) => id))).toEqual([[enumerating, kept[0]], [kept[1], kept[2]], []]);
      // without foldNightly they are all there, as before
      expect(await listRuns(db, 25, 0)).toHaveLength(8);
    });

    it('puts work still going first, newest started first, then finished work by when it finished', async () => {
      const finishedEarly = await opened('test', 300);
      await job(finishedEarly, 'a', 'Thumbnail', { state: 'completed' });
      const finishedLate = await opened('test', 400);
      await job(finishedLate, 'a', 'Thumbnail', { state: 'completed' });
      const openOld = await opened('test', 500);
      await job(openOld, 'a', 'Thumbnail', { state: 'active' });
      const openNew = await opened('test', 10);
      await job(openNew, 'a', 'Thumbnail');
      await finishAll();
      await sql`update job_run set "finishedAt" = now() - interval '200 minutes',
          summary = jsonb_set(summary, '{finishedAt}', to_jsonb(now() - interval '200 minutes'))
        where id = ${finishedEarly}::uuid`.execute(db);
      await sql`update job_run set "finishedAt" = now() - interval '100 minutes',
          summary = jsonb_set(summary, '{finishedAt}', to_jsonb(now() - interval '100 minutes'))
        where id = ${finishedLate}::uuid`.execute(db);
      const page = await listRuns(db, 25, 0, true);
      expect(page.map(({ id }) => id)).toEqual([openNew, openOld, finishedLate, finishedEarly]);
      expect(page[3].state).toBe('completed');
    });

    it('a refused folder scan says it could not reach the library, by name, and names its library', async () => {
      const { ctx } = newMediumService(BaseService, {
        database: db as unknown as Kysely<DB>,
        real: [],
        mock: [LoggingRepository],
      });
      const { user } = await ctx.newUser();
      const libraryId = randomUUID();
      await sql`insert into library(id, name, "ownerId", "importPaths", "exclusionPatterns")
        values (${libraryId}::uuid, 'Jamie''s phone', ${user.id}::uuid, '{/import-jamie}', '{}')`.execute(db);
      const scan = async (status: string, errorCode: string | null) => {
        const id = await opened('library_scan', 5, undefined, { libraryId });
        await sql`insert into media_operation(id, "ownerId", kind, status, destination, label, snapshot, settings, "errorCode")
          values (${id}::uuid, ${user.id}::uuid, 'library_scan', ${status}, 'local', 'Scan',
            ${JSON.stringify({ libraryId, trigger: 'manual' })}::text::jsonb, '{}', ${errorCode})`.execute(db);
        return id;
      };
      const refused = await scan('failed', 'library_source_empty');
      const done = await scan('completed', null);
      await job(done, 'a', 'Metadata', { state: 'completed' });
      await finishAll();

      const page = await listRuns(db, 25, 0, true);
      expect(page.map(({ id }) => id).toSorted()).toEqual([refused, done].toSorted());
      const card = page.find(({ id }) => id === refused)!;
      expect(card).toMatchObject({
        state: 'completed',
        total: 0,
        libraryName: "Jamie's phone",
        unreachableLibraries: ["Jamie's phone"],
      });
      expect(card.reasons).toContain('source-unavailable');
      expect(page.find(({ id }) => id === done)).toMatchObject({ libraryName: "Jamie's phone" });
      expect(page.find(({ id }) => id === done)!.reasons).not.toContain('source-unavailable');
      // a deleted library keeps the plain title
      await sql`update library set "deletedAt" = now() where id = ${libraryId}::uuid`.execute(db);
      expect((await read(done)).libraryName).toBeUndefined();
    });
  });

  it('without foldNightly the list is unchanged', async () => {
    const older = await night(2, ['a']);
    const newer = await night(1, ['a']);
    await finishRuns(db, 10);
    const page = await listRuns(db, 25, 0);
    expect(page.map(({ id }) => id)).toEqual([newer, older]);
    expect(page[0].earlierRuns).toBeUndefined();
    expect(page[0].leftOverStreak).toBeUndefined();
    expect(page[0]).toMatchObject({ nightly: true });
  });
});
