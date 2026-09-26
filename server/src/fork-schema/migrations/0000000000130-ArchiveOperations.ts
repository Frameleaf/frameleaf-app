import { Kysely, sql } from 'kysely';

/**
 * Transactional archive operations (FL-32), ported from PR #133's `0000000000110-ArchiveOperations`
 * and `0000000000120-ArchivePreparation`, which were never deployed and are merged here.
 *
 * An operation freezes the exact set of assets an archive covers before anything changes: an
 * explicit selection, or every matching asset of the owner's normal Timeline counted in one SQL
 * statement and held `prepared` until the owner confirms that count. The durable bulk job
 * (`media_operation`, kind `bulk`) does the work; each item records the visibility it had and the
 * `updateId` the archive published, so Undo restores only items nothing has changed since.
 *
 * Fork-owned, so it lives in `immich_fork` and does not foreign-key into the official schema (the
 * job ids point at `public.media_operation` without a constraint, like `asset_develop_revision`).
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE immich_fork.archive_operation (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "ownerId" uuid NOT NULL,
      "sessionId" uuid,
      "requestKey" uuid NOT NULL,
      scope text NOT NULL CHECK (scope = ANY (ARRAY['selected-owned-assets'::text, 'matching-owned-timeline'::text])),
      descriptor jsonb,
      prepared boolean NOT NULL DEFAULT false,
      "preparedElevated" boolean NOT NULL DEFAULT false,
      "expiresAt" timestamptz,
      "archiveJobId" uuid,
      "undoJobId" uuid,
      "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
      UNIQUE ("ownerId", "requestKey")
    )
  `.execute(db);
  await sql`CREATE INDEX archive_operation_owner_created_idx ON immich_fork.archive_operation ("ownerId", "createdAt" DESC)`.execute(
    db,
  );
  await sql`
    CREATE TABLE immich_fork.archive_operation_item (
      "operationId" uuid NOT NULL REFERENCES immich_fork.archive_operation(id) ON DELETE CASCADE,
      "assetId" uuid NOT NULL,
      ordinal integer NOT NULL,
      status text NOT NULL DEFAULT 'pending'
        CHECK (status = ANY (ARRAY['pending'::text, 'archived'::text, 'skipped'::text, 'undone'::text, 'conflict'::text])),
      "previousVisibility" text,
      "publishedUpdateId" uuid,
      PRIMARY KEY ("operationId", "assetId")
    )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE immich_fork.archive_operation_item`.execute(db);
  await sql`DROP TABLE immich_fork.archive_operation`.execute(db);
}
