import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE smart_search ADD COLUMN "producerModelKey" character varying,
    ADD CONSTRAINT smart_search_producer_key_check
    CHECK ("producerModelKey" IS NULL OR "producerModelKey" ~ '^clip:[a-f0-9]{64}$')`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`LOCK TABLE smart_search IN ACCESS EXCLUSIVE MODE`.execute(db);
  const { rows } = await sql<{ recorded: boolean }>`
    SELECT EXISTS (SELECT 1 FROM smart_search WHERE "producerModelKey" IS NOT NULL) AS recorded
  `.execute(db);
  if (rows[0].recorded) throw new Error('Cannot discard recorded CLIP producer identity during schema downgrade');
  await sql`ALTER TABLE smart_search DROP COLUMN "producerModelKey"`.execute(db);
}
