import { Kysely, sql } from 'kysely';

/** FL231 additive tag event facts and session-local delivery progression. No target-key cascading FK. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE tag_asset ADD COLUMN "updateId" uuid NOT NULL DEFAULT immich_uuid_v7();`.execute(db);
  await sql`CREATE INDEX "tag_asset_updateId_idx" ON tag_asset ("updateId");`.execute(db);
  await sql`CREATE TABLE tag_audit (
    id uuid PRIMARY KEY DEFAULT immich_uuid_v7(), "tagId" uuid NOT NULL, "userId" uuid NOT NULL,
    "deletedAt" timestamp with time zone NOT NULL DEFAULT clock_timestamp()
  );`.execute(db);
  await sql`CREATE TABLE tag_asset_audit (
    id uuid PRIMARY KEY DEFAULT immich_uuid_v7(), "tagId" uuid NOT NULL, "assetId" uuid NOT NULL, "userId" uuid NOT NULL,
    "deletedAt" timestamp with time zone NOT NULL DEFAULT clock_timestamp()
  );`.execute(db);
  for (const [table, columns] of [
    ['tag_audit', ['tagId', 'userId', 'deletedAt']],
    ['tag_asset_audit', ['tagId', 'assetId', 'userId', 'deletedAt']],
  ] as const) {
    for (const column of columns) {
      await sql`CREATE INDEX ${sql.id(`${table}_${column}_idx`)} ON ${sql.id(table)} (${sql.id(column)});`.execute(db);
    }
  }
  await sql`CREATE TABLE session_tag_sync_state (
    "sessionId" uuid NOT NULL REFERENCES session(id) ON DELETE CASCADE ON UPDATE CASCADE,
    kind character varying NOT NULL, key character varying NOT NULL, "tagId" uuid NOT NULL, "assetId" uuid,
    "sourceId" uuid NOT NULL, "eventId" uuid NOT NULL DEFAULT immich_uuid_v7(), action text NOT NULL,
    delivered boolean NOT NULL DEFAULT false, acknowledged boolean NOT NULL DEFAULT false,
    "potentiallyVisible" boolean NOT NULL DEFAULT false, "confirmedVisible" boolean NOT NULL DEFAULT false,
    PRIMARY KEY ("sessionId", kind, key)
  );`.execute(db);
  await sql`CREATE INDEX "session_tag_sync_state_eventId_idx" ON session_tag_sync_state ("eventId");`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION tag_delete_audit()
  RETURNS TRIGGER
  LANGUAGE PLPGSQL
  AS $$BEGIN INSERT INTO tag_audit ("tagId", "userId") SELECT id, "userId" FROM OLD; RETURN NULL; END$$;`.execute(db);
  await db
    .insertInto('migration_overrides')
    .values({
      name: 'function_tag_delete_audit',
      value: {
        type: 'function',
        name: 'tag_delete_audit',
        sql: 'CREATE OR REPLACE FUNCTION tag_delete_audit()\n  RETURNS TRIGGER\n  LANGUAGE PLPGSQL\n  AS $$BEGIN INSERT INTO tag_audit ("tagId", "userId") SELECT id, "userId" FROM OLD; RETURN NULL; END$$;',
      },
    })
    .execute();
  await sql`CREATE OR REPLACE FUNCTION tag_asset_delete_audit()
  RETURNS TRIGGER
  LANGUAGE PLPGSQL
  AS $$
    BEGIN
    INSERT INTO tag_asset_audit ("tagId", "assetId", "userId")
    SELECT deleted."tagId", deleted."assetId", coalesce(tag."userId", asset."ownerId")
    FROM OLD AS deleted LEFT JOIN tag ON tag.id = deleted."tagId" LEFT JOIN asset ON asset.id = deleted."assetId"
    WHERE coalesce(tag."userId", asset."ownerId") IS NOT NULL
      AND (tag."userId" IS NULL OR asset."ownerId" IS NULL OR tag."userId" = asset."ownerId");
    RETURN NULL; END
  $$;`.execute(db);
  await db
    .insertInto('migration_overrides')
    .values({
      name: 'function_tag_asset_delete_audit',
      value: {
        type: 'function',
        name: 'tag_asset_delete_audit',
        sql: 'CREATE OR REPLACE FUNCTION tag_asset_delete_audit()\n  RETURNS TRIGGER\n  LANGUAGE PLPGSQL\n  AS $$\n    BEGIN\n    INSERT INTO tag_asset_audit ("tagId", "assetId", "userId")\n    SELECT deleted."tagId", deleted."assetId", coalesce(tag."userId", asset."ownerId")\n    FROM OLD AS deleted LEFT JOIN tag ON tag.id = deleted."tagId" LEFT JOIN asset ON asset.id = deleted."assetId"\n    WHERE coalesce(tag."userId", asset."ownerId") IS NOT NULL\n      AND (tag."userId" IS NULL OR asset."ownerId" IS NULL OR tag."userId" = asset."ownerId");\n    RETURN NULL; END\n  $$;',
      },
    })
    .execute();
  await sql`CREATE OR REPLACE FUNCTION tag_asset_update_id()
  RETURNS TRIGGER
  LANGUAGE PLPGSQL
  AS $$BEGIN NEW."updateId" := immich_uuid_v7(); RETURN NEW; END$$;`.execute(db);
  await db
    .insertInto('migration_overrides')
    .values({
      name: 'function_tag_asset_update_id',
      value: {
        type: 'function',
        name: 'tag_asset_update_id',
        sql: 'CREATE OR REPLACE FUNCTION tag_asset_update_id()\n  RETURNS TRIGGER\n  LANGUAGE PLPGSQL\n  AS $$BEGIN NEW."updateId" := immich_uuid_v7(); RETURN NEW; END$$;',
      },
    })
    .execute();
  await sql`CREATE OR REPLACE TRIGGER "tag_delete_audit"
  AFTER DELETE ON "tag"
  REFERENCING OLD TABLE AS "old"
  FOR EACH STATEMENT
  EXECUTE FUNCTION tag_delete_audit();`.execute(db);
  await db
    .insertInto('migration_overrides')
    .values({
      name: 'trigger_tag_delete_audit',
      value: {
        type: 'trigger',
        name: 'tag_delete_audit',
        sql: 'CREATE OR REPLACE TRIGGER "tag_delete_audit"\n  AFTER DELETE ON "tag"\n  REFERENCING OLD TABLE AS "old"\n  FOR EACH STATEMENT\n  EXECUTE FUNCTION tag_delete_audit();',
      },
    })
    .execute();
  await sql`CREATE OR REPLACE TRIGGER "tag_asset_update_id"
  BEFORE UPDATE ON "tag_asset"
  FOR EACH ROW
  EXECUTE FUNCTION tag_asset_update_id();`.execute(db);
  await db
    .insertInto('migration_overrides')
    .values({
      name: 'trigger_tag_asset_update_id',
      value: {
        type: 'trigger',
        name: 'tag_asset_update_id',
        sql: 'CREATE OR REPLACE TRIGGER "tag_asset_update_id"\n  BEFORE UPDATE ON "tag_asset"\n  FOR EACH ROW\n  EXECUTE FUNCTION tag_asset_update_id();',
      },
    })
    .execute();
  await sql`CREATE OR REPLACE TRIGGER "tag_asset_delete_audit"
  AFTER DELETE ON "tag_asset"
  REFERENCING OLD TABLE AS "old"
  FOR EACH STATEMENT
  EXECUTE FUNCTION tag_asset_delete_audit();`.execute(db);
  await db
    .insertInto('migration_overrides')
    .values({
      name: 'trigger_tag_asset_delete_audit',
      value: {
        type: 'trigger',
        name: 'tag_asset_delete_audit',
        sql: 'CREATE OR REPLACE TRIGGER "tag_asset_delete_audit"\n  AFTER DELETE ON "tag_asset"\n  REFERENCING OLD TABLE AS "old"\n  FOR EACH STATEMENT\n  EXECUTE FUNCTION tag_asset_delete_audit();',
      },
    })
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db
    .deleteFrom('migration_overrides')
    .where('name', 'in', [
      'function_tag_delete_audit',
      'function_tag_asset_delete_audit',
      'function_tag_asset_update_id',
      'trigger_tag_delete_audit',
      'trigger_tag_asset_update_id',
      'trigger_tag_asset_delete_audit',
    ])
    .execute();
  await sql`DROP TRIGGER tag_asset_update_id ON tag_asset; DROP TRIGGER tag_asset_delete_audit ON tag_asset; DROP TRIGGER tag_delete_audit ON tag;`.execute(
    db,
  );
  await sql`DROP FUNCTION tag_asset_update_id(); DROP FUNCTION tag_asset_delete_audit(); DROP FUNCTION tag_delete_audit();`.execute(
    db,
  );
  await sql`DROP TABLE session_tag_sync_state; DROP TABLE tag_asset_audit; DROP TABLE tag_audit;`.execute(db);
  await sql`ALTER TABLE tag_asset DROP COLUMN "updateId";`.execute(db);
}
