import { Expression, ExpressionBuilder, Kysely, sql } from 'kysely';
import type { JobRepository } from 'src/repositories/job.repository.js';
import type { PersonRepository } from 'src/repositories/person.repository.js';
import { BEST_PHOTOS_MIN_SCORE } from 'src/dtos/best-photos.dto.js';
import { AlbumKind, AlbumUserRole, AssetVisibility, JobName, PetObservationState } from 'src/enum.js';
import { getForkSchemaPhase, readsForkSidecar } from 'src/repositories/fork-derived-results.js';
import { DB } from 'src/schema/index.js';
import { anyUuid, nsfwAssetIdExists } from 'src/utils/database.js';
import { isLockedAssetId, isUnlockedAsset } from 'src/utils/locked-state.js';

/**
 * Locked photos are never covers (owner decisions, September 22, 2026, FL-53).
 *
 * A cover, a featured photo or a person's face thumbnail is shown wherever its owner is listed: to
 * other album and space members, in shared links, on the people and pets pages, and to clients that
 * sync. None of those viewers may see Locked media, so a photo that becomes Locked stops being every
 * such reference at once, and each takes a replacement where one exists. Every reference to an asset
 * used as a picture of something else is here:
 *
 * - `album.albumThumbnailAssetId`, for albums, collections and shared spaces alike (all album rows).
 * - `shared_space_person.coverAssetId`, a shared space's picture for a linked person.
 * - `person.faceAssetId`, a person's featured face. `thumbnailPath` is cleared at the same time, so the
 *   crop cut from the Locked photo is never served again; the thumbnail is generated anew from the new
 *   face (`queueReleasedPersonThumbnails` after the transaction, or the nightly missing-thumbnail sweep
 *   for callers that cannot queue jobs).
 * - `pet.featuredAssetId`, a pet's featured photo.
 * - `user.profileImageAssetId`, the photo a profile picture was copied from. The picture is a copy, so
 *   replacing it means generating a new image, which cannot happen inside this transaction; it is
 *   refused from the moment of the move (`UserService.getProfileImage`) and replaced right after it
 *   (`replaceLockedProfileImages`).
 *
 * How a replacement is chosen (owner decision 4): only photos that are neither Locked nor trashed, and
 * in a shared context only photos every member may see (not sensitive either). Among those, photos
 * marked as Best Photos come first, the highest score first, and then the rule each reference had
 * before: the newest. Where the context is private, sensitive photos come last rather than never.
 *
 * Membership is untouched: a Locked photo stays in its albums, spaces, people and pets, and each read
 * hides it from whoever may not see it. Only the covers are released.
 *
 * Call it after the Locked change and in the same transaction, so a cover and the Locked state never
 * disagree. It must be a separate statement from the asset update, because a statement does not see
 * the rows another part of the same statement changes and would pick the asset again. Unaffected ids
 * are ignored, so it is safe after any update.
 */
export const releaseLockedCoverReferences = async (db: Kysely<DB>, assetIds: string[]): Promise<void> => {
  if (assetIds.length === 0) {
    return;
  }

  const scores = await getBestPhotoScoreTable(db);
  await releaseAlbumCovers(db, assetIds, scores);
  await releaseSharedSpacePersonCovers(db, assetIds, scores);
  await releasePersonFaces(db, assetIds, scores);
  await releasePetFeaturedPhotos(db, assetIds, scores);
};

/** Where Best Photos scores are read from: the fork's own schema once it is authoritative. */
export type BestPhotoScoreTable = 'public.asset_best_photo_score' | 'immich_fork.asset_best_photo_score';

export const getBestPhotoScoreTable = async (db: Kysely<DB>): Promise<BestPhotoScoreTable> =>
  readsForkSidecar(await getForkSchemaPhase(db))
    ? 'immich_fork.asset_best_photo_score'
    : 'public.asset_best_photo_score';

/**
 * SQL sort key, descending: a photo marked as a Best Photo sorts by its score, before every photo that
 * is not (-1). Mirrors `BestPhotosRepository.getBestPhotos` with the Explore threshold.
 */
export const bestPhotoRank = (scores: BestPhotoScoreTable, assetId: Expression<unknown>) => sql<number>`coalesce((
    select best_photo.score
    from ${sql.table(scores)} as best_photo
    where best_photo."assetId" = ${assetId}
      and best_photo.score >= ${sql.lit(BEST_PHOTOS_MIN_SCORE)}
  ), -1)`;

/** SQL sort key, ascending: photos that are not sensitive first. */
const sensitiveLast = (assetId: Expression<unknown>) => sql<boolean>`${nsfwAssetIdExists(assetId)}`;

/** SQL: the photo is not sensitive, so every member of a shared context may see it. */
const isNotSensitive = (assetId: Expression<unknown>) => sql<boolean>`not ${nsfwAssetIdExists(assetId)}`;

/**
 * SQL: someone besides its owner sees this album row and so its cover: a shared space, an album with
 * members, one linked into a shared space, or one with a shared link.
 */
const isSharedAlbum = (eb: ExpressionBuilder<DB, 'album'>) =>
  eb.or([
    eb('album.kind', '=', sql.lit(AlbumKind.Space)),
    eb.exists(
      eb
        .selectFrom('album_user')
        .select(sql.lit(1).as('shared'))
        .whereRef('album_user.albumId', '=', 'album.id')
        .where('album_user.role', '!=', sql.lit(AlbumUserRole.Owner)),
    ),
    eb.exists(
      eb
        .selectFrom('shared_space_album')
        .select(sql.lit(1).as('shared'))
        .whereRef('shared_space_album.linkedAlbumId', '=', 'album.id'),
    ),
    eb.exists(
      eb.selectFrom('shared_link').select(sql.lit(1).as('shared')).whereRef('shared_link.albumId', '=', 'album.id'),
    ),
  ]);

/**
 * The cover an album, collection or shared space takes in place of one that became Locked: one of its
 * own items, neither Locked nor trashed, and not sensitive when it is shared; Best Photos first, then
 * the newest. None when it has no such item (a collection has no items of its own).
 */
export const albumCoverReplacement = (eb: ExpressionBuilder<DB, 'album'>, scores: BestPhotoScoreTable) =>
  eb
    .selectFrom('album_asset')
    .innerJoin('asset', 'asset.id', 'album_asset.assetId')
    .select('album_asset.assetId')
    .whereRef('album_asset.albumId', '=', 'album.id')
    .where('asset.deletedAt', 'is', null)
    .where(isUnlockedAsset())
    .where((inner) => inner.or([inner.not(isSharedAlbum(eb)), isNotSensitive(sql.ref('asset.id'))]))
    .orderBy(sensitiveLast(sql.ref('asset.id')), 'asc')
    .orderBy(bestPhotoRank(scores, sql.ref('asset.id')), 'desc')
    .orderBy('asset.fileCreatedAt', 'desc')
    .limit(sql.lit(1));

const releaseAlbumCovers = async (db: Kysely<DB>, assetIds: string[], scores: BestPhotoScoreTable) => {
  await db
    .updateTable('album')
    .set((eb) => ({ albumThumbnailAssetId: albumCoverReplacement(eb, scores) }))
    .where('album.albumThumbnailAssetId', '=', anyUuid(assetIds))
    .where(isLockedAssetId(sql.ref('album.albumThumbnailAssetId')))
    .execute();
};

/**
 * The picture a shared space shows for a linked person in place of one that became Locked: an item
 * already in the space that shows them and that every member may see (Timeline or Archive, not
 * trashed, not sensitive, as `AlbumUserRepository.getLinkedPersonCoverAssetId`); Best Photos first,
 * then the newest. None when there is no such item.
 */
export const sharedSpacePersonCover = (eb: ExpressionBuilder<DB, 'shared_space_person'>, scores: BestPhotoScoreTable) =>
  eb
    .selectFrom('asset')
    .innerJoin('album_asset', 'album_asset.assetId', 'asset.id')
    .innerJoin('asset_face', 'asset_face.assetId', 'asset.id')
    .select('asset.id')
    .whereRef('album_asset.albumId', '=', 'shared_space_person.albumId')
    .whereRef('asset_face.personGroupId', '=', 'shared_space_person.personGroupId')
    .where('asset.visibility', 'in', [sql.lit(AssetVisibility.Archive), sql.lit(AssetVisibility.Timeline)])
    .where(isUnlockedAsset())
    .where('asset.deletedAt', 'is', null)
    .where(isNotSensitive(sql.ref('asset.id')))
    .where('asset_face.deletedAt', 'is', null)
    .where('asset_face.isVisible', 'is', true)
    .orderBy(bestPhotoRank(scores, sql.ref('asset.id')), 'desc')
    .orderBy('asset.fileCreatedAt', 'desc')
    .limit(sql.lit(1));

const releaseSharedSpacePersonCovers = async (db: Kysely<DB>, assetIds: string[], scores: BestPhotoScoreTable) => {
  await db
    .updateTable('shared_space_person')
    .set((eb) => ({ coverAssetId: sharedSpacePersonCover(eb, scores) }))
    .where('shared_space_person.coverAssetId', '=', anyUuid(assetIds))
    .where(isLockedAssetId(sql.ref('shared_space_person.coverAssetId')))
    .execute();
};

/**
 * The face that stands in for a person once their featured face is on a Locked photo: another of
 * their visible faces on a photo neither Locked nor trashed; faces on photos that are not sensitive
 * first (as `PersonRepository.getRandomFace` does), then Best Photos, then the newest. None when there
 * is no such face.
 */
export const nextPersonFace = (eb: ExpressionBuilder<DB, 'person'>, scores: BestPhotoScoreTable) =>
  eb
    .selectFrom('asset_face')
    .innerJoin('asset', 'asset.id', 'asset_face.assetId')
    .select('asset_face.id')
    .whereRef('asset_face.personGroupId', '=', 'person.personGroupId')
    .where('asset_face.deletedAt', 'is', null)
    .where('asset_face.isVisible', 'is', true)
    .where('asset.deletedAt', 'is', null)
    .where(isUnlockedAsset())
    .orderBy(sensitiveLast(sql.ref('asset.id')), 'asc')
    .orderBy(bestPhotoRank(scores, sql.ref('asset.id')), 'desc')
    .orderBy('asset.fileCreatedAt', 'desc')
    .limit(sql.lit(1));

const releasePersonFaces = async (db: Kysely<DB>, assetIds: string[], scores: BestPhotoScoreTable) => {
  await db
    .updateTable('person')
    .set((eb) => ({ faceAssetId: nextPersonFace(eb, scores), thumbnailPath: '' }))
    .where('person.faceAssetId', 'in', (eb) =>
      eb
        .selectFrom('asset_face')
        .select('asset_face.id')
        .where('asset_face.assetId', '=', anyUuid(assetIds))
        .where(isLockedAssetId(sql.ref('asset_face.assetId'))),
    )
    .execute();
};

/**
 * The featured photo a pet takes in place of one that became Locked (owner decision 1): the photo of
 * one of its confirmed observations, the pet owner's own and neither Locked nor trashed; photos that
 * are not sensitive first, then Best Photos, then the newest. None when there is no such photo.
 */
export const petFeaturedReplacement = (eb: ExpressionBuilder<DB, 'pet'>, scores: BestPhotoScoreTable) =>
  eb
    .selectFrom('pet_observation')
    .innerJoin('asset', 'asset.id', 'pet_observation.assetId')
    .select('asset.id')
    .whereRef('pet_observation.petId', '=', 'pet.id')
    .where('pet_observation.state', '=', sql.lit(PetObservationState.Confirmed))
    .whereRef('asset.ownerId', '=', 'pet.ownerId')
    .where('asset.deletedAt', 'is', null)
    .where(isUnlockedAsset())
    .orderBy(sensitiveLast(sql.ref('asset.id')), 'asc')
    .orderBy(bestPhotoRank(scores, sql.ref('asset.id')), 'desc')
    .orderBy('asset.fileCreatedAt', 'desc')
    .limit(sql.lit(1));

const releasePetFeaturedPhotos = async (db: Kysely<DB>, assetIds: string[], scores: BestPhotoScoreTable) => {
  await db
    .updateTable('pet')
    .set((eb) => ({ featuredAssetId: petFeaturedReplacement(eb, scores), updatedAt: new Date() }))
    .where('pet.featuredAssetId', '=', anyUuid(assetIds))
    .where(isLockedAssetId(sql.ref('pet.featuredAssetId')))
    .execute();
};

/**
 * Queues a new thumbnail for every person whose featured face `releaseLockedCoverReferences` moved off
 * `assetIds`, or off another photo of their stacks that became Locked with them (FL-53). Call it once
 * the move into the Locked folder is committed; the thumbnail job reads the new face.
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
    unique
      .values()
      .map(
        ({ ownerId, personGroupId }) =>
          ({ name: JobName.PersonGenerateThumbnail, data: { ownerId, personGroupId } }) as const,
      )
      .toArray(),
  );
};
