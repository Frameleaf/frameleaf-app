import { Kysely, sql } from 'kysely';

/** Durable pet changes extend the qualified session delivery ledger; model proposals stay excluded. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE session_tag_sync_state RENAME COLUMN "tagId" TO "entityId";`.execute(db);
  await sql`ALTER TABLE pet ADD COLUMN "updateId" uuid NOT NULL DEFAULT immich_uuid_v7();`.execute(db);
  await sql`CREATE INDEX "pet_updateId_idx" ON pet ("updateId");`.execute(db);
  await sql`ALTER TABLE pet_observation ADD COLUMN "updateId" uuid NOT NULL DEFAULT immich_uuid_v7();`.execute(db);
  await sql`CREATE INDEX "pet_observation_updateId_idx" ON pet_observation ("updateId");`.execute(db);
  await sql`CREATE TABLE pet_audit (id uuid PRIMARY KEY DEFAULT immich_uuid_v7(), "petId" uuid NOT NULL, "ownerId" uuid NOT NULL, "deletedAt" timestamp with time zone NOT NULL DEFAULT clock_timestamp());`.execute(
    db,
  );
  await sql`CREATE INDEX "pet_audit_petId_idx" ON pet_audit ("petId");`.execute(db);
  await sql`CREATE INDEX "pet_audit_ownerId_idx" ON pet_audit ("ownerId");`.execute(db);
  await sql`CREATE INDEX "pet_audit_deletedAt_idx" ON pet_audit ("deletedAt");`.execute(db);
  await sql`CREATE TABLE pet_observation_audit (id uuid PRIMARY KEY DEFAULT immich_uuid_v7(), "observationId" uuid NOT NULL, "petId" uuid NOT NULL, "assetId" uuid NOT NULL, "ownerId" uuid NOT NULL, "deletedAt" timestamp with time zone NOT NULL DEFAULT clock_timestamp());`.execute(
    db,
  );
  await sql`CREATE INDEX "pet_observation_audit_observationId_idx" ON pet_observation_audit ("observationId");`.execute(
    db,
  );
  await sql`CREATE INDEX "pet_observation_audit_petId_idx" ON pet_observation_audit ("petId");`.execute(db);
  await sql`CREATE INDEX "pet_observation_audit_assetId_idx" ON pet_observation_audit ("assetId");`.execute(db);
  await sql`CREATE INDEX "pet_observation_audit_ownerId_idx" ON pet_observation_audit ("ownerId");`.execute(db);
  await sql`CREATE INDEX "pet_observation_audit_deletedAt_idx" ON pet_observation_audit ("deletedAt");`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION pet_delete_audit()
  RETURNS trigger
  LANGUAGE PLPGSQL
  AS $$BEGIN INSERT INTO pet_audit ("petId", "ownerId") SELECT id, "ownerId" FROM OLD; RETURN NULL; END$$;`.execute(db);
  await db
    .insertInto('migration_overrides')
    .values({
      name: 'function_pet_delete_audit',
      value: {
        type: 'function',
        name: 'pet_delete_audit',
        sql: 'CREATE OR REPLACE FUNCTION pet_delete_audit()\n  RETURNS trigger\n  LANGUAGE PLPGSQL\n  AS $$BEGIN INSERT INTO pet_audit ("petId", "ownerId") SELECT id, "ownerId" FROM OLD; RETURN NULL; END$$;',
      },
    })
    .execute();
  await sql`CREATE OR REPLACE FUNCTION pet_observation_delete_audit()
  RETURNS trigger
  LANGUAGE PLPGSQL
  AS $$
    BEGIN
 INSERT INTO pet_observation_audit ("observationId", "petId", "assetId", "ownerId")
 SELECT deleted.id, deleted."petId", deleted."assetId", coalesce(pet."ownerId", asset."ownerId")
 FROM OLD AS deleted LEFT JOIN pet ON pet.id = deleted."petId" LEFT JOIN asset ON asset.id = deleted."assetId"
 WHERE coalesce(pet."ownerId", asset."ownerId") IS NOT NULL
 AND (pet."ownerId" IS NULL OR asset."ownerId" IS NULL OR pet."ownerId" = asset."ownerId");
 RETURN NULL; END
  $$;`.execute(db);
  await db
    .insertInto('migration_overrides')
    .values({
      name: 'function_pet_observation_delete_audit',
      value: {
        type: 'function',
        name: 'pet_observation_delete_audit',
        sql: 'CREATE OR REPLACE FUNCTION pet_observation_delete_audit()\n  RETURNS trigger\n  LANGUAGE PLPGSQL\n  AS $$\n    BEGIN\n INSERT INTO pet_observation_audit ("observationId", "petId", "assetId", "ownerId")\n SELECT deleted.id, deleted."petId", deleted."assetId", coalesce(pet."ownerId", asset."ownerId")\n FROM OLD AS deleted LEFT JOIN pet ON pet.id = deleted."petId" LEFT JOIN asset ON asset.id = deleted."assetId"\n WHERE coalesce(pet."ownerId", asset."ownerId") IS NOT NULL\n AND (pet."ownerId" IS NULL OR asset."ownerId" IS NULL OR pet."ownerId" = asset."ownerId");\n RETURN NULL; END\n  $$;',
      },
    })
    .execute();
  await sql`CREATE OR REPLACE FUNCTION pet_update_id()
  RETURNS trigger
  LANGUAGE PLPGSQL
  AS $$BEGIN NEW."updateId" := immich_uuid_v7(); RETURN NEW; END$$;`.execute(db);
  await db
    .insertInto('migration_overrides')
    .values({
      name: 'function_pet_update_id',
      value: {
        type: 'function',
        name: 'pet_update_id',
        sql: 'CREATE OR REPLACE FUNCTION pet_update_id()\n  RETURNS trigger\n  LANGUAGE PLPGSQL\n  AS $$BEGIN NEW."updateId" := immich_uuid_v7(); RETURN NEW; END$$;',
      },
    })
    .execute();
  await sql`CREATE OR REPLACE FUNCTION pet_observation_update_id()
  RETURNS trigger
  LANGUAGE PLPGSQL
  AS $$BEGIN NEW."updateId" := immich_uuid_v7(); RETURN NEW; END$$;`.execute(db);
  await db
    .insertInto('migration_overrides')
    .values({
      name: 'function_pet_observation_update_id',
      value: {
        type: 'function',
        name: 'pet_observation_update_id',
        sql: 'CREATE OR REPLACE FUNCTION pet_observation_update_id()\n  RETURNS trigger\n  LANGUAGE PLPGSQL\n  AS $$BEGIN NEW."updateId" := immich_uuid_v7(); RETURN NEW; END$$;',
      },
    })
    .execute();
  await sql`CREATE OR REPLACE TRIGGER "pet_update_id"
  BEFORE UPDATE ON "pet"
  FOR EACH ROW
  EXECUTE FUNCTION pet_update_id();`.execute(db);
  await db
    .insertInto('migration_overrides')
    .values({
      name: 'trigger_pet_update_id',
      value: {
        type: 'trigger',
        name: 'pet_update_id',
        sql: 'CREATE OR REPLACE TRIGGER "pet_update_id"\n  BEFORE UPDATE ON "pet"\n  FOR EACH ROW\n  EXECUTE FUNCTION pet_update_id();',
      },
    })
    .execute();
  await sql`CREATE OR REPLACE TRIGGER "pet_delete_audit"
  AFTER DELETE ON "pet"
  REFERENCING OLD TABLE AS "old"
  FOR EACH STATEMENT
  EXECUTE FUNCTION pet_delete_audit();`.execute(db);
  await db
    .insertInto('migration_overrides')
    .values({
      name: 'trigger_pet_delete_audit',
      value: {
        type: 'trigger',
        name: 'pet_delete_audit',
        sql: 'CREATE OR REPLACE TRIGGER "pet_delete_audit"\n  AFTER DELETE ON "pet"\n  REFERENCING OLD TABLE AS "old"\n  FOR EACH STATEMENT\n  EXECUTE FUNCTION pet_delete_audit();',
      },
    })
    .execute();
  await sql`CREATE OR REPLACE TRIGGER "pet_observation_update_id"
  BEFORE UPDATE ON "pet_observation"
  FOR EACH ROW
  EXECUTE FUNCTION pet_observation_update_id();`.execute(db);
  await db
    .insertInto('migration_overrides')
    .values({
      name: 'trigger_pet_observation_update_id',
      value: {
        type: 'trigger',
        name: 'pet_observation_update_id',
        sql: 'CREATE OR REPLACE TRIGGER "pet_observation_update_id"\n  BEFORE UPDATE ON "pet_observation"\n  FOR EACH ROW\n  EXECUTE FUNCTION pet_observation_update_id();',
      },
    })
    .execute();
  await sql`CREATE OR REPLACE TRIGGER "pet_observation_delete_audit"
  AFTER DELETE ON "pet_observation"
  REFERENCING OLD TABLE AS "old"
  FOR EACH STATEMENT
  EXECUTE FUNCTION pet_observation_delete_audit();`.execute(db);
  await db
    .insertInto('migration_overrides')
    .values({
      name: 'trigger_pet_observation_delete_audit',
      value: {
        type: 'trigger',
        name: 'pet_observation_delete_audit',
        sql: 'CREATE OR REPLACE TRIGGER "pet_observation_delete_audit"\n  AFTER DELETE ON "pet_observation"\n  REFERENCING OLD TABLE AS "old"\n  FOR EACH STATEMENT\n  EXECUTE FUNCTION pet_observation_delete_audit();',
      },
    })
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db
    .deleteFrom('migration_overrides')
    .where('name', 'in', [
      'function_pet_delete_audit',
      'function_pet_observation_delete_audit',
      'function_pet_update_id',
      'function_pet_observation_update_id',
      'trigger_pet_update_id',
      'trigger_pet_delete_audit',
      'trigger_pet_observation_update_id',
      'trigger_pet_observation_delete_audit',
    ])
    .execute();
  await sql`DROP TRIGGER pet_delete_audit ON pet; DROP TRIGGER pet_update_id ON pet;`.execute(db);
  await sql`DROP TRIGGER pet_observation_delete_audit ON pet_observation; DROP TRIGGER pet_observation_update_id ON pet_observation;`.execute(
    db,
  );
  await sql`DROP FUNCTION pet_delete_audit();`.execute(db);
  await sql`DROP FUNCTION pet_observation_delete_audit();`.execute(db);
  await sql`DROP FUNCTION pet_update_id();`.execute(db);
  await sql`DROP FUNCTION pet_observation_update_id();`.execute(db);
  await sql`DROP TABLE pet_observation_audit; DROP TABLE pet_audit;`.execute(db);
  await sql`ALTER TABLE pet DROP COLUMN "updateId";`.execute(db);
  await sql`ALTER TABLE pet_observation DROP COLUMN "updateId";`.execute(db);
  await sql`ALTER TABLE session_tag_sync_state RENAME COLUMN "entityId" TO "tagId";`.execute(db);
}
