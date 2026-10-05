import { Kysely, sql } from 'kysely';

/** Fresh canonical installations only. Called by the canonical migration, never on worker startup. */
export async function createQueueSchema(db: Kysely<any>) {
  const statements = `
    create table job_queue (
      name text primary key, paused boolean not null default false, "manifestFilling" boolean not null default false,
      concurrency integer not null default 1 check (concurrency > 0)
    );
    create table job_worker (
      id uuid primary key, "startedAt" timestamptz not null default now(),
      "heartbeatAt" timestamptz not null default now(), state text not null default 'running'
        check (state in ('running','stopping','lost'))
    );
    create table job_run (
      id uuid primary key, kind text not null, selection jsonb not null,
      "enumerationDone" boolean not null default false,
      "createdAt" timestamptz not null default now(), "finishedAt" timestamptz
    );
    create table job_selection (
      id uuid primary key, "runId" uuid not null references job_run(id), "producerId" uuid,
      stage text not null, queue text not null references job_queue(name),
      "safeToRetry" boolean not null, sensitive boolean not null, "deadlineMs" integer not null,
      state text not null check (state in ('enumerating','ready','needs_attention','cancelled')),
      "createdAt" timestamptz not null default now(), "capturedAt" timestamptz, unique ("runId", stage), unique ("producerId", stage)
    );
    create table job_selection_run (
      "runId" uuid not null references job_run(id) on delete cascade,
      "selectionId" uuid not null references job_selection(id) on delete cascade,
      "copyAfter" text, "lineageAfter" bigint not null default 0, "copyComplete" boolean not null default false,
      primary key ("runId", "selectionId")
    );
    create index job_selection_run_selection on job_selection_run("selectionId", "runId");
    create index job_selection_run_copy on job_selection_run("selectionId", "runId") where not "copyComplete";
    create table job_run_item (
      "runId" uuid not null references job_run(id), "itemKey" text not null, "rootItemKey" text, stage text not null, queue text not null references job_queue(name),
      selection jsonb not null, "selectionId" uuid references job_selection(id), "jobId" uuid, state text not null default 'pending',
      "selectionVersion" integer not null default 0,
      primary key ("runId", "itemKey", stage),
      check (state in ('pending','waiting','active','completed','failed','needs_attention','cancelled','blocked'))
    );
    create index job_run_item_job on job_run_item("jobId") where "jobId" is not null;
    create index job_run_root_item on job_run_item("runId", "rootItemKey");
    create table job_selection_lineage (
      id bigint generated always as identity primary key,
      "selectionId" uuid not null references job_selection(id) on delete cascade,
      "runId" uuid not null, "itemKey" text not null, stage text not null,
      superseded boolean not null default false,
      unique ("selectionId", "itemKey", stage),
      foreign key ("runId", "itemKey", stage) references job_run_item("runId", "itemKey", stage) on delete cascade
    );
    create index job_selection_lineage_page on job_selection_lineage("selectionId", id);
    create index job_selection_lineage_source on job_selection_lineage("runId", "itemKey", stage);
    create table job (
      id uuid primary key, queue text not null references job_queue(name), name text not null,
      data jsonb not null, state text not null default 'pending',
      "dedupKey" text, "externalId" text, "latestPending" jsonb,
      "safeToRetry" boolean not null, sensitive boolean not null default false,
      "deadlineMs" integer not null, attempt integer not null default 0, "retryBaseAttempt" integer not null default 0,
      "runId" uuid references job_run(id), "itemKey" text, "rootItemKey" text,
      "parentId" uuid references job(id), token uuid, "workerId" uuid references job_worker(id),
      "availableAt" timestamptz not null default now(), "createdAt" timestamptz not null default now(),
      "startedAt" timestamptz, "finishedAt" timestamptz, "leaseExpiresAt" timestamptz,
      "progressAt" timestamptz, "progressUnits" bigint not null default 0,
      "cancelRequestedAt" timestamptz,
      "cancelReason" text constraint job_cancel_reason_check check ("cancelReason" in ('deadline','request')),
      "dependencyReason" text, error text,
      check (state in ('pending','waiting','active','completed','failed','needs_attention','cancelled','blocked')),
      check ((state = 'active') = (token is not null)),
      foreign key ("runId", "itemKey", name) references job_run_item("runId", "itemKey", stage)
    );
    alter table job_selection add foreign key ("producerId") references job(id) on delete set null;
    create index job_manifest_pending on job_run_item("selectionId", "itemKey") where "jobId" is null and state = 'pending';
    create index job_manifest_source_pending on job_run_item("selectionId", "runId", "itemKey") where "jobId" is null and state = 'pending';
    create index job_selection_membership on job_run_item("selectionId", "itemKey", stage) where "selectionId" is not null;
    create index job_selection_source on job_run_item("selectionId", "runId", "itemKey") where "selectionId" is not null;
    create index job_run_unfinished on job_run_item("runId") where state in ('pending','waiting','active');
    create index job_run_unfinished_execution on job_run_item("runId") where state in ('pending','waiting','active') and ("selectionId" is null or "jobId" is not null);
    create index job_unadmitted_queue on job_run_item(queue) where "jobId" is null and state in ('pending','waiting','active');
    create index job_unadmitted_execution_queue on job_run_item(queue) where "jobId" is null and "selectionId" is null and state in ('pending','waiting','active');
    create index job_selection_feed on job_selection(queue, "createdAt", id) where state = 'ready';
    create index job_selection_enumerating on job_selection(queue) where state = 'enumerating';
    create index job_selection_live on job_selection(queue, id) where state in ('ready','enumerating');
    create index job_live_queue on job(queue, state, "createdAt", id) where state in ('pending','waiting','active');
    create unique index job_dedup_live on job(queue, "dedupKey")
      where "dedupKey" is not null and state in ('pending','waiting','active');
    create unique index job_run_stage on job("runId", "itemKey", name) where "runId" is not null;
    create index job_claim on job(queue, "availableAt", "createdAt") where state in ('pending','waiting');
    create index job_cancel_pending on job(queue, "createdAt", id) where state in ('pending','waiting')
      and "cancelRequestedAt" is not null and "cancelReason" is distinct from 'deadline';
    create index job_lease on job("leaseExpiresAt") where state = 'active';
    create index job_parent on job("parentId") where "parentId" is not null;
    create index job_worker_reference on job("workerId") where "workerId" is not null;
    create index job_dependency_pending on job("parentId") where "parentId" is not null and state in ('pending','waiting');
    create index job_retention on job("finishedAt", id)
      where state in ('completed','failed','cancelled','blocked') and "latestPending" is null;
    create table job_attempt (
      "jobId" uuid not null references job(id) on delete cascade, attempt integer not null,
      token uuid not null unique, "workerId" uuid not null references job_worker(id),
      "startedAt" timestamptz not null default now(), "finishedAt" timestamptz,
      outcome text, error text, primary key ("jobId", attempt)
    );
    create index job_attempt_worker_reference on job_attempt("workerId");
  `;
  for (const statement of statements.split(';')) {
    if (!statement.trim()) continue;
    await sql.raw(statement).execute(db);
  }
  for (const table of ['job', 'job_attempt', 'job_worker', 'job_run_item']) {
    await sql`alter table ${sql.id(table)} set (autovacuum_vacuum_scale_factor = 0.02,
      autovacuum_analyze_scale_factor = 0.05, autovacuum_vacuum_threshold = 50,
      autovacuum_analyze_threshold = 50)`.execute(db);
  }
}
