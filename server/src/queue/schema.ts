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
      state text not null check (state in ('enumerating','ready','needs_attention')),
      "createdAt" timestamptz not null default now(), unique ("runId", stage), unique ("producerId", stage)
    );
    create table job_run_item (
      "runId" uuid not null references job_run(id), "itemKey" text not null, "rootItemKey" text, stage text not null, queue text not null references job_queue(name),
      selection jsonb not null, "selectionId" uuid references job_selection(id), "jobId" uuid, state text not null default 'pending',
      primary key ("runId", "itemKey", stage),
      check (state in ('pending','waiting','active','completed','failed','needs_attention','cancelled','blocked'))
    );
    create index job_run_item_job on job_run_item("jobId") where "jobId" is not null;
    create index job_run_root_item on job_run_item("runId", "rootItemKey");
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
      "cancelRequestedAt" timestamptz, "dependencyReason" text, error text,
      check (state in ('pending','waiting','active','completed','failed','needs_attention','cancelled','blocked')),
      check ((state = 'active') = (token is not null)),
      foreign key ("runId", "itemKey", name) references job_run_item("runId", "itemKey", stage)
    );
    alter table job_selection add foreign key ("producerId") references job(id) on delete set null;
    create index job_manifest_pending on job_run_item("selectionId", "itemKey") where "jobId" is null and state = 'pending';
    create unique index job_dedup_live on job(queue, "dedupKey")
      where "dedupKey" is not null and state in ('pending','waiting','active');
    create unique index job_run_stage on job("runId", "itemKey", name) where "runId" is not null;
    create index job_claim on job(queue, "availableAt", "createdAt") where state in ('pending','waiting');
    create index job_lease on job("leaseExpiresAt") where state = 'active';
    create index job_parent on job("parentId") where "parentId" is not null;
    create index job_retention on job("finishedAt", id)
      where state in ('completed','failed','cancelled','blocked') and "latestPending" is null;
    create table job_attempt (
      "jobId" uuid not null references job(id) on delete cascade, attempt integer not null,
      token uuid not null unique, "workerId" uuid not null references job_worker(id),
      "startedAt" timestamptz not null default now(), "finishedAt" timestamptz,
      outcome text, error text, primary key ("jobId", attempt)
    );
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
