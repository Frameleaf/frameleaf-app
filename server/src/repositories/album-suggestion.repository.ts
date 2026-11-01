import { Kysely, sql } from 'kysely';
import type { DB } from 'src/schema/index.js';
import { LibraryScope } from 'src/enum.js';
import { LOOKS_LIKE_DISTANCE } from 'src/utils/album-suggestions.js';
import { hiddenByOwnerRules, validLandmarkMatch } from 'src/utils/database.js';
import { libraryScopePredicate } from 'src/utils/library-scope.js';
import { isNotLocked, isTimelineVisible } from 'src/utils/locked.js';

/** ponytail: caps keep one album's suggestions to a few bounded queries; page them if albums outgrow them. */
const MAX_TRIP_PHOTOS = 5000;
const MAX_CANDIDATES = 1000;
const MAX_VISUAL_REFERENCES = 100;
const MAX_UNDATED_REFERENCES = 40;
const UNDATED_NEIGHBOURS = 20;

/** Names that show a photo was saved or received rather than taken: Facebook, WhatsApp, Messenger. */
const SAVED_NAME = String.raw`^(FB_IMG_\d{13}|(IMG|VID)-\d{8}-WA\d+|received_\d+)`;

/** Personal-library media on the timeline, not trashed, Locked or hidden by its owner's rules. */
const suggestible = (alias: string) => sql<boolean>`(
  ${isTimelineVisible(alias)} and ${libraryScopePredicate(LibraryScope.Personal, alias)}
  and ${sql.ref(`${alias}.deletedAt`)} is null
  and not ${hiddenByOwnerRules(alias)}
)`;

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
  takenAt: Date;
  localDateTime: Date;
  latitude: number | null;
  longitude: number | null;
  place: string | null;
  make: string | null;
  model: string | null;
};

export type CandidateRow = TripPhotoRow & { originalFileName: string; hasCameraDetails: boolean };

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

  /** The album's own photos that are not Locked, to describe its trip. */
  getTripPhotos(albumId: string): Promise<TripPhotoRow[]> {
    return this.db
      .selectFrom('album_asset')
      .innerJoin('asset as photo', 'photo.id', 'album_asset.assetId')
      .leftJoin('asset_exif as photo_exif', 'photo_exif.assetId', 'photo.id')
      .where('album_asset.albumId', '=', albumId)
      .where('photo.deletedAt', 'is', null)
      .where(isNotLocked('photo'))
      .select([
        'photo.id',
        'photo.fileCreatedAt as takenAt',
        'photo.localDateTime',
        'photo_exif.make',
        'photo_exif.model',
        ...this.located('photo'),
      ])
      .orderBy('photo.fileCreatedAt')
      .limit(MAX_TRIP_PHOTOS)
      .execute();
  }

  /** When the album's photos (not Locked) were taken, for a cheap check before reading them all. */
  async getTimeSpan(albumId: string): Promise<{ from: Date; to: Date } | undefined> {
    const row = await this.db
      .selectFrom('album_asset')
      .innerJoin('asset as photo', 'photo.id', 'album_asset.assetId')
      .where('album_asset.albumId', '=', albumId)
      .where('photo.deletedAt', 'is', null)
      .where(isNotLocked('photo'))
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
        sql<boolean>`(candidate_exif.make is not null or candidate_exif.model is not null
          or candidate_exif."timeZone" is not null)`.as('hasCameraDetails'),
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
              and candidate_exif.model is null and candidate_exif."timeZone" is null))`,
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

/** Evenly spaced picks, so a long trip is represented from start to end. */
const sample = <T>(items: T[], count: number): T[] => {
  if (items.length <= count) return items;
  const step = items.length / count;
  return Array.from({ length: count }, (_, index) => items[Math.floor(index * step)]);
};
