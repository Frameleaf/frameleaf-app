import { Kysely, sql } from 'kysely';

/** Worker retention probes must not scan retained execution/attempt history. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`create index job_worker_reference on job("workerId") where "workerId" is not null`.execute(db);
  await sql`create index job_attempt_worker_reference on job_attempt("workerId")`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`drop index job_attempt_worker_reference`.execute(db);
  await sql`drop index job_worker_reference`.execute(db);
}
