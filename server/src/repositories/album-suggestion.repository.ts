import { Kysely, sql } from 'kysely';
import type { DB } from 'src/schema/index.js';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { AssetVisibility, JobName, LibraryScope, QueueName } from 'src/enum.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { QUEUE_TIMING } from 'src/queue/types.js';
import { AssetOriginField } from 'src/repositories/partner-origin.repository.js';
import { LOOKS_LIKE_DISTANCE, sample } from 'src/utils/album-suggestions.js';
import {
  hiddenByOwnerRules,
  hiddenFromOthers,
  validLandmarkMatch,
  withHiddenContentFilter,
} from 'src/utils/database.js';
import { dateSetByHand } from 'src/utils/date-sanity.js';
import { libraryScopePredicate } from 'src/utils/library-scope.js';
import { isLocked, isNotLocked, isTimelineVisible, notLockedOrOwnedBy } from 'src/utils/locked.js';

/** ponytail: caps keep one album's suggestions to a few bounded queries; page them if albums outgrow them. */
const MAX_TRIP_PHOTOS = 5000;
const MAX_CANDIDATES = 1000;
const MAX_VISUAL_REFERENCES = 100;
const MAX_UNDATED_REFERENCES = 40;
const UNDATED_NEIGHBOURS = 20;
/** ponytail: an album past this is treated as too wide to heal rather than read in full. */
export const MAX_HEAL_PHOTOS = 50_000;

/** Names that show a photo was saved or received rather than taken: Facebook, WhatsApp, Messenger. */
export const SAVED_NAME = String.raw`^(FB_IMG_\d{13}|(IMG|VID)-\d{8}-WA\d+|received_\d+)`;

/** Personal-library media on the timeline, not trashed, Locked or hidden by its owner's rules. */
const suggestible = (alias: string) => sql<boolean>`(
  ${isTimelineVisible(alias)} and ${libraryScopePredicate(LibraryScope.Personal, alias)}
  and ${sql.ref(`${alias}.deletedAt`)} is null
  and not ${hiddenByOwnerRules(alias)}
)`;

/** FL-1299: whether this row's date is still the one healing estimated, so it proves nothing. */
const dateEstimated = (exifAlias: string) =>
  sql<boolean>`coalesce(${sql.ref(`${exifAlias}.estimatedDateTimeOriginal`)} = ${sql.ref(`${exifAlias}.dateTimeOriginal`)}, false)`;

/** A located photo's place: its recorded position, else a landmark it was matched to (recorded or inferred). */
const landmark = (alias: string) => sql`(
  select landmark from landmark
  join asset_landmark on asset_landmark."landmarkId" = landmark.id
  join asset on asset.id = asset_landmark."assetId"
  where asset_landmark."assetId" = ${sql.ref(`${alias}.id`)} and ${validLandmarkMatch()}
  order by asset_landmark.inference nulls first, landmark.rank, landmark.id
  limit 1
)`;

export type TripPhotoRow = {
  id: string;
  visibility: AssetVisibility;
  takenAt: Date;
  localDateTime: Date;
  latitude: number | null;
  longitude: number | null;
  place: string | null;
  make: string | null;
  model: string | null;
  /** A person chose this date (FL-1410), so `dateProblem` never calls it wrong. */
  dateSetByHand?: boolean;
};

export type CandidateRow = Omit<TripPhotoRow, 'visibility'> & { originalFileName: string; hasCameraDetails: boolean };

export type HealPhotoRow = {
  id: string;
  ownerId: string;
  originalFileName: string;
  takenAt: Date;
  localDateTime: Date;
  hasCameraDetails: boolean;
  dateEstimated: boolean;
  dateSet: boolean;
  isLocked: boolean;
};

/** FL-1299: what a heal replaced and what it wrote, as a change's `before` and `after`. Dates are ISO strings. */
export type HealedDateBefore = {
  dateTimeOriginal: string | null;
  timeZone: string | null;
  fileCreatedAt: string;
  localDateTime: string;
};
export type HealedDateAfter = { dateTimeOriginal: string; fileCreatedAt: string };

export class AlbumSuggestionRepository {
  constructor(private db: Kysely<DB>) {}

  private located<A extends string>(alias: A) {
    return [
      sql<number | null>`coalesce(${sql.ref(`${alias}_exif.latitude`)}, (${landmark(alias)}).latitude)`.as('latitude'),
      sql<number | null>`coalesce(${sql.ref(`${alias}_exif.longitude`)}, (${landmark(alias)}).longitude)`.as(
        'longitude',
      ),
      sql<string | null>`coalesce(${sql.ref(`${alias}_exif.city`)}, (${landmark(alias)}).name)`.as('place'),
    ];
  }

  /**
   * The album's photos that `viewerId` may see, to describe its trip: not Locked, and not another member's
   * photo that its owner's Locked rules hide (FL-446), since trip dates, places and matches reveal them.
   */
  getTripPhotos(albumId: string, viewerId: string, options?: HiddenContentQueryOptions): Promise<TripPhotoRow[]> {
    return (
      this.db
        .selectFrom('album_asset')
        .innerJoin('asset as photo', 'photo.id', 'album_asset.assetId')
        .leftJoin('asset_exif as photo_exif', 'photo_exif.assetId', 'photo.id')
        .where('album_asset.albumId', '=', albumId)
        .where('photo.deletedAt', 'is', null)
        .where(isNotLocked('photo'))
        .where(sql<boolean>`not ${hiddenFromOthers(viewerId, 'photo')}`)
        // FL-1299: an estimated date is no evidence of when the trip was.
        .where(sql<boolean>`not ${dateEstimated('photo_exif')}`)
        // The session's own filter too: a session that isn't unlocked doesn't see its own Locked-rule matches.
        .$call((qb) => withHiddenContentFilter(qb, options, 'photo'))
        .select([
          'photo.id',
          'photo.fileCreatedAt as takenAt',
          'photo.localDateTime',
          'photo.visibility',
          'photo_exif.make',
          'photo_exif.model',
          dateSetByHand('photo').as('dateSetByHand'),
          ...this.located('photo'),
        ])
        .orderBy('photo.fileCreatedAt')
        .limit(MAX_TRIP_PHOTOS)
        .execute()
    );
  }

  /**
   * FL-1299: the album's photos as date healing weighs them, for one session. Locked photos are present only in
   * their owner's elevated session; without one, nothing here can be computed from them. Unlike the trip's
   * photos this reads every photo, because the ones it heals are exactly those that sort far away.
   */
  getHealPhotos(
    albumId: string,
    viewerId: string,
    lockedOwnerId: string | undefined,
    options?: HiddenContentQueryOptions,
  ): Promise<HealPhotoRow[]> {
    return this.db
      .selectFrom('album_asset')
      .innerJoin('asset as photo', 'photo.id', 'album_asset.assetId')
      .leftJoin('asset_exif as photo_exif', 'photo_exif.assetId', 'photo.id')
      .where('album_asset.albumId', '=', albumId)
      .where('photo.deletedAt', 'is', null)
      .where('photo.visibility', '!=', AssetVisibility.Hidden)
      .where(notLockedOrOwnedBy(lockedOwnerId, 'photo'))
      .where(sql<boolean>`not ${hiddenFromOthers(viewerId, 'photo')}`)
      .$call((qb) => withHiddenContentFilter(qb, options, 'photo'))
      .select([
        'photo.id',
        'photo.ownerId',
        'photo.originalFileName',
        'photo.fileCreatedAt as takenAt',
        'photo.localDateTime',
        sql<boolean>`(photo_exif.make is not null or photo_exif.model is not null
          or photo_exif."timeZone" is not null)`.as('hasCameraDetails'),
        dateEstimated('photo_exif').as('dateEstimated'),
        // Whatever locked the date set it on purpose.
        sql<boolean>`coalesce(photo_exif."lockedProperties" && array['dateTimeOriginal', 'timeZone']::varchar[], false)`.as(
          'dateSet',
        ),
        isLocked('photo').as('isLocked'),
      ])
      .orderBy('photo.fileCreatedAt')
      .orderBy('photo.id')
      .limit(MAX_HEAL_PHOTOS + 1)
      .execute();
  }

  /**
   * FL-1299: puts a healed date back, only if it is still the date healing set: a later edit wins. The locks
   * healing took stay until the sidecar has been rewritten; see `queueSidecarRestores`.
   */
  async restoreHealedDate(
    assetId: string,
    before: HealedDateBefore,
    after: HealedDateAfter,
  ): Promise<{ outcome: 'restored' | 'changed'; fileName: string; isLocked: boolean } | undefined> {
    const row = await this.db
      .selectFrom('asset')
      .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select([
        'asset.originalFileName',
        'asset.fileCreatedAt',
        'asset_exif.dateTimeOriginal',
        isLocked('asset').as('isLocked'),
      ])
      .where('asset.id', '=', assetId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) {
      return;
    }
    const base = { fileName: row.originalFileName, isLocked: row.isLocked };
    const unchanged =
      row.dateTimeOriginal !== null &&
      new Date(row.dateTimeOriginal).getTime() === new Date(after.dateTimeOriginal).getTime() &&
      new Date(row.fileCreatedAt).getTime() === new Date(after.fileCreatedAt).getTime();
    if (!unchanged) {
      return { ...base, outcome: 'changed' };
    }
    await this.db
      .updateTable('asset_exif')
      .set({
        dateTimeOriginal: before.dateTimeOriginal,
        timeZone: before.timeZone,
        estimatedDateTimeOriginal: null,
      })
      .where('assetId', '=', assetId)
      .execute();
    await this.db
      .updateTable('asset')
      .set({ fileCreatedAt: before.fileCreatedAt, localDateTime: before.localDateTime })
      .where('id', '=', assetId)
      .execute();
    return { ...base, outcome: 'restored' };
  }

  /**
   * The work a restored date sets off, in the transaction that restored it: the sidecars rewritten with the
   * restored dates, and any partner copies following these photos brought back into line.
   */
  async queueAfterRestore(ids: string[], partnerSourceIds: string[]): Promise<void> {
    const timing = { safeToRetry: false, sensitive: false, deadlineMs: QUEUE_TIMING.opaqueDeadline };
    await new SqlQueueStore(this.db).enqueue([
      ...ids.map((id) => ({
        name: JobName.SidecarWrite,
        queue: QueueName.Sidecar,
        data: { id, releaseDateLock: true },
        ...timing,
      })),
      ...partnerSourceIds.map((sourceId) => ({
        name: JobName.PartnerPropagate,
        queue: QueueName.BackgroundTask,
        data: { kind: 'asset', sourceId, fields: [AssetOriginField.DateTimeOriginal] },
        ...timing,
      })),
    ]);
  }

  /** When the album's photos (not Locked) were taken, for a cheap check before reading them all. */
  async getTimeSpan(albumId: string, viewerId: string): Promise<{ from: Date; to: Date } | undefined> {
    const row = await this.db
      .selectFrom('album_asset')
      .innerJoin('asset as photo', 'photo.id', 'album_asset.assetId')
      .leftJoin('asset_exif as photo_exif', 'photo_exif.assetId', 'photo.id')
      .where('album_asset.albumId', '=', albumId)
      .where('photo.deletedAt', 'is', null)
      .where(isNotLocked('photo'))
      .where(sql<boolean>`not ${hiddenFromOthers(viewerId, 'photo')}`)
      .where(sql<boolean>`not ${dateEstimated('photo_exif')}`)
      .select([
        sql<Date | null>`min(photo."fileCreatedAt")`.as('from'),
        sql<Date | null>`max(photo."fileCreatedAt")`.as('to'),
      ])
      .executeTakeFirst();
    return row?.from && row.to ? { from: new Date(row.from), to: new Date(row.to) } : undefined;
  }

  /** `ownerId`'s photos taken inside the windows that are not in the album and were not dismissed. */
  getTripCandidates(ownerId: string, albumId: string, windows: { from: Date; to: Date }[]): Promise<CandidateRow[]> {
    if (windows.length === 0) return Promise.resolve([]);
    return this.candidates(ownerId, albumId)
      .where(sql<boolean>`not ${dateEstimated('candidate_exif')}`)
      .where((eb) =>
        eb.or(
          windows.map(({ from, to }) =>
            eb.and([eb('candidate.fileCreatedAt', '>=', from), eb('candidate.fileCreatedAt', '<=', to)]),
          ),
        ),
      )
      .orderBy('candidate.fileCreatedAt')
      .limit(MAX_CANDIDATES)
      .execute();
  }

  getCandidates(ownerId: string, albumId: string, ids: string[]): Promise<CandidateRow[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.candidates(ownerId, albumId).where('candidate.id', 'in', ids).execute();
  }

  private candidates(ownerId: string, albumId: string) {
    return this.db
      .selectFrom('asset as candidate')
      .leftJoin('asset_exif as candidate_exif', 'candidate_exif.assetId', 'candidate.id')
      .where('candidate.ownerId', '=', ownerId)
      .where(suggestible('candidate'))
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('album_asset')
              .select('album_asset.assetId')
              .whereRef('album_asset.assetId', '=', 'candidate.id')
              .where('album_asset.albumId', '=', albumId),
          ),
        ),
      )
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('album_suggestion_dismissal')
              .select('album_suggestion_dismissal.assetId')
              .whereRef('album_suggestion_dismissal.assetId', '=', 'candidate.id')
              .where('album_suggestion_dismissal.albumId', '=', albumId),
          ),
        ),
      )
      .select([
        'candidate.id',
        'candidate.fileCreatedAt as takenAt',
        'candidate.localDateTime',
        'candidate.originalFileName',
        'candidate_exif.make',
        'candidate_exif.model',
        // A healed date brought a time zone with it, which must not read as camera details.
        sql<boolean>`((candidate_exif.make is not null or candidate_exif.model is not null
          or candidate_exif."timeZone" is not null) and not ${dateEstimated('candidate_exif')})`.as('hasCameraDetails'),
        ...this.located('candidate'),
      ]);
  }

  /** Closest stored-embedding distance from each candidate to the album photos (same CLIP model only). */
  async getVisualDistances(candidateIds: string[], albumPhotoIds: string[]): Promise<Map<string, number>> {
    if (candidateIds.length === 0 || albumPhotoIds.length === 0) return new Map();
    const references = sample(albumPhotoIds, MAX_VISUAL_REFERENCES);
    const rows = await this.db
      .selectFrom('smart_search as candidate')
      .innerJoin('smart_search as reference', 'reference.producerModelKey', 'candidate.producerModelKey')
      .where('candidate.assetId', 'in', candidateIds)
      .where('reference.assetId', 'in', references)
      .where('candidate.producerModelKey', 'is not', null)
      .select(['candidate.assetId', sql<number>`min(candidate.embedding <=> reference.embedding)`.as('distance')])
      .groupBy('candidate.assetId')
      .execute();
    return new Map(rows.map(({ assetId, distance }) => [assetId, Number(distance)]));
  }

  /**
   * `ownerId`'s photos whose date can't be trusted (saved or received names, or no camera details at all)
   * that look like album photos: the nearest neighbours of a sample of album photos.
   */
  getUndatedNeighbours(
    ownerId: string,
    albumId: string,
    albumPhotoIds: string[],
  ): Promise<{ assetId: string; referenceId: string; distance: number }[]> {
    const references = sample(albumPhotoIds, MAX_UNDATED_REFERENCES);
    if (references.length === 0) return Promise.resolve([]);
    return this.db.transaction().execute(async (tx) => {
      await sql`set local hnsw.ef_search = 100`.execute(tx);
      await sql`set local hnsw.iterative_scan = relaxed_order`.execute(tx);
      const found: { assetId: string; referenceId: string; distance: number }[] = [];
      for (const referenceId of references) {
        const reference = await tx
          .selectFrom('smart_search')
          .select(['embedding', 'producerModelKey'])
          .where('assetId', '=', referenceId)
          .where('producerModelKey', 'is not', null)
          .executeTakeFirst();
        if (!reference) continue;
        const rows = await tx
          .selectFrom('smart_search')
          .innerJoin('asset as candidate', 'candidate.id', 'smart_search.assetId')
          .leftJoin('asset_exif as candidate_exif', 'candidate_exif.assetId', 'candidate.id')
          .where('smart_search.producerModelKey', '=', reference.producerModelKey)
          .where('candidate.ownerId', '=', ownerId)
          .where(suggestible('candidate'))
          .where(
            sql<boolean>`(candidate."originalFileName" ~* ${SAVED_NAME} or (candidate_exif.make is null
              and candidate_exif.model is null and candidate_exif."timeZone" is null)
              or ${dateEstimated('candidate_exif')})`,
          )
          .where(({ not, exists, selectFrom }) =>
            not(
              exists(
                selectFrom('album_asset')
                  .select('album_asset.assetId')
                  .whereRef('album_asset.assetId', '=', 'candidate.id')
                  .where('album_asset.albumId', '=', albumId),
              ),
            ),
          )
          .select([
            'candidate.id as assetId',
            sql<number>`smart_search.embedding <=> ${reference.embedding}::vector`.as('distance'),
          ])
          .orderBy('distance')
          .orderBy('candidate.id')
          .limit(UNDATED_NEIGHBOURS)
          .execute();
        for (const row of rows) {
          const distance = Number(row.distance);
          if (distance <= LOOKS_LIKE_DISTANCE) found.push({ assetId: row.assetId, referenceId, distance });
        }
      }
      return found;
    });
  }

  /** Named, shown people of `ownerId` in each photo. */
  async getPeople(ownerId: string, assetIds: string[]): Promise<Map<string, { id: string; name: string }[]>> {
    if (assetIds.length === 0) return new Map();
    const rows = await this.db
      .selectFrom('asset_face')
      .innerJoin('person', 'person.personGroupId', 'asset_face.personGroupId')
      .where('asset_face.assetId', 'in', assetIds)
      .where('asset_face.deletedAt', 'is', null)
      .where('asset_face.isVisible', '=', true)
      .where('person.ownerId', '=', ownerId)
      .where('person.isHidden', '=', false)
      .where('person.name', '!=', '')
      .select(['asset_face.assetId', 'person.personGroupId as id', 'person.name'])
      .distinct()
      .orderBy('person.name')
      .execute();
    const people = new Map<string, { id: string; name: string }[]>();
    for (const { assetId, id, name } of rows) people.set(assetId, [...(people.get(assetId) ?? []), { id, name }]);
    return people;
  }

  /**
   * FL-1094: the faces of `ownerId`'s named, shown people in these photos, with the outfit stored for each
   * by `modelName` (`encoded` is false while none was made; `embedding` is null when there's no torso).
   */
  getOutfits(ownerId: string, assetIds: string[], modelName: string) {
    if (assetIds.length === 0) return Promise.resolve([]);
    return this.db
      .selectFrom('asset_face')
      .innerJoin('person', 'person.personGroupId', 'asset_face.personGroupId')
      .leftJoin('asset_face_outfit as outfit', (join) =>
        join.onRef('outfit.faceId', '=', 'asset_face.id').on('outfit.modelName', '=', modelName),
      )
      .where('asset_face.assetId', 'in', assetIds)
      .where('asset_face.deletedAt', 'is', null)
      .where('asset_face.isVisible', '=', true)
      .where('person.ownerId', '=', ownerId)
      .where('person.isHidden', '=', false)
      .where('person.name', '!=', '')
      .select([
        'asset_face.assetId',
        'person.personGroupId as personId',
        'person.name',
        'outfit.embedding',
        sql<boolean>`outfit."faceId" is not null`.as('encoded'),
      ])
      .orderBy('asset_face.assetId')
      .orderBy('asset_face.id')
      .execute();
  }

  /** FL-1094: a photo's visible faces with a person and no outfit by `modelName` yet, for the outfit job. */
  getFacesWithoutOutfit(assetId: string, modelName: string) {
    return this.db
      .selectFrom('asset_face')
      .leftJoin('asset_face_outfit as outfit', (join) =>
        join.onRef('outfit.faceId', '=', 'asset_face.id').on('outfit.modelName', '=', modelName),
      )
      .where('asset_face.assetId', '=', assetId)
      .where('asset_face.deletedAt', 'is', null)
      .where('asset_face.isVisible', '=', true)
      .where('asset_face.personGroupId', 'is not', null)
      .where('outfit.faceId', 'is', null)
      .select([
        'asset_face.id',
        'asset_face.imageWidth',
        'asset_face.imageHeight',
        'asset_face.boundingBoxX1 as x1',
        'asset_face.boundingBoxY1 as y1',
        'asset_face.boundingBoxX2 as x2',
        'asset_face.boundingBoxY2 as y2',
      ])
      .orderBy('asset_face.id')
      .execute();
  }

  async saveOutfits(rows: { faceId: string; modelName: string; embedding: string | null }[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db
      .insertInto('asset_face_outfit')
      .values(rows)
      .onConflict((oc) =>
        oc.column('faceId').doUpdateSet((eb) => ({
          modelName: eb.ref('excluded.modelName'),
          embedding: eb.ref('excluded.embedding'),
          createdAt: sql`now()`,
        })),
      )
      .execute();
  }

  async getFileNames(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db.selectFrom('asset').select(['id', 'originalFileName']).where('id', 'in', ids).execute();
    return new Map(rows.map(({ id, originalFileName }) => [id, originalFileName]));
  }

  async dismiss(albumId: string, assetIds: string[]): Promise<void> {
    if (assetIds.length === 0) return;
    await this.db
      .insertInto('album_suggestion_dismissal')
      .values(assetIds.map((assetId) => ({ albumId, assetId })))
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  async isAutoAdd(albumId: string, userId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('album_suggestion_auto_add')
      .select('albumId')
      .where('albumId', '=', albumId)
      .where('userId', '=', userId)
      .executeTakeFirst();
    return !!row;
  }

  async setAutoAdd(albumId: string, userId: string, enabled: boolean): Promise<void> {
    await (enabled
      ? this.db
          .insertInto('album_suggestion_auto_add')
          .values({ albumId, userId })
          .onConflict((oc) => oc.doNothing())
          .execute()
      : this.db
          .deleteFrom('album_suggestion_auto_add')
          .where('albumId', '=', albumId)
          .where('userId', '=', userId)
          .execute());
  }

  /** Albums where `userId` asked for new photos from the trip to be added; deleted albums excluded. */
  async getAutoAddAlbumIds(userId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('album_suggestion_auto_add')
      .innerJoin('album', 'album.id', 'album_suggestion_auto_add.albumId')
      .where('album_suggestion_auto_add.userId', '=', userId)
      .where('album.deletedAt', 'is', null)
      .select('album.id')
      .execute();
    return rows.map(({ id }) => id);
  }
}
