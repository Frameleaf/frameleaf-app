import { Expression, ExpressionBuilder, Kysely, sql } from 'kysely';
import { AssetVisibility, JobName } from 'src/enum.js';
import type { JobRepository } from 'src/repositories/job.repository.js';
import type { PersonRepository } from 'src/repositories/person.repository.js';
import { DB } from 'src/schema/index.js';
import { automaticAlbumCover } from 'src/utils/album-cover.js';
import { anyUuid, nsfwAssetIdExists } from 'src/utils/database.js';

/**
 * Locked photos are never covers (owner decision, September 22, 2026, FL-53).
 *
 * A cover, a featured photo or a person's face thumbnail is shown wherever its owner is listed: to
 * other album and space members, in shared links, on the people and pets pages, and to clients that
 * sync. None of those viewers may see Locked media, so a photo that becomes Locked stops being every
 * such reference at once. Every reference to an asset used as a picture of something else is here:
 *
 * - `album.albumThumbnailAssetId`, for albums, collections and shared spaces alike (all album rows):
 *   the automatic cover (newest member neither Locked nor trashed), or none.
 * - `shared_space_person.coverAssetId`: the newest item of the space that shows that person and that
 *   every member may see (not Locked, not trashed, not sensitive), or none.
 * - `person.faceAssetId`: the next face of that person whose photo is not Locked, preferring faces on
 *   photos that are not sensitive, or none. `thumbnailPath` is cleared at the same time, so the crop
 *   cut from the Locked photo is never served again; the thumbnail is generated anew from the new
 *   face (`queueReleasedPersonThumbnails` after the transaction, or the nightly missing-thumbnail
 *   sweep for callers that cannot queue jobs).
 * - `pet.featuredAssetId`: cleared. A featured photo is the owner's own choice and there is no
 *   automatic one to fall back to.
 *
 * Membership is untouched: a Locked photo stays in its albums, spaces, people and pets, and each read
 * hides it from whoever may not see it. Only the covers are released.
 *
 * Call it after the visibility change and in the same transaction, so a cover and the Locked flag
 * never disagree. It must be a separate statement from the asset update, because a statement does
 * not see the rows another part of the same statement changes and would pick the asset again.
 * Unaffected ids are ignored, so it is safe after any update.
 */
export const releaseLockedCoverReferences = async (db: Kysely<DB>, assetIds: string[]): Promise<void> => {
  if (assetIds.length === 0) {
    return;
  }

  await releaseAlbumCovers(db, assetIds);
  await releaseSharedSpacePersonCovers(db, assetIds);
  await releasePersonFaces(db, assetIds);
  await releasePetFeaturedPhotos(db, assetIds);
};

/** True when `assetId` is a Locked asset. */
const isLockedAssetId = (assetId: Expression<unknown>) => sql<boolean>`exists (
    select 1
    from asset as locked_asset
    where locked_asset.id = ${assetId}
      and locked_asset.visibility = ${sql.lit(AssetVisibility.Locked)}
  )`;

/** Albums, collections and shared spaces: back to the automatic cover, which is never Locked. */
const releaseAlbumCovers = async (db: Kysely<DB>, assetIds: string[]) => {
  await db
    .updateTable('album')
    .set((eb) => ({ albumThumbnailAssetId: automaticAlbumCover(eb) }))
    .where('album.albumThumbnailAssetId', '=', anyUuid(assetIds))
    .where(isLockedAssetId(sql.ref('album.albumThumbnailAssetId')))
    .execute();
};

/**
 * The picture a shared space shows for a linked person: the newest item already in the space that
 * shows them and that every member may see. Mirrors `AlbumUserRepository.getLinkedPersonCoverAssetId`
 * with the space's content options (Timeline and Archive only, sensitive media left out).
 */
export const sharedSpacePersonCover = (eb: ExpressionBuilder<DB, 'shared_space_person'>) =>
  eb
    .selectFrom('asset')
    .innerJoin('album_asset', 'album_asset.assetId', 'asset.id')
    .innerJoin('asset_face', 'asset_face.assetId', 'asset.id')
    .select('asset.id')
    .whereRef('album_asset.albumId', '=', 'shared_space_person.albumId')
    .whereRef('asset_face.personGroupId', '=', 'shared_space_person.personGroupId')
    .where('asset.visibility', 'in', [sql.lit(AssetVisibility.Archive), sql.lit(AssetVisibility.Timeline)])
    .where('asset.deletedAt', 'is', null)
    .where(sql<boolean>`not ${nsfwAssetIdExists(sql.ref('asset.id'))}`)
    .where('asset_face.deletedAt', 'is', null)
    .where('asset_face.isVisible', 'is', true)
    .orderBy('asset.fileCreatedAt', 'desc')
    .limit(sql.lit(1));

const releaseSharedSpacePersonCovers = async (db: Kysely<DB>, assetIds: string[]) => {
  await db
    .updateTable('shared_space_person')
    .set((eb) => ({ coverAssetId: sharedSpacePersonCover(eb) }))
    .where('shared_space_person.coverAssetId', '=', anyUuid(assetIds))
    .where(isLockedAssetId(sql.ref('shared_space_person.coverAssetId')))
    .execute();
};

/**
 * The face that stands in for a person once their featured face is on a Locked photo: any other of
 * their faces whose photo is not Locked, a face on a photo that is not sensitive first (as
 * `PersonRepository.getRandomFace` does), or none.
 */
export const nextPersonFace = (eb: ExpressionBuilder<DB, 'person'>) =>
  eb
    .selectFrom('asset_face')
    .innerJoin('asset', (join) =>
      join
        .onRef('asset.id', '=', 'asset_face.assetId')
        .on('asset.visibility', '!=', sql.lit(AssetVisibility.Locked)),
    )
    .select('asset_face.id')
    .whereRef('asset_face.personGroupId', '=', 'person.personGroupId')
    .where('asset_face.deletedAt', 'is', null)
    .where('asset_face.isVisible', 'is', true)
    .orderBy(sql`${nsfwAssetIdExists(sql.ref('asset_face.assetId'))} asc`)
    .limit(sql.lit(1));

const releasePersonFaces = async (db: Kysely<DB>, assetIds: string[]) => {
  await db
    .updateTable('person')
    .set((eb) => ({ faceAssetId: nextPersonFace(eb), thumbnailPath: '' }))
    .where('person.faceAssetId', 'in', (eb) =>
      eb
        .selectFrom('asset_face')
        .innerJoin('asset', (join) =>
          join
            .onRef('asset.id', '=', 'asset_face.assetId')
            .on('asset.visibility', '=', sql.lit(AssetVisibility.Locked)),
        )
        .select('asset_face.id')
        .where('asset_face.assetId', '=', anyUuid(assetIds)),
    )
    .execute();
};

const releasePetFeaturedPhotos = async (db: Kysely<DB>, assetIds: string[]) => {
  await db
    .updateTable('pet')
    .set({ featuredAssetId: null, updatedAt: new Date() })
    .where('pet.featuredAssetId', '=', anyUuid(assetIds))
    .where(isLockedAssetId(sql.ref('pet.featuredAssetId')))
    .execute();
};

/**
 * Queues a new thumbnail for every person whose featured face `releaseLockedCoverReferences` moved off
 * `assetIds` (FL-53). Call it once the move into the Locked folder is committed; the thumbnail job
 * reads the new face.
 */
export const queueReleasedPersonThumbnails = async (
  repositories: {
    person: Pick<PersonRepository, 'getMissingThumbnailsForAssets'>;
    job: Pick<JobRepository, 'queueAll'>;
  },
  assetIds: string[],
): Promise<void> => {
  if (assetIds.length === 0) {
    return;
  }

  const people = await repositories.person.getMissingThumbnailsForAssets(assetIds);
  const unique = new Map(people.map((person) => [`${person.ownerId}:${person.personGroupId}`, person]));
  if (unique.size === 0) {
    return;
  }

  await repositories.job.queueAll(
    [...unique.values()].map(
      ({ ownerId, personGroupId }) =>
        ({ name: JobName.PersonGenerateThumbnail, data: { ownerId, personGroupId } }) as const,
    ),
  );
};
