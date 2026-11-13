import { Kysely, sql } from 'kysely';

/** FL-1532: files found on the drive that no library lists, each read once, and what became of them. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "found_file" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "path" text NOT NULL,
  "sizeInBytes" bigint NOT NULL,
  "modifiedAt" timestamp with time zone NOT NULL,
  "sha1" bytea,
  "sha256" bytea,
  "outcome" text NOT NULL,
  "reason" text,
  "ownerId" uuid,
  "assetId" uuid,
  "previousPath" text,
  "steps" jsonb NOT NULL DEFAULT '[]',
  "sortedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "found_file_path_uq" UNIQUE ("path"),
  CONSTRAINT "found_file_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "found_file_outcome_idx" ON "found_file" ("outcome", "sortedAt", "id");`.execute(db);
  await sql`CREATE INDEX "found_file_owner_idx" ON "found_file" ("ownerId", "outcome");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "found_file";`.execute(db);
}
