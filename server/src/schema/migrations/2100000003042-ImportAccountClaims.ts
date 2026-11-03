import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('user').addColumn('importClaimPending', 'boolean', (column) => column.notNull().defaultTo(false)).execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DO $$ BEGIN
    LOCK TABLE public."user" IN ACCESS EXCLUSIVE MODE;
    IF EXISTS (SELECT 1 FROM public."user" WHERE "importClaimPending") THEN
      RAISE EXCEPTION 'Imported accounts still require secure claims';
    END IF;
    ALTER TABLE public."user" DROP COLUMN "importClaimPending";
  END $$`.execute(db);
}
