import { Kysely, sql } from 'kysely';

/**
 * The shared space collaboration suite (FL-55): a durable record of what
 * happened in a space, and who was mentioned in a comment.
 *
 * Both are new tables and nothing is backfilled: the feed starts when this
 * migration runs, and an old comment simply has no mentions. Both hold only
 * references — ids of users, activities and assets — so dropping them loses the
 * feed's history and the mention links, never a photo, a comment or an account.
 * Comment and like events cascade from `activity`, so a deleted comment leaves
 * the feed with it; a deleted account leaves its events behind without a name.
 */
export async function up(db: Kysely<any>): Promise<void> {
  // NOTE: constraint and index names follow the generator's conventions so
  // `migrations:generate` produces no drift against the table classes:
  // `{table}_{column}_fkey`, `{table}_pkey`, and a `{table}_{column}_idx` index
  // for every foreign-key column, plus the one composite index named on the class.
  await sql`CREATE TABLE "shared_space_event" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "albumId" uuid NOT NULL,
  "actorId" uuid,
  "type" character varying NOT NULL,
  "targetUserId" uuid,
  "activityId" uuid,
  "assetIds" uuid[] NOT NULL DEFAULT '{}',
  "subject" character varying,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "shared_space_event_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "album" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "shared_space_event_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "shared_space_event_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "shared_space_event_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "activity" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "shared_space_event_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "shared_space_event_albumId_idx" ON "shared_space_event" ("albumId");`.execute(db);
  await sql`CREATE INDEX "shared_space_event_actorId_idx" ON "shared_space_event" ("actorId");`.execute(db);
  await sql`CREATE INDEX "shared_space_event_targetUserId_idx" ON "shared_space_event" ("targetUserId");`.execute(db);
  await sql`CREATE INDEX "shared_space_event_activityId_idx" ON "shared_space_event" ("activityId");`.execute(db);
  await sql`CREATE INDEX "shared_space_event_albumId_createdAt_idx" ON "shared_space_event" ("albumId", "createdAt");`.execute(
    db,
  );

  await sql`CREATE TABLE "shared_space_mention" (
  "activityId" uuid NOT NULL,
  "userId" uuid NOT NULL,
  CONSTRAINT "shared_space_mention_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "activity" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "shared_space_mention_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "shared_space_mention_pkey" PRIMARY KEY ("activityId", "userId")
);`.execute(db);
  await sql`CREATE INDEX "shared_space_mention_activityId_idx" ON "shared_space_mention" ("activityId");`.execute(db);
  await sql`CREATE INDEX "shared_space_mention_userId_idx" ON "shared_space_mention" ("userId");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "shared_space_mention";`.execute(db);
  await sql`DROP TABLE "shared_space_event";`.execute(db);
}
