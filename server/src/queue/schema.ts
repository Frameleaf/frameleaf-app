import { Kysely, sql } from 'kysely';

/** Fresh canonical installations only. Called by the canonical migration, never on worker startup. */
export async function createQueueSchema(db: Kysely<any>) {
  const statements = `
    create table job_queue (
      name text primary key, paused boolean not null default false,
      concurrency integer not null default 1 check (concurrency > 0), "closedUntil" timestamptz
    );
    create table job_worker (
      id uuid primary key, "startedAt" timestamptz not null default now(),
      "heartbeatAt" timestamptz not null default now(), state text not null default 'running'
        check (state in ('running','stopping','lost'))
    );
    create table job_run (
      id uuid primary key, kind text not null, selection jsonb not null,
      "enumerationDone" boolean not null default false,
      "createdAt" timestamptz not null default now(), "finishedAt" timestamptz, summary jsonb,
      "ownerId" uuid, origin text, label text, "itemCount" integer
    );
    create index job_run_origin on job_run("ownerId", "createdAt") where origin is not null;
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
      check ((state = 'active') = (token is not null))
    );
    create index job_live_queue on job(queue, state, "createdAt", id) where state in ('pending','waiting','active');
    -- FL-1213: queue status counts every state, kept history included; answered from the index alone
    create index job_queue_state_idx on job(queue, state, "availableAt");
    create unique index job_dedup_live on job(queue, "dedupKey")
      where "dedupKey" is not null and state in ('pending','waiting','active');
    create unique index job_run_stage on job("runId", "itemKey", name) where "runId" is not null;
    create index job_run_live on job("runId") where "runId" is not null and state in ('pending','waiting','active');
    -- FL-1265: held jobs wait at availableAt 'infinity', the end of the claim order
    create index job_claim on job(queue, "availableAt", "createdAt", id) where state in ('pending','waiting');
    create index job_run_progress on job("runId", "rootItemKey", name, state) where "runId" is not null;
    create index job_run_deferred on job("runId", "dependencyReason") where state = 'pending' and "dependencyReason" is not null;
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
  for (const table of ['job', 'job_attempt', 'job_worker']) {
    await sql`alter table ${sql.id(table)} set (autovacuum_vacuum_scale_factor = 0.02,
      autovacuum_analyze_scale_factor = 0.05, autovacuum_vacuum_threshold = 50,
      autovacuum_analyze_threshold = 50)`.execute(db);
  }
}
