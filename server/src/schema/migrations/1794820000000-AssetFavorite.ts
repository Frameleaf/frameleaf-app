import { Kysely, sql } from 'kysely';

/** FL-786: a person's own favourite on an item someone else owns (shared album or space). */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE asset_favorite (
    "userId" uuid NOT NULL,
    "assetId" uuid NOT NULL,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT asset_favorite_pkey PRIMARY KEY ("userId", "assetId"),
    CONSTRAINT "asset_favorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"(id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "asset_favorite_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES asset(id) ON UPDATE CASCADE ON DELETE CASCADE
  )`.execute(db);
  await sql`CREATE INDEX "asset_favorite_assetId_idx" ON asset_favorite ("assetId")`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE asset_favorite`.execute(db);
}
