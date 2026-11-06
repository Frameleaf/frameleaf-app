import { Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { DatabaseLock, JobName, MediaOperationDestination, MediaOperationKind, QueueName } from 'src/enum.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { DB } from 'src/schema/index.js';
import { LibraryService } from 'src/services/library.service.js';
import { getLibraryQueueDB } from 'test/medium/library-queue-database.js';
import { SCALE_ITEMS, scaleIt } from 'test/medium/scale.js';
import { MediumTestContext } from 'test/medium.factory.js';

const ROOTS = SCALE_ITEMS;
// One read of a live run: three quarters of a second, then ten microseconds a photo. A hosted runner
// takes well under that for 25,000 photos; the budget only stops a gross slowdown (FL-1265: one
// index-only pass over the run's jobs, no ledger).
const SUMMARY_BUDGET_MS = Math.min(5000, 750 + ROOTS / 100);

/** A scan's photos as its jobs: one SidecarCheck each, in the scan's run (`runId` = operation id). */
const seedScanJobs = (db: Kysely<DB>, runId: string, after: number, take = 1000) =>
  sql`insert into job (id, queue, name, data, "safeToRetry", sensitive, "deadlineMs", "runId", "itemKey", "rootItemKey")
    select gen_random_uuid(), ${QueueName.Sidecar}, ${JobName.SidecarCheck},
      jsonb_build_object('id', md5(n::text)::uuid::text, 'source', 'upload'), false, false, 300000,
      ${runId}::uuid, md5(n::text)::uuid::text, md5(n::text)::uuid::text
    from generate_series(${after + 1}::int, ${after + take}::int) n`.execute(db);

scaleIt('reports %i photos of a live library scan through the public summary in budget', 0.24, async () => {
  const db = await getLibraryQueueDB();
  const store = new SqlQueueStore(db);
  const jobs = new JobRepository({} as never, {} as never, {} as never, { setContext() {} } as never, db);
  try {
    await store.initialize([QueueName.Library, QueueName.Sidecar], randomUUID());
    await store.pause(QueueName.Sidecar, true);
    const ctx = new MediumTestContext(LibraryService, { database: db, real: [], mock: [LoggingRepository] });
    const { user } = await ctx.newUser({ isAdmin: true });
    const library = await new LibraryRepository(db).create({
      ownerId: user.id,
      name: 'Synthetic summary',
      importPaths: ['/synthetic'],
      exclusionPatterns: [],
    });
    const operation = await new MediaOperationRepository(db).createUnlessActive(
      {
        ownerId: user.id,
        kind: MediaOperationKind.LibraryScan,
        destination: MediaOperationDestination.Local,
        destinationDetail: null,
        label: library.name,
        snapshot: { libraryId: library.id },
        settings: {},
        estimate: null,
        result: {},
      },
      { key: 'libraryId', value: library.id, lock: DatabaseLock.Library },
    );
    if (!('created' in operation)) throw new Error('Synthetic operation unexpectedly active');
    const id = operation.created.id;
    await jobs.ensureLibraryScanSource({ operationId: id, libraryId: library.id }, false);
    const seedStarted = performance.now();
    for (let after = 0; after < ROOTS; after += 1000) await seedScanJobs(db, id, after);
    console.info(
      'library-public-seed-complete',
      JSON.stringify({ roots: ROOTS, elapsedMs: performance.now() - seedStarted }),
    );
    await sql`analyze job`.execute(db);

    const read = async () => (await jobs.listRuns(10, 0)).find((run) => run.id === id)!;
    const started = performance.now();
    // The scan is still going: its photos count already and wait on the paused queue.
    expect(await read()).toMatchObject({ total: ROOTS, paused: ROOTS, enumerationDone: false, finishedAt: null });
    const elapsedMs = performance.now() - started;
    expect(elapsedMs).toBeLessThan(SUMMARY_BUDGET_MS);
    console.info(
      'library-public-summary-calibration',
      JSON.stringify({ roots: ROOTS, elapsedMs, budgetMs: SUMMARY_BUDGET_MS }),
    );

    await sql`update job set state = 'completed', "finishedAt" = now() where id = (
      select id from job where "runId" = ${id}::uuid order by "itemKey" limit 1)`.execute(db);
    await sql`update job set state = 'cancelled', "finishedAt" = now() where id = (
      select id from job where "runId" = ${id}::uuid and state = 'pending' order by "itemKey" limit 1)`.execute(db);
    await sql`update job_run set "enumerationDone" = true where id = ${id}::uuid`.execute(db);
    expect(await read()).toMatchObject({
      total: ROOTS,
      completed: 1,
      cancelled: 1,
      paused: ROOTS - 2,
      enumerationDone: true,
    });
  } finally {
    await db.destroy();
  }
});

it('preserves exact selected-root priority for every pair of actual stage outcomes', async () => {
  const db = await getLibraryQueueDB();
  const store = new SqlQueueStore(db);
  try {
    const queue = `priority-${randomUUID()}`;
    const pausedQueue = `${queue}-paused`;
    await store.initialize([queue, pausedQueue]);
    await store.pause(pausedQueue, true);
    const runId = randomUUID();
    await sql`insert into job_run(id, kind, selection, "enumerationDone") values (${runId}::uuid, 'public-root-priority', '{}', true)`.execute(
      db,
    );
    // Ordered by the existing public root priority. Stored blocked is failed;
    // pending dependency-blocked remains live and outranks terminal outcomes.
    const variants = [
      { state: 'completed', outcome: 'completed', rank: 1 },
      { state: 'cancelled', outcome: 'cancelled', rank: 2 },
      { state: 'failed', outcome: 'failed', rank: 3 },
      { state: 'blocked', outcome: 'failed', rank: 3 },
      { state: 'needs_attention', outcome: 'needsAttention', rank: 4 },
      { state: 'pending', outcome: 'blocked', rank: 5, dependencyReason: 'local-capacity' },
      { state: 'pending', outcome: 'paused', rank: 6, paused: true },
      { state: 'pending', outcome: 'delayed', rank: 7, delayed: true },
      { state: 'pending', outcome: 'waiting', rank: 8 },
      { state: 'pending', outcome: 'retrying', rank: 9, retry: true },
      { state: 'active', outcome: 'active', rank: 10 },
    ];
    const expected = new Map<string, string>();
    const jobs: any[] = [];
    for (const [a, left] of variants.entries())
      for (const [b, right] of variants.entries()) {
        const root = `${a.toString().padStart(2, '0')}/${b.toString().padStart(2, '0')}`;
        expected.set(
          createHash('md5').update(`${runId}:${root}`).digest('hex'),
          (left.rank >= right.rank ? left : right).outcome,
        );
        for (const [stage, variant] of [left, right].entries()) {
          const id = randomUUID();
          const itemKey = `${root}/${stage}`;
          const destination = variant.paused ? pausedQueue : queue;
          jobs.push({
            id,
            runId,
            itemKey,
            rootItemKey: root,
            name: `stage-${stage}`,
            queue: destination,
            data: {},
            safeToRetry: true,
            sensitive: false,
            deadlineMs: 60_000,
            state: variant.state,
            dependencyReason: variant.dependencyReason ?? (variant.state === 'completed' ? 'source-unavailable' : null),
            attempt: variant.retry ? 2 : 0,
            retryBaseAttempt: 0,
            token: variant.state === 'active' ? randomUUID() : null,
            availableAt: new Date(Date.now() + (variant.delayed ? 60_000 : -60_000)),
          });
        }
      }
    expect(jobs).toHaveLength(242);
    await db.insertInto('job').values(jobs).execute();
    const page = await store.listRunItems(runId, 250, 0);
    expect(page).toHaveLength(expected.size);
    for (const item of page!) {
      expect(item.outcome, item.id).toBe(expected.get(item.id));
      expect(item.stageTotals.total).toBe(2);
    }
    const knownReasons = [
      'destination-budget',
      'destination-configuration',
      'destination-consent',
      'destination-unavailable',
      'local-capacity',
      'source-unavailable',
      'workload-disabled',
    ];
    // FL-1265: the run read is exact for these; pending photos read as waiting, paused or blocked there (an
    // index-only pass), while each photo's row above keeps its exact outcome.
    const exact = new Set(['active', 'completed', 'failed', 'cancelled', 'needsAttention']);
    const expectedCounts: Record<string, number> = {};
    for (const outcome of expected.values())
      if (exact.has(outcome)) expectedCounts[outcome] = (expectedCounts[outcome] ?? 0) + 1;
    const before = (await store.listRuns(10, 0)).find((run) => run.id === runId)!;
    expect(before).toMatchObject({ total: expected.size, ...expectedCounts });
    expect(before.reasons.filter((reason) => knownReasons.includes(reason))).toEqual(['local-capacity']);
    // Producer-level jobs can carry every deferred reason while never inflating selected roots.
    const deferred = knownReasons.map((reason) => ({ id: randomUUID(), itemKey: `reason/${reason}`, reason }));
    await db
      .insertInto('job')
      .values(
        deferred.map(({ id, itemKey, reason }) => ({
          id,
          runId,
          itemKey,
          rootItemKey: null,
          name: 'deferred',
          queue,
          data: {},
          safeToRetry: true,
          sensitive: false,
          deadlineMs: 60_000,
          state: 'pending',
          dependencyReason: reason,
        })),
      )
      .execute();
    const after = (await store.listRuns(10, 0)).find((run) => run.id === runId)!;
    expect(after).toMatchObject({ total: expected.size, ...expectedCounts });
    expect(after.stageTotals.total).toBe(249);
    expect(after.reasons.filter((reason) => knownReasons.includes(reason))).toEqual(knownReasons);
  } finally {
    await db.destroy();
  }
});
