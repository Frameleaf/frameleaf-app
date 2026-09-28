import { sql } from 'kysely';
import type { Kysely, RawBuilder } from 'kysely';

/**
 * Locked photos are never covers, featured photos or face thumbnails (owner decisions, September 22,
 * 2026, FL-53).
 *
 * Before FL-53 a photo that moved into the Locked folder kept every such role. This repairs the data
 * saved before the fix; from now on the change itself releases them (`releaseLockedCoverReferences`).
 * Nothing else is touched: every Locked photo keeps its albums, spaces, people and pets. Migration
 * 2100000000310 runs this again for the photos it locks with their stacks.
 *
 * Each reference takes a replacement chosen as the live release chooses it: never a Locked or trashed
 * photo, and in a shared context never one some member may not see; photos marked as Best Photos
 * (score 0.9 and up) first, the highest score first, then the newest.
 *
 * - Albums, collections and shared spaces whose cover is Locked take one of their own items (not
 *   sensitive when someone besides the owner sees the album), or none. Migration 290 did the same
 *   without Best Photos; this is repeated for covers saved between the two.
 * - A shared space's picture for a linked person that is Locked takes another item of the space that
 *   shows them and that every member may see, or none.
 * - A person whose featured face is on a Locked photo takes another of their faces on a photo neither
 *   Locked nor trashed, not sensitive first, or none, and loses the thumbnail cut from the Locked
 *   photo. The thumbnail is generated again from the new face by the missing-thumbnail job (nightly,
 *   or "Missing" under Generate Thumbnails in the job queues).
 * - A pet whose featured photo is Locked takes the photo of another of its confirmed observations,
 *   not sensitive first, or none.
 *
 * Which photos are sensitive is read where the server reads it in the current schema phase. Where
 * the phase leaves it undetermined, a shared context only takes a Best Photo on the Timeline that is
 * not flagged sensitive.
 *
 * Here Locked is the upstream Locked folder, the only lock that existed then. Migration 2100000000320
 * (FL-34) moves Locked into lock records and runs the same repair on them (`repairLockedCoverReferences`).
 */
export async function up(db: Kysely<any>): Promise<void> {
  await repairLockedCoverReferences(db, lockedFolder);
}

/** How a repair recognises a Locked photo. */
export type LockedCondition = {
  /** A subquery listing the ids of every Locked asset. */
  lockedIds: RawBuilder<unknown>;
  /** The `asset` row in scope is Locked. */
  assetLocked: RawBuilder<boolean>;
  /** The `asset` row in scope is not Locked. */
  assetNotLocked: RawBuilder<boolean>;
};

/** The upstream Locked folder. */
const lockedFolder: LockedCondition = {
  lockedIds: sql`SELECT "id" FROM "asset" WHERE "visibility"::text = 'locked'`,
  assetLocked: sql<boolean>`"asset"."visibility"::text = 'locked'`,
  assetNotLocked: sql<boolean>`"asset"."visibility"::text != 'locked'`,
};

/** The repair itself, for whichever Locked state `locked` describes. */
export async function repairLockedCoverReferences(db: Kysely<any>, locked: LockedCondition): Promise<void> {
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

export async function down(): Promise<void> {
  // Nothing to restore: a Locked cover is never valid, and the previous covers are not recorded.
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
