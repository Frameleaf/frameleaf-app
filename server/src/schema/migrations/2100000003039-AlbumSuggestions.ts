import { Kysely, sql } from 'kysely';

// FL-1092: "Not from this trip" dismissals and the per-album "Keep adding new photos from this trip" choice.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE album_suggestion_dismissal (
    "albumId" uuid NOT NULL,
    "assetId" uuid NOT NULL,
    "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT album_suggestion_dismissal_pkey PRIMARY KEY ("albumId", "assetId"),
    CONSTRAINT "album_suggestion_dismissal_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES album(id) ON DELETE CASCADE,
    CONSTRAINT "album_suggestion_dismissal_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES asset(id) ON DELETE CASCADE
  )`.execute(db);
  await sql`CREATE INDEX "album_suggestion_dismissal_albumId_idx" ON album_suggestion_dismissal ("albumId")`.execute(db);
  await sql`CREATE INDEX "album_suggestion_dismissal_assetId_idx" ON album_suggestion_dismissal ("assetId")`.execute(db);
  await sql`CREATE TABLE album_suggestion_auto_add (
    "albumId" uuid NOT NULL,
    "userId" uuid NOT NULL,
    "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT album_suggestion_auto_add_pkey PRIMARY KEY ("albumId", "userId"),
    CONSTRAINT "album_suggestion_auto_add_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES album(id) ON DELETE CASCADE,
    CONSTRAINT "album_suggestion_auto_add_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"(id) ON DELETE CASCADE
  )`.execute(db);
  await sql`CREATE INDEX "album_suggestion_auto_add_albumId_idx" ON album_suggestion_auto_add ("albumId")`.execute(db);
  await sql`CREATE INDEX "album_suggestion_auto_add_userId_idx" ON album_suggestion_auto_add ("userId")`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE album_suggestion_auto_add`.execute(db);
  await sql`DROP TABLE album_suggestion_dismissal`.execute(db);
}
