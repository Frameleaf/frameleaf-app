import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE immich_fork.archive_operation (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "ownerId" uuid NOT NULL,
    "sessionId" uuid NOT NULL,
    "requestKey" uuid NOT NULL,
    scope text NOT NULL,
    "assetIds" uuid[] NOT NULL,
    cancelled boolean NOT NULL DEFAULT false,
    undo boolean NOT NULL DEFAULT false,
    "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE ("ownerId", "requestKey")
  )`.execute(db);
  await sql`CREATE TABLE immich_fork.archive_operation_item (
    "operationId" uuid NOT NULL REFERENCES immich_fork.archive_operation(id) ON DELETE CASCADE,
    "assetId" uuid NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','skipped','revoked','error','undone','conflict')),
    "previousVisibility" text,
    "publishedUpdateId" uuid,
    PRIMARY KEY ("operationId", "assetId")
  )`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE immich_fork.archive_operation_item`.execute(db);
  await sql`DROP TABLE immich_fork.archive_operation`.execute(db);
}
