import { Kysely, sql } from 'kysely';

/** Fresh Frameleaf composition and deterministic development fixtures; no released-version migration contract. */
export async function up(db: Kysely<any>): Promise<void> {
  // Detailed pre-protocol history cannot prove ancestry once parent edges have been pruned.
  // Real fresh installations apply this migration before workers run; refuse inconsistent fixtures.
  const { rows } = await sql`select 1 from job_run_item child
    where child."selectionId" is null and child."jobId" is null and child."rootItemKey" is not null
      and exists (select 1 from job_run_item root where root."runId" = child."runId"
        and root."rootItemKey" = child."rootItemKey" and root."selectionId" is not null) limit 1`.execute(db);
  if (rows.length > 0)
    throw new Error('Pre-protocol selection lineage cannot be proven after detailed history was pruned');
  await sql`alter table job_selection_run add column "lineageAfter" bigint not null default 0`.execute(db);
  await sql`create table job_selection_lineage (
    id bigint generated always as identity primary key,
    "selectionId" uuid not null references job_selection(id) on delete cascade,
    "runId" uuid not null, "itemKey" text not null, stage text not null,
    superseded boolean not null default false,
    unique ("selectionId", "itemKey", stage),
    foreign key ("runId", "itemKey", stage) references job_run_item("runId", "itemKey", stage) on delete cascade
  )`.execute(db);
  await sql`create index job_selection_lineage_page on job_selection_lineage("selectionId", id)`.execute(db);
  await sql`create index job_selection_lineage_source on job_selection_lineage("runId", "itemKey", stage)`.execute(db);
  // Parent-job edges are authoritative for pre-protocol development/restore fixtures. Preserve
  // all generations while workers are stopped; runtime history copying remains bounded to 250.
  await sql`with recursive descendants as (
    select i."selectionId", i."runId", i."itemKey", i.stage, i."jobId" from job_run_item i
      join job_selection s on s.id = i."selectionId" and s."runId" = i."runId"
    union
    select p."selectionId", i."runId", i."itemKey", i.stage, i."jobId" from descendants p
      join job child on child."parentId" = p."jobId"
      join job_run_item i on i."jobId" = child.id and i."runId" = p."runId"
  ) insert into job_selection_lineage("selectionId", "runId", "itemKey", stage)
    select d."selectionId", d."runId", d."itemKey", d.stage from descendants d
      join job_run_item i on (i."runId", i."itemKey", i.stage) = (d."runId", d."itemKey", d.stage)
    where i."selectionId" is distinct from d."selectionId" on conflict do nothing`.execute(db);
  const { rows: unproven } = await sql`select 1 from job_run_item child
    where child."selectionId" is null and child."rootItemKey" is not null
      and exists (select 1 from job_run_item root where root."runId" = child."runId"
        and root."rootItemKey" = child."rootItemKey" and root."selectionId" is not null
        and not exists (select 1 from job_selection_lineage l join job_run_item source
          on (source."runId", source."itemKey", source.stage) = (l."runId", l."itemKey", l.stage)
          where l."selectionId" = root."selectionId" and source."jobId" = child."jobId"
            and source."rootItemKey" is not distinct from child."rootItemKey")) limit 1`.execute(db);
  if (unproven.length > 0)
    throw new Error('Pre-protocol selection lineage cannot be proven without retained parent-job edges');
  await sql`with pending as (
    update job_selection_run m set "copyComplete" = false from job_selection s
      where m."selectionId" = s.id and m."runId" != s."runId"
        and exists (select 1 from job_selection_lineage l where l."selectionId" = s.id) returning m."runId"
  ) update job_run set "enumerationDone" = false, "finishedAt" = null where id in (select "runId" from pending)`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  // A replaced source tuple can now describe a different request. The old schema cannot
  // represent that distinction, so never silently discard its durable cancellation proof.
  const { rows } = await sql`select 1 from job_selection_lineage where superseded limit 1`.execute(db);
  if (rows.length > 0) throw new Error('Superseded selection lineage cannot be represented before migration150');
  // Offline rollback preserves every known descendant outcome before removing the new cursor.
  await sql`insert into job_run_item("runId", "itemKey", "rootItemKey", stage, queue, selection, "jobId", state, "selectionId")
    select m."runId", i."itemKey", i."rootItemKey", i.stage, i.queue, i.selection, i."jobId", i.state, i."selectionId"
    from job_selection_run m join job_selection_lineage l on l."selectionId" = m."selectionId"
      join job_run_item i on (i."runId", i."itemKey", i.stage) = (l."runId", l."itemKey", l.stage)
    on conflict do nothing`.execute(db);
  await sql`drop table job_selection_lineage`.execute(db);
  await sql`alter table job_selection_run drop column "lineageAfter"`.execute(db);
}
