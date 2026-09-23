import { Kysely, sql } from 'kysely';

/**
 * Threaded replies in shared space comments (FL-55).
 *
 * A reply is an ordinary `activity` comment plus one row here naming the
 * top-level comment it answers. The upstream `activity` table is not altered,
 * so an upstream merge never conflicts with this. Nothing is backfilled: every
 * existing comment has no row and stays a top-level comment.
 *
 * Dropping the table loses only which comment answered which; every comment
 * stays, shown as a top-level comment.
 */
export async function up(db: Kysely<any>): Promise<void> {
  // NOTE: constraint and index names follow the generator's conventions so
  // `migrations:generate` produces no drift against SharedSpaceCommentThreadTable:
  // `{table}_{column}_fkey`, `{table}_pkey`, and a `{table}_{column}_idx` index for
  // every foreign-key column except `activityId`, which is the table's only
  // primary-key column and so gets no separate index from the generator.
  await sql`CREATE TABLE "shared_space_comment_thread" (
  "activityId" uuid NOT NULL,
  "parentActivityId" uuid NOT NULL,
  "albumId" uuid NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "shared_space_comment_thread_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "activity" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "shared_space_comment_thread_parentActivityId_fkey" FOREIGN KEY ("parentActivityId") REFERENCES "activity" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "shared_space_comment_thread_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "album" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "shared_space_comment_thread_pkey" PRIMARY KEY ("activityId")
);`.execute(db);
  await sql`CREATE INDEX "shared_space_comment_thread_parentActivityId_idx" ON "shared_space_comment_thread" ("parentActivityId");`.execute(
    db,
  );
  await sql`CREATE INDEX "shared_space_comment_thread_albumId_idx" ON "shared_space_comment_thread" ("albumId");`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "shared_space_comment_thread";`.execute(db);
}
