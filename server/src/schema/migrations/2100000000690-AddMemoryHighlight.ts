import { Kysely, sql } from 'kysely';

/** FL-194: a memory's highlight video renders as a Studio export of a project made for it. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "memory_export" ADD "settings" jsonb;`.execute(db);
  await sql`ALTER TABLE "memory_export" ADD "studioProjectId" uuid;`.execute(db);
  await sql`ALTER TABLE "memory_export" ADD "studioExportVersionId" uuid;`.execute(db);
  await sql`CREATE INDEX "memory_export_studioProjectId_idx" ON "memory_export" ("studioProjectId");`.execute(db);
  await sql`CREATE INDEX "memory_export_studioExportVersionId_idx" ON "memory_export" ("studioExportVersionId");`.execute(
    db,
  );
  await sql`ALTER TABLE "memory_export" ADD CONSTRAINT "memory_export_studioProjectId_fkey" FOREIGN KEY ("studioProjectId") REFERENCES "studio_project" ("id") ON UPDATE CASCADE ON DELETE SET NULL;`.execute(
    db,
  );
  await sql`ALTER TABLE "memory_export" ADD CONSTRAINT "memory_export_studioExportVersionId_fkey" FOREIGN KEY ("studioExportVersionId") REFERENCES "studio_export_version" ("id") ON UPDATE CASCADE ON DELETE SET NULL;`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "memory_export" DROP CONSTRAINT IF EXISTS "memory_export_studioExportVersionId_fkey";`.execute(
    db,
  );
  await sql`ALTER TABLE "memory_export" DROP CONSTRAINT IF EXISTS "memory_export_studioProjectId_fkey";`.execute(db);
  await sql`DROP INDEX IF EXISTS "memory_export_studioExportVersionId_idx";`.execute(db);
  await sql`DROP INDEX IF EXISTS "memory_export_studioProjectId_idx";`.execute(db);
  await sql`ALTER TABLE "memory_export" DROP COLUMN IF EXISTS "studioExportVersionId";`.execute(db);
  await sql`ALTER TABLE "memory_export" DROP COLUMN IF EXISTS "studioProjectId";`.execute(db);
  await sql`ALTER TABLE "memory_export" DROP COLUMN IF EXISTS "settings";`.execute(db);
}
