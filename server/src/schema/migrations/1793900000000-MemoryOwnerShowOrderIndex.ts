import { Kysely, sql } from 'kysely';

/** FL-1213: the memories list pages one owner's memories newest first without sorting them all. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE INDEX IF NOT EXISTS "memory_owner_show_order_idx" ON "memory" ("ownerId", "showAt" DESC NULLS LAST, "memoryAt" DESC) WHERE "deletedAt" IS NULL`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS "memory_owner_show_order_idx"`.execute(db);
}
