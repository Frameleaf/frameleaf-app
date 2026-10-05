import { Kysely, sql } from 'kysely';

/** Keep the publication fence while distinguishing explicit cancellation from a retryable deadline. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`alter table job add column "cancelReason" text
    constraint job_cancel_reason_check check ("cancelReason" in ('deadline','request'))`.execute(db);
  await sql`create index job_cancel_pending on job(queue, "createdAt", id) where state in ('pending','waiting')
    and "cancelRequestedAt" is not null and "cancelReason" is distinct from 'deadline'`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  if (!db.isTransaction) return db.transaction().execute(down);
  await sql`lock table job in access exclusive mode`.execute(db);
  const { rows } =
    await sql`select 1 from job where state in ('pending','waiting','active') and "cancelRequestedAt" is not null limit 1`.execute(
      db,
    );
  if (rows.length > 0) throw new Error('Cannot discard the cancellation reason of an unsettled job');
  await sql`alter table job drop column "cancelReason"`.execute(db);
}
