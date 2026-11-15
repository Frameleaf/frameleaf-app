import { Kysely, sql } from 'kysely';

// FL-934: folders an owner leaves out of face recognition; each prefix is an absolute folder path ending in `/`
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE face_folder_exclusion (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "ownerId" uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE ON UPDATE CASCADE,
    "pathPrefix" text NOT NULL CHECK ("pathPrefix" LIKE '/_%/'),
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("ownerId", "pathPrefix")
  )`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE face_folder_exclusion`.execute(db);
}
