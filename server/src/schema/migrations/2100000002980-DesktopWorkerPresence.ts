import { Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Old credentials are not proof that a helper is online; leave existing rows unobserved.
  await db.schema.alterTable('desktop_worker_session').addColumn('lastSeenAt', 'timestamptz').execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('desktop_worker_session').dropColumn('lastSeenAt').execute();
}
