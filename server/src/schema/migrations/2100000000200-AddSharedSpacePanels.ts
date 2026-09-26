import { Kysely, sql } from 'kysely';

/**
 * The three things a shared space page adds (FL-55): albums linked into it,
 * people linked into it, and each member's own last-seen marker.
 *
 * All three are new tables. Nothing existing is altered and nothing is
 * backfilled, because all three are references: an album linked into a space
 * keeps its owner, its members and its place in its owner's tree; a person
 * linked into a space keeps their private name in their owner's library; and a
 * missing last-seen row simply means that member has not marked the space seen
 * yet. Dropping any of them loses only the references, never a photo, an album
 * or an identity.
 */
export async function up(db: Kysely<any>): Promise<void> {
  // NOTE: constraint and index names follow the generator's conventions so
  // `migrations:generate` produces no drift against the table classes:
  // `{table}_{column}_fkey`, `{table}_pkey`, `{table}_{columns}_uq`, and a
  // `{table}_{column}_idx` index for every foreign-key column (the generator
  // auto-creates those, including for columns that also form the primary key).
  await sql`CREATE TABLE "shared_space_album" (
  "albumId" uuid NOT NULL,
  "linkedAlbumId" uuid NOT NULL,
  "linkedById" uuid,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "shared_space_album_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "album" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "shared_space_album_linkedAlbumId_fkey" FOREIGN KEY ("linkedAlbumId") REFERENCES "album" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "shared_space_album_linkedById_fkey" FOREIGN KEY ("linkedById") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "shared_space_album_pkey" PRIMARY KEY ("albumId", "linkedAlbumId")
);`.execute(db);
  await sql`CREATE INDEX "shared_space_album_albumId_idx" ON "shared_space_album" ("albumId");`.execute(db);
  await sql`CREATE INDEX "shared_space_album_linkedAlbumId_idx" ON "shared_space_album" ("linkedAlbumId");`.execute(db);
  await sql`CREATE INDEX "shared_space_album_linkedById_idx" ON "shared_space_album" ("linkedById");`.execute(db);

  await sql`CREATE TABLE "shared_space_person" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "albumId" uuid NOT NULL,
  "personOwnerId" uuid NOT NULL,
  "personGroupId" uuid NOT NULL,
  "name" character varying NOT NULL DEFAULT '',
  "coverAssetId" uuid,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "shared_space_person_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "album" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "shared_space_person_personOwnerId_fkey" FOREIGN KEY ("personOwnerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "shared_space_person_personGroupId_fkey" FOREIGN KEY ("personGroupId") REFERENCES "person_group" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "shared_space_person_coverAssetId_fkey" FOREIGN KEY ("coverAssetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "shared_space_person_albumId_personOwnerId_personGroupId_uq" UNIQUE ("albumId", "personOwnerId", "personGroupId"),
  CONSTRAINT "shared_space_person_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "shared_space_person_albumId_idx" ON "shared_space_person" ("albumId");`.execute(db);
  await sql`CREATE INDEX "shared_space_person_personOwnerId_idx" ON "shared_space_person" ("personOwnerId");`.execute(
    db,
  );
  await sql`CREATE INDEX "shared_space_person_personGroupId_idx" ON "shared_space_person" ("personGroupId");`.execute(
    db,
  );
  await sql`CREATE INDEX "shared_space_person_coverAssetId_idx" ON "shared_space_person" ("coverAssetId");`.execute(db);

  await sql`CREATE TABLE "shared_space_visit" (
  "albumId" uuid NOT NULL,
  "userId" uuid NOT NULL,
  "lastSeenAt" timestamp with time zone NOT NULL,
  CONSTRAINT "shared_space_visit_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "album" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "shared_space_visit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "shared_space_visit_pkey" PRIMARY KEY ("albumId", "userId")
);`.execute(db);
  await sql`CREATE INDEX "shared_space_visit_albumId_idx" ON "shared_space_visit" ("albumId");`.execute(db);
  await sql`CREATE INDEX "shared_space_visit_userId_idx" ON "shared_space_visit" ("userId");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "shared_space_visit";`.execute(db);
  await sql`DROP TABLE "shared_space_person";`.execute(db);
  await sql`DROP TABLE "shared_space_album";`.execute(db);
}
