import { Kysely, sql } from 'kysely';

/**
 * One Locked state (owner decision, September 22, 2026, FL-34).
 *
 * Locked is a per-asset lock record, `asset_lock`: metadata, never a relocation. A locked asset keeps
 * its albums, favourites, tags, faces and stack and is hidden from every read except its owner's
 * elevated (PIN-unlocked) session, where the Locked view lists it. The upstream Locked folder
 * (`visibility = locked`) is no longer used as a state, and the fork's separate sensitive projection
 * (`asset.is_nsfw`, migration 2100000000010) no longer hides anything by itself. Both become lock
 * records here, so nothing that was private becomes visible and nothing disappears:
 *
 * 1. Every asset in the old Locked folder gets a lock with reason `immich-locked-folder` and
 *    `previousVisibility = 'locked'`, and its stored visibility becomes `timeline` (`hidden` for the
 *    video part of a live photo, which never shows on its own). Upstream moves an asset out of the
 *    folder to `timeline` too, so this is where "Unlock" would have put it.
 * 2. Every asset the owner marked sensitive (a manual review with `isNsfw = true`) gets a lock with
 *    reason `marked`.
 * 3. Every other asset the fork counts as sensitive gets a lock with reason `detected`, but only when
 *    the administrator had "hide sensitive detections from the library" switched on in the saved
 *    configuration: with it off, detections were never hidden, and locking them now would take them
 *    out of the timeline. The same switch decides whether new detections lock from now on.
 *    In the fork's `active` phase the privacy sidecar (`immich_fork.asset_privacy`) is the source;
 *    otherwise `asset.is_nsfw` and the review in `asset_metadata`. Only positive evidence counts: an
 *    asset with no privacy row is not locked here.
 * 4. Stacks and live photos lock as a whole: every other member of a stack with a locked member, and
 *    the video part of a locked live photo, get a lock with the same reason.
 * 5. A locked asset is never a cover, featured photo or face thumbnail (FL-53): the references the
 *    new locks hold are released exactly as migration 2100000000300 released them for the old folder.
 *
 * Idempotent: the table is created only when missing, every insert skips an asset that already has a
 * lock, and the visibility rewrite only touches rows still stored as `locked`. On a fresh upgrade from
 * Immich, steps 2 and 3 find nothing and step 1 carries the Locked folder over.
 *
 * `down` puts every locked asset back into the upstream Locked folder before dropping the table, so a
 * database taken back to a release without lock records hides the same assets it hid here.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS "asset_lock" (
  "assetId" uuid NOT NULL,
  "reason" character varying NOT NULL,
  "lockedAt" timestamp with time zone NOT NULL DEFAULT now(),
  "lockedBy" uuid,
  "previousVisibility" asset_visibility_enum,
  CONSTRAINT "asset_lock_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "asset_lock_lockedBy_fkey" FOREIGN KEY ("lockedBy") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "asset_lock_pkey" PRIMARY KEY ("assetId")
);`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS "asset_lock_lockedBy_idx" ON "asset_lock" ("lockedBy");`.execute(db);

  // 1. The old Locked folder.
  await sql`
    INSERT INTO "asset_lock" ("assetId", "reason", "lockedAt", "previousVisibility")
    SELECT "asset"."id", 'immich-locked-folder', "asset"."updatedAt", 'locked'
    FROM "asset"
    WHERE "asset"."visibility" = 'locked'
    ON CONFLICT ("assetId") DO NOTHING
  `.execute(db);
  await sql`
    UPDATE "asset"
    SET "visibility" = CASE
      WHEN EXISTS (SELECT 1 FROM "asset" AS "still" WHERE "still"."livePhotoVideoId" = "asset"."id") THEN 'hidden'
      ELSE 'timeline'
    END::asset_visibility_enum
    WHERE "asset"."visibility" = 'locked'
  `.execute(db);

  // 2 and 3. Sensitive marks and detections.
  const lockDetections = await isDetectionHidingEnabled(db);
  if (await isPrivacySidecarAuthoritative(db)) {
    await sql`
      INSERT INTO "asset_lock" ("assetId", "reason", "lockedAt")
      SELECT "privacy"."assetId", 'marked', coalesce("privacy"."updatedAt", now())
      FROM immich_fork.asset_privacy AS "privacy"
      WHERE "privacy"."isNsfw" = true
        AND "privacy".suppression ->> 'isNsfw' = 'true'
      ON CONFLICT ("assetId") DO NOTHING
    `.execute(db);
    if (lockDetections) {
      await sql`
        INSERT INTO "asset_lock" ("assetId", "reason", "lockedAt")
        SELECT "privacy"."assetId", 'detected', coalesce("privacy"."updatedAt", now())
        FROM immich_fork.asset_privacy AS "privacy"
        WHERE "privacy"."isNsfw" = true
        ON CONFLICT ("assetId") DO NOTHING
      `.execute(db);
    }
  } else {
    await sql`
      INSERT INTO "asset_lock" ("assetId", "reason", "lockedAt")
      SELECT "asset_metadata"."assetId", 'marked', "asset_metadata"."updatedAt"
      FROM "asset_metadata"
      WHERE "asset_metadata"."key" = 'ml-enrichment'
        AND "asset_metadata"."value" #>> '{nsfwDetection,review,isNsfw}' = 'true'
      ON CONFLICT ("assetId") DO NOTHING
    `.execute(db);
    if (lockDetections) {
      await sql`
        INSERT INTO "asset_lock" ("assetId", "reason")
        SELECT "asset"."id", 'detected'
        FROM "asset"
        WHERE "asset"."is_nsfw" = true
        ON CONFLICT ("assetId") DO NOTHING
      `.execute(db);
    }
  }

  // 4. Stacks and live photos lock as a whole. The stack pass runs first so that a live photo stacked
  // with a locked item also locks its video part.
  await sql`
    INSERT INTO "asset_lock" ("assetId", "reason", "lockedAt", "lockedBy")
    SELECT "member"."id", "source"."reason", "source"."lockedAt", "source"."lockedBy"
    FROM "asset" AS "member"
    INNER JOIN (
      SELECT DISTINCT ON ("asset"."stackId") "asset"."stackId", "asset_lock"."reason", "asset_lock"."lockedAt", "asset_lock"."lockedBy"
      FROM "asset_lock"
      INNER JOIN "asset" ON "asset"."id" = "asset_lock"."assetId"
      INNER JOIN "stack" ON "stack"."id" = "asset"."stackId"
      ORDER BY "asset"."stackId", ("asset"."id" = "stack"."primaryAssetId") DESC, "asset_lock"."lockedAt"
    ) AS "source" ON "source"."stackId" = "member"."stackId"
    ON CONFLICT ("assetId") DO NOTHING
  `.execute(db);
  await sql`
    INSERT INTO "asset_lock" ("assetId", "reason", "lockedAt", "lockedBy")
    SELECT "still"."livePhotoVideoId", "asset_lock"."reason", "asset_lock"."lockedAt", "asset_lock"."lockedBy"
    FROM "asset_lock"
    INNER JOIN "asset" AS "still" ON "still"."id" = "asset_lock"."assetId"
    WHERE "still"."livePhotoVideoId" IS NOT NULL
    ON CONFLICT ("assetId") DO NOTHING
  `.execute(db);

  // 5. Covers, featured photos and face thumbnails (as in 2100000000300, keyed on the lock).
  await sql`
    UPDATE "album"
    SET "albumThumbnailAssetId" = (
      SELECT "album_asset"."assetId"
      FROM "album_asset"
      INNER JOIN "asset"
        ON "album_asset"."assetId" = "asset"."id"
        AND "asset"."deletedAt" IS NULL
        AND NOT EXISTS (SELECT 1 FROM "asset_lock" WHERE "asset_lock"."assetId" = "asset"."id")
      WHERE "album_asset"."albumId" = "album"."id"
      ORDER BY "asset"."fileCreatedAt" DESC
      LIMIT 1
    )
    WHERE "albumThumbnailAssetId" IN (SELECT "assetId" FROM "asset_lock")
  `.execute(db);

  await sql`
    UPDATE "shared_space_person"
    SET "coverAssetId" = NULL
    WHERE "coverAssetId" IN (SELECT "assetId" FROM "asset_lock")
  `.execute(db);

  await sql`
    UPDATE "person"
    SET
      "faceAssetId" = (
        SELECT "asset_face"."id"
        FROM "asset_face"
        INNER JOIN "asset"
          ON "asset"."id" = "asset_face"."assetId"
          AND NOT EXISTS (SELECT 1 FROM "asset_lock" WHERE "asset_lock"."assetId" = "asset"."id")
        WHERE "asset_face"."personGroupId" = "person"."personGroupId"
          AND "asset_face"."deletedAt" IS NULL
          AND "asset_face"."isVisible" IS TRUE
        ORDER BY "asset"."deletedAt" IS NOT NULL, "asset"."fileCreatedAt" DESC
        LIMIT 1
      ),
      "thumbnailPath" = ''
    WHERE "faceAssetId" IN (
      SELECT "asset_face"."id"
      FROM "asset_face"
      INNER JOIN "asset_lock" ON "asset_lock"."assetId" = "asset_face"."assetId"
    )
  `.execute(db);

  await sql`
    UPDATE "pet"
    SET "featuredAssetId" = NULL, "updatedAt" = now()
    WHERE "featuredAssetId" IN (SELECT "assetId" FROM "asset_lock")
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // Back into the upstream Locked folder, so a release without lock records still hides them.
  await sql`
    UPDATE "asset"
    SET "visibility" = 'locked'
    WHERE "id" IN (SELECT "assetId" FROM "asset_lock")
  `.execute(db);
  await sql`DROP TABLE IF EXISTS "asset_lock";`.execute(db);
}

/** The saved "hide sensitive detections from the library" switch; off by default. */
const isDetectionHidingEnabled = async (db: Kysely<any>) => {
  const { rows } = await sql<{ enabled: string | null }>`
    SELECT "value" #>> '{machineLearning,nsfwDetection,hideFromLibrary}' AS "enabled"
    FROM "system_metadata"
    WHERE "key" = 'system-config'
  `.execute(db);
  return rows[0]?.enabled === 'true';
};

/** The fork's privacy sidecar is the source of truth only in its `active` phase. */
const isPrivacySidecarAuthoritative = async (db: Kysely<any>) => {
  const { rows: tables } = await sql<{ state: string | null; privacy: string | null }>`
    SELECT to_regclass('immich_fork.state')::text AS "state", to_regclass('immich_fork.asset_privacy')::text AS "privacy"
  `.execute(db);
  if (!tables[0]?.state || !tables[0]?.privacy) {
    return false;
  }

  const { rows } = await sql<{ phase: string | null }>`SELECT phase FROM immich_fork.state WHERE id = 1`.execute(db);
  return rows[0]?.phase === 'active';
};
