import { Kysely, sql } from 'kysely';

/** FL-774: a partnership limited to chosen albums, people, folders and a start date. No row means Everything. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE partner_scope (
    "sharedById" uuid NOT NULL,
    "sharedWithId" uuid NOT NULL,
    "sinceDate" date,
    "albumIds" uuid[] NOT NULL DEFAULT '{}',
    "personIds" uuid[] NOT NULL DEFAULT '{}',
    folders text[] NOT NULL DEFAULT '{}',
    "updatedAt" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT partner_scope_pkey PRIMARY KEY ("sharedById", "sharedWithId"),
    CONSTRAINT "partner_scope_sharedById_sharedWithId_fkey" FOREIGN KEY ("sharedById", "sharedWithId")
      REFERENCES partner ("sharedById", "sharedWithId") ON DELETE CASCADE,
    CONSTRAINT partner_scope_chooses_check CHECK (
      "sinceDate" IS NOT NULL OR cardinality("albumIds") > 0 OR cardinality("personIds") > 0 OR cardinality(folders) > 0)
  )`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE partner_scope`.execute(db);
}
