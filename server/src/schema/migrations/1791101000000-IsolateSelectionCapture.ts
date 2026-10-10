import { Kysely, sql } from 'kysely';

/** A committed empty capture and a shared producer membership both need durable proof. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`alter table job_selection add column "capturedAt" timestamptz`.execute(db);
  // Before phase separation every visible selection was captured in the same transaction.
  await sql`update job_selection set "capturedAt" = "createdAt"`.execute(db);
  await sql`alter table job_run_item add column "selectionVersion" integer not null default 0`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`alter table job_run_item drop column "selectionVersion"`.execute(db);
  await sql`alter table job_selection drop column "capturedAt"`.execute(db);
}
