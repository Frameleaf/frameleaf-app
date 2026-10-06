import { sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  DatabaseLock,
  JobName,
  JobStatus,
  MediaOperationDestination,
  MediaOperationKind,
  QueueName,
} from 'src/enum.js';
import { shareSelectionPage } from 'src/queue/manifest.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { LibraryService } from 'src/services/library.service.js';
import { explainLibraryRunRead, getLibraryQueueDB, profileLibraryRunRead } from 'test/medium/library-queue-database.js';
import { MediumTestContext } from 'test/medium.factory.js';

/** Synthetic ledger construction is excluded from public read timing. The separate service
 * harness proves actual asset/source acceptance; this calibrates its million-row read shape.
 */
it('reports 500000 cold selected roots and one producer through the actual public summary within existing SQL limits', async () => {
  const db = await getLibraryQueueDB();
  const store = new SqlQueueStore(db),
    worker = randomUUID();
  const jobs = new JobRepository({} as never, {} as never, {} as never, { setContext() {} } as never, db);
  jobs['handlers'][JobName.SidecarCheck] = {
    jobName: JobName.SidecarCheck,
    queueName: QueueName.Sidecar,
    label: 'Synthetic public read',
    handler: () => Promise.resolve(JobStatus.Success),
  };
  try {
    await store.initialize([QueueName.Library, QueueName.Sidecar], worker);
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
    const origin = await store.createRun('synthetic-library-origin', {});
    const itemKey = (n: number) => `library/${id}/${n.toString().padStart(20, '0')}`;
    await store.enqueue([
      {
        name: JobName.LibraryScanQueueAll,
        queue: QueueName.Library,
        data: {},
        safeToRetry: false,
        sensitive: false,
        deadlineMs: 300_000,
        runId: origin,
        itemKey: 'producer',
        rootItemKey: null,
      },
    ]);
    const [producer] = await store.claim(QueueName.Library, worker);
    await sql`insert into job_library_source_producer("selectionId","producerId") values (${id}::uuid,${producer.id}::uuid)`.execute(
      db,
    );
    await sql`insert into job_selection_run("runId","selectionId","copyComplete","libraryVersion") values (${origin}::uuid,${id}::uuid,true,500000)`.execute(
      db,
    );
    expect(await store.complete(producer, [])).toBe(true);
    // Deliberate SQL-only fixture population with production-width item/hash keys and
    // copied-origin rows (no canonical intent). Not an append/checkpoint/media acceptance.
    // Synthetic construction uses 1000-row statements to avoid 4000 serial round trips before read timing.
    for (let after = 0; after < 500_000; after += 1000)
      for (const run of [id, origin])
        await sql`insert into job_run_item("runId","itemKey","rootItemKey",stage,queue,selection,"selectionId","librarySourceKey","libraryIntent","libraryOriginComplete")
          select ${run}::uuid,'library/'||${id}::text||'/'||lpad(n::text,20,'0'),md5(n::text)::uuid::text,${JobName.SidecarCheck},${QueueName.Sidecar},jsonb_build_object('id',md5(n::text)::uuid::text,'source','upload'),${id}::uuid,
            case when ${run === id} then md5(n::text)||md5(n::text) end,
            case when ${run === id} then jsonb_build_object('name',${JobName.SidecarCheck}::text,'queue',${QueueName.Sidecar}::text,'data',jsonb_build_object('id',md5(n::text)::uuid::text,'source','upload'),
              'safeToRetry',false,'sensitive',false,'deadlineMs',300000,'runId',${id}::text,'itemKey','library/'||${id}::text||'/'||lpad(n::text,20,'0'),'rootItemKey',md5(n::text)::uuid::text) end,${run === id}
          from generate_series(${after + 1}::int,${after + 1000}::int) n`.execute(db);
    await sql`update job_selection set state='ready',"sourceClosedAt"=now(),"capturedAt"=now(),"appendSequence"=500000 where id=${id}::uuid`.execute(
      db,
    );
    await sql`update job_selection_run set "copyComplete"=false,"copyAfter"=${itemKey(500_000)},"libraryVersion"=500000 where "selectionId"=${id}::uuid and "runId"=${origin}::uuid`.execute(
      db,
    );
    // The synthetic initial rows have no descendant proof obligations, as the real append
    // sets libraryOriginComplete=true for initial roots. One final empty page acknowledges it.
    expect(await shareSelectionPage(db, { queue: QueueName.Sidecar })).toBe(true);
    expect(await shareSelectionPage(db, { queue: QueueName.Sidecar })).toBe(false);
    await sql`analyze job_run_item`.execute(db);
    const started = performance.now();
    const summary = await (async () => {
      try {
        return (await store.listRuns(10, 0)).find((run) => run.id === origin)!;
      } catch (error) {
        console.info('library-public-summary-estimated-plan', JSON.stringify(await explainLibraryRunRead(db)));
        await profileLibraryRunRead(db);
        throw error;
      }
    })();
    const elapsedMs = performance.now() - started;
    expect(summary).toMatchObject({
      total: 500_000,
      stageTotals: { total: 500_001, completed: 1, paused: 500_000 },
      enumerationDone: true,
    });
    expect(elapsedMs).toBeLessThan(5000);
    console.info(
      'library-public-summary-calibration',
      JSON.stringify({ roots: 500_000, ledgerRows: 1_000_001, elapsedMs, pool: 2, statementMs: 5000, lockMs: 3000 }),
    );
    try {
      const actualPlan = await explainLibraryRunRead(db, true);
      console.info('library-public-summary-actual-plan', JSON.stringify(actualPlan));
      const measured = (actualPlan as Record<string, any>)['QUERY PLAN'][0];
      expect(measured['Execution Time']).toBeGreaterThan(0);
      expect(measured['Execution Time']).toBeLessThan(5000);
      expect(measured.Plan['Shared Hit Blocks'] + measured.Plan['Shared Read Blocks']).toBeGreaterThan(0);
      const pending: any[] = [measured.Plan];
      let scopes = 0;
      while (pending.length > 0) {
        const node = pending.pop()!;
        if (node.Alias === 'initial_scope') {
          scopes++;
          expect(node['Actual Loops']).toBe(1);
          expect(node['Actual Rows']).toBeLessThanOrEqual(2);
        }
        pending.push(...(node.Plans ?? []));
      }
      expect(scopes).toBe(1);
    } catch (error) {
      await profileLibraryRunRead(db);
      throw error;
    }
    const readPhase = async (phase: string) => {
      const started = performance.now();
      try {
        const rows = await store.listRuns(10, 0);
        console.info('library-public-state-phase', JSON.stringify({ phase, elapsedMs: performance.now() - started }));
        return rows;
      } catch (error) {
        console.info(
          'library-public-state-phase',
          JSON.stringify({ phase, elapsedMs: performance.now() - started, error: String(error) }),
        );
        await profileLibraryRunRead(db);
        throw error;
      }
    };
    // A sparse retained outcome must override a cold origin without changing the other
    // 499,999 rows; explicit origin cancellation still wins over its physical owner.
    await sql`update job_run_item set state='completed' where "runId"=${id}::uuid and "itemKey"=${itemKey(1)}`.execute(
      db,
    );
    await sql`update job_run_item set state='cancelled' where "runId"=${origin}::uuid and "itemKey"=${itemKey(2)}`.execute(
      db,
    );
    expect((await readPhase('sparse-outcome')).find((run) => run.id === origin)).toMatchObject({
      total: 500_000,
      completed: 1,
      cancelled: 1,
      paused: 499_998,
      stageTotals: { total: 500_001, completed: 2, cancelled: 1, paused: 499_998 },
      enumerationDone: true,
    });
    // The direct canonical branch must keep a retained completed outcome while a
    // terminal header stops only its unadmitted pending roots. Explicit cancellation
    // on the copied origin remains higher priority than the attention decision.
    await sql`update job_selection set state='needs_attention' where id=${id}::uuid`.execute(db);
    const stopped = await readPhase('attention-header');
    expect(stopped.find((run) => run.id === id)).toMatchObject({
      total: 500_000,
      completed: 1,
      needsAttention: 499_999,
      stageTotals: { total: 500_000, completed: 1, needsAttention: 499_999 },
    });
    expect(stopped.find((run) => run.id === origin)).toMatchObject({
      total: 500_000,
      completed: 1,
      needsAttention: 499_998,
      cancelled: 1,
    });
    await sql`update job_selection set state='cancelled' where id=${id}::uuid`.execute(db);
    expect((await readPhase('cancelled-header')).find((run) => run.id === id)).toMatchObject({
      total: 500_000,
      completed: 1,
      cancelled: 499_999,
    });
    // Cancellation of the retained producer request removes the alias entitlement,
    // even when its initial source remains ready and canonical roots remain pending.
    await sql`update job_selection set state='ready' where id=${id}::uuid`.execute(db);
    await sql`update job_run_item set state='cancelled' where "runId"=${origin}::uuid and "rootItemKey" is null`.execute(
      db,
    );
    const detached = await readPhase('cancelled-producer');
    expect(detached.find((run) => run.id === origin)).toMatchObject({
      total: 500_000,
      cancelled: 500_000,
      stageTotals: { total: 500_001, cancelled: 500_001 },
    });
    expect(detached.find((run) => run.id === id)).toMatchObject({
      total: 500_000,
      completed: 1,
      paused: 499_999,
    });
  } finally {
    await db.destroy();
  }
}, 120_000);

it('preserves exact selected-root priority for every pair of actual stage outcomes', async () => {
  const db = await getLibraryQueueDB();
  const store = new SqlQueueStore(db);
  try {
    const queue = `priority-${randomUUID()}`;
    const pausedQueue = `${queue}-paused`;
    await store.initialize([queue, pausedQueue]);
    await store.pause(pausedQueue, true);
    const runId = await store.createRun('public-root-priority', {});
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
    const items: any[] = [];
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
          items.push({
            runId,
            itemKey,
            rootItemKey: root,
            stage: `stage-${stage}`,
            queue: destination,
            selection: {},
            jobId: id,
            state: variant.state,
          });
        }
      }
    expect(jobs).toHaveLength(242);
    await db.insertInto('job_run_item').values(items).execute();
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
    const before = (await store.listRuns(10, 0)).find((run) => run.id === runId)!;
    expect(before.reasons.filter((reason) => knownReasons.includes(reason))).toEqual(['local-capacity']);
    // Operational bookkeeping can carry every deferred reason while never inflating selected roots.
    const deferred = knownReasons.map((reason) => ({ id: randomUUID(), itemKey: `reason/${reason}`, reason }));
    await db
      .insertInto('job_run_item')
      .values(
        deferred.map(({ id, itemKey }) => ({
          runId,
          itemKey,
          rootItemKey: null,
          stage: 'deferred',
          queue,
          selection: {},
          jobId: id,
          state: 'pending',
        })),
      )
      .execute();
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
    expect(after.total).toBe(121);
    expect(after.stageTotals.total).toBe(249);
    expect(after.reasons.filter((reason) => knownReasons.includes(reason))).toEqual(knownReasons);
  } finally {
    await db.destroy();
  }
});
