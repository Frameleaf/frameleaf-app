import { createPostgres } from '@frameleaf/sql-tools';
import { Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { JobName } from 'src/enum.js';
import { freezeSelection } from 'src/queue/manifest.js';
import { unfinishedQueueItems, unfinishedRunItems } from 'src/queue/selection-state.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { QueueExecution, QueueIntent } from 'src/queue/types.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { canonicalDatabaseUrl } from 'test/fixtures/canonical-database.js';
import { getKyselyDB } from 'test/utils.js';

describe('real large producer selection capture', () => {
  let db: Kysely<any>;
  beforeAll(async () => {
    db = await getKyselyDB();
  });
  afterAll(async () => db?.destroy());

  it('captures 500000 real asset rows while unrelated claims, heartbeats and publications continue', async () => {
    const ownerId = randomUUID();
    const groupId = randomUUID();
    await sql`insert into cluster_group(id) values (${groupId}::uuid)`.execute(db);
    await sql`insert into "user"(id, name, email, "clusterGroupId") values
      (${ownerId}::uuid, 'capture fixture', ${`${ownerId}@example.test`}, ${groupId}::uuid)`.execute(db);
    // Source media metadata is seeded. The actual frozen snapshot below is produced by the
    // production thumbnail selector and freezeSelection; no media decoding is claimed here.
    await sql`insert into asset(id,"ownerId",type,"originalPath","originalFileName",checksum,"checksumAlgorithm",
      "fileCreatedAt","fileModifiedAt","localDateTime")
      select md5(${ownerId} || ':' || n::text)::uuid, ${ownerId}::uuid, 'IMAGE', '/fixture/' || n || '.jpg',
        n || '.jpg', decode(md5(${ownerId} || ':' || n::text), 'hex'), 'sha1', now(), now(), now()
      from generate_series(1, 500000) n`.execute(db);
    await sql`analyze asset`.execute(db);
    const store = new SqlQueueStore(db);
    const queue = `scale-capture-${randomUUID()}`;
    const otherQueue = `scale-other-${randomUUID()}`;
    const worker = randomUUID();
    await store.initialize([queue, otherQueue], worker);
    const intent = (queue: string, name: string): QueueIntent => ({
      queue,
      name,
      data: {},
      safeToRetry: true,
      sensitive: false,
      deadlineMs: 600_000,
    });
    await store.enqueue([intent(queue, 'producer')]);
    let [producer] = await store.claim(queue, worker);
    const context: QueueExecution = {
      claim: producer,
      signal: new AbortController().signal,
      progress: () => {},
      progressUnits: 0,
      followups: [],
      adoptions: [],
      buffering: false,
    };
    const selection = new AssetJobRepository(db).selectionForThumbnailJob({ force: true, fullsizeEnabled: true });
    const started = performance.now();
    let capturing = true;
    const capture = freezeSelection(db, intent(queue, JobName.AssetGenerateThumbnails), selection, context).finally(
      () => {
        capturing = false;
      },
    );
    const observed = capture.catch(() => {});
    let probes = 0;
    let maxProbeMs = 0;
    try {
      // One bounded observation at a time, retaining aggregate telemetry rather than an ever-growing log.
      do {
        const probeStarted = performance.now();
        await store.heartbeat(worker, [producer]);
        await store.enqueue([intent(otherQueue, 'unrelated')]);
        const [other] = await store.claim(otherQueue, worker);
        expect(other).toBeDefined();
        expect(await store.complete(other, [])).toBe(true);
        maxProbeMs = Math.max(maxProbeMs, performance.now() - probeStarted);
        probes++;
        expect(maxProbeMs, 'heartbeat + enqueue + claim + publication responsiveness').toBeLessThan(1000);
        if (capturing) await sleep(100);
      } while (capturing && probes < 600);
      expect(capturing, 'capture exceeds bounded responsiveness probe window').toBe(false);
    } finally {
      await observed;
    }
    const runId = await capture;
    const captureMs = performance.now() - started;
    expect(probes).toBeGreaterThan(1);
    const {
      rows: [counts],
    } = await sql<{ selected: number; admitted: number }>`select count(*)::int selected,
      count("jobId")::int admitted from job_run_item where "runId" = ${runId}::uuid and "selectionId" is not null`.execute(
      db,
    );
    expect(counts).toEqual({ selected: 500_000, admitted: 0 });
    expect(await store.feedManifest(queue)).toBe(0);
    process.stdout.write(
      `${JSON.stringify({ fixtureAssets: 500_000, capturedItems: counts.selected, mediaExecutions: 0, probes, maxProbeMs, captureMs })}\n`,
    );
    const {
      rows: [database],
    } = await sql<{ name: string }>`select current_database() name`.execute(db);
    const controlDb = new Kysely<any>({
      dialect: new PostgresJSDialect({
        postgres: createPostgres({
          connection: {
            connectionType: 'url',
            url: canonicalDatabaseUrl(process.env.IMMICH_TEST_POSTGRES_URL!, database.name),
          },
          maxConnections: 2,
          statementTimeoutMs: 5000,
          lockTimeoutMs: 3000,
        }),
      }),
    });
    const control = new SqlQueueStore(controlDb);
    try {
      expect(await control.fail(producer, 'first failed attempt')).toBe(true);
      await sql`update job set "availableAt" = now() where id = ${producer.id}::uuid`.execute(db);
      [producer] = await control.claim(queue, worker);
      const terminalStarted = performance.now();
      try {
        expect(await control.fail(producer, 'exhausted capture producer')).toBe(true);
      } finally {
        process.stdout.write(
          `${JSON.stringify({ terminalFailureMs: performance.now() - terminalStarted, statementTimeoutMs: 5000 })}\n`,
        );
      }
      expect(await control.hasUnfinishedWork(queue)).toBe(false);
      expect((await store.listRunItems(runId, 1, 0))?.[0]).toMatchObject({ outcome: 'needsAttention' });
      const failed = (await store.listRuns(10, 0)).find((run) => run.id === runId);
      expect(failed).toMatchObject({
        total: 500_000,
        needsAttention: 500_000,
        enumerationDone: true,
        finishedAt: expect.any(Date),
        stageTotals: { total: 500_001, failed: 1, needsAttention: 500_000 },
      });
      type Plan = {
        'Node Type'?: string;
        'Index Name'?: string;
        'Actual Rows': number;
        'Actual Loops': number;
        'Relation Name'?: string;
        'Rows Removed by Filter'?: number;
        Plans?: Plan[];
      };
      const examined = (plan: Plan): number =>
        (plan['Relation Name']
          ? (plan['Actual Rows'] + (plan['Rows Removed by Filter'] ?? 0)) * plan['Actual Loops']
          : 0) + (plan.Plans ?? []).reduce((total, child) => total + examined(child), 0);
      const contributions = (plan: Plan): { relation: string; examined: number; node: Plan }[] => [
        ...(plan['Relation Name']
          ? [
              {
                relation: plan['Relation Name'],
                examined: (plan['Actual Rows'] + (plan['Rows Removed by Filter'] ?? 0)) * plan['Actual Loops'],
                node: plan,
              },
            ]
          : []),
        ...(plan.Plans ?? []).flatMap((child) => contributions(child)),
      ];
      const measurements: { predicate: string; examined: number }[] = [];
      for (const [name, predicate] of [
        ['unfinishedRunItems', unfinishedRunItems(sql<string>`${runId}::uuid`)],
        ['unfinishedQueueItems', unfinishedQueueItems(queue)],
      ] as const) {
        const { rows: plans } = await sql<{ 'QUERY PLAN': [{ Plan: Plan }] }>`explain (analyze, buffers, format json)
          select ${predicate} unfinished`.execute(controlDb);
        const plan = plans[0]['QUERY PLAN'][0].Plan;
        const total = examined(plan);
        const relations = contributions(plan).sort((left, right) => right.examined - left.examined);
        // Keep both predicates observable before either budget assertion, without dumping raw plans or SQL.
        process.stdout.write(
          `${JSON.stringify({
            predicate: name,
            examined: total,
            relationNodes: relations.slice(0, 12).map(({ relation, examined, node }) => ({
              relation,
              nodeType: node['Node Type'],
              index: node['Index Name'],
              rows: node['Actual Rows'],
              loops: node['Actual Loops'],
              removedByFilter: node['Rows Removed by Filter'] ?? 0,
              examined,
            })),
            omittedRelationNodes: Math.max(0, relations.length - 12),
            omittedExamined: relations.slice(12).reduce((total, relation) => total + relation.examined, 0),
          })}\n`,
        );
        measurements.push({ predicate: name, examined: total });
      }
      for (const measurement of measurements) {
        expect(
          measurement.examined,
          `${measurement.predicate}: terminal 500k manifest must be skipped by its header`,
        ).toBeLessThan(50);
      }
      expect(await control.retryFailed(queue)).toBe(1);
      expect(await control.hasUnfinishedWork(queue)).toBe(true);
      [producer] = await control.claim(queue, worker);
      context.claim = producer;
    } finally {
      await controlDb.destroy();
    }
    // Replay invokes a now-empty live selector; only the committed snapshot is eligible.
    await freezeSelection(
      db,
      intent(queue, JobName.AssetGenerateThumbnails),
      selection.where('asset.id', '=', randomUUID()),
      context,
    );
    expect(await store.complete(producer, [])).toBe(true);
    expect(await store.feedManifest(queue)).toBe(250);
    const {
      rows: [after],
    } = await sql`select count(*)::int selected, count("jobId")::int admitted
      from job_run_item where "runId" = ${runId}::uuid and "selectionId" is not null`.execute(db);
    expect(after).toEqual({ selected: 500_000, admitted: 250 });
    const [active] = await store.claim(queue, worker);
    await store.clear(queue, ['pending', 'waiting']);
    expect(await store.hasUnfinishedWork(queue)).toBe(true);
    expect(await store.complete(active, [])).toBe(true);
    expect(await store.hasUnfinishedWork(queue)).toBe(false);
    expect(await store.feedManifest(queue)).toBe(0);
    expect((await store.listRuns(10, 0)).find((run) => run.id === runId)).toMatchObject({
      total: 500_000,
      cancelled: 499_999,
      completed: 1,
      finishedAt: expect.any(Date),
    });
  }, 120_000);
});
