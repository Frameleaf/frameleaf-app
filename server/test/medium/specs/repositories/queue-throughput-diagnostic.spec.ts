import { type CompiledQuery, Kysely, type QueryResult, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import postgres from 'postgres';
import type { JobItem } from 'src/types.js';
import { JobName, JobStatus, QueueName } from 'src/enum.js';
import { queueAdmission } from 'src/queue/admission.js';
import { publishJobResult } from 'src/queue/context.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { publicationDatabase } from 'src/queue/transaction.js';
import { QUEUE_HIGH_WATER, type QueueClaim } from 'src/queue/types.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { getKyselyConfig } from 'src/utils/database.js';
import { canonicalDatabaseUrl } from 'test/fixtures/canonical-database.js';
import { getKyselyDB } from 'test/utils.js';

// Opt-in cost attribution only. This small sample does not qualify the unchanged 15k acceptance gate.
const enabled = process.env.FRAMELEAF_QUEUE_PROFILE === '1';
const boundaries = [1, 5, 20, 100, 500, 2000, Infinity];
type Metric = { count: number; totalMs: number; maxMs: number; buckets: number[] };
const metric = (): Metric => ({ count: 0, totalMs: 0, maxMs: 0, buckets: boundaries.map(() => 0) });
const add = (target: Metric, duration: number) => {
  target.count++;
  target.totalMs += duration;
  target.maxMs = Math.max(target.maxMs, duration);
  target.buckets[boundaries.findIndex((limit) => duration <= limit)]++;
};

// Finite structural classes only: no query text, parameters, URLs, errors or identifiers in receipts.
const queryClass = (text: string) => {
  const q = text.toLowerCase().trimStart();
  if (/^(begin|commit|rollback)\b/.test(q)) return q.split(/\s/, 1)[0];
  if (q.includes('select name from job_queue') && q.includes('for no key update')) return 'queue-lock';
  if (q.startsWith('set ')) return 'session-setting';

  // Match outer statement shapes before broad table classes. Feeder CTEs contain the
  // same library/lineage predicates as publication, but run once per queue visit.
  // Keep discriminators near the start for the activity observer's truncated SQL.
  if (q.startsWith('insert into system_metadata (key,value)') && q.includes("'stoppedat'"))
    return 'attempt-stopped-evidence';
  if (q.startsWith('with cursor as materialized (') && q.includes('"librarycleanupid"'))
    return 'feeder-library-redaction';
  if (q.startsWith('with cursor as (') && q.includes('select distinct m."runid"')) return 'feeder-library-settlement';
  if (q.startsWith('with candidates as materialized (') && q.includes('"produceritemkey"'))
    return 'feeder-library-participants';
  if (q.startsWith('select s.id, s."runid" from job_selection s') && q.includes("'library-child'"))
    return 'feeder-library-origins';
  if (q.startsWith('with candidate as (') && q.includes('s."appendsequence" from job_selection_run m'))
    return 'feeder-library-retirement';
  if (q.startsWith('select m."runid", m."selectionid", s."runid"')) return 'feeder-sharing-probe';

  // These are separate SQL commands even for an ordinary non-library media item.
  if (q.startsWith('select 1 from job_selection_run membership')) return 'selection-sharing-check';
  if (q.startsWith('select 1 where exists (') && q.includes('from job_library_source_producer link'))
    return 'library-attachment-check';
  if (q.startsWith('select 1 from job_selection where "producerid"') && q.includes('"capturedat" is null'))
    return 'selection-capture-check';
  if (q.startsWith('update job_selection set state = case')) return 'selection-header-finish';
  if (q.startsWith('select 1 from job_run_item i join job j on j.id = i."jobid"')) return 'selection-coordinator-check';
  if (q.startsWith('with owners as materialized (') && q.includes('"libraryexecutionrunid"'))
    return 'library-followup-parents';
  if (q.startsWith('select 1 from job_run_item i join job_selection s') && q.includes('i."libraryintent" is not null'))
    return 'library-followup-recognition';
  if (q.startsWith('select 1 from job_library_source_producer where')) return 'library-producer-probe';
  if (q.startsWith('select "runid", "itemkey", "rootitemkey" from job_run_item')) return 'lineage-membership-probe';
  if (q.startsWith('update job_run_item i set state = j.state from job j')) return 'item-state-sync';
  if (q.startsWith('update job_run_item i set selection =') && q.includes('j.sensitive'))
    return 'item-library-redaction';
  if (q.startsWith('update job_run_item shadow') && q.includes('join job_selection_lineage origin'))
    return 'lineage-mirror';
  if (q.startsWith('with origins as (') && q.includes('insert into job_selection_lineage')) return 'lineage-record';
  if (q.startsWith('select candidate.id from unnest(')) return 'settlement-live-proof';

  if (q.includes('insert into system_metadata')) return 'operational-evidence';
  if (q.includes('queue_profile_output')) return 'output-adoption';
  if (q.includes('update job_run r set "finishedat"')) return 'settlement';
  if (q.includes('update job_run r set "enumerationdone"')) return 'enumeration';
  if (q.includes('job_selection_lineage')) return 'lineage';
  if (q.includes('job_library_')) return 'library';
  if (q.includes('job_selection')) return 'selection';
  if (q.includes('job_run_item')) return 'item-ledger';
  if (q.includes('job_attempt')) return 'attempt';
  if (q.includes('job_worker')) return 'worker';
  if (q.includes('select "latestpending"')) return 'claim-fence';
  if (q.includes('update job set')) return 'job-update';
  if (q.includes('insert into job(') || q.includes('insert into "job"')) return 'child-admission';
  if (q.includes('pg_notify')) return 'notification';
  if (q.includes('job_queue')) return 'queue-control';
  if (q.includes('job_run')) return 'run';
  return 'other';
};

describe('bounded queue throughput diagnostic', () => {
  it.skipIf(!enabled)(
    'attributes local admission, SQL and lock costs through the real facade',
    async ({ signal, onTestFinished }) => {
      const template = await getKyselyDB();
      let url: string;
      try {
        const { rows } = await sql<{ name: string }>`select current_database() name`.execute(template);
        url = canonicalDatabaseUrl(process.env.IMMICH_TEST_POSTGRES_URL!, rows[0].name);
      } finally {
        await template.destroy();
      }
      const timings = new Map<string, Metric>();
      const fingerprints = new Map<string, { fingerprint: string; maxMs: number }>();
      let phase = 'setup';
      const observe = (kind: string, started: number) => {
        const key = `${phase}:${kind}`;
        let value = timings.get(key);
        if (!value) timings.set(key, (value = metric()));
        add(value, performance.now() - started);
      };
      const config = getKyselyConfig({ connectionType: 'url', url });
      const driver = config.dialect.createDriver();
      const acquire = driver.acquireConnection.bind(driver);
      driver.acquireConnection = async () => {
        const started = performance.now();
        try {
          const connection = await acquire();
          const execute = connection.executeQuery.bind(connection);
          // A fresh driver connection wrapper belongs to each reservation. No retained spy per query.
          connection.executeQuery = async <R>(query: CompiledQuery): Promise<QueryResult<R>> => {
            const began = performance.now();
            const kind = queryClass(query.sql);
            try {
              return await execute<R>(query);
            } finally {
              observe(`sql:${kind}`, began);
              const ms = performance.now() - began;
              if (ms > (fingerprints.get(kind)?.maxMs ?? -1)) {
                // Hash a redacted shape; neither this string nor bindings leave this callback.
                const shape = query.sql.replaceAll(/'(?:''|[^'])*'/g, "'?'");
                fingerprints.set(kind, {
                  fingerprint: createHash('sha256').update(shape).digest('hex').slice(0, 16),
                  maxMs: ms,
                });
              }
            }
          };
          return connection;
        } finally {
          observe('acquire', started);
        }
      };
      const db = new Kysely<any>({
        ...config,
        dialect: {
          createDriver: () => driver,
          createAdapter: () => config.dialect.createAdapter(),
          createIntrospector: (database) => config.dialect.createIntrospector(database),
          createQueryCompiler: () => config.dialect.createQueryCompiler(),
        },
        log: () => {}, // Avoid the ordinary failure logger's SQL/parameter output in this diagnostic.
      });
      const observer = postgres(url, {
        max: 1,
        connect_timeout: 3,
        connection: { application_name: 'queue-cost-observer', statement_timeout: 500 },
      });
      const settled = Promise.withResolvers<void>();
      onTestFinished(() => settled.promise, 15_000);
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const deadline = setTimeout(() => controller.abort(new Error('Diagnostic work budget exhausted')), 120_000);
      const observerStop = new AbortController();
      const waits = new Map<string, number>();
      let samples = 0;
      let observerFailed = false;
      let observerWork: Promise<void> | undefined;
      let heartbeatWork: Promise<unknown> | undefined;
      let heartbeat: NodeJS.Timeout | undefined;
      let heartbeatFailed = false;
      let active: QueueClaim[] = [];
      const inflight = new Set<Promise<void>>();
      const phases: Array<{ roots: number; concurrency: number; outputs: number; durationMs: number }> = [];
      let cleanupComplete = false;
      const admission = queueAdmission(db);
      const publicationRun = admission.publication.run.bind(admission.publication);
      const publicationSpy = vi.spyOn(admission.publication, 'run').mockImplementation(async (cancellation, action) => {
        const waiting = performance.now();
        return publicationRun(cancellation, async () => {
          observe('publication-wait', waiting);
          const held = performance.now();
          try {
            return await action();
          } finally {
            observe('publication-hold', held);
          }
        });
      });
      try {
        await sql`create table queue_profile_output (phase text, id text, stage text, primary key(phase,id,stage))`.execute(
          db,
        );
        const store = new SqlQueueStore(db);
        const worker = randomUUID();
        await store.initialize([], worker);
        heartbeat = setInterval(() => {
          if (!heartbeatWork) {
            heartbeatWork = store
              .heartbeat(worker, active)
              .catch(() => {
                heartbeatFailed = true;
              })
              .finally(() => {
                heartbeatWork = undefined;
              });
          }
        }, 10_000);
        observerWork = (async () => {
          const end = performance.now() + 60_000;
          try {
            while (!observerStop.signal.aborted && samples < 600 && performance.now() < end) {
              // SQL text is classified in memory, never reported; backend IDs remain inside PostgreSQL.
              const rows = await observer<
                {
                  query: string;
                  wait_type: string | null;
                  wait_event: string | null;
                  blocked: boolean;
                  queue_lock: boolean;
                  blocker_query: string | null;
                }[]
              >`select a.query, a.wait_event_type wait_type, a.wait_event, cardinality(pg_blocking_pids(a.pid)) > 0 blocked,
              exists (select 1 from pg_locks l where l.pid = any(pg_blocking_pids(a.pid))
                and l.relation = 'job_queue'::regclass and l.granted) queue_lock,
              (select b.query from pg_stat_activity b where b.pid = any(pg_blocking_pids(a.pid)) limit 1) blocker_query
              from pg_stat_activity a where a.datname = current_database() and a.pid != pg_backend_pid()
                and a.state = 'active'`;
              // A blocker holding a queue-table lock is correlation, not proof of the particular blocked tuple.
              for (const row of rows) {
                // Whitelist labels; catalog values cannot create an unbounded log-cardinality surface.
                const type = ['Lock', 'IO', 'Client', 'LWLock'].includes(row.wait_type ?? '')
                  ? row.wait_type
                  : 'running-or-other';
                const event = [
                  'transactionid',
                  'tuple',
                  'relation',
                  'ClientRead',
                  'ClientWrite',
                  'DataFileRead',
                ].includes(row.wait_event ?? '')
                  ? row.wait_event
                  : 'other';
                const key = `${queryClass(row.query)}:${type}:${event}:${row.blocked ? 'blocked' : 'clear'}:${row.queue_lock ? 'blocker-touches-queue' : 'other'}:${row.blocker_query ? queryClass(row.blocker_query) : 'no-blocker'}`;
                if (waits.has(key) || waits.size < 64) waits.set(key, (waits.get(key) ?? 0) + 1);
              }
              samples++;
              await delay(100, undefined, { signal: observerStop.signal });
            }
          } catch {
            if (!observerStop.signal.aborted) observerFailed = true;
          }
        })();
        for (const [roots, concurrency] of [
          [16, 1],
          [64, 32],
        ]) {
          phase = `roots-${roots}-claims-${concurrency}`;
          const began = performance.now();
          const queue = `profile-${randomUUID()}`;
          const stages = [
            JobName.AssetExtractMetadata,
            JobName.AssetGenerateThumbnails,
            JobName.AssetEncodeVideo,
            JobName.SmartSearch,
          ];
          await store.initialize([queue]);
          await store.setConcurrency(queue, concurrency);
          const artifacts = publicationDatabase(db);
          const facade = new JobRepository(
            {} as never,
            {} as never,
            { emit: async (_event: string, _queue: string, item: JobItem) => facade.run(item) } as never,
            { setContext: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
            db,
          );
          for (const [position, name] of stages.entries()) {
            facade['handlers'][name] = {
              jobName: name,
              queueName: queue as QueueName,
              label: 'diagnostic synthetic stage',
              handler: async (data) => {
                const { id } = data as { id: string };
                await publishJobResult(async () => {
                  await artifacts.insertInto('queue_profile_output').values({ phase, id, stage: name }).execute();
                  const next = stages[position + 1];
                  if (next) await facade.queue({ name: next, data: { id } } as JobItem);
                });
                return JobStatus.Success;
              },
            };
          }
          await facade.queueSelection(
            stages[0],
            db
              .selectFrom(sql<{ id: string }>`(select generate_series(1,${roots})::text id)`.as('selected'))
              .select('id'),
          );
          const readStarted = performance.now();
          expect((await store.listRuns(10, 0)).some((run) => run.total === roots && run.waiting === roots)).toBe(true);
          observe('manifest-read', readStarted);
          for (let batch = 0; ; batch++) {
            controller.signal.throwIfAborted();
            expect(heartbeatFailed || observerFailed).toBe(false);
            expect(batch).toBeLessThan(roots * 4 + 8);
            expect(await store.feedManifest(queue)).toBeLessThanOrEqual(250);
            active = await store.claim(queue, worker);
            expect(active.length).toBeLessThanOrEqual(concurrency);
            if (active.length === 0) break;
            const beganBatch = performance.now();
            const tasks = active.map((claim) => {
              const work = facade['execute'](claim, controller);
              inflight.add(work);
              void work.finally(() => inflight.delete(work)).catch(() => {});
              return work;
            });
            await Promise.all(tasks);
            observe('facade-batch', beganBatch);
            active = [];
            const live = await store.counts(queue);
            expect(live.active + live.waiting + live.delayed).toBeLessThanOrEqual(QUEUE_HIGH_WATER);
          }
          const outputs = await artifacts
            .selectFrom('queue_profile_output')
            .select(({ fn }) => fn.countAll<number>().as('count'))
            .where('phase', '=', phase)
            .executeTakeFirstOrThrow();
          expect(Number(outputs.count)).toBe(roots * 4);
          const runs = await store.listRuns(10, 0);
          expect(runs.some((run) => run.total === roots && run.completed === roots && run.state === 'completed')).toBe(
            true,
          );
          const attempts = await sql<{
            maximum: number;
          }>`select max(attempt)::int maximum from job where queue=${queue}`.execute(db);
          expect(attempts.rows).toEqual([{ maximum: 1 }]);
          phases.push({ roots, concurrency, outputs: Number(outputs.count), durationMs: performance.now() - began });
        }
        expect(observerFailed || heartbeatFailed).toBe(false);
      } finally {
        controller.abort(new Error('Diagnostic owner finished'));
        clearTimeout(deadline);
        clearInterval(heartbeat);
        observerStop.abort();
        try {
          // Abort uses production query cancellation; do not hide unfinished claims behind a race.
          await Promise.allSettled(inflight);
          await heartbeatWork;
          await observerWork;
          publicationSpy.mockRestore();
          phase = 'cleanup';
          try {
            await sql`drop table if exists queue_profile_output`.execute(db);
          } finally {
            await db.destroy();
          }
          const [sessions] = await observer<{ count: number }[]>`select count(*)::int count from pg_stat_activity
          where datname=current_database() and pid != pg_backend_pid()`;
          expect(sessions.count).toBe(0);
          cleanupComplete = true;
        } finally {
          publicationSpy.mockRestore();
          try {
            await observer.end({ timeout: 0 });
          } finally {
            signal.removeEventListener('abort', abort);
            console.info(
              'queue-cost-diagnostic',
              JSON.stringify({
                mode: 'attribution-only',
                phases,
                samples,
                observerFailed,
                heartbeatFailed,
                cleanupComplete,
                bucketUpperMs: [1, 5, 20, 100, 500, 2000, 'infinity'],
                timings: Object.fromEntries(timings),
                fingerprints: Object.fromEntries(fingerprints),
                waits: Object.fromEntries(waits),
              }),
            );
            settled.resolve();
          }
        }
      }
    },
    180_000,
  );
});
