import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE public.push_device_activity ADD COLUMN "operationId" uuid`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE public.push_device_activity DROP COLUMN "operationId"`.execute(db);
}
