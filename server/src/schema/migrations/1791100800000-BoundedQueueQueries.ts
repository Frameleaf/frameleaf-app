import { Kysely, sql } from 'kysely';

/** Keep hot queue work proportional to live items and the affected manifest memberships. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`create index job_manifest_source_pending on job_run_item("selectionId", "runId", "itemKey")
    where "jobId" is null and state = 'pending'`.execute(db);
  await sql`create index job_selection_membership on job_run_item("selectionId", "itemKey", stage)
    where "selectionId" is not null`.execute(db);
  await sql`create index job_run_unfinished on job_run_item("runId")
    where state in ('pending','waiting','active')`.execute(db);
  await sql`create index job_unadmitted_queue on job_run_item(queue)
    where "jobId" is null and state in ('pending','waiting','active')`.execute(db);
  await sql`create index job_selection_feed on job_selection(queue, "createdAt", id) where state = 'ready'`.execute(db);
  await sql`create index job_selection_enumerating on job_selection(queue) where state = 'enumerating'`.execute(db);
  await sql`create index job_live_queue on job(queue, state, "createdAt", id)
    where state in ('pending','waiting','active')`.execute(db);
  await sql`create index job_dependency_pending on job("parentId")
    where "parentId" is not null and state in ('pending','waiting')`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const index of [
    'job_manifest_source_pending',
    'job_selection_membership',
    'job_run_unfinished',
    'job_unadmitted_queue',
    'job_selection_feed',
    'job_selection_enumerating',
    'job_live_queue',
    'job_dependency_pending',
  ]) {
    await sql`drop index ${sql.id(index)}`.execute(db);
  }
}
