import { Kysely, sql } from 'kysely';

/** FL-771: phones report how many items they hold and why items wait, for the backup receipt. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE public.backup_device ADD COLUMN "phoneItemCount" integer`.execute(db);
  await sql`ALTER TABLE public.backup_device ADD COLUMN "pendingReasons" jsonb NOT NULL DEFAULT '[]'`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE public.backup_device DROP COLUMN "pendingReasons"`.execute(db);
  await sql`ALTER TABLE public.backup_device DROP COLUMN "phoneItemCount"`.execute(db);
}
