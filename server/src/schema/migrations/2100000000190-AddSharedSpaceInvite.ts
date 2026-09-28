import { Kysely, sql } from 'kysely';

/**
 * Pending invitations to a shared space (FL-55).
 *
 * A recipient must be able to see what a space exposes before joining it, so an
 * invitation is its own row and grants nothing: membership (`album_user`) is
 * created only on accept. Nothing existing is changed or backfilled — every
 * album, collection and space keeps the members it already has.
 */
export async function up(db: Kysely<any>): Promise<void> {
  // NOTE: constraint and index names follow the generator's conventions so
  // `migrations:generate` produces no drift against SharedSpaceInviteTable:
  // `{table}_{column}_fkey`, `{table}_pkey`, and a `{table}_{column}_idx` index
  // for every foreign-key column (the generator auto-creates FK indexes, including
  // for the columns that also form the primary key).
  await sql`CREATE TABLE "shared_space_invite" (
  "albumId" uuid NOT NULL,
  "userId" uuid NOT NULL,
  "role" "album_user_role_enum" NOT NULL DEFAULT 'editor',
  "invitedById" uuid,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "shared_space_invite_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "album" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "shared_space_invite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "shared_space_invite_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "shared_space_invite_pkey" PRIMARY KEY ("albumId", "userId")
);`.execute(db);
  await sql`CREATE INDEX "shared_space_invite_albumId_idx" ON "shared_space_invite" ("albumId");`.execute(db);
  await sql`CREATE INDEX "shared_space_invite_userId_idx" ON "shared_space_invite" ("userId");`.execute(db);
  await sql`CREATE INDEX "shared_space_invite_invitedById_idx" ON "shared_space_invite" ("invitedById");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "shared_space_invite";`.execute(db);
}
