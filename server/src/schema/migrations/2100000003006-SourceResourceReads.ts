import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql.raw(`CREATE TABLE "source_original" (
  "assetId" uuid NOT NULL,
  "resourceId" uuid NOT NULL,
  "scopeFingerprint" character varying NOT NULL,
  "authorizationEpoch" integer NOT NULL,
  CONSTRAINT "source_original_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "source_original_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "photo_source_resource" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "source_original_resourceId_uq" UNIQUE ("resourceId"),
  CONSTRAINT "source_original_epoch_check" CHECK ("authorizationEpoch" > 0),
  CONSTRAINT "source_original_pkey" PRIMARY KEY ("assetId")
);`).execute(db);
  await sql.raw(`CREATE TABLE "source_resource_read" (
  "id" uuid NOT NULL DEFAULT uuidv7(),
  "assetId" uuid NOT NULL,
  "resourceId" uuid NOT NULL,
  "sourceId" uuid NOT NULL,
  "ownerId" uuid NOT NULL,
  "deviceId" uuid NOT NULL,
  "scopeFingerprint" character varying NOT NULL,
  "authorizationEpoch" integer NOT NULL,
  "state" character varying NOT NULL DEFAULT 'pending',
  "claimFence" integer NOT NULL DEFAULT 0,
  "claimTokenHash" bytea,
  "claimCredentialHash" bytea,
  "leaseUntil" timestamp with time zone,
  "deadline" timestamp with time zone NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "source_resource_read_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "source_resource_read_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "photo_source_resource" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "source_resource_read_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "photo_source" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "source_resource_read_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "source_resource_read_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "desktop_device" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "source_resource_read_claim_check" CHECK (("claimTokenHash" IS NULL OR octet_length("claimTokenHash") = 32)
    AND ("claimCredentialHash" IS NULL OR octet_length("claimCredentialHash") = 32)
    AND (state NOT IN ('claimed','delivering') OR
      ("claimFence" > 0 AND "claimTokenHash" IS NOT NULL AND "claimCredentialHash" IS NOT NULL AND "leaseUntil" IS NOT NULL))),
  CONSTRAINT "source_resource_read_epoch_check" CHECK ("authorizationEpoch" > 0 AND "claimFence" >= 0),
  CONSTRAINT "source_resource_read_state_check" CHECK (state IN ('pending','claimed','delivering','ready','unavailable')),
  CONSTRAINT "source_resource_read_pkey" PRIMARY KEY ("id")
);`).execute(db);
  await sql.raw(`CREATE UNIQUE INDEX "source_resource_read_active_uq" ON "source_resource_read" ("assetId", "resourceId", "scopeFingerprint", "authorizationEpoch") WHERE (state IN ('pending', 'claimed', 'delivering'));`).execute(db);
  await sql.raw(`CREATE UNIQUE INDEX "source_resource_read_claimed_source_uq" ON "source_resource_read" ("sourceId") WHERE (state IN ('claimed', 'delivering'));`).execute(db);
  await sql.raw(`CREATE INDEX "source_resource_read_sourceId_state_createdAt_idx" ON "source_resource_read" ("sourceId", "state", "createdAt");`).execute(db);
  await sql.raw(`CREATE INDEX "source_resource_read_assetId_idx" ON "source_resource_read" ("assetId");`).execute(db);
  await sql.raw(`CREATE INDEX "source_resource_read_resourceId_idx" ON "source_resource_read" ("resourceId");`).execute(db);
  await sql.raw(`CREATE INDEX "source_resource_read_ownerId_idx" ON "source_resource_read" ("ownerId");`).execute(db);
  await sql.raw(`CREATE INDEX "source_resource_read_deviceId_idx" ON "source_resource_read" ("deviceId");`).execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('source_resource_read').execute();
  await db.schema.dropTable('source_original').execute();
}
