import { sql } from 'kysely';
import type { Kysely, RawBuilder } from 'kysely';

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
 *    out of the timeline. The same switch decides whether new detections lock from now on. A switch
 *    turned on only in a configuration file is not visible here; the server locks those detections
 *    once on its first start (`ImageEnrichmentService.onConfigInit`).
 *    In the fork's `active` phase the privacy sidecar (`immich_fork.asset_privacy`) is the source;
 *    otherwise `asset.is_nsfw` and the review in `asset_metadata`. Only positive evidence counts: an
 *    asset with no privacy row is not locked here. Only rows whose asset still exists are read.
 * 4. Stacks and live photos lock as a whole: every other member of a stack with a locked member, and
 *    the video part of a locked live photo, get a lock with the same reason. (Migration 2100000000310
 *    no longer does this on the upstream Locked folder; it happens here, on the lock records.)
 * 5. A locked asset is never a cover, featured photo or face thumbnail (FL-53): the references the
 *    new locks hold are repaired exactly as migration 2100000000300 repairs them for the old folder,
 *    Best Photos first. Profile pictures copied from a now locked photo are replaced by the server's
 *    nightly thumbnail sweep (`replaceLockedProfileImages`), which cannot run inside a migration.
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
    SELECT "asset"."id", 'immich-locked-folder', "asset"."updatedAt", "asset"."visibility"
    FROM "asset"
    WHERE "asset"."visibility"::text = 'locked'
    ON CONFLICT ("assetId") DO NOTHING
  `.execute(db);
  await sql`
    UPDATE "asset"
    SET "visibility" = CASE
      WHEN EXISTS (SELECT 1 FROM "asset" AS "still" WHERE "still"."livePhotoVideoId" = "asset"."id") THEN 'hidden'
      ELSE 'timeline'
    END::asset_visibility_enum
    WHERE "asset"."visibility"::text = 'locked'
  `.execute(db);

  // 2 and 3. Sensitive marks and detections.
  const lockDetections = await isDetectionHidingEnabled(db);
  if (await isPrivacySidecarAuthoritative(db)) {
    await sql`
      INSERT INTO "asset_lock" ("assetId", "reason", "lockedAt")
      SELECT "privacy"."assetId", 'marked', coalesce("privacy"."updatedAt", now())
      FROM immich_fork.asset_privacy AS "privacy"
      INNER JOIN "asset" ON "asset"."id" = "privacy"."assetId"
      WHERE "privacy"."isNsfw" = true
        AND "privacy".suppression ->> 'isNsfw' = 'true'
      ON CONFLICT ("assetId") DO NOTHING
    `.execute(db);
    if (lockDetections) {
      await sql`
        INSERT INTO "asset_lock" ("assetId", "reason", "lockedAt")
        SELECT "privacy"."assetId", 'detected', coalesce("privacy"."updatedAt", now())
        FROM immich_fork.asset_privacy AS "privacy"
        INNER JOIN "asset" ON "asset"."id" = "privacy"."assetId"
        WHERE "privacy"."isNsfw" = true
        ON CONFLICT ("assetId") DO NOTHING
      `.execute(db);
    }
  } else {
    await sql`
      INSERT INTO "asset_lock" ("assetId", "reason", "lockedAt")
      SELECT "asset_metadata"."assetId", 'marked', "asset_metadata"."updatedAt"
      FROM "asset_metadata"
      INNER JOIN "asset" ON "asset"."id" = "asset_metadata"."assetId"
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

  // 5. Covers, featured photos and face thumbnails: the repair of 2100000000300 (Best Photos first,
  // nothing a shared context's members may not see), keyed on the lock records.
  await repairLockedCoverReferences(db, lockRecords);
}

/** Locked as a lock record, for the repair of 2100000000300. */
const lockRecords: LockedCondition = {
  lockedIds: sql`SELECT "assetId" FROM "asset_lock"`,
  assetLocked: sql<boolean>`EXISTS (SELECT 1 FROM "asset_lock" WHERE "asset_lock"."assetId" = "asset"."id")`,
  assetNotLocked: sql<boolean>`NOT EXISTS (SELECT 1 FROM "asset_lock" WHERE "asset_lock"."assetId" = "asset"."id")`,
};

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

// The repair of 2100000000300, copied here so this migration stays self-contained (migrations never import
// one another). It must keep behaving exactly as it did when 2100000000300 shipped.

/** How a repair recognises a Locked photo. */
type LockedCondition = {
  /** A subquery listing the ids of every Locked asset. */
  lockedIds: RawBuilder<unknown>;
  /** The `asset` row in scope is Locked. */
  assetLocked: RawBuilder<boolean>;
  /** The `asset` row in scope is not Locked. */
  assetNotLocked: RawBuilder<boolean>;
};

/** The repair itself, for whichever Locked state `locked` describes. */
async function repairLockedCoverReferences(db: Kysely<any>, locked: LockedCondition): Promise<void> {
  const rules = await getRules(db);
  const { rank, sensitive, visibleToEveryone } = rules;

  await sql`
    UPDATE "album"
    SET "albumThumbnailAssetId" = (
      SELECT "album_asset"."assetId"
      FROM "album_asset"
      INNER JOIN "asset" ON "album_asset"."assetId" = "asset"."id"
      WHERE "album_asset"."albumId" = "album"."id"
        AND "asset"."deletedAt" IS NULL
        AND ${locked.assetNotLocked}
        AND (NOT ${isSharedAlbum} OR ${visibleToEveryone})
      ORDER BY ${sensitive} ASC, ${rank} DESC, "asset"."fileCreatedAt" DESC
      LIMIT 1
    )
    WHERE "albumThumbnailAssetId" IN (${locked.lockedIds})
  `.execute(db);

  await sql`
    UPDATE "shared_space_person"
    SET "coverAssetId" = (
      SELECT "asset"."id"
      FROM "asset"
      INNER JOIN "album_asset" ON "album_asset"."assetId" = "asset"."id"
      INNER JOIN "asset_face" ON "asset_face"."assetId" = "asset"."id"
      WHERE "album_asset"."albumId" = "shared_space_person"."albumId"
        AND "asset_face"."personGroupId" = "shared_space_person"."personGroupId"
        AND "asset"."visibility" IN ('archive', 'timeline')
        AND ${locked.assetNotLocked}
        AND "asset"."deletedAt" IS NULL
        AND ${visibleToEveryone}
        AND "asset_face"."deletedAt" IS NULL
        AND "asset_face"."isVisible" IS TRUE
      ORDER BY ${rank} DESC, "asset"."fileCreatedAt" DESC
      LIMIT 1
    )
    WHERE "coverAssetId" IN (${locked.lockedIds})
  `.execute(db);

  await sql`
    UPDATE "person"
    SET
      "faceAssetId" = (
        SELECT "asset_face"."id"
        FROM "asset_face"
        INNER JOIN "asset" ON "asset"."id" = "asset_face"."assetId"
        WHERE "asset_face"."personGroupId" = "person"."personGroupId"
          AND "asset_face"."deletedAt" IS NULL
          AND "asset_face"."isVisible" IS TRUE
          AND "asset"."deletedAt" IS NULL
          AND ${locked.assetNotLocked}
        ORDER BY ${sensitive} ASC, ${rank} DESC, "asset"."fileCreatedAt" DESC
        LIMIT 1
      ),
      "thumbnailPath" = ''
    WHERE "faceAssetId" IN (
      SELECT "asset_face"."id"
      FROM "asset_face"
      INNER JOIN "asset"
        ON "asset"."id" = "asset_face"."assetId"
        AND ${locked.assetLocked}
    )
  `.execute(db);

  await sql`
    UPDATE "pet"
    SET
      "featuredAssetId" = (
        SELECT "asset"."id"
        FROM "pet_observation"
        INNER JOIN "asset" ON "asset"."id" = "pet_observation"."assetId"
        WHERE "pet_observation"."petId" = "pet"."id"
          AND "pet_observation"."state" = 'confirmed'
          AND "asset"."ownerId" = "pet"."ownerId"
          AND "asset"."deletedAt" IS NULL
          AND ${locked.assetNotLocked}
        ORDER BY ${sensitive} ASC, ${rank} DESC, "asset"."fileCreatedAt" DESC
        LIMIT 1
      ),
      "updatedAt" = now()
    WHERE "featuredAssetId" IN (${locked.lockedIds})
  `.execute(db);
}

/** A photo is marked as a Best Photo from this score up (a frozen copy of `BEST_PHOTOS_MIN_SCORE`). */
const BEST_PHOTOS_MIN_SCORE = 0.9;

/** Someone besides its owner sees the album row in scope and so its cover. */
const isSharedAlbum = sql<boolean>`(
  "album"."kind" = 'space'
  OR EXISTS (
    SELECT 1 FROM "album_user" WHERE "album_user"."albumId" = "album"."id" AND "album_user"."role" != 'owner'
  )
  OR EXISTS (SELECT 1 FROM "shared_space_album" WHERE "shared_space_album"."linkedAlbumId" = "album"."id")
  OR EXISTS (SELECT 1 FROM "shared_link" WHERE "shared_link"."albumId" = "album"."id")
)`;

type Rules = {
  /** Sort key, descending: a Best Photo's score, -1 for every other photo. */
  rank: RawBuilder<number>;
  /** Sort key, ascending: whether the photo is sensitive. */
  sensitive: RawBuilder<boolean>;
  /** Whether every member of a shared context may see the photo. */
  visibleToEveryone: RawBuilder<boolean>;
};

/** The rules for the `asset` row in scope, read from the schema phase the server is in. */
const getRules = async (db: Kysely<any>): Promise<Rules> => {
  const phase = await getForkSchemaPhase(db);
  const scores = phase === 'active' ? sql`immich_fork.asset_best_photo_score` : sql`public.asset_best_photo_score`;
  const rank = sql<number>`coalesce((
    SELECT best_photo.score
    FROM ${scores} AS best_photo
    WHERE best_photo."assetId" = "asset"."id" AND best_photo.score >= ${sql.lit(BEST_PHOTOS_MIN_SCORE)}
  ), -1)`;

  // Mirrors `nsfwAssetIdExists` for the phases in which it reads a sensitive flag.
  if (['legacy', 'dual-write', 'ready'].includes(phase)) {
    const sensitive = sql<boolean>`"asset"."is_nsfw"`;
    return { rank, sensitive, visibleToEveryone: sql<boolean>`NOT ${sensitive}` };
  }

  if (phase === 'active') {
    const sensitive = sql<boolean>`NOT EXISTS (
      SELECT 1 FROM immich_fork.asset_privacy AS privacy_asset
      WHERE privacy_asset."assetId" = "asset"."id" AND privacy_asset."isNsfw" = false
    )`;
    return { rank, sensitive, visibleToEveryone: sql<boolean>`NOT ${sensitive}` };
  }

  // Undetermined: only a Best Photo on the Timeline that is not flagged sensitive.
  return {
    rank,
    sensitive: sql<boolean>`"asset"."is_nsfw"`,
    visibleToEveryone: sql<boolean>`(
      "asset"."visibility" = 'timeline' AND NOT "asset"."is_nsfw" AND ${rank} >= 0
    )`,
  };
};

const getForkSchemaPhase = async (db: Kysely<any>): Promise<string> => {
  const {
    rows: [schema],
  } = await sql<{ stateTable: string | null }>`SELECT to_regclass('immich_fork.state')::text AS "stateTable"`.execute(
    db,
  );
  if (!schema?.stateTable) {
    return 'legacy';
  }

  const {
    rows: [state],
  } = await sql<{ phase: string }>`SELECT phase FROM immich_fork.state WHERE id = 1`.execute(db);
  return state?.phase ?? 'inactive';
};
