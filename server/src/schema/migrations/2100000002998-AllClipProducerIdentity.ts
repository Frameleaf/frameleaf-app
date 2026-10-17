import { Kysely, sql } from 'kysely';

const tables = ['asset_video_duplicate_frame', 'smart_search_description', 'video_moment_frame_embedding'] as const;

export async function up(db: Kysely<any>): Promise<void> {
  for (const table of tables) {
    await sql`ALTER TABLE ${sql.table(table)} ADD COLUMN "producerModelKey" character varying,
      ADD CONSTRAINT ${sql.id(`${table}_producer_key_check`)}
      CHECK ("producerModelKey" IS NULL OR "producerModelKey" ~ '^clip:[a-f0-9]{64}$')`.execute(db);
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const table of tables) await sql`LOCK TABLE ${sql.table(table)} IN ACCESS EXCLUSIVE MODE`.execute(db);
  for (const table of tables) {
    const { rows } = await sql<{ recorded: boolean }>`
      SELECT EXISTS (SELECT 1 FROM ${sql.table(table)} WHERE "producerModelKey" IS NOT NULL) AS recorded
    `.execute(db);
    if (rows[0].recorded) throw new Error('Cannot discard recorded CLIP producer identity during schema downgrade');
  }
  for (const table of tables) await sql`ALTER TABLE ${sql.table(table)} DROP COLUMN "producerModelKey"`.execute(db);
}
