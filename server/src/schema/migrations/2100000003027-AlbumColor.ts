import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE album ADD COLUMN color text DEFAULT NULL, ADD CONSTRAINT album_color_check CHECK (color IS NULL OR color = ANY (ARRAY['grey'::text, 'green'::text, 'teal'::text, 'blue'::text, 'purple'::text, 'pink'::text, 'amber'::text, 'red'::text]));`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE album DROP CONSTRAINT album_color_check, DROP COLUMN color;`.execute(db);
}
