import { Kysely, sql } from 'kysely';
import { DB } from 'src/schema/index.js';

export async function assertICloudReferences(db: Kysely<DB>): Promise<void> {
  const result = await sql<{ invalid: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM immich_fork.icloud_connection connection
      WHERE NOT EXISTS (SELECT 1 FROM public.user owner WHERE owner.id = connection."ownerId")
        AND (state <> 'paused' OR "encryptedSession" IS NOT NULL OR "nextRunAt" IS NOT NULL OR "lastError" IS DISTINCT FROM 'owner_removed')
      UNION ALL
      SELECT 1 FROM immich_fork.icloud_resource resource
      WHERE ("assetId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.asset asset WHERE asset.id = resource."assetId" AND asset."ownerId" = resource."ownerId"
      )) OR (NOT EXISTS (SELECT 1 FROM public.user owner WHERE owner.id = resource."ownerId")
        AND ("leaseToken" IS NOT NULL OR "pendingJobs" <> '[]'::jsonb OR status NOT IN ('blocked', 'removed')))
      UNION ALL
      SELECT 1 FROM immich_fork.icloud_album album
      JOIN immich_fork.icloud_connection connection ON connection.id = album."connectionId"
      WHERE album."albumId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.album target JOIN public.album_user ownership ON ownership."albumId"=target.id
        WHERE target.id = album."albumId" AND ownership."userId" = connection."ownerId" AND ownership.role='owner'
      )
      UNION ALL
      SELECT 1 FROM immich_fork.icloud_membership membership
      JOIN immich_fork.icloud_connection connection ON connection.id = membership."connectionId"
      WHERE (membership."assetId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.asset asset WHERE asset.id = membership."assetId" AND asset."ownerId" = connection."ownerId"
      )) OR (membership."albumId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.album album JOIN public.album_user ownership ON ownership."albumId"=album.id
        WHERE album.id = membership."albumId" AND ownership."userId" = connection."ownerId" AND ownership.role='owner'
      ))
    ) AS invalid
  `.execute(db);
  if (result.rows[0]?.invalid) {
    throw new Error('Fork return activation found unresolved iCloud references');
  }
}

// Called only while return reconciliation holds the public and fork table locks.
export async function reconcileICloudReferences(db: Kysely<DB>): Promise<number> {
  await sql`
    UPDATE immich_fork.icloud_connection connection
    SET state = 'paused', "encryptedSession" = NULL, "nextRunAt" = NULL,
        "lastError" = 'owner_removed', "updatedAt" = now()
    WHERE NOT EXISTS (SELECT 1 FROM public.user owner WHERE owner.id = connection."ownerId")
  `.execute(db);

  await sql`
    UPDATE immich_fork.icloud_resource resource
    SET "leaseToken" = NULL, "leaseExpiresAt" = NULL, "reservedBytes" = 0,
        "pendingJobs" = '[]', "nextAttemptAt" = NULL, status = 'blocked',
        "lastError" = 'owner_removed', "updatedAt" = now()
    WHERE NOT EXISTS (SELECT 1 FROM public.user owner WHERE owner.id = resource."ownerId")
      AND status <> 'removed'
  `.execute(db);

  await sql`
    UPDATE immich_fork.icloud_run run SET status = 'cancelled', "finishedAt" = now()
    WHERE "finishedAt" IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.user owner WHERE owner.id = run."ownerId")
  `.execute(db);

  const resourceArchive = await sql<{ count: number }>`
    WITH missing AS (
      SELECT resource.* FROM immich_fork.icloud_resource resource
      WHERE "assetId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.asset asset WHERE asset.id = resource."assetId" AND asset."ownerId" = resource."ownerId"
      )
    ), archived AS (
      INSERT INTO immich_fork.orphaned_records ("sourceTable", "sourceKey", payload)
      SELECT 'icloud_resource_mapping', id::text, to_jsonb(missing) FROM missing
      ON CONFLICT ("sourceTable", "sourceKey") DO NOTHING RETURNING 1
    ), updated AS (
    UPDATE immich_fork.icloud_resource resource
    SET "assetId" = NULL, status = 'removed', "lastError" = 'asset_removed',
        "pendingJobs" = '[]', "leaseToken" = NULL, "leaseExpiresAt" = NULL,
        "reservedBytes" = 0, "nextAttemptAt" = NULL, "updatedAt" = now()
    WHERE id IN (SELECT id FROM missing) RETURNING 1
    ) SELECT count(*)::int AS count FROM archived
  `.execute(db);

  const albumArchive = await sql<{ count: number }>`
    WITH missing AS (
      SELECT album.* FROM immich_fork.icloud_album album
      JOIN immich_fork.icloud_connection connection ON connection.id = album."connectionId"
      WHERE album."albumId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.album target JOIN public.album_user ownership ON ownership."albumId"=target.id
        WHERE target.id = album."albumId" AND ownership."userId" = connection."ownerId" AND ownership.role='owner'
      )
    ), archived AS (
      INSERT INTO immich_fork.orphaned_records ("sourceTable", "sourceKey", payload)
      SELECT 'icloud_album_mapping', jsonb_build_array("connectionId", "libraryKey", "sourceId")::text, to_jsonb(missing)
      FROM missing ON CONFLICT ("sourceTable", "sourceKey") DO NOTHING RETURNING 1
    ), updated AS (
    UPDATE immich_fork.icloud_album album SET "albumId" = NULL,
      source=jsonb_set(album.source,'{_sync}',coalesce(album.source->'_sync','{}'::jsonb) || '{"suppressed":true}'::jsonb,true)
    FROM missing WHERE album."connectionId" = missing."connectionId"
      AND album."libraryKey" = missing."libraryKey" AND album."sourceId" = missing."sourceId" RETURNING 1
    ) SELECT count(*)::int AS count FROM archived
  `.execute(db);

  const membershipArchive = await sql<{ count: number }>`
    WITH missing AS (
      SELECT membership.* FROM immich_fork.icloud_membership membership
      JOIN immich_fork.icloud_connection connection ON connection.id = membership."connectionId"
      WHERE (membership."assetId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.asset asset WHERE asset.id = membership."assetId" AND asset."ownerId" = connection."ownerId"
      )) OR (membership."albumId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.album album JOIN public.album_user ownership ON ownership."albumId"=album.id
        WHERE album.id = membership."albumId" AND ownership."userId" = connection."ownerId" AND ownership.role='owner'
      ))
    ), archived AS (
      INSERT INTO immich_fork.orphaned_records ("sourceTable", "sourceKey", payload)
      SELECT 'icloud_membership_mapping', jsonb_build_array("connectionId", "libraryKey", "sourceAlbumId", "sourceAssetId")::text,
        to_jsonb(missing) FROM missing ON CONFLICT ("sourceTable", "sourceKey") DO NOTHING RETURNING 1
    ), updated AS (
    UPDATE immich_fork.icloud_membership membership
    SET "assetId" = NULL, "albumId" = NULL, "addedBySync" = false
    FROM missing WHERE membership."connectionId" = missing."connectionId"
      AND membership."libraryKey" = missing."libraryKey"
      AND membership."sourceAlbumId" = missing."sourceAlbumId"
      AND membership."sourceAssetId" = missing."sourceAssetId" RETURNING 1
    ) SELECT count(*)::int AS count FROM archived
  `.execute(db);
  return (
    (resourceArchive.rows[0]?.count ?? 0) + (albumArchive.rows[0]?.count ?? 0) + (membershipArchive.rows[0]?.count ?? 0)
  );
}
