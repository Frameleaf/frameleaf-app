import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE immich_fork.archive_operation
    ADD COLUMN prepared boolean NOT NULL DEFAULT false,
    ADD COLUMN descriptor jsonb,
    ADD COLUMN "preparedElevated" boolean NOT NULL DEFAULT false,
    ADD COLUMN "expiresAt" timestamptz`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // Unconfirmed selections must never become runnable under the older application.
  await sql`DELETE FROM immich_fork.archive_operation WHERE prepared`.execute(db);
  // Restore the older receipt count representation for confirmed matching operations.
  await sql`UPDATE immich_fork.archive_operation o SET "assetIds"=ARRAY(
    SELECT i."assetId" FROM immich_fork.archive_operation_item i WHERE i."operationId"=o.id ORDER BY i."assetId")
    WHERE scope='matching-owned-timeline'`.execute(db);
  await sql`ALTER TABLE immich_fork.archive_operation
    DROP COLUMN prepared, DROP COLUMN descriptor, DROP COLUMN "preparedElevated", DROP COLUMN "expiresAt"`.execute(db);
}
