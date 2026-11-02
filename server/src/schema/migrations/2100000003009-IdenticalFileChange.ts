import { Kysely, sql } from 'kysely';

/** FL-413: the identical-files journal (`IdenticalFileChangeTable`). */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "identical_file_change" (
    "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
    "runId" uuid NOT NULL,
    "kind" character varying NOT NULL,
    "assetId" uuid NOT NULL,
    "keptAssetId" uuid,
    "ownPath" character varying NOT NULL,
    "checksum" bytea NOT NULL,
    "sizeInBytes" bigint NOT NULL,
    "trashEntryId" uuid,
    "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
    "undoneAt" timestamp with time zone,
    CONSTRAINT "identical_file_change_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "identical_file_change_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id")
      ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "identical_file_change_keptAssetId_fkey" FOREIGN KEY ("keptAssetId") REFERENCES "asset" ("id")
      ON UPDATE CASCADE ON DELETE SET NULL
  )`.execute(db);
  await sql`CREATE INDEX "identical_file_change_assetId_idx" ON "identical_file_change" ("assetId")`.execute(db);
  await sql`CREATE INDEX "identical_file_change_runId_idx" ON "identical_file_change" ("runId")`.execute(db);
  await sql`CREATE INDEX "identical_file_change_keptAssetId_idx" ON "identical_file_change" ("keptAssetId")`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "identical_file_change"`.execute(db);
}
