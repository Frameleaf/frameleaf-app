import { Kysely, sql } from 'kysely';

/** Domain-owned library enumeration and accepted child stages share the bounded manifest ledger. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`alter table job_selection
    add column "sourceKind" text not null default 'frozen',
    add column "libraryFrozenProducerId" uuid,
    add column "librarySharesExecution" boolean not null default false,
    add column "libraryOperationId" uuid,
    add column "sourceClosedAt" timestamptz,
    add column "appendSequence" bigint not null default 0,
    add constraint job_selection_library_source check (
      ("sourceKind" = 'frozen' and "libraryOperationId" is null)
      or ("sourceKind" in ('library-initial','library-child') and "libraryOperationId" is not null
        and "libraryOperationId" = "runId" and "producerId" is null)),
    add constraint job_selection_append_sequence check ("appendSequence" >= 0)`.execute(db);
  await sql`update job_selection set "libraryFrozenProducerId" = "producerId" where "producerId" is not null`.execute(db);
  await sql`alter table job_run_item
    add column "libraryCleanupId" bigint generated always as identity,
    add column "librarySourceKey" text,
    add column "libraryProducerId" uuid,
    add column "libraryOriginComplete" boolean not null default false,
    add column "libraryOriginAfter" uuid,
    add column "libraryExecutionRunId" uuid,
    add column "libraryExecutionItemKey" text,
    add constraint job_library_execution_identity check (("libraryExecutionRunId" is null) = ("libraryExecutionItemKey" is null)),
    add column "libraryIntent" jsonb,
    add column "libraryParentId" uuid references job(id) on delete set null,
    add constraint job_run_item_library_intent check (("librarySourceKey" is null) = ("libraryIntent" is null))`.execute(
    db,
  );
  await sql`alter table job_selection_run add column "libraryVersion" bigint not null default 0`.execute(db);
  await sql`alter table job_selection_lineage add column "libraryChildOrigin" boolean not null default false`.execute(db);
  await sql`create index job_selection_generic_lineage on job_selection_lineage("selectionId",id)
    where not "libraryChildOrigin"`.execute(db);
  await sql`create table job_library_source_producer (
    "selectionId" uuid not null references job_selection(id) on delete cascade,
    "producerId" uuid not null,
    primary key ("selectionId", "producerId"))`.execute(db);
  await sql`create index job_library_source_producer_job on job_library_source_producer("producerId", "selectionId")`.execute(db);
  await sql`create index job_library_origin_request on job_run_item ((coalesce("libraryProducerId", "jobId")), "runId")
    where "rootItemKey" is null`.execute(db);
  await sql`create unique index job_library_source_identity on job_run_item("selectionId", "runId", "librarySourceKey")
    where "librarySourceKey" is not null`.execute(db);
  await sql`create index job_library_operation_source on job_selection("libraryOperationId", "sourceKind")
    where "libraryOperationId" is not null`.execute(db);
  await sql`create index job_library_origin_pending on job_run_item("selectionId", "runId", "itemKey")
    where "libraryIntent" is not null and not "libraryOriginComplete"`.execute(db);
  await sql`create index job_library_feeder_ready on job_run_item("selectionId", "runId", "itemKey")
    where "jobId" is null and state='pending' and "libraryIntent" is not null and "libraryOriginComplete"`.execute(db);
  await sql`create index job_library_execution_owner on job_run_item("libraryExecutionRunId", "libraryExecutionItemKey", stage)
    where "libraryExecutionRunId" is not null`.execute(db);
  await sql`create index job_library_canonical_job on job_run_item("jobId","runId","itemKey",stage)
    where "jobId" is not null and "libraryIntent" is not null`.execute(db);
  await sql`create index job_library_initial_outcome on job_run_item("selectionId","runId","itemKey",stage)
    where "libraryIntent" is not null and ("jobId" is not null or state!='pending' or "libraryExecutionRunId" is not null)`.execute(db);
  await sql`create index job_library_redact_all_cursor on job_run_item("libraryCleanupId")
    where "jobId" is null and "libraryIntent"->>'sensitive'='true'
      and ("libraryIntent" ? 'options' or "libraryIntent"->'data' != '{}'::jsonb)`.execute(db);
  await sql`create index job_library_redact_cursor on job_run_item(queue,"libraryCleanupId")
    where "jobId" is null and "libraryIntent"->>'sensitive'='true'
      and ("libraryIntent" ? 'options' or "libraryIntent"->'data' != '{}'::jsonb)`.execute(db);
  await sql`create index job_library_source_parent on job_run_item("libraryParentId")
    where "libraryParentId" is not null`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // A previous release cannot preserve pending library intent options or an open domain source.
  const { rows } = await sql`select 1 from job_selection s where s."sourceKind" != 'frozen'
    and (s."sourceClosedAt" is null or exists (select 1 from job_run_item i where i."selectionId" = s.id
      and i."jobId" is null and i.state = 'pending')) limit 1`.execute(db);
  if (rows.length > 0) throw new Error('Settle library sources before downgrading');
  await sql`drop table job_library_source_producer`.execute(db);
  await sql`drop index job_library_canonical_job`.execute(db);
  await sql`alter table job_selection_run drop column "libraryVersion"`.execute(db);
  await sql`alter table job_selection_lineage drop column "libraryChildOrigin"`.execute(db);
  await sql`alter table job_run_item drop constraint job_run_item_library_intent, drop constraint job_library_execution_identity,
    drop column "libraryCleanupId", drop column "libraryParentId", drop column "libraryIntent", drop column "librarySourceKey", drop column "libraryProducerId",
    drop column "libraryOriginComplete", drop column "libraryOriginAfter",
    drop column "libraryExecutionRunId", drop column "libraryExecutionItemKey"`.execute(db);
  await sql`drop index job_library_operation_source`.execute(db);
  await sql`alter table job_selection drop constraint job_selection_library_source,
    drop constraint job_selection_append_sequence, drop column "sourceKind", drop column "libraryOperationId",
    drop column "sourceClosedAt", drop column "appendSequence", drop column "libraryFrozenProducerId", drop column "librarySharesExecution"`.execute(db);
}
