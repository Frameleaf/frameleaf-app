import { Kysely, sql } from 'kysely';

/**
 * Preservation packages (FL-74, `IMP-006`).
 *
 * - `preservation_package`: one package the owner exported, uploaded or (an administrator) named by
 *   path, with its validated manifest summary and last verification.
 * - `preservation_item`: one original of a package; an export's per-item journal and the latest
 *   verification result for it.
 * - `preservation_restore`: one restoration of a package into its owner's library.
 * - `preservation_restore_item`: what the review found for one original, the owner's choices and
 *   what the restore did with it.
 *
 * The jobs themselves are `media_operation` rows of the four `preservation_*` kinds; `status` and
 * `kind` there are free text, so the new kinds need no change of their own.
 *
 * Additive only. Constraint and index names follow the generator's conventions
 * (`{table}_{column}_fkey`, `{table}_pkey`, `{table}_{columns}_uq`, a `{table}_{column}_idx` index for
 * every foreign-key column that no unique constraint already leads with) so `migrations:generate`
 * produces no drift against `src/schema/tables/preservation.table.ts`.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "preservation_package" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "ownerId" uuid NOT NULL,
  "origin" character varying NOT NULL,
  "name" character varying NOT NULL,
  "status" character varying NOT NULL DEFAULT 'building',
  "format" character varying NOT NULL,
  "path" character varying NOT NULL,
  "originalFileName" character varying,
  "sizeBytes" bigint,
  "digest" character varying,
  "includeLocked" boolean NOT NULL DEFAULT false,
  "includeMetadata" boolean NOT NULL DEFAULT true,
  "scope" jsonb,
  "manifest" jsonb,
  "verification" jsonb,
  "verifiedAt" timestamp with time zone,
  "expiresAt" timestamp with time zone,
  "removedAt" timestamp with time zone,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updateId" uuid NOT NULL DEFAULT immich_uuid_v7(),
  CONSTRAINT "preservation_package_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "preservation_package_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "preservation_package_ownerId_idx" ON "preservation_package" ("ownerId");`.execute(db);
  await sql`CREATE INDEX "preservation_package_ownerId_createdAt_idx" ON "preservation_package" ("ownerId", "createdAt");`.execute(
    db,
  );
  await sql`CREATE TRIGGER "preservation_package_updatedAt"
  BEFORE UPDATE ON "preservation_package"
  FOR EACH ROW
  EXECUTE FUNCTION updated_at();`.execute(db);

  await sql`CREATE TABLE "preservation_item" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "packageId" uuid NOT NULL,
  "sourceAssetId" uuid NOT NULL,
  "assetId" uuid,
  "state" character varying NOT NULL DEFAULT 'pending',
  "locked" boolean NOT NULL DEFAULT false,
  "entry" jsonb,
  "attempts" integer NOT NULL DEFAULT 0,
  "verifyState" character varying,
  "reasonKey" character varying,
  "error" text,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updateId" uuid NOT NULL DEFAULT immich_uuid_v7(),
  CONSTRAINT "preservation_item_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "preservation_package" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "preservation_item_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "preservation_item_packageId_sourceAssetId_uq" UNIQUE ("packageId", "sourceAssetId"),
  CONSTRAINT "preservation_item_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "preservation_item_assetId_idx" ON "preservation_item" ("assetId");`.execute(db);
  await sql`CREATE INDEX "preservation_item_packageId_state_idx" ON "preservation_item" ("packageId", "state");`.execute(
    db,
  );
  await sql`CREATE TRIGGER "preservation_item_updatedAt"
  BEFORE UPDATE ON "preservation_item"
  FOR EACH ROW
  EXECUTE FUNCTION updated_at();`.execute(db);

  await sql`CREATE TABLE "preservation_restore" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "ownerId" uuid NOT NULL,
  "packageId" uuid,
  "name" character varying NOT NULL,
  "status" character varying NOT NULL DEFAULT 'reviewing',
  "packageIdentity" character varying,
  "options" jsonb NOT NULL,
  "summary" jsonb,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updateId" uuid NOT NULL DEFAULT immich_uuid_v7(),
  CONSTRAINT "preservation_restore_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "preservation_restore_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "preservation_package" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "preservation_restore_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "preservation_restore_ownerId_idx" ON "preservation_restore" ("ownerId");`.execute(db);
  await sql`CREATE INDEX "preservation_restore_packageId_idx" ON "preservation_restore" ("packageId");`.execute(db);
  await sql`CREATE INDEX "preservation_restore_ownerId_createdAt_idx" ON "preservation_restore" ("ownerId", "createdAt");`.execute(
    db,
  );
  await sql`CREATE TRIGGER "preservation_restore_updatedAt"
  BEFORE UPDATE ON "preservation_restore"
  FOR EACH ROW
  EXECUTE FUNCTION updated_at();`.execute(db);

  await sql`CREATE TABLE "preservation_restore_item" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "restoreId" uuid NOT NULL,
  "sourceAssetId" uuid NOT NULL,
  "state" character varying NOT NULL DEFAULT 'ready',
  "match" character varying,
  "assetId" uuid,
  "locked" boolean NOT NULL DEFAULT false,
  "entry" jsonb,
  "sidecar" jsonb,
  "conflicts" jsonb,
  "decisions" jsonb,
  "findings" jsonb,
  "reasonKey" character varying,
  "error" text,
  "attempts" integer NOT NULL DEFAULT 0,
  "creatingAt" timestamp with time zone,
  "appliedAt" timestamp with time zone,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updateId" uuid NOT NULL DEFAULT immich_uuid_v7(),
  CONSTRAINT "preservation_restore_item_restoreId_fkey" FOREIGN KEY ("restoreId") REFERENCES "preservation_restore" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "preservation_restore_item_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "preservation_restore_item_restoreId_sourceAssetId_uq" UNIQUE ("restoreId", "sourceAssetId"),
  CONSTRAINT "preservation_restore_item_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "preservation_restore_item_assetId_idx" ON "preservation_restore_item" ("assetId");`.execute(
    db,
  );
  await sql`CREATE INDEX "preservation_restore_item_restoreId_state_idx" ON "preservation_restore_item" ("restoreId", "state");`.execute(
    db,
  );
  await sql`CREATE TRIGGER "preservation_restore_item_updatedAt"
  BEFORE UPDATE ON "preservation_restore_item"
  FOR EACH ROW
  EXECUTE FUNCTION updated_at();`.execute(db);

  // The schema tool records every updatedAt trigger it manages; without these rows it would
  // report the triggers as drift.
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_preservation_package_updatedAt', '{"type":"trigger","name":"preservation_package_updatedAt","sql":"CREATE OR REPLACE TRIGGER \\"preservation_package_updatedAt\\"\\n  BEFORE UPDATE ON \\"preservation_package\\"\\n  FOR EACH ROW\\n  EXECUTE FUNCTION updated_at();"}'::jsonb);`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_preservation_item_updatedAt', '{"type":"trigger","name":"preservation_item_updatedAt","sql":"CREATE OR REPLACE TRIGGER \\"preservation_item_updatedAt\\"\\n  BEFORE UPDATE ON \\"preservation_item\\"\\n  FOR EACH ROW\\n  EXECUTE FUNCTION updated_at();"}'::jsonb);`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_preservation_restore_updatedAt', '{"type":"trigger","name":"preservation_restore_updatedAt","sql":"CREATE OR REPLACE TRIGGER \\"preservation_restore_updatedAt\\"\\n  BEFORE UPDATE ON \\"preservation_restore\\"\\n  FOR EACH ROW\\n  EXECUTE FUNCTION updated_at();"}'::jsonb);`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_preservation_restore_item_updatedAt', '{"type":"trigger","name":"preservation_restore_item_updatedAt","sql":"CREATE OR REPLACE TRIGGER \\"preservation_restore_item_updatedAt\\"\\n  BEFORE UPDATE ON \\"preservation_restore_item\\"\\n  FOR EACH ROW\\n  EXECUTE FUNCTION updated_at();"}'::jsonb);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // Package files on disk are left alone: removing an owner's copies is never a schema operation.
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_preservation_package_updatedAt';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_preservation_item_updatedAt';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_preservation_restore_updatedAt';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_preservation_restore_item_updatedAt';`.execute(db);
  await sql`DROP TABLE IF EXISTS "preservation_restore_item";`.execute(db);
  await sql`DROP TABLE IF EXISTS "preservation_restore";`.execute(db);
  await sql`DROP TABLE IF EXISTS "preservation_item";`.execute(db);
  await sql`DROP TABLE IF EXISTS "preservation_package";`.execute(db);
  await sql`DELETE FROM "media_operation" WHERE "kind" LIKE 'preservation\\_%'`.execute(db);
}
