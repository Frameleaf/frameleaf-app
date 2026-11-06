import { Kysely, sql } from 'kysely';

const CONVERSION_PAGE = 50_000;
const SUMMARY_RUNS = 200;
const IMPORT_KINDS = sql`('immich-import-derived','library-import-derived')`;

/**
 * FL-1265: `job` becomes the only record of work. Work still waiting in the old item ledger becomes jobs (held import
 * stages stay held, as `availableAt = 'infinity'`), finished runs keep their counts as a summary, and the ledger,
 * selection and lineage tables go. Quiet hours become a per-queue `closedUntil`; queues they paused are resumed.
 */
export async function up(db: Kysely<any>): Promise<void> {
  if (!db.isTransaction) return db.transaction().execute(up);
  await sql`SET LOCAL statement_timeout = 0`.execute(db);
  await sql`SET LOCAL lock_timeout = '60s'`.execute(db);
  await sql`SET LOCAL maintenance_work_mem = '256MB'`.execute(db);

  await sql`ALTER TABLE "job" DROP CONSTRAINT IF EXISTS "job_runId_itemKey_name_fkey"`.execute(db);

  // Import stages still waiting for setup keep waiting; setup recomputes these holds on its next pass.
  await sql`UPDATE job_run r SET selection = r.selection || jsonb_build_object('holds', h.holds, 'holdsDirty', true)
    FROM (SELECT s."runId", jsonb_object_agg(s.stage, CASE
        WHEN rr.selection #>> '{managerSetup,startedAt}' IS NULL THEN 'setup'
        WHEN rr.selection #> '{managerSetup,paused}' = 'true'::jsonb THEN 'paused'
        WHEN coalesce(rr.selection #> '{managerSetup,parkedStages}', '[]'::jsonb) ? s.stage THEN 'parked'
        ELSE 'setup' END) holds
      FROM job_selection s JOIN job_run rr ON rr.id = s."runId"
      WHERE rr.kind IN ${IMPORT_KINDS} AND s."sourceKind" = 'frozen' AND (s.state = 'enumerating'
        -- The old claim also held a Manager import's fed work until first setup started, and while setup was paused.
        OR (jsonb_typeof(rr.selection->'managerSetup') = 'object'
          AND (rr.selection #>> '{managerSetup,startedAt}' IS NULL OR rr.selection #> '{managerSetup,paused}' = 'true'::jsonb)))
      GROUP BY s."runId") h
    WHERE r.id = h."runId"`.execute(db);
  // Jobs already queued for a held stage were held by the claim's old predicate; hold them the new way.
  await sql`UPDATE job j SET "availableAt" = 'infinity'::timestamptz FROM job_run r
    WHERE r.id = j."runId" AND r.selection ? 'holds' AND r.selection->'holds' ? j.name
      AND j.state IN ('pending','waiting')`.execute(db);

  // Selected items not yet fed to the queue become jobs of their own run, a keyset page per statement.
  const { rows: runs } = await sql<{ runId: string }>`SELECT DISTINCT "runId" FROM job_run_item
    WHERE "jobId" IS NULL AND state = 'pending' AND "selectionId" IS NOT NULL`.execute(db);
  for (const { runId } of runs) {
    let after: { itemKey: string; stage: string } | null = null;
    for (;;) {
      const {
        rows: [page],
      }: { rows: Array<{ selected: number; itemKey: string | null; stage: string | null }> } = await sql<{
        selected: number;
        itemKey: string | null;
        stage: string | null;
      }>`WITH page AS MATERIALIZED (
          SELECT i.* FROM job_run_item i WHERE i."runId" = ${runId}::uuid AND i."jobId" IS NULL AND i.state = 'pending'
            ${after ? sql`AND (i."itemKey", i.stage) > (${after.itemKey}, ${after.stage})` : sql``}
          ORDER BY i."itemKey", i.stage LIMIT ${CONVERSION_PAGE}
        ), src AS (
          SELECT p.*, s."safeToRetry" "selectionSafeToRetry", s.sensitive "selectionSensitive",
            s."deadlineMs" "selectionDeadlineMs", r.selection rsel
          FROM page p JOIN job_selection s ON s.id = p."selectionId" JOIN job_run r ON r.id = p."runId"
          WHERE p."runId" = s."runId"
            -- An item that owns its own execution is this run's work; one shared from another run's item is not.
            AND (p."libraryExecutionRunId" IS NULL
              OR (p."libraryExecutionRunId", p."libraryExecutionItemKey") = (p."runId", p."itemKey"))
            AND (s."sourceKind" <> 'frozen' OR s."capturedAt" IS NOT NULL)
            AND (s."sourceKind" <> 'library-child' OR p."libraryOriginComplete")
            AND (s.state IN ('enumerating','ready') OR (s."sourceKind" = 'library-initial' AND s.state = 'needs_attention'))
        ), inserted AS (
          INSERT INTO job (id, queue, name, data, "dedupKey", "externalId", "safeToRetry", sensitive, "deadlineMs",
            "availableAt", "runId", "itemKey", "rootItemKey")
          SELECT gen_random_uuid(), queue, stage, coalesce("libraryIntent"->'data', selection),
            CASE WHEN "libraryIntent" IS NOT NULL
                THEN coalesce("libraryIntent" #>> '{options,deduplication,id}', "libraryIntent" #>> '{options,jobId}')
              WHEN stage = 'SmartAlbumReevaluate'
                THEN stage || ':' || (selection->>'id') || ':' || coalesce(selection->>'kind', 'all') END,
            "libraryIntent" #>> '{options,jobId}',
            coalesce(("libraryIntent"->>'safeToRetry')::boolean, "selectionSafeToRetry"),
            coalesce(("libraryIntent"->>'sensitive')::boolean, "selectionSensitive"),
            coalesce(("libraryIntent"->>'deadlineMs')::int, "selectionDeadlineMs"),
            CASE WHEN coalesce(rsel->'holds', '{}'::jsonb) ? stage THEN 'infinity'::timestamptz ELSE now() END,
            "runId", "itemKey", "rootItemKey"
          FROM src ON CONFLICT DO NOTHING RETURNING 1
        ), last AS (SELECT "itemKey", stage FROM page ORDER BY "itemKey" DESC, stage DESC LIMIT 1)
        SELECT (SELECT count(*) FROM page)::int selected, (SELECT count(*) FROM inserted)::int,
          (SELECT "itemKey" FROM last) "itemKey", (SELECT stage FROM last) stage`.execute(db);
      if (page.selected < CONVERSION_PAGE || page.itemKey === null || page.stage === null) break;
      after = { itemKey: page.itemKey, stage: page.stage };
    }
  }

  // A run finishes once its enumeration is done and no live job remains. Producer runs stay open through their
  // live producer job; imports are closed by their own import step, library scans when their operation ends.
  await sql`UPDATE job_run r SET "enumerationDone" = true
    WHERE r."finishedAt" IS NULL AND NOT r."enumerationDone" AND r.kind NOT IN ${IMPORT_KINDS}
      AND NOT EXISTS (SELECT 1 FROM media_operation o WHERE o.id = r.id
        AND o.status NOT IN ('completed','failed','cancelled'))`.execute(db);

  // Finished runs without a current summary keep their counts: the ledger they were counted from goes below.
  for (let after: string | null = null; ; ) {
    const { rows }: { rows: Array<{ id: string }> } = await sql<{ id: string }>`WITH runs AS MATERIALIZED (
        SELECT id, "finishedAt" FROM job_run r WHERE r."finishedAt" IS NOT NULL
          AND NOT coalesce(r.summary->>'complete' = 'true'
            AND (r.summary->>'finishedAt')::timestamptz = r."finishedAt", false)
          ${after ? sql`AND r.id > ${after}::uuid` : sql``}
        ORDER BY id LIMIT ${SUMMARY_RUNS}
      ), roots AS (
        SELECT i."runId", CASE WHEN bool_or(i.state IN ('failed','blocked')) THEN 'failed'
            WHEN bool_or(i.state = 'needs_attention') THEN 'needsAttention'
            WHEN bool_or(i.state = 'cancelled') THEN 'cancelled'
            WHEN bool_and(i.state = 'completed') THEN 'completed' ELSE 'waiting' END outcome
        FROM job_run_item i JOIN runs ON runs.id = i."runId" WHERE i."rootItemKey" IS NOT NULL
        GROUP BY i."runId", i."rootItemKey"
      ), root_counts AS (
        SELECT "runId", count(*)::int total, count(*) FILTER (WHERE outcome = 'completed')::int completed,
          count(*) FILTER (WHERE outcome = 'failed')::int failed,
          count(*) FILTER (WHERE outcome = 'needsAttention')::int "needsAttention",
          count(*) FILTER (WHERE outcome = 'cancelled')::int cancelled,
          count(*) FILTER (WHERE outcome = 'waiting')::int waiting
        FROM roots GROUP BY "runId"
      ), task_counts AS (
        SELECT i."runId", count(*)::int total, count(*) FILTER (WHERE i.state = 'completed')::int completed,
          count(*) FILTER (WHERE i.state = 'failed')::int failed,
          count(*) FILTER (WHERE i.state = 'needs_attention')::int "needsAttention",
          count(*) FILTER (WHERE i.state = 'cancelled')::int cancelled,
          count(*) FILTER (WHERE i.state = 'blocked')::int blocked,
          count(*) FILTER (WHERE i.state IN ('pending','waiting','active'))::int waiting
        FROM job_run_item i JOIN runs ON runs.id = i."runId" WHERE i."rootItemKey" IS NOT NULL GROUP BY i."runId"
      ), updated AS (
        UPDATE job_run r SET summary = jsonb_build_object('complete', true, 'finishedAt', r."finishedAt", 'migrated', true,
          'counts', jsonb_build_object('total', coalesce(rc.total, 0), 'completed', coalesce(rc.completed, 0),
            'failed', coalesce(rc.failed, 0), 'needsAttention', coalesce(rc."needsAttention", 0),
            'cancelled', coalesce(rc.cancelled, 0), 'active', 0, 'retrying', 0, 'delayed', 0, 'paused', 0,
            'waiting', coalesce(rc.waiting, 0), 'blocked', 0),
          'stageTotals', jsonb_build_object('total', coalesce(tc.total, 0), 'completed', coalesce(tc.completed, 0),
            'failed', coalesce(tc.failed, 0), 'needsAttention', coalesce(tc."needsAttention", 0),
            'cancelled', coalesce(tc.cancelled, 0), 'active', 0, 'retrying', 0, 'delayed', 0, 'paused', 0,
            'waiting', coalesce(tc.waiting, 0), 'blocked', coalesce(tc.blocked, 0)),
          'dependencyFailed', coalesce(tc.blocked, 0) > 0)
        FROM runs LEFT JOIN root_counts rc ON rc."runId" = runs.id LEFT JOIN task_counts tc ON tc."runId" = runs.id
        WHERE r.id = runs.id RETURNING r.id
      ) SELECT id::text FROM updated ORDER BY id`.execute(db);
    if (rows.length < SUMMARY_RUNS) break;
    after = rows.at(-1)!.id;
  }

  await sql`DROP TABLE job_library_source_producer, job_selection_lineage, job_selection_run, job_run_item, job_selection`.execute(
    db,
  );
  await sql`ALTER TABLE job_queue DROP COLUMN "manifestFilling", ADD COLUMN "closedUntil" timestamptz`.execute(db);

  // The claim reads in (availableAt, createdAt, id) order straight from the index; held jobs sit at its end.
  await sql`DROP INDEX IF EXISTS job_claim`.execute(db);
  await sql`CREATE INDEX job_claim ON job (queue, "availableAt", "createdAt", id) WHERE state IN ('pending','waiting')`.execute(
    db,
  );
  await sql`CREATE INDEX job_run_progress ON job ("runId", "rootItemKey", name, state) WHERE "runId" IS NOT NULL`.execute(
    db,
  );
  await sql`CREATE INDEX job_run_deferred ON job ("runId", "dependencyReason")
    WHERE state = 'pending' AND "dependencyReason" IS NOT NULL`.execute(db);

  // Quiet hours no longer pause queues; give back the ones they paused.
  await sql`UPDATE job_queue q SET paused = false FROM system_metadata m
    WHERE m.key = 'overnight-sequence' AND jsonb_typeof(m.value #> '{quiet,holding}') = 'array'
      AND (m.value #> '{quiet,holding}') ? q.name`.execute(db);
  await sql`UPDATE system_metadata SET value = jsonb_set(value, '{quiet,holding}', 'null'::jsonb)
    WHERE key = 'overnight-sequence' AND jsonb_typeof(value->'quiet') = 'object'`.execute(db);

  // History the retention sweep would delete anyway, in one pass instead of millions of page-sized ones. Same keep
  // rules (retention.ts); a job with an attempt that did not complete is left to the sweep, which keeps its evidence.
  await sql`DELETE FROM job j
    WHERE j.state IN ('completed','failed','cancelled','blocked') AND j."latestPending" IS NULL
      AND j."finishedAt" < now() - CASE WHEN j.state = 'completed' THEN interval '7 days' ELSE interval '30 days' END
      AND NOT EXISTS (SELECT 1 FROM job child WHERE child."parentId" = j.id)
      AND NOT EXISTS (SELECT 1 FROM job_run r WHERE r.id = j."runId" AND r."finishedAt" IS NULL)
      AND NOT EXISTS (SELECT 1 FROM job_attempt a WHERE a."jobId" = j.id
        AND (a.outcome IS DISTINCT FROM 'completed' OR a."finishedAt" IS NULL))`.execute(db);
  await sql`DELETE FROM job_worker w WHERE w.state = 'lost' AND w."heartbeatAt" < now() - interval '7 days'
    AND NOT EXISTS (SELECT 1 FROM job j WHERE j."workerId" = w.id)
    AND NOT EXISTS (SELECT 1 FROM job_attempt a WHERE a."workerId" = w.id)`.execute(db);
  // Deleting rows does not give disk back. Rewrite the queue tables compactly (VACUUM FULL cannot run in a transaction;
  // CLUSTER on a named table can). ponytail: needs free space for the rows kept, which the drops above just freed.
  for (const [table, index] of [
    ['job', 'job_pkey'],
    ['job_attempt', 'job_attempt_pkey'],
    ['job_run', 'job_run_pkey'],
    ['job_worker', 'job_worker_pkey'],
  ]) {
    await sql`CLUSTER ${sql.id(table)} USING ${sql.id(index)}`.execute(db);
    // A one-off rewrite: leave no clustering mark in the schema.
    await sql`ALTER TABLE ${sql.id(table)} SET WITHOUT CLUSTER`.execute(db);
  }

  await sql`ANALYZE job, job_attempt, job_run, job_worker`.execute(db);
}

export function down(): Promise<never> {
  return Promise.reject(
    new Error('FL-1265 cannot be reversed: the old job ledger is gone. Restore a backup taken before the upgrade.'),
  );
}
