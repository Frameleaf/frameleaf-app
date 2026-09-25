import { ConflictException, Injectable } from '@nestjs/common';
import { type ExpressionBuilder, type Insertable, type Kysely, type Transaction, type Updateable, sql } from 'kysely';
import { jsonObjectFrom } from 'kysely/helpers/postgres';
import { InjectKysely } from 'nestjs-kysely';
import type { ForkSchemaPhase } from 'src/repositories/fork-schema.repository.js';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import type { LockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import { AssetFace } from 'src/database.js';
import { Chunked, ChunkedArray, DummyValue, GenerateSql } from 'src/decorators.js';
import { AssetFileType, SourceType, UserMetadataKey } from 'src/enum.js';
import { isForkWriteEnabled, isLegacyAuthoritative } from 'src/fork-schema/authority.js';
import { DB } from 'src/schema/index.js';
import { AssetFaceTable } from 'src/schema/tables/asset-face.table.js';
import { FaceSearchTable } from 'src/schema/tables/face-search.table.js';
import { PersonGroupTable } from 'src/schema/tables/person-group.table.js';
import { PersonTable } from 'src/schema/tables/person.table.js';
import {
  anyUuid,
  asUuid,
  dummy,
  inSharedAlbum,
  isNotLockedAsset,
  nsfwAssetIdExists,
  removeUndefinedKeys,
  withFilePath,
  withHiddenContentFilter,
  withLockedOwnerScope,
} from 'src/utils/database.js';
import { effectiveVisibility, isTimelineVisible } from 'src/utils/locked.js';
import { type PaginationOptions, paginationHelper } from 'src/utils/pagination.js';

export interface PersonSearchOptions extends HiddenContentQueryOptions {
  withHidden: boolean;
  closestFaceAssetId?: string;
}

export interface PersonNameSearchOptions extends HiddenContentQueryOptions {
  withHidden?: boolean;
}

export interface PersonNameResponse {
  personGroupId: string;
  name: string;
}

export interface AssetFaceId {
  assetId: string;
  personGroupId: string;
}

export interface UpdateFacesData {
  oldPersonGroupId?: string;
  faceIds?: string[];
  ownerId?: string;
  newPersonGroupId: string;
}

export interface PersonStatistics {
  assets: number;
}

export interface DeleteFacesOptions {
  sourceType: SourceType;
}

export interface GetAllPeopleOptions {
  ownerId?: string;
  thumbnailPath?: string;
  faceAssetId?: string | null;
  isHidden?: boolean;
}

export interface GetAllFacesOptions {
  personGroupId?: string | null;
  assetId?: string;
  sourceType?: SourceType;
  clusterGroupId?: string;
}

export type UnassignFacesOptions = DeleteFacesOptions & { clusterGroupId?: string };

/** FL-57: an owner's answer to a merge suggestion they did not accept. */
export type PersonMergeVerdict = 'different' | 'later';

export type GetFacesOptions = WithPersonOptions & {
  isVisible?: boolean;
  /** FL-38: also return faces the owner hid (soft-deleted, `deletedAt` set). */
  withHidden?: boolean;
};

/** FL-38: a face box in pixels of an image of `imageWidth` x `imageHeight`. */
export type FaceBoxPixels = {
  imageWidth: number;
  imageHeight: number;
  boundingBoxX1: number;
  boundingBoxY1: number;
  boundingBoxX2: number;
  boundingBoxY2: number;
};

/**
 * FL-38: one revision-checked correction of a face. `personGroupId: null` unassigns it, a box
 * moves or resizes it (in original-image pixels) and `hidden` hides or restores it.
 */
export type FaceCorrection = {
  personGroupId?: string | null;
  box?: FaceBoxPixels;
  hidden?: boolean;
};

/** a person is identified by its owner and the group it belongs to */
export type PersonId = { ownerId: string; personGroupId: string };

export type ReassignCluster = { userId: string; newClusterId: string };

export type WithPersonOptions = {
  /** whose version of the person to select */
  viewingUserId: string;
};

const withPerson = ({ viewingUserId }: WithPersonOptions) => {
  return (eb: ExpressionBuilder<DB, 'asset_face'>) =>
    jsonObjectFrom(
      eb
        .selectFrom('person')
        .selectAll('person')
        .whereRef('person.personGroupId', '=', 'asset_face.personGroupId')
        .where('person.ownerId', '=', viewingUserId),
    ).as('person');
};

const withFaceSearch = (eb: ExpressionBuilder<DB, 'asset_face'>) => {
  return jsonObjectFrom(
    eb.selectFrom('face_search').selectAll('face_search').whereRef('face_search.faceId', '=', 'asset_face.id'),
  ).as('faceSearch');
};

@Injectable()
export class PersonRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [{ oldPersonGroupId: DummyValue.UUID, newPersonGroupId: DummyValue.UUID }] })
  async reassignFaces({ oldPersonGroupId, faceIds, ownerId, newPersonGroupId }: UpdateFacesData): Promise<number> {
    const result = await this.db
      .updateTable('asset_face')
      .from('asset')
      .whereRef('asset_face.assetId', '=', 'asset.id')
      .set({ personGroupId: newPersonGroupId })
      .$if(!!oldPersonGroupId, (qb) => qb.where('asset_face.personGroupId', '=', oldPersonGroupId!))
      .$if(!!faceIds, (qb) => qb.where('asset_face.id', 'in', faceIds!))
      .$if(!!ownerId, (qb) => qb.where('asset.ownerId', '=', ownerId!))
      .executeTakeFirst();

    return Number(result.numUpdatedRows ?? 0);
  }

  @GenerateSql({ params: [{ sourceType: SourceType.MachineLearning, clusterGroupId: DummyValue.UUID }] })
  async unassignFaces({ sourceType, clusterGroupId }: UnassignFacesOptions): Promise<void> {
    await this.db
      .updateTable('asset_face')
      // FL-38: a forced re-run starts clustering over, so earlier corrections no longer hold the
      // face back from recognition (see handleRecognizeFaces)
      .set({ personGroupId: null, correctedAt: null })
      .from('asset')
      .whereRef('asset_face.assetId', '=', 'asset.id')
      .where('asset_face.sourceType', '=', sourceType)
      .$if(!!clusterGroupId, (qb) =>
        qb.innerJoin('user', 'user.id', 'asset.ownerId').where('user.clusterGroupId', '=', clusterGroupId!),
      )
      .execute();
  }

  @GenerateSql({ params: [[DummyValue.UUID], DummyValue.UUID] })
  @Chunked()
  async delete(personGroupIds: string[], ownerId?: string) {
    if (personGroupIds.length === 0) {
      return [];
    }

    return this.db
      .deleteFrom('person')
      .$if(!!ownerId, (qb) => qb.where('ownerId', '=', ownerId!))
      .where('person.personGroupId', 'in', personGroupIds)
      .returning(['personGroupId', 'ownerId', 'thumbnailPath'])
      .execute();
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  @Chunked()
  async deleteGroups(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    await this.db.deleteFrom('person_group').where('person_group.id', 'in', ids).execute();
  }

  @GenerateSql()
  async deleteEmptyGroups(): Promise<number> {
    const result = await this.db
      .deleteFrom('person_group')
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('person')
              .whereRef('person.personGroupId', '=', 'person_group.id')
              .select('person.personGroupId'),
          ),
        ),
      )
      .executeTakeFirst();

    return Number(result.numDeletedRows);
  }

  @GenerateSql()
  async deleteOrphanedClusterGroups(): Promise<number> {
    const result = await this.db
      .deleteFrom('cluster_group')
      .where(({ not, exists, selectFrom }) =>
        not(exists(selectFrom('user').whereRef('user.clusterGroupId', '=', 'cluster_group.id').select('user.id'))),
      )
      .executeTakeFirst();

    return Number(result.numDeletedRows);
  }

  async deleteFaces({ sourceType }: DeleteFacesOptions): Promise<void> {
    await this.db.deleteFrom('asset_face').where('asset_face.sourceType', '=', sourceType).execute();
  }

  @GenerateSql({
    params: [{ personGroupId: null, sourceType: SourceType.MachineLearning, clusterGroupId: DummyValue.UUID }],
    stream: true,
  })
  getAllFaces(options: GetAllFacesOptions = {}) {
    return this.db
      .selectFrom('asset_face')
      .selectAll('asset_face')
      .$if(options.personGroupId === null, (qb) => qb.where('asset_face.personGroupId', 'is', null))
      .$if(!!options.personGroupId, (qb) => qb.where('asset_face.personGroupId', '=', options.personGroupId!))
      .$if(!!options.sourceType, (qb) => qb.where('asset_face.sourceType', '=', options.sourceType!))
      .$if(!!options.assetId, (qb) => qb.where('asset_face.assetId', '=', options.assetId!))
      .$if(!!options.clusterGroupId, (qb) =>
        qb
          .innerJoin('asset', 'asset.id', 'asset_face.assetId')
          .innerJoin('user', 'user.id', 'asset.ownerId')
          .where('user.clusterGroupId', '=', options.clusterGroupId!),
      )
      .where('asset_face.deletedAt', 'is', null)
      .where('asset_face.isVisible', 'is', true)
      .stream();
  }

  getAll(options: GetAllPeopleOptions = {}) {
    return this.db
      .selectFrom('person')
      .selectAll('person')
      .$if(!!options.ownerId, (qb) => qb.where('person.ownerId', '=', options.ownerId!))
      .$if(options.thumbnailPath !== undefined, (qb) => qb.where('person.thumbnailPath', '=', options.thumbnailPath!))
      .$if(options.faceAssetId === null, (qb) => qb.where('person.faceAssetId', 'is', null))
      .$if(!!options.faceAssetId, (qb) => qb.where('person.faceAssetId', '=', options.faceAssetId!))
      .$if(options.isHidden !== undefined, (qb) => qb.where('person.isHidden', '=', options.isHidden!))
      .stream();
  }

  @GenerateSql()
  getFileSamples() {
    return this.db
      .selectFrom('person')
      .select(['ownerId', 'personGroupId', 'thumbnailPath'])
      .where('thumbnailPath', '!=', sql.lit(''))
      .limit(sql.lit(3))
      .execute();
  }

  @GenerateSql({ params: [{ take: 1, skip: 0 }, DummyValue.UUID] })
  async getAllForUser(pagination: PaginationOptions, userId: string, options?: PersonSearchOptions) {
    const items = await this.db
      .selectFrom('person')
      .selectAll('person')
      .innerJoin('asset_face', 'asset_face.personGroupId', 'person.personGroupId')
      .innerJoin('asset', (join) =>
        join
          .onRef('asset_face.assetId', '=', 'asset.id')
          .onRef('asset.ownerId', '=', 'person.ownerId')
          .on(isTimelineVisible('asset'))
          .on('asset.deletedAt', 'is', null),
      )
      // FL-37: the People grid shows "N items" per card and sorts by photo count or by the
      // most recent capture. Both come from the rows this query already joins (timeline-visible,
      // not deleted, not locked), so the counts never include content the grid would not show.
      .select((eb) => [
        eb.fn.count<number>('asset_face.assetId').distinct().as('assetCount'),
        eb.fn.max('asset.fileCreatedAt').as('lastSeenAt'),
      ])
      .$call((qb) => withHiddenContentFilter(qb, options))
      .where('person.ownerId', '=', userId)
      .where('asset_face.deletedAt', 'is', null)
      .where('asset_face.isVisible', 'is', true)
      .orderBy('person.isHidden', 'asc')
      .orderBy('person.isFavorite', 'desc')
      .having((eb) =>
        eb.or([
          eb('person.name', '!=', ''),
          eb(
            (innerEb) => innerEb.fn.count('asset_face.assetId'),
            '>=',
            sql<number>`COALESCE(
              (SELECT value -> 'people' ->> 'minimumFaces'
              FROM user_metadata
              WHERE "userId" = ${userId}
                AND key = ${sql.lit(UserMetadataKey.Preferences)}),
              '3'
            )::int `,
          ),
        ]),
      )
      .groupBy(['person.ownerId', 'person.personGroupId'])
      .$if(!!options?.closestFaceAssetId, (qb) =>
        qb.orderBy((eb) =>
          eb(
            (eb) =>
              eb
                .selectFrom('face_search')
                .select('face_search.embedding')
                .whereRef('face_search.faceId', '=', 'person.faceAssetId'),
            '<=>',
            (eb) =>
              eb
                .selectFrom('face_search')
                .select('face_search.embedding')
                .where('face_search.faceId', '=', options!.closestFaceAssetId!),
          ),
        ),
      )
      .$if(!options?.closestFaceAssetId, (qb) =>
        qb
          .orderBy(sql`NULLIF(person.name, '') is null`, 'asc')
          .orderBy((eb) => eb.fn.count('asset_face.assetId'), 'desc')
          .orderBy(sql`NULLIF(person.name, '')`, (om) => om.asc().nullsLast())
          .orderBy('person.createdAt'),
      )
      .$if(!options?.withHidden, (qb) => qb.where('person.isHidden', '=', false))
      .offset(pagination.skip ?? 0)
      .limit(pagination.take + 1)
      .execute();

    return paginationHelper(items, pagination.take);
  }

  @GenerateSql()
  getAllWithoutFaces() {
    return this.db
      .selectFrom('person')
      .selectAll('person')
      .leftJoin('asset_face', 'asset_face.personGroupId', 'person.personGroupId')
      .where('asset_face.deletedAt', 'is', null)
      .where((eb) => eb.or([eb('asset_face.isVisible', 'is', null), eb('asset_face.isVisible', '=', true)]))
      .having((eb) => eb.fn.count('asset_face.assetId'), '=', 0)
      .groupBy(['person.ownerId', 'person.personGroupId'])
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, { viewingUserId: DummyValue.UUID, isVisible: true }] })
  getFaces(assetId: string, options: GetFacesOptions) {
    const { viewingUserId, isVisible, withHidden } = options;

    return this.db
      .selectFrom('asset_face')
      .selectAll('asset_face')
      .select(withPerson({ viewingUserId }))
      .where('asset_face.assetId', '=', assetId)
      .$if(!withHidden, (qb) => qb.where('asset_face.deletedAt', 'is', null))
      .$if(isVisible !== undefined, (qb) => qb.where('asset_face.isVisible', '=', isVisible!))
      .orderBy('asset_face.boundingBoxX1', 'asc')
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, { viewingUserId: DummyValue.UUID }] })
  getFaceById(id: string, { viewingUserId }: WithPersonOptions) {
    // TODO return null instead of find or fail
    return this.db
      .selectFrom('asset_face')
      .selectAll('asset_face')
      .select(withPerson({ viewingUserId }))
      .where('asset_face.id', '=', id)
      .where('asset_face.deletedAt', 'is', null)
      .executeTakeFirstOrThrow();
  }

  /** FL-38: a face for a correction, including one its owner hid (so it can be shown again). */
  getFaceForCorrection(id: string, { viewingUserId }: WithPersonOptions) {
    return this.db
      .selectFrom('asset_face')
      .selectAll('asset_face')
      .select(withPerson({ viewingUserId }))
      .where('asset_face.id', '=', id)
      .executeTakeFirst();
  }

  /**
   * FL-38: applies a correction only while the face is still at `expectedRevision` (its
   * `updateId`, renewed by the `asset_face_updatedAt` trigger on every update), so a correction
   * made against an older face never overwrites a newer change. Returns the rows changed (0 when
   * the face moved on). Person and box changes stamp `correctedAt` like `reassignFace`; hiding or
   * showing a face does not, since it corrects neither identity nor position.
   */
  async correctFace(id: string, expectedRevision: string, { personGroupId, box, hidden }: FaceCorrection) {
    const corrected = personGroupId !== undefined || box !== undefined;
    const result = await this.db
      .updateTable('asset_face')
      .set({
        ...(personGroupId !== undefined && { personGroupId }),
        // a box is drawn on the displayed image, so it is visible there by construction
        ...(box && { ...box, isVisible: true }),
        ...(hidden !== undefined && { deletedAt: hidden ? sql<Date>`clock_timestamp()` : null }),
        ...(corrected && { correctedAt: sql<Date>`clock_timestamp()` }),
      })
      .where('asset_face.id', '=', id)
      .where('asset_face.updateId', '=', expectedRevision)
      .executeTakeFirst();

    return Number(result.numUpdatedRows);
  }

  /** FL-38: deletes (or soft-deletes) a face only while it is still at `expectedRevision`. */
  async deleteFaceAtRevision(id: string, expectedRevision: string, { force }: { force: boolean }) {
    const result = force
      ? await this.db
          .deleteFrom('asset_face')
          .where('asset_face.id', '=', id)
          .where('asset_face.updateId', '=', expectedRevision)
          .executeTakeFirst()
      : await this.db
          .updateTable('asset_face')
          .set({ deletedAt: sql<Date>`clock_timestamp()` })
          .where('asset_face.id', '=', id)
          .where('asset_face.updateId', '=', expectedRevision)
          .executeTakeFirst();

    return Number('numDeletedRows' in result ? result.numDeletedRows : result.numUpdatedRows);
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getFaceForFacialRecognitionJob(id: string) {
    return this.db
      .selectFrom('asset_face')
      .select(['asset_face.id', 'asset_face.personGroupId', 'asset_face.sourceType', 'asset_face.correctedAt'])
      .select((eb) =>
        jsonObjectFrom(
          eb
            .selectFrom('asset')
            .innerJoin('user', 'user.id', 'asset.ownerId')
            .select([
              'asset.ownerId',
              effectiveVisibility('asset').as('visibility'),
              'asset.fileCreatedAt',
              'user.clusterGroupId',
            ])
            .whereRef('asset.id', '=', 'asset_face.assetId'),
        ).as('asset'),
      )
      .select(withFaceSearch)
      .where('asset_face.id', '=', id)
      .where('asset_face.deletedAt', 'is', null)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [{ ownerId: DummyValue.UUID, personGroupId: DummyValue.UUID }] })
  getDataForThumbnailGenerationJob({ ownerId, personGroupId }: PersonId) {
    return this.db
      .selectFrom('person')
      .innerJoin('asset_face', 'asset_face.id', 'person.faceAssetId')
      .innerJoin('asset', 'asset_face.assetId', 'asset.id')
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select([
        'person.ownerId',
        'asset_face.boundingBoxX1 as x1',
        'asset_face.boundingBoxY1 as y1',
        'asset_face.boundingBoxX2 as x2',
        'asset_face.boundingBoxY2 as y2',
        'asset_face.imageWidth as oldWidth',
        'asset_face.imageHeight as oldHeight',
        'asset.type',
        'asset.originalPath',
        'asset_exif.orientation as exifOrientation',
      ])
      .select((eb) => withFilePath(eb, AssetFileType.Preview).as('previewPath'))
      .where('person.ownerId', '=', ownerId)
      .where('person.personGroupId', '=', personGroupId)
      .where('asset_face.deletedAt', 'is', null)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  async reassignFace(assetFaceId: string, newPersonGroupId: string): Promise<number> {
    // FL-57: stamps `correctedAt` so a face a person explicitly moved between people
    // (single reassign, or the split flow's per-face loop) shows up in that person's
    // correction history and survives reprocessing. The bulk `reassignFaces` below is
    // only used for a whole-person merge, which is already durable as a person-level
    // event, so it intentionally leaves `correctedAt` alone to avoid flooding the
    // history with every face a merge happened to move.
    const result = await this.db
      .updateTable('asset_face')
      .set({ personGroupId: newPersonGroupId, correctedAt: sql`clock_timestamp()` })
      .where('asset_face.id', '=', assetFaceId)
      .executeTakeFirst();

    return Number(result.numUpdatedRows);
  }

  @GenerateSql({ params: [{ ownerId: DummyValue.UUID, personGroupId: DummyValue.UUID }] })
  getByGroupId({ ownerId, personGroupId }: PersonId) {
    return this.db //
      .selectFrom('person')
      .selectAll('person')
      .where('person.personGroupId', '=', personGroupId)
      .where('person.ownerId', '=', ownerId)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING, { withHidden: true }] })
  getByName(userId: string, personName: string, options: PersonNameSearchOptions) {
    return this.db
      .with('similarity_threshold', (db) =>
        db.selectNoFrom(sql`set_config('pg_trgm.word_similarity_threshold', '0.5', true)`.as('thresh')),
      )
      .selectFrom(['similarity_threshold', 'person'])
      .selectAll('person')
      .where('person.ownerId', '=', userId)
      .where(() => sql`f_unaccent("person"."name") %> f_unaccent(${personName})`)
      .orderBy(sql`f_unaccent("person"."name") <->>> f_unaccent(${personName})`)
      .limit(100)
      .$if(!options.withHidden, (qb) => qb.where('person.isHidden', '=', false))
      .where((eb) =>
        eb.exists((eb) =>
          eb
            .selectFrom('asset_face')
            .innerJoin('asset', (join) =>
              join
                .onRef('asset.id', '=', 'asset_face.assetId')
                .on(isTimelineVisible('asset'))
                .on('asset.deletedAt', 'is', null),
            )
            .whereRef('asset_face.personGroupId', '=', 'person.personGroupId')
            .where('asset_face.deletedAt', 'is', null)
            .where('asset_face.isVisible', 'is', true)
            .$call((qb) => withHiddenContentFilter(qb, options)),
        ),
      )
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, { withHidden: true }] })
  getDistinctNames(userId: string, { withHidden }: PersonNameSearchOptions): Promise<PersonNameResponse[]> {
    return this.db
      .selectFrom('person')
      .select(['person.personGroupId', 'person.name'])
      .distinctOn((eb) => eb.fn('lower', ['person.name']))
      .where((eb) => eb.and([eb('person.ownerId', '=', userId), eb('person.name', '!=', '')]))
      .$if(!withHidden, (qb) => qb.where('person.isHidden', '=', false))
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  async getStatistics(
    personGroupId: string,
    userId: string,
    options: HiddenContentQueryOptions = {},
  ): Promise<PersonStatistics> {
    const result = await this.db
      .selectFrom('asset_face')
      .leftJoin('asset', (join) =>
        join
          .onRef('asset.id', '=', 'asset_face.assetId')
          .on(isTimelineVisible('asset'))
          .on('asset.deletedAt', 'is', null)
          .on((eb) => eb.or([eb('asset.ownerId', '=', asUuid(userId)), inSharedAlbum(eb, userId)])),
      )
      .select((eb) => eb.fn.count(eb.fn('distinct', ['asset.id'])).as('count'))
      .$call((qb) => withHiddenContentFilter(qb, options))
      .where('asset_face.deletedAt', 'is', null)
      .where('asset_face.isVisible', 'is', true)
      .where('asset_face.personGroupId', '=', personGroupId)
      .executeTakeFirst();

    return {
      assets: result ? Number(result.count) : 0,
    };
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getNumberOfPeople(userId: string, options: HiddenContentQueryOptions = {}) {
    const zero = sql.lit(0);
    return this.db
      .selectFrom('person')
      .where((eb) =>
        eb.exists((eb) =>
          eb
            .selectFrom('asset_face')
            .whereRef('asset_face.personGroupId', '=', 'person.personGroupId')
            .where('asset_face.deletedAt', 'is', null)
            .where('asset_face.isVisible', '=', true)
            .where((eb) =>
              eb.exists((eb) =>
                eb
                  .selectFrom('asset')
                  .whereRef('asset.id', '=', 'asset_face.assetId')
                  .where(isTimelineVisible('asset'))
                  .where('asset.deletedAt', 'is', null)
                  .$call((qb) => withHiddenContentFilter(qb, options)),
              ),
            ),
        ),
      )
      .where('person.ownerId', '=', userId)
      .select((eb) => eb.fn.coalesce(eb.fn.countAll<number>(), zero).as('total'))
      .select((eb) => eb.fn.coalesce(eb.fn.countAll<number>().filterWhere('isHidden', '=', true), zero).as('hidden'))
      .executeTakeFirstOrThrow();
  }

  create(person: Insertable<PersonTable>) {
    return this.db.insertInto('person').values(person).returningAll().executeTakeFirstOrThrow();
  }

  async createAll(people: Insertable<PersonTable>[]) {
    if (people.length === 0) {
      return [];
    }

    return this.db.insertInto('person').values(people).returningAll().execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  createGroup(ownerId: string) {
    return this.db
      .insertInto('person_group')
      .columns(['clusterGroupId'])
      .expression((eb) => eb.selectFrom('user').select('user.clusterGroupId').where('user.id', '=', ownerId))
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [{ userId: DummyValue.UUID, newClusterId: DummyValue.UUID }] })
  async reassignCluster({ userId, newClusterId }: ReassignCluster): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      // a group nobody else has people in moves across as it is
      await trx
        .updateTable('person_group')
        .set({ clusterGroupId: newClusterId })
        .where('person_group.id', 'in', (eb) =>
          eb.selectFrom('person').select('person.personGroupId').where('person.ownerId', '=', userId),
        )
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('person')
                .select('person.personGroupId')
                .whereRef('person.personGroupId', '=', 'person_group.id')
                .where('person.ownerId', '!=', userId),
            ),
          ),
        )
        .execute();

      // the rest is shared with someone else, so this user gets a group of their own for each
      const mapping = await trx
        .with('shared', (db) =>
          db
            .selectFrom('person')
            .select('person.personGroupId as oldId')
            .distinct()
            .where('person.ownerId', '=', userId)
            .where(({ exists, selectFrom }) =>
              exists(
                selectFrom('person as other')
                  .select('other.personGroupId')
                  .whereRef('other.personGroupId', '=', 'person.personGroupId')
                  .where('other.ownerId', '!=', userId),
              ),
            ),
        )
        .with(
          (cte) => cte('mapping').materialized(),
          (db) => db.selectFrom('shared').select(['shared.oldId', sql<string>`uuid_generate_v4()`.as('newId')]),
        )
        .with('created', (db) =>
          db
            .insertInto('person_group')
            .columns(['id', 'clusterGroupId'])
            .expression((eb) =>
              eb.selectFrom('mapping').select(['mapping.newId', sql.val(newClusterId).as('clusterGroupId')]),
            ),
        )
        .selectFrom('mapping')
        .select(['mapping.oldId', 'mapping.newId'])
        .execute();

      if (mapping.length === 0) {
        return;
      }

      const oldIds = mapping.map(({ oldId }) => oldId);
      const newIds = mapping.map(({ newId }) => newId);
      const remapped = sql<{
        oldId: string;
        newId: string;
      }>`(select unnest(${`{${oldIds}}`}::uuid[]) as "oldId", unnest(${`{${newIds}}`}::uuid[]) as "newId")`.as(
        'mapping',
      );

      await trx
        .updateTable('person')
        .from(remapped)
        .set((eb) => ({ personGroupId: eb.ref('mapping.newId') }))
        .whereRef('person.personGroupId', '=', 'mapping.oldId')
        .where('person.ownerId', '=', userId)
        .execute();

      await trx
        .updateTable('asset_face')
        .from(remapped)
        .set((eb) => ({ personGroupId: eb.ref('mapping.newId') }))
        .whereRef('asset_face.personGroupId', '=', 'mapping.oldId')
        .where(({ exists, selectFrom }) =>
          exists(
            selectFrom('asset')
              .select('asset.id')
              .whereRef('asset.id', '=', 'asset_face.assetId')
              .where('asset.ownerId', '=', userId),
          ),
        )
        .execute();
    });
  }

  @GenerateSql({ params: [DummyValue.UUID, 2] })
  async createGroups(personGroups: Insertable<PersonGroupTable>[]) {
    if (personGroups.length === 0) {
      return [];
    }

    return this.db.insertInto('person_group').values(personGroups).returningAll().execute();
  }

  @GenerateSql({ params: [[], [], [{ faceId: DummyValue.UUID, embedding: DummyValue.VECTOR }]] })
  async refreshFaces(
    facesToAdd: (Insertable<AssetFaceTable> & { assetId: string })[],
    faceIdsToRemove: string[],
    embeddingsToAdd?: Insertable<FaceSearchTable>[],
  ): Promise<void> {
    let query = this.db;
    if (facesToAdd.length > 0) {
      (query as any) = query.with('added', (db) => db.insertInto('asset_face').values(facesToAdd));
    }

    if (faceIdsToRemove.length > 0) {
      (query as any) = query.with('removed', (db) =>
        db.deleteFrom('asset_face').where('asset_face.id', '=', (eb) => eb.fn.any(eb.val(faceIdsToRemove))),
      );
    }

    if (embeddingsToAdd?.length) {
      (query as any) = query.with('added_embeddings', (db) => db.insertInto('face_search').values(embeddingsToAdd));
    }

    await query.selectFrom(dummy).execute();
  }

  async update(person: Updateable<PersonTable> & PersonId) {
    return this.db
      .updateTable('person')
      .set(person)
      .where('person.ownerId', '=', person.ownerId)
      .where('person.personGroupId', '=', person.personGroupId)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async updateAll(people: Insertable<PersonTable>[]): Promise<void> {
    if (people.length === 0) {
      return;
    }

    await this.db
      .insertInto('person')
      .values(people)
      .onConflict((oc) =>
        oc.columns(['ownerId', 'personGroupId']).doUpdateSet((eb) =>
          removeUndefinedKeys(
            {
              name: eb.ref('excluded.name'),
              birthDate: eb.ref('excluded.birthDate'),
              thumbnailPath: eb.ref('excluded.thumbnailPath'),
              faceAssetId: eb.ref('excluded.faceAssetId'),
              isHidden: eb.ref('excluded.isHidden'),
              isFavorite: eb.ref('excluded.isFavorite'),
              color: eb.ref('excluded.color'),
            },
            people[0],
          ),
        ),
      )
      .execute();
  }

  @GenerateSql({
    params: [[{ assetId: DummyValue.UUID, personGroupId: DummyValue.UUID }], { viewingUserId: DummyValue.UUID }],
  })
  @ChunkedArray()
  getFacesByIds(ids: AssetFaceId[], { viewingUserId }: WithPersonOptions) {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }

    const assetIds: string[] = [];
    const personGroupIds: string[] = [];
    for (const { assetId, personGroupId } of ids) {
      assetIds.push(assetId);
      personGroupIds.push(personGroupId);
    }

    return this.db
      .selectFrom('asset_face')
      .selectAll('asset_face')
      .select(withPerson({ viewingUserId }))
      .where('asset_face.assetId', 'in', assetIds)
      .where('asset_face.personGroupId', 'in', personGroupIds)
      .where('asset_face.deletedAt', 'is', null)
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getRandomFace(personGroupId: string) {
    return (
      this.db
        .selectFrom('asset_face')
        .selectAll('asset_face')
        // A Locked photo is never a face thumbnail (FL-53): the thumbnail is shown on the people page
        // and wherever the person is listed, whatever the session.
        .innerJoin('asset', (join) =>
          join.onRef('asset.id', '=', 'asset_face.assetId').on((eb) => isNotLockedAsset(eb)),
        )
        .where('asset_face.personGroupId', '=', personGroupId)
        .where('asset_face.deletedAt', 'is', null)
        .where('asset_face.isVisible', 'is', true)
        // Prefer a non-NSFW face for person thumbnails; NSFW-only people still get one.
        .orderBy(sql`${nsfwAssetIdExists(sql.ref('asset_face.assetId'))} asc`)
        .executeTakeFirst()
    );
  }

  /**
   * People with a face on one of `assetIds`, or on another photo of their stacks, who have a featured
   * face but no thumbnail: after those assets move into the Locked folder, taking the rest of their
   * stacks with them, the people whose featured face was on them (FL-53). Their thumbnail is
   * generated anew from the face that replaced it.
   */
  @GenerateSql({ params: [[DummyValue.UUID]] })
  @ChunkedArray()
  getMissingThumbnailsForAssets(assetIds: string[]): Promise<PersonId[]> {
    if (assetIds.length === 0) {
      return Promise.resolve([]);
    }

    return this.db
      .selectFrom('person')
      .select(['person.ownerId', 'person.personGroupId'])
      .where('person.thumbnailPath', '=', sql.lit(''))
      .where('person.faceAssetId', 'is not', null)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('asset_face')
            .whereRef('asset_face.personGroupId', '=', 'person.personGroupId')
            .where((eb) =>
              eb.or([
                eb('asset_face.assetId', '=', anyUuid(assetIds)),
                eb(
                  'asset_face.assetId',
                  'in',
                  eb
                    .selectFrom('asset as stacked')
                    .innerJoin('asset as moved', 'moved.stackId', 'stacked.stackId')
                    .select('stacked.id')
                    .where('moved.id', '=', anyUuid(assetIds)),
                ),
              ]),
            ),
        ),
      )
      .execute();
  }

  @GenerateSql()
  async getLatestFaceDate(): Promise<string | undefined> {
    const result = (await this.db
      .selectFrom('asset_job_status')
      .select((eb) => sql`${eb.fn.max('asset_job_status.facesRecognizedAt')}::text`.as('latestDate'))
      .executeTakeFirst()) as { latestDate: string } | undefined;

    return result?.latestDate;
  }

  async createAssetFace(face: Insertable<AssetFaceTable>): Promise<void> {
    await this.db.insertInto('asset_face').values(face).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async deleteAssetFace(id: string): Promise<void> {
    await this.db.deleteFrom('asset_face').where('asset_face.id', '=', id).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async softDeleteAssetFaces(id: string): Promise<void> {
    await this.db.updateTable('asset_face').set({ deletedAt: new Date() }).where('asset_face.id', '=', id).execute();
  }

  async vacuum({ reindexVectors }: { reindexVectors: boolean }): Promise<void> {
    await sql`VACUUM ANALYZE asset_face, face_search, person`.execute(this.db);
    await sql`REINDEX TABLE asset_face`.execute(this.db);
    await sql`REINDEX TABLE person`.execute(this.db);
    if (reindexVectors) {
      await sql`REINDEX TABLE face_search`.execute(this.db);
    }
  }

  @GenerateSql({ params: [[], []] })
  async updateVisibility(visible: AssetFace[], hidden: AssetFace[]): Promise<void> {
    if (visible.length === 0 && hidden.length === 0) {
      return;
    }

    await this.db.transaction().execute(async (trx) => {
      if (visible.length > 0) {
        await trx
          .updateTable('asset_face')
          .set({ isVisible: true })
          .where(
            'asset_face.id',
            'in',
            visible.map(({ id }) => id),
          )
          .execute();
      }

      if (hidden.length > 0) {
        await trx
          .updateTable('asset_face')
          .set({ isVisible: false })
          .where(
            'asset_face.id',
            'in',
            hidden.map(({ id }) => id),
          )
          .execute();
      }
    });
  }

  @GenerateSql({ params: [{ personGroupId: DummyValue.UUID, assetId: DummyValue.UUID }] })
  getForFeatureFaceUpdate({ personGroupId, assetId }: { personGroupId: string; assetId: string }) {
    return (
      this.db
        .selectFrom('asset_face')
        .select('asset_face.id')
        .innerJoin('asset', (join) =>
          join.onRef('asset.id', '=', 'asset_face.assetId').on('asset.isOffline', '=', false),
        )
        // the caller refuses a Locked photo as a featured face (FL-53)
        .select(['asset.ownerId', effectiveVisibility('asset').as('visibility')])
        .where('asset_face.assetId', '=', assetId)
        .where('asset_face.personGroupId', '=', personGroupId)
        .where('asset_face.deletedAt', 'is', null)
        .executeTakeFirst()
    );
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  getForMergePerson(personGroupIds: string[]) {
    return this.db
      .selectFrom('person')
      .selectAll('person')
      .where('person.personGroupId', 'in', personGroupIds)
      .orderBy('person.ownerId')
      .execute();
  }

  /**
   * FL-57: guided merge-suggestion candidates. Reuses the same face-embedding distance
   * metric (`<=>`, cosine distance) the facial-recognition job already uses to cluster
   * faces into people (see `searchFaces` in search.repository.ts and
   * `handleRecognizeFaces` in person.service.ts) instead of inventing a second notion of
   * "similar". Every visible person with a feature face is paired against every other
   * once (`p2.personGroupId > p1.personGroupId` keeps each unordered pair a single row),
   * and only pairs under `maxDistance` survive. The comparison happens inside a CTE so
   * the computed `distance` can be filtered/ordered on the outer query — Postgres does
   * not allow referencing a SELECT alias directly in the same query's WHERE clause.
   */
  @GenerateSql({ params: [DummyValue.UUID, { maxDistance: 0.5, limit: 20 }] })
  getMergeSuggestions(ownerId: string, { maxDistance, limit = 20 }: { maxDistance: number; limit?: number }) {
    // a pair the owner answered "different" is never suggested again, one deferred with "later" not for
    // 30 days (see `setMergeVerdict`)
    const unanswered = sql<boolean>`not exists (
      select 1 from immich_fork.person_merge_verdict verdict
      where verdict."ownerId" = ${ownerId}::uuid
        and verdict."personId" = "candidates"."personId"
        and verdict."suggestionId" = "candidates"."suggestionId"
        and (verdict.verdict = 'different' or verdict."createdAt" > now() - interval '30 days')
    )`;
    return this.db
      .with('candidates', (qb) =>
        qb
          .selectFrom('person as p1')
          .innerJoin('face_search as fs1', 'fs1.faceId', 'p1.faceAssetId')
          .innerJoin('person as p2', (join) =>
            join.onRef('p2.ownerId', '=', 'p1.ownerId').onRef('p2.personGroupId', '>', 'p1.personGroupId'),
          )
          .innerJoin('face_search as fs2', 'fs2.faceId', 'p2.faceAssetId')
          .select([
            'p1.personGroupId as personId',
            'p2.personGroupId as suggestionId',
            sql<number>`fs1.embedding <=> fs2.embedding`.as('distance'),
          ])
          .where('p1.ownerId', '=', ownerId)
          .where('p1.isHidden', '=', false)
          .where('p2.isHidden', '=', false),
      )
      .selectFrom('candidates')
      .selectAll()
      .where('candidates.distance', '<', maxDistance)
      .where(unanswered)
      .orderBy('candidates.distance', 'asc')
      .limit(limit)
      .execute();
  }

  /**
   * FL-57: records an owner's answer to a merge suggestion, replacing any earlier one for the pair.
   * `personId` must sort before `suggestionId` (the order `getMergeSuggestions` returns pairs in).
   * Like every fork-owned writer, it refuses while the fork schema is not writable or a handoff runs.
   */
  setMergeVerdict(ownerId: string, personId: string, suggestionId: string, verdict: PersonMergeVerdict) {
    return this.db.transaction().execute(async (tx) => {
      await this.lockForkWrites(tx);
      const { rows } = await sql<{ verdict: PersonMergeVerdict; createdAt: Date }>`
        INSERT INTO immich_fork.person_merge_verdict ("ownerId", "personId", "suggestionId", verdict)
        VALUES (${ownerId}::uuid, ${personId}::uuid, ${suggestionId}::uuid, ${verdict})
        ON CONFLICT ("ownerId", "personId", "suggestionId")
        DO UPDATE SET verdict = excluded.verdict, "createdAt" = excluded."createdAt"
        RETURNING verdict, "createdAt"
      `.execute(tx);
      return rows[0];
    });
  }

  /** FL-57: undoes a merge-suggestion answer; true when there was one. */
  deleteMergeVerdict(ownerId: string, personId: string, suggestionId: string) {
    return this.db.transaction().execute(async (tx) => {
      await this.lockForkWrites(tx);
      const { numAffectedRows } = await sql`
        DELETE FROM immich_fork.person_merge_verdict
        WHERE "ownerId" = ${ownerId}::uuid AND "personId" = ${personId}::uuid AND "suggestionId" = ${suggestionId}::uuid
      `.execute(tx);
      return (numAffectedRows ?? 0n) > 0n;
    });
  }

  /**
   * FL-57: drops verdicts that name a person their owner no longer has (deleted, merged away, or the
   * owner's account removed). `ownerId` narrows it to one owner; without it every owner is checked.
   */
  async deleteOrphanedMergeVerdicts(ownerId?: string): Promise<number> {
    return this.db.transaction().execute(async (tx) => {
      await this.lockForkWrites(tx);
      const { numAffectedRows } = await sql`
        DELETE FROM immich_fork.person_merge_verdict verdict
        WHERE (${ownerId ?? null}::uuid IS NULL OR verdict."ownerId" = ${ownerId ?? null}::uuid)
          AND (
            NOT EXISTS (
              SELECT 1 FROM public.person person
              WHERE person."ownerId" = verdict."ownerId" AND person."personGroupId" = verdict."personId"
            )
            OR NOT EXISTS (
              SELECT 1 FROM public.person person
              WHERE person."ownerId" = verdict."ownerId" AND person."personGroupId" = verdict."suggestionId"
            )
          )
      `.execute(tx);
      return Number(numAffectedRows ?? 0n);
    });
  }

  private async lockForkWrites(tx: Transaction<DB>) {
    const { rows } = await sql<{ phase: ForkSchemaPhase }>`
      SELECT phase FROM immich_fork.state WHERE id = 1 FOR SHARE
    `.execute(tx);
    const handoff = await sql`
      SELECT 1 FROM immich_fork.migration_audit
      WHERE status = 'running' AND name IN ('official-handoff-preparation', 'fork-return-reconciliation')
      LIMIT 1
    `.execute(tx);
    const phase = rows[0]?.phase;
    if (!phase || !(isLegacyAuthoritative(phase) || isForkWriteEnabled(phase)) || handoff.rows.length > 0) {
      throw new ConflictException('Merge suggestion answers are unavailable during database handoff');
    }
  }

  /**
   * FL-57: correction history for a person — faces explicitly moved onto them by a
   * human (see `reassignFace` above), most recent first. Machine-learning-only
   * assignments (never corrected) do not appear here.
   *
   * A person group spans every account in its cluster, so its faces sit on several owners' media.
   * A face on Locked media is listed only for that media's owner in an elevated session
   * (`lockedOwnerId`): nobody else learns the Locked item's id (FL-34).
   */
  @GenerateSql({ params: [DummyValue.UUID, { lockedOwnerId: DummyValue.UUID }] })
  getCorrections(personGroupId: string, options: LockedVisibilityOptions = {}) {
    return this.db
      .selectFrom('asset')
      .$call((qb) => withLockedOwnerScope(qb, options.lockedOwnerId))
      .innerJoin('asset_face', 'asset_face.assetId', 'asset.id')
      .select(['asset_face.id', 'asset_face.assetId', 'asset_face.correctedAt'])
      .where('asset_face.personGroupId', '=', personGroupId)
      .where('asset_face.deletedAt', 'is', null)
      .where('asset_face.correctedAt', 'is not', null)
      .orderBy('asset_face.correctedAt', 'desc')
      .limit(200)
      .execute();
  }
}
