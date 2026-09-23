import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // These tables carry the shared updated_at() trigger, which also stamps "updateId".
  await sql`ALTER TABLE "render_worker_limit" ADD "updateId" uuid NOT NULL DEFAULT immich_uuid_v7();`.execute(db);
  await sql`ALTER TABLE "studio_project_comment" ADD "updateId" uuid NOT NULL DEFAULT immich_uuid_v7();`.execute(db);
  await sql`ALTER TABLE "video_moment_index" ADD "updateId" uuid NOT NULL DEFAULT immich_uuid_v7();`.execute(db);
  await sql`ALTER TABLE "video_moment_frame" ADD "updateId" uuid NOT NULL DEFAULT immich_uuid_v7();`.execute(db);
  await sql`ALTER TABLE "video_moment" ADD "updateId" uuid NOT NULL DEFAULT immich_uuid_v7();`.execute(db);
  await sql`CREATE INDEX "media_operation_ownerId_idx" ON "media_operation" ("ownerId");`.execute(db);
  await sql`CREATE INDEX "media_operation_assetId_idx" ON "media_operation" ("assetId");`.execute(db);
  await sql`CREATE INDEX "media_operation_resultAssetId_idx" ON "media_operation" ("resultAssetId");`.execute(db);
  await sql`CREATE INDEX "media_operation_retryOfId_idx" ON "media_operation" ("retryOfId");`.execute(db);
  await sql`CREATE INDEX "media_operation_checkpoint_operationId_idx" ON "media_operation_checkpoint" ("operationId");`.execute(db);
  await sql`CREATE INDEX "ml_workload_accounting_destinationId_idx" ON "ml_workload_accounting" ("destinationId");`.execute(db);
  await sql`CREATE INDEX "render_worker_createdBy_idx" ON "render_worker" ("createdBy");`.execute(db);
  await sql`CREATE INDEX "render_worker_session_workerId_idx" ON "render_worker_session" ("workerId");`.execute(db);
  await sql`CREATE INDEX "render_worker_limit_userId_idx" ON "render_worker_limit" ("userId");`.execute(db);
  await sql`CREATE INDEX "memory_export_ownerId_idx" ON "memory_export" ("ownerId");`.execute(db);
  await sql`CREATE INDEX "memory_export_memoryId_idx" ON "memory_export" ("memoryId");`.execute(db);
  await sql`CREATE INDEX "studio_preview_frame_ownerId_idx" ON "studio_preview_frame" ("ownerId");`.execute(db);
  await sql`CREATE INDEX "studio_preview_frame_operationId_idx" ON "studio_preview_frame" ("operationId");`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_media_operation_updatedAt', '{"type":"trigger","name":"media_operation_updatedAt","sql":"CREATE OR REPLACE TRIGGER \\"media_operation_updatedAt\\"\\n  BEFORE UPDATE ON \\"media_operation\\"\\n  FOR EACH ROW\\n  EXECUTE FUNCTION updated_at();"}'::jsonb);`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_media_operation_checkpoint_updatedAt', '{"type":"trigger","name":"media_operation_checkpoint_updatedAt","sql":"CREATE OR REPLACE TRIGGER \\"media_operation_checkpoint_updatedAt\\"\\n  BEFORE UPDATE ON \\"media_operation_checkpoint\\"\\n  FOR EACH ROW\\n  EXECUTE FUNCTION updated_at();"}'::jsonb);`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_asset_restoration_updatedAt', '{"type":"trigger","name":"asset_restoration_updatedAt","sql":"CREATE OR REPLACE TRIGGER \\"asset_restoration_updatedAt\\"\\n  BEFORE UPDATE ON \\"asset_restoration\\"\\n  FOR EACH ROW\\n  EXECUTE FUNCTION updated_at();"}'::jsonb);`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('index_asset_restoration_assetId_isCurrent_uq', '{"type":"index","name":"asset_restoration_assetId_isCurrent_uq","sql":"CREATE UNIQUE INDEX \\"asset_restoration_assetId_isCurrent_uq\\" ON \\"asset_restoration\\" (\\"assetId\\") WHERE (\\"isCurrent\\");"}'::jsonb);`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_render_worker_updatedAt', '{"type":"trigger","name":"render_worker_updatedAt","sql":"CREATE OR REPLACE TRIGGER \\"render_worker_updatedAt\\"\\n  BEFORE UPDATE ON \\"render_worker\\"\\n  FOR EACH ROW\\n  EXECUTE FUNCTION updated_at();"}'::jsonb);`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_render_worker_limit_updatedAt', '{"type":"trigger","name":"render_worker_limit_updatedAt","sql":"CREATE OR REPLACE TRIGGER \\"render_worker_limit_updatedAt\\"\\n  BEFORE UPDATE ON \\"render_worker_limit\\"\\n  FOR EACH ROW\\n  EXECUTE FUNCTION updated_at();"}'::jsonb);`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_studio_preview_frame_updatedAt', '{"type":"trigger","name":"studio_preview_frame_updatedAt","sql":"CREATE OR REPLACE TRIGGER \\"studio_preview_frame_updatedAt\\"\\n  BEFORE UPDATE ON \\"studio_preview_frame\\"\\n  FOR EACH ROW\\n  EXECUTE FUNCTION updated_at();"}'::jsonb);`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_studio_project_updatedAt', '{"type":"trigger","name":"studio_project_updatedAt","sql":"CREATE OR REPLACE TRIGGER \\"studio_project_updatedAt\\"\\n  BEFORE UPDATE ON \\"studio_project\\"\\n  FOR EACH ROW\\n  EXECUTE FUNCTION updated_at();"}'::jsonb);`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_studio_project_comment_updatedAt', '{"type":"trigger","name":"studio_project_comment_updatedAt","sql":"CREATE OR REPLACE TRIGGER \\"studio_project_comment_updatedAt\\"\\n  BEFORE UPDATE ON \\"studio_project_comment\\"\\n  FOR EACH ROW\\n  EXECUTE FUNCTION updated_at();"}'::jsonb);`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_video_moment_index_updatedAt', '{"type":"trigger","name":"video_moment_index_updatedAt","sql":"CREATE OR REPLACE TRIGGER \\"video_moment_index_updatedAt\\"\\n  BEFORE UPDATE ON \\"video_moment_index\\"\\n  FOR EACH ROW\\n  EXECUTE FUNCTION updated_at();"}'::jsonb);`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_video_moment_frame_updatedAt', '{"type":"trigger","name":"video_moment_frame_updatedAt","sql":"CREATE OR REPLACE TRIGGER \\"video_moment_frame_updatedAt\\"\\n  BEFORE UPDATE ON \\"video_moment_frame\\"\\n  FOR EACH ROW\\n  EXECUTE FUNCTION updated_at();"}'::jsonb);`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_video_moment_updatedAt', '{"type":"trigger","name":"video_moment_updatedAt","sql":"CREATE OR REPLACE TRIGGER \\"video_moment_updatedAt\\"\\n  BEFORE UPDATE ON \\"video_moment\\"\\n  FOR EACH ROW\\n  EXECUTE FUNCTION updated_at();"}'::jsonb);`.execute(db);
  // asset_video_duplicate_frame is mirrored column for column by the fork v2 sidecar, so it keeps no
  // updateId: its trigger stamps only updatedAt, as the media health tables do (2100000000060).
  await sql`CREATE OR REPLACE TRIGGER "asset_video_duplicate_frame_updatedAt"
    BEFORE UPDATE ON "asset_video_duplicate_frame"
    FOR EACH ROW EXECUTE FUNCTION media_health_updated_at();`.execute(db);
  await sql`UPDATE "migration_overrides"
    SET "value" = jsonb_set("value", '{sql}', to_jsonb(replace("value"->>'sql', 'FUNCTION updated_at()', 'FUNCTION media_health_updated_at()')))
    WHERE "name" = 'trigger_asset_video_duplicate_frame_updatedAt';`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`CREATE OR REPLACE TRIGGER "asset_video_duplicate_frame_updatedAt"
    BEFORE UPDATE ON "asset_video_duplicate_frame"
    FOR EACH ROW EXECUTE FUNCTION updated_at();`.execute(db);
  await sql`UPDATE "migration_overrides"
    SET "value" = jsonb_set("value", '{sql}', to_jsonb(replace("value"->>'sql', 'FUNCTION media_health_updated_at()', 'FUNCTION updated_at()')))
    WHERE "name" = 'trigger_asset_video_duplicate_frame_updatedAt';`.execute(db);
  await sql`ALTER TABLE "render_worker_limit" DROP COLUMN "updateId";`.execute(db);
  await sql`ALTER TABLE "studio_project_comment" DROP COLUMN "updateId";`.execute(db);
  await sql`ALTER TABLE "video_moment_index" DROP COLUMN "updateId";`.execute(db);
  await sql`ALTER TABLE "video_moment_frame" DROP COLUMN "updateId";`.execute(db);
  await sql`ALTER TABLE "video_moment" DROP COLUMN "updateId";`.execute(db);
  await sql`DROP INDEX "memory_export_ownerId_idx";`.execute(db);
  await sql`DROP INDEX "memory_export_memoryId_idx";`.execute(db);
  await sql`DROP INDEX "ml_workload_accounting_destinationId_idx";`.execute(db);
  await sql`DROP INDEX "media_operation_checkpoint_operationId_idx";`.execute(db);
  await sql`DROP INDEX "render_worker_createdBy_idx";`.execute(db);
  await sql`DROP INDEX "render_worker_session_workerId_idx";`.execute(db);
  await sql`DROP INDEX "render_worker_limit_userId_idx";`.execute(db);
  await sql`DROP INDEX "studio_preview_frame_ownerId_idx";`.execute(db);
  await sql`DROP INDEX "studio_preview_frame_operationId_idx";`.execute(db);
  await sql`DROP INDEX "media_operation_ownerId_idx";`.execute(db);
  await sql`DROP INDEX "media_operation_assetId_idx";`.execute(db);
  await sql`DROP INDEX "media_operation_resultAssetId_idx";`.execute(db);
  await sql`DROP INDEX "media_operation_retryOfId_idx";`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_media_operation_updatedAt';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_media_operation_checkpoint_updatedAt';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_asset_restoration_updatedAt';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'index_asset_restoration_assetId_isCurrent_uq';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_render_worker_updatedAt';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_render_worker_limit_updatedAt';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_studio_preview_frame_updatedAt';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_studio_project_updatedAt';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_studio_project_comment_updatedAt';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_video_moment_index_updatedAt';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_video_moment_frame_updatedAt';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_video_moment_updatedAt';`.execute(db);
}
