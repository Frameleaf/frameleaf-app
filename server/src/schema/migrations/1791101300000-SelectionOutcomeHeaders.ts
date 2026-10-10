import { Kysely, sql } from 'kysely';

/** Preserve run/snapshot ownership after producer execution history is pruned. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`alter table job_selection drop constraint job_selection_state_check`.execute(db);
  await sql`alter table job_selection add constraint job_selection_state_check
    check (state in ('enumerating','ready','needs_attention','cancelled'))`.execute(db);
  await sql`create table job_selection_run (
    "runId" uuid not null references job_run(id) on delete cascade,
    "selectionId" uuid not null references job_selection(id) on delete cascade,
    "copyAfter" text, "copyComplete" boolean not null default false,
    primary key ("runId", "selectionId"))`.execute(db);
  await sql`create index job_selection_run_selection on job_selection_run("selectionId", "runId")`.execute(db);
  await sql`create index job_selection_run_copy on job_selection_run("selectionId", "runId") where not "copyComplete"`.execute(
    db,
  );
  await sql`insert into job_selection_run("runId", "selectionId", "copyComplete")
    select "runId", id, true from job_selection
    union select "runId", "selectionId", true from job_run_item where "selectionId" is not null`.execute(db);
  await sql`insert into job_selection_run("runId", "selectionId", "copyComplete")
    select i."runId", s.id, false from job_selection s join job_run_item i on i."jobId" = s."producerId"
      and i."rootItemKey" is null on conflict do nothing`.execute(db);
  // Older releases stored the producer failure on every unadmitted membership. The selection
  // header already has that outcome; normalize the underlying admission state once on upgrade.
  await sql`update job_run_item set state = 'pending' where "jobId" is null and "selectionId" is not null
    and state = 'needs_attention'`.execute(db);
  await sql`create index job_run_unfinished_execution on job_run_item("runId")
    where state in ('pending','waiting','active') and ("selectionId" is null or "jobId" is not null)`.execute(db);
  await sql`create index job_unadmitted_execution_queue on job_run_item(queue)
    where "jobId" is null and "selectionId" is null and state in ('pending','waiting','active')`.execute(db);
  await sql`create index job_selection_live on job_selection(queue, id) where state in ('ready','enumerating')`.execute(
    db,
  );
  await sql`create index job_selection_source on job_run_item("selectionId", "runId", "itemKey") where "selectionId" is not null`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  // Downgrade runs with workers stopped. Materialize outstanding memberships before removing
  // the durable cursor; the previous release cannot resume a header-only shared run.
  await sql`insert into job_run_item("runId", "itemKey", "rootItemKey", stage, queue, selection, "jobId", state, "selectionId")
    select m."runId", i."itemKey", i."rootItemKey", i.stage, i.queue, i.selection, i."jobId", i.state, i."selectionId"
    from job_selection_run m join job_selection s on s.id = m."selectionId"
      join job_run_item i on i."selectionId" = s.id and i."runId" = s."runId"
    where not m."copyComplete" on conflict do nothing`.execute(db);
  await sql`update job_run_item i set "selectionVersion" = (select count(*) from job_selection s
    where s."producerId" = i."jobId" and s."capturedAt" is not null)
    where i."rootItemKey" is null and i."jobId" is not null`.execute(db);
  await sql`update job_run_item i set state = s.state from job_selection s where s.id = i."selectionId"
    and i."jobId" is null and i.state = 'pending' and s.state in ('needs_attention','cancelled')`.execute(db);
  await sql`update job_run r set "enumerationDone" = true where exists (
      select 1 from job_selection_run m where m."runId" = r.id)
    and not exists (select 1 from job_run_item i where i."runId" = r.id and i."rootItemKey" is null
      and i.state in ('pending','waiting','active'))
    and not exists (select 1 from job_selection_run m join job_selection s on s.id = m."selectionId"
      where m."runId" = r.id and s.state = 'enumerating')`.execute(db);
  await sql`update job_run r set "finishedAt" = now() where r."enumerationDone" and r."finishedAt" is null
    and not exists (select 1 from job_run_item i where i."runId" = r.id and i.state in ('pending','waiting','active'))`.execute(
    db,
  );
  await sql`update job_selection set state = 'needs_attention' where state = 'cancelled'`.execute(db);
  await sql`alter table job_selection drop constraint job_selection_state_check`.execute(db);
  await sql`alter table job_selection add constraint job_selection_state_check
    check (state in ('enumerating','ready','needs_attention'))`.execute(db);
  await sql`drop index job_selection_live`.execute(db);
  await sql`drop index job_selection_source`.execute(db);
  await sql`drop index job_run_unfinished_execution`.execute(db);
  await sql`drop index job_unadmitted_execution_queue`.execute(db);
  await sql`drop table job_selection_run`.execute(db);
}
