import { createPostgres } from '@frameleaf/sql-tools';
import { Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { freezeSelection, selectionCopySource, shareSelectionPage } from 'src/queue/manifest.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { QueueClaim, QueueIntent } from 'src/queue/types.js';
import { recordStoppedAttempt } from 'src/utils/attempt-evidence.js';
import { canonicalDatabaseUrl } from 'test/fixtures/canonical-database.js';
import { SCALE_ITEMS, scaleIt } from 'test/medium/scale.js';
import { getKyselyDB } from 'test/utils.js';

describe('late shared selection recovery budget', () => {
  // Capture, then one sharing transaction per 250 items; recovery/page bounds stay independent of the size.
  scaleIt('keeps coordinator recovery bounded when a run of %i items attaches after sharing', 0.36, async () => {
    const db = await getKyselyDB();
    let controlDb: Kysely<any> | undefined;
    try {
      const store = new SqlQueueStore(db);
      const queue = `late-recovery-${randomUUID()}`;
      const worker = randomUUID();
      await store.initialize([queue], worker);
      const producer = (runId?: string): QueueIntent => ({
        queue,
        name: 'producer',
        data: {},
        safeToRetry: true,
        sensitive: false,
        deadlineMs: 600_000,
        runId,
        itemKey: runId ? 'producer' : undefined,
        options: { deduplication: { id: queue } },
      });
      await store.enqueue([producer()]);
      let [claim] = await store.claim(queue, worker);
      const capture = (claim: QueueClaim) =>
        freezeSelection(
          db,
          { ...producer(), name: 'child' },
          db
            .selectFrom(sql<{ id: string }>`(select generate_series(1,${SCALE_ITEMS})::text id)`.as('selected'))
            .select('id'),
          {
            claim,
            signal: new AbortController().signal,
            progress: () => {},
            progressUnits: 0,
            adoptions: [],
            followups: [],
            buffering: false,
          },
        );
      await capture(claim);
      await store.fail(claim, 'first attempt interrupted');
      await sql`update job set "availableAt" = now() where id = ${claim.id}::uuid`.execute(db);
      [claim] = await store.claim(queue, worker);
      await capture(claim);
      const lateRun = await store.createRun('late-shared', {});
      await store.enqueue([producer(lateRun)]);
      await recordStoppedAttempt(db, claim.id, claim.token);
      await sql`update job set "leaseExpiresAt" = now() - interval '1 second' where id = ${claim.id}::uuid`.execute(db);
      const {
        rows: [database],
      } = await sql<{ name: string }>`select current_database() name`.execute(db);
      controlDb = new Kysely({
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
      const recovery = new SqlQueueStore(controlDb);
      const started = performance.now();
      try {
        await recovery.recoverExpired();
        expect(performance.now() - started).toBeLessThan(1000);
      } finally {
        process.stdout.write(
          `${JSON.stringify({ lateSharedItems: SCALE_ITEMS, recoveryMs: performance.now() - started, statementTimeoutMs: 5000 })}\n`,
        );
      }
      expect(await store.complete(claim, [])).toBe(false);
      expect(await recovery.hasUnfinishedWork(queue)).toBe(true);
      expect(
        (await db.selectFrom('job_run').selectAll().where('id', '=', lateRun).executeTakeFirstOrThrow())
          .enumerationDone,
      ).toBe(false);
      await recovery.pause(queue, true);
      // Even a paused queue settles durable copied outcomes, without admitting media executions.
      expect(await recovery.feedManifest(queue)).toBe(0);
      const {
        rows: [firstPage],
      } = await sql<{ count: number }>`select count(*)::int count from job_run_item
        where "runId" = ${lateRun}::uuid and "selectionId" is not null`.execute(db);
      expect(firstPage.count).toBe(250);
      let pages = 1;
      let maxPageMs = 0;
      let tailRows = 0;
      for (;;) {
        const pageStarted = performance.now();
        const copied = await shareSelectionPage(controlDb, { queue });
        maxPageMs = Math.max(maxPageMs, performance.now() - pageStarted);
        expect(maxPageMs, 'one coordinator copy page remains responsive').toBeLessThan(1000);
        if (!copied) break;
        pages++;
        if (pages === 1999) {
          const {
            rows: [cursor],
          } = await sql<{ copyAfter: string; selectionId: string; sourceRunId: string }>`
            select m."copyAfter", m."selectionId", s."runId" "sourceRunId" from job_selection_run m
            join job_selection s on s.id = m."selectionId" where m."runId" = ${lateRun}::uuid`.execute(db);
          type Plan = {
            'Actual Rows': number;
            'Actual Loops': number;
            'Rows Removed by Filter'?: number;
            'Relation Name'?: string;
            Plans?: Plan[];
          };
          const {
            rows: [plan],
          } = await sql<{ 'QUERY PLAN': [{ Plan: Plan }] }>`explain (analyze, buffers, format json)
            ${selectionCopySource(cursor.sourceRunId, cursor.selectionId, cursor.copyAfter)}`.execute(controlDb);
          const examined = (node: Plan): number =>
            (node['Relation Name']
              ? (node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0)) * node['Actual Loops']
              : 0) + (node.Plans ?? []).reduce((sum, child) => sum + examined(child), 0);
          tailRows = examined(plan['QUERY PLAN'][0].Plan);
          expect(tailRows, 'near-tail physical source work is one250-row page').toBeLessThanOrEqual(250);
        }
        if (pages % 200 === 0) {
          // Another queue publishes between bounded maintenance visits.
          const other = `${queue}-other`;
          await recovery.initialize([other]);
          await recovery.enqueue([{ ...producer(), queue: other, options: undefined }]);
          const [unrelated] = await recovery.claim(other, worker);
          expect(await recovery.complete(unrelated, [])).toBe(true);
          await recovery.heartbeat(worker, []);
        }
        expect(pages).toBeLessThanOrEqual(SCALE_ITEMS / 250 + 1);
      }
      expect(pages).toBe(SCALE_ITEMS / 250 + 1); // Final empty page acknowledges an exact multiple of250.
      expect(await recovery.hasUnfinishedWork(queue)).toBe(false);
      const {
        rows: [counts],
      } = await sql`select count(*)::int count from job_run_item
        where "runId" = ${lateRun}::uuid and "selectionId" is not null`.execute(db);
      expect(counts).toEqual({ count: SCALE_ITEMS });
      expect((await store.listRuns(100, 0)).find((run) => run.id === lateRun)).toMatchObject({
        total: SCALE_ITEMS,
        needsAttention: SCALE_ITEMS,
        enumerationDone: true,
        finishedAt: expect.any(Date),
      });
      process.stdout.write(
        `${JSON.stringify({ copiedItems: SCALE_ITEMS, pages, maxPageMs, tailRows, mediaExecutions: 0 })}\n`,
      );
    } finally {
      await controlDb?.destroy();
      await db.destroy();
    }
  });
});
