import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "memory_export" (
    "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
    "ownerId" uuid NOT NULL,
    "memoryId" uuid NOT NULL,
    "format" character varying NOT NULL DEFAULT 'archive',
    "status" character varying NOT NULL DEFAULT 'pending',
    "title" character varying NOT NULL,
    "assetIds" jsonb NOT NULL,
    "assetCount" integer NOT NULL DEFAULT 0,
    "processedAssets" integer NOT NULL DEFAULT 0,
    "path" text,
    "sizeInBytes" bigint,
    "error" text,
    "cancelRequestedAt" timestamp with time zone,
    "startedAt" timestamp with time zone,
    "finishedAt" timestamp with time zone,
    "expiresAt" timestamp with time zone,
    "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
    "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "memory_export_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "memory_export_memoryId_fkey" FOREIGN KEY ("memoryId") REFERENCES "memory" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "memory_export_pkey" PRIMARY KEY ("id")
  );`.execute(db);

  await sql`CREATE INDEX "memory_export_ownerId_createdAt_idx" ON "memory_export" ("ownerId", "createdAt");`.execute(
    db,
  );
  await sql`CREATE INDEX "memory_export_status_idx" ON "memory_export" ("status");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS "memory_export_status_idx";`.execute(db);
  await sql`DROP INDEX IF EXISTS "memory_export_ownerId_createdAt_idx";`.execute(db);
  await sql`DROP TABLE IF EXISTS "memory_export";`.execute(db);
}
