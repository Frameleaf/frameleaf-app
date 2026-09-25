import { Injectable } from '@nestjs/common';
import {
  Kysely,
  NotNull,
  OrderByDirection,
  RawBuilder,
  SelectQueryBuilder,
  Selectable,
  ShallowDehydrateObject,
  sql,
} from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import z from 'zod';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import type { LockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import { columns } from 'src/database.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { MapAsset } from 'src/dtos/asset-response.dto.js';
import {
  SMART_SEARCH_COUNT_CAP,
  SearchFacetField,
  SearchFilter,
  SearchHistogramGranularity,
  SearchOrder,
} from 'src/dtos/search.dto.js';
import {
  AssetStatus,
  AssetType,
  AssetVisibility,
  ImageEnrichmentFilter,
  PetObservationState,
  VectorIndex,
} from 'src/enum.js';
import { probes } from 'src/repositories/database.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetExifTable } from 'src/schema/tables/asset-exif.table.js';
import {
  anyUuid,
  searchAssetBuilder,
  searchAssetBuilderLegacy,
  searchMetadataV3Examples,
  searchRandomV3Examples,
  searchSmartV3Examples,
  searchStatisticsV3Examples,
  tagIsSuppressed,
  tokenizeForSearch,
  withExifInner,
  withHiddenContentFilter,
  withSearchOrder,
} from 'src/utils/database.js';
import { isLocked, isTimelineVisible } from 'src/utils/locked.js';
import { type PaginationOptions, paginationHelper } from 'src/utils/pagination.js';

export interface SearchAssetIdOptions {
  checksum?: Buffer;
  id?: string;
}

export interface SearchUserIdOptions {
  libraryId?: string | null;
  userIds?: string[];
  /** FL-54: server derived; owners whose assets a place filter must never match. Never client-controlled. */
  locationHiddenOwnerIds?: string[];
}

export type SearchIdOptions = SearchAssetIdOptions & SearchUserIdOptions;

export interface SearchStatusOptions extends HiddenContentQueryOptions {
  isEncoded?: boolean;
  isFavorite?: boolean;
  isMotion?: boolean;
  isOffline?: boolean;
  isNotInAlbum?: boolean;
  type?: AssetType;
  status?: AssetStatus;
  withArchived?: boolean;
  withDeleted?: boolean;
  visibility?: AssetVisibility;
}

export interface SearchOneToOneRelationOptions {
  withExif?: boolean;
  withStacked?: boolean;
}

export interface SearchRelationOptions extends SearchOneToOneRelationOptions {
  withFaces?: boolean;
  withPeople?: boolean;
  /** whose version of the people to select, required when selecting faces or people */
  viewingUserId?: string;
}

export interface SearchDateOptions {
  createdBefore?: Date;
  createdAfter?: Date;
  takenBefore?: Date;
  takenAfter?: Date;
  trashedBefore?: Date;
  trashedAfter?: Date;
  updatedBefore?: Date;
  updatedAfter?: Date;
}

export interface SearchPathOptions {
  encodedVideoPath?: string;
  originalFileName?: string;
  originalPath?: string;
  previewPath?: string;
  thumbnailPath?: string;
}

export interface SearchExifOptions {
  city?: string | null;
  country?: string | null;
  lensModel?: string | null;
  make?: string | null;
  model?: string | null;
  state?: string | null;
  description?: string | null;
  rating?: number | null;
}

export interface SearchEmbeddingOptions {
  embedding: string;
  userIds: string[];
  /**
   * Optional raw text query. When present, smart search blends OCR
   * trigram similarity into the rank so text-in-image queries
   * (signs, receipts, screenshots) surface alongside CLIP matches.
   */
  query?: string;
}

export interface SearchOcrOptions {
  ocr?: string;
}

export interface SearchImageEnrichmentOptions {
  imageEnrichment?: ImageEnrichmentFilter;
}

export interface SearchPeopleOptions {
  personIds?: string[];
}

/** FL-58: matched against `viewingUserId`'s own confirmed pet observations, never anyone else's. */
export interface SearchPetOptions {
  petIds?: string[];
}

export interface SearchTagOptions {
  tagIds?: string[] | null;
}

export interface SearchAlbumOptions {
  albumIds?: string[];
}

export interface SearchOrderOptions {
  orderDirection?: 'asc' | 'desc';
}

export interface SearchPaginationOptions {
  page: number;
  size: number;
}

type BaseAssetSearchOptions = SearchDateOptions &
  SearchIdOptions &
  SearchExifOptions &
  SearchOrderOptions &
  SearchPathOptions &
  SearchStatusOptions &
  SearchUserIdOptions &
  SearchPeopleOptions &
  SearchPetOptions &
  SearchTagOptions &
  SearchAlbumOptions &
  SearchOcrOptions &
  SearchImageEnrichmentOptions;

export interface SearchLockedOwnerOptions {
  /**
   * The one owner whose Locked media a search may return: the viewer, in an elevated session. Server
   * derived, never client controlled. Left out, no Locked media comes back; another owner's (a
   * partner's, an album member's) never does.
   */
  lockedOwnerId?: string;
  /**
   * Leave out live-photo motion parts of Locked stills other than `lockedOwnerId`'s (FL-34). Every
   * interactive search sets it; the motion part keeps visibility `hidden` while its still is Locked.
   */
  hideLockedMotion?: boolean;
}

export type AssetSearchOptions = Omit<BaseAssetSearchOptions, 'visibility'> &
  SearchRelationOptions &
  SearchLockedOwnerOptions & { visibility?: AssetVisibility | 'not-locked' };

export type AssetSearchBuilderOptions = Omit<AssetSearchOptions, 'orderDirection'>;

export interface AssetSearchBuilderV3Options extends HiddenContentQueryOptions, SearchImageEnrichmentOptions {
  filter?: SearchFilter;
  /** Server-derived ownership scope. Never client-controlled. */
  userIds?: string[];
  /** whose version of the people to select, required when selecting faces or people */
  viewingUserId?: string;
  withExif?: boolean;
  withFaces?: boolean;
  withPeople?: boolean;
  withStacked?: boolean;
  order?: SearchOrder;
}

export type AssetSearchScope = {
  userIds: string[];
  lockedOwnerId: string;
  viewingUserId?: string;
  /**
   * Set by every interactive search (FL-34): leaves out live-photo motion parts of Locked stills
   * except those of `lockedMotion.lockedOwnerId`, the viewer when their session is elevated.
   */
  lockedMotion?: LockedVisibilityOptions;
  /** FL-54: owners whose assets a place filter must never match (set only when the filter uses a place) */
  locationHiddenOwnerIds?: string[];
};

export type SmartSearchOptions = SearchDateOptions &
  SearchEmbeddingOptions &
  SearchExifOptions &
  SearchOneToOneRelationOptions &
  Omit<SearchStatusOptions, 'visibility'> &
  SearchUserIdOptions &
  SearchPeopleOptions &
  SearchPetOptions &
  SearchTagOptions &
  SearchOcrOptions &
  SearchImageEnrichmentOptions &
  SearchLockedOwnerOptions & { visibility?: AssetVisibility | 'not-locked'; viewingUserId?: string };

export type OcrSearchOptions = SearchDateOptions & SearchOcrOptions;

export type LargeAssetSearchOptions = AssetSearchOptions & { minFileSize?: number };

type SearchSuggestionPrivacyOptions = HiddenContentQueryOptions;

// Weighted hybrid-search bonuses subtracted from CLIP cosine distance when an
// asset's text sidecars match the smart-search query. CLIP distance is in
// [0, 2]; each bonus is in [0, weight]. Weights are tuned so a perfect text
// match shifts an asset ahead of CLIP rivals within ~0.15-0.25 of cosine
// distance, without letting text-only matches dominate visual matches.
const OCR_FUSION_WEIGHT = 0.15;
const DESCRIPTION_FUSION_WEIGHT = 0.1;
// Best-of-both retrieval: when an asset has a CLIP-text embedding of its
// description, use the smaller of (visual cosine, description-text cosine).
// This lets the VLM's understanding of an image surface matches the visual
// encoder missed, without ever making the rank worse.
const DESCRIPTION_EMBEDDING_WEIGHT = 0.5;

export interface FaceEmbeddingSearch extends Omit<SearchEmbeddingOptions, 'userIds'> {
  clusterGroupId: string;
  hasPerson?: boolean;
  numResults: number;
  maxDistance: number;
  minBirthDate?: Date | null;
}

export interface FaceSearchResult {
  distance: number;
  id: string;
  personGroupId: string | null;
}

export interface AssetDuplicateResult {
  assetId: string;
  duplicateId: string | null;
  distance: number;
}

export interface GetStatesOptions {
  country?: string;
}

export interface GetCitiesOptions extends GetStatesOptions {
  state?: string;
}

export interface GetCameraModelsOptions {
  make?: string;
  lensModel?: string;
}

export interface GetCameraMakesOptions {
  model?: string;
  lensModel?: string;
}

export interface GetCameraLensModelsOptions {
  make?: string;
  model?: string;
}

/**
 * FL-49: who is looking and what they may be told. Facets name people and tags from the viewer's own
 * records only, leave out what the session keeps suppressed, and never place an owner who hides their
 * locations from the viewer.
 */
export interface SearchFacetOptions {
  viewerId: string;
  facets: SearchFacetField[];
  limit: number;
  /** partners who hide their locations from the viewer: they contribute no city or country */
  locationHiddenOwnerIds: string[];
  /** a session that is not unlocked: these people and tags (with their descendants) are never named */
  suppressedPersonIds: string[];
  suppressedTagIds: string[];
  /** also pick, per value, the newest matching asset by capture time (Explore's card covers) */
  covers?: boolean;
}

export type SearchFacetRow = {
  field: SearchFacetField;
  value: string;
  label: string | null;
  count: number;
  coverAssetId: string | null;
};
export type SearchFacetResult = { total: number; rows: SearchFacetRow[] };
export type TagStatisticsRow = { tagId: string; count: number; total: number };
export type SearchHistogramRow = { date: string; count: number };

const facetExample: SearchFacetOptions = {
  viewerId: DummyValue.UUID,
  facets: Object.values(SearchFacetField),
  limit: 10,
  locationHiddenOwnerIds: [DummyValue.UUID_1],
  suppressedPersonIds: [DummyValue.UUID_1],
  suppressedTagIds: [DummyValue.UUID_1],
  covers: true,
};
const legacySearchExample = { takenAfter: DummyValue.DATE, userIds: [DummyValue.UUID], lockedOwnerId: DummyValue.UUID };
const v3ScopeExample: AssetSearchScope = { userIds: [DummyValue.UUID], lockedOwnerId: DummyValue.UUID };

type MatchedAssets = SelectQueryBuilder<DB, 'asset', any>;

const asUuidLiteral = (id: string) => sql`${id}::uuid`;

const trimmed = (column: string) => sql`nullif(trim(${sql.ref(column)}), '')`;

@Injectable()
export class SearchRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({
    params: [
      { page: 1, size: 100 },
      {
        takenAfter: DummyValue.DATE,
        lensModel: DummyValue.STRING,
        withStacked: true,
        isFavorite: true,
        userIds: [DummyValue.UUID],
      },
    ],
  })
  async searchMetadata(pagination: SearchPaginationOptions, options: AssetSearchOptions) {
    const orderDirection = (options.orderDirection?.toLowerCase() || 'desc') as OrderByDirection;
    const items = await searchAssetBuilderLegacy(this.db, options)
      .select(columns.searchAsset)
      .select(isLocked('asset').as('isLocked'))
      .orderBy('asset.fileCreatedAt', orderDirection)
      .orderBy('asset.id', orderDirection)
      .limit(pagination.size + 1)
      .offset((pagination.page - 1) * pagination.size)
      .execute();

    return paginationHelper(items, pagination.size);
  }

  @GenerateSql({
    params: [
      {
        takenAfter: DummyValue.DATE,
        lensModel: DummyValue.STRING,
        isFavorite: true,
        userIds: [DummyValue.UUID],
      },
    ],
  })
  searchStatistics(options: AssetSearchOptions) {
    return searchAssetBuilderLegacy(this.db, options)
      .select((qb) => qb.fn.countAll<number>().as('total'))
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({
    params: [
      100,
      {
        takenAfter: DummyValue.DATE,
        lensModel: DummyValue.STRING,
        withStacked: true,
        isFavorite: true,
        userIds: [DummyValue.UUID],
      },
    ],
  })
  async searchRandom(size: number, options: AssetSearchOptions) {
    return searchAssetBuilderLegacy(this.db, options)
      .select(columns.searchAsset)
      .select(isLocked('asset').as('isLocked'))
      .orderBy(sql`random()`)
      .limit(size)
      .execute();
  }

  @GenerateSql({
    params: [
      100,
      {
        takenAfter: DummyValue.DATE,
        lensModel: DummyValue.STRING,
        withStacked: true,
        isFavorite: true,
        userIds: [DummyValue.UUID],
      },
    ],
  })
  searchLargeAssets(size: number, options: LargeAssetSearchOptions) {
    const orderDirection = (options.orderDirection?.toLowerCase() || 'desc') as OrderByDirection;
    return searchAssetBuilderLegacy(this.db, options)
      .select(columns.searchAsset)
      .select(isLocked('asset').as('isLocked'))
      .$call(withExifInner)
      .where('asset_exif.fileSizeInByte', '>', options.minFileSize || 0)
      .orderBy('asset_exif.fileSizeInByte', orderDirection)
      .limit(size)
      .execute();
  }

  @GenerateSql({
    params: [
      { page: 1, size: 200 },
      {
        takenAfter: DummyValue.DATE,
        embedding: DummyValue.VECTOR,
        lensModel: DummyValue.STRING,
        withStacked: true,
        isFavorite: true,
        userIds: [DummyValue.UUID],
      },
    ],
  })
  searchSmart(pagination: SearchPaginationOptions, options: SmartSearchOptions) {
    if (!z.int().min(1).max(1000).safeParse(pagination.size).success) {
      throw new Error(`Invalid value for 'size': ${pagination.size}`);
    }

    return this.db.transaction().execute(async (trx) => {
      await sql`set local vchordrq.probes = ${sql.lit(probes[VectorIndex.Clip])}`.execute(trx);
      const items = await searchAssetBuilderLegacy(trx, options)
        .selectAll('asset')
        .select(isLocked('asset').as('isLocked'))
        .innerJoin('smart_search', 'asset.id', 'smart_search.assetId')
        .orderBy(this.smartSearchOrder(options))
        .orderBy('asset.id', 'asc')
        .limit(pagination.size + 1)
        .offset((pagination.page - 1) * pagination.size)
        .execute();
      return paginationHelper(items, pagination.size);
    });
  }

  @GenerateSql({
    params: [DummyValue.UUID],
  })
  async getEmbedding(assetId: string) {
    return this.db.selectFrom('smart_search').selectAll().where('assetId', '=', assetId).executeTakeFirst();
  }

  @GenerateSql({
    params: [
      {
        userIds: [DummyValue.UUID],
        embedding: DummyValue.VECTOR,
        numResults: 10,
        maxDistance: 0.6,
      },
    ],
  })
  searchFaces({ clusterGroupId, embedding, numResults, maxDistance, hasPerson, minBirthDate }: FaceEmbeddingSearch) {
    if (!z.int().min(1).max(1000).safeParse(numResults).success) {
      throw new Error(`Invalid value for 'numResults': ${numResults}`);
    }

    return this.db.transaction().execute(async (trx) => {
      await sql`set local vchordrq.probes = ${sql.lit(probes[VectorIndex.Face])}`.execute(trx);
      return await trx
        .with('cte', (qb) =>
          qb
            .selectFrom('asset_face')
            .innerJoin('asset', 'asset.id', 'asset_face.assetId')
            .innerJoin('face_search', 'face_search.faceId', 'asset_face.id')
            .select([
              'asset_face.id',
              'asset_face.personGroupId',
              sql<number>`face_search.embedding <=> ${embedding}`.as('distance'),
            ])
            .where('asset.ownerId', 'in', (eb) =>
              eb.selectFrom('user').select('user.id').where('user.clusterGroupId', '=', clusterGroupId),
            )
            .where('asset.deletedAt', 'is', null)
            .$if(!!hasPerson, (qb) => qb.where('asset_face.personGroupId', 'is not', null))
            .$if(!!minBirthDate, (qb) =>
              qb.where((eb) =>
                eb.not(
                  eb.exists(
                    eb
                      .selectFrom('person')
                      .select('person.personGroupId')
                      .whereRef('person.personGroupId', '=', 'asset_face.personGroupId')
                      .where('person.birthDate', '>', minBirthDate!),
                  ),
                ),
              ),
            )
            .orderBy('distance')
            .limit(numResults),
        )
        .selectFrom('cte')
        .selectAll()
        .where('cte.distance', '<=', maxDistance)
        .execute();
    });
  }

  @GenerateSql({ params: [DummyValue.STRING] })
  searchPlaces(placeName: string) {
    return this.db
      .selectFrom('geodata_places')
      .selectAll()
      .where(
        () =>
          // kysely doesn't support trigram %>> or <->>> operators
          sql`
            f_unaccent(name) %>> f_unaccent(${placeName}) or
            f_unaccent("admin2Name") %>> f_unaccent(${placeName}) or
            f_unaccent("admin1Name") %>> f_unaccent(${placeName}) or
            f_unaccent("alternateNames") %>> f_unaccent(${placeName})
          `,
      )
      .orderBy(
        sql`
          coalesce(f_unaccent(name) <->>> f_unaccent(${placeName}), 0.1) +
          coalesce(f_unaccent("admin2Name") <->>> f_unaccent(${placeName}), 0.1) +
          coalesce(f_unaccent("admin1Name") <->>> f_unaccent(${placeName}), 0.1) +
          coalesce(f_unaccent("alternateNames") <->>> f_unaccent(${placeName}), 0.1)
        `,
      )
      .limit(20)
      .execute();
  }

  /**
   * FL-49: the pet twin of `PersonRepository.getByName`, for Ask Search. The same trigram rule and
   * order (word similarity 0.5, closest first), over the owner's own, not hidden pets only, and only a
   * pet with at least one confirmed photo the caller may see (timeline, not trashed, not hidden
   * content), so a suppressed pet never resolves in a session that is not unlocked.
   *
   * Like the pet repository it reads, it carries no `@GenerateSql` example and adds no snapshot.
   */
  searchPetsByName(ownerId: string, petName: string, options: HiddenContentQueryOptions = {}) {
    return this.db
      .with('similarity_threshold', (db) =>
        db.selectNoFrom(sql`set_config('pg_trgm.word_similarity_threshold', '0.5', true)`.as('thresh')),
      )
      .selectFrom(['similarity_threshold', 'pet'])
      .select(['pet.id', 'pet.name'])
      .where('pet.ownerId', '=', ownerId)
      .where('pet.isHidden', '=', false)
      .where(() => sql<boolean>`f_unaccent("pet"."name") %> f_unaccent(${petName})`)
      .where((eb) =>
        eb.exists((eb) =>
          eb
            .selectFrom('pet_observation')
            .innerJoin('asset', (join) =>
              join
                .onRef('asset.id', '=', 'pet_observation.assetId')
                .on(isTimelineVisible('asset'))
                .on('asset.deletedAt', 'is', null),
            )
            .whereRef('pet_observation.petId', '=', 'pet.id')
            .where('pet_observation.state', '=', PetObservationState.Confirmed)
            .$call((qb) => withHiddenContentFilter(qb, options)),
        ),
      )
      .orderBy(sql`f_unaccent("pet"."name") <->>> f_unaccent(${petName})`)
      .limit(100)
      .execute();
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  getAssetsByCity(userIds: string[], options: SearchSuggestionPrivacyOptions = {}) {
    return this.db
      .withRecursive('cte', (qb) => {
        const base = qb
          .selectFrom('asset_exif')
          .select(['city', 'assetId'])
          .innerJoin('asset', 'asset.id', 'asset_exif.assetId')
          .where('asset.ownerId', '=', anyUuid(userIds))
          .where(isTimelineVisible('asset'))
          .where('asset.type', '=', AssetType.Image)
          .where('asset.deletedAt', 'is', null)
          .$call((qb) => withHiddenContentFilter(qb, options))
          .orderBy('city')
          .limit(1);

        const recursive = qb
          .selectFrom('cte')
          .select(['l.city', 'l.assetId'])
          .innerJoinLateral(
            (qb) =>
              qb
                .selectFrom('asset_exif')
                .select(['city', 'assetId'])
                .innerJoin('asset', 'asset.id', 'asset_exif.assetId')
                .where('asset.ownerId', '=', anyUuid(userIds))
                .where(isTimelineVisible('asset'))
                .where('asset.type', '=', AssetType.Image)
                .where('asset.deletedAt', 'is', null)
                .$call((qb) => withHiddenContentFilter(qb, options))
                .whereRef('asset_exif.city', '>', 'cte.city')
                .orderBy('city')
                .limit(1)
                .as('l'),
            (join) => join.onTrue(),
          );

        return sql<{ city: string; assetId: string }>`(${base} union all ${recursive})`;
      })
      .selectFrom('asset')
      .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
      .innerJoin('cte', 'asset.id', 'cte.assetId')
      .select(columns.searchAsset)
      .select(isLocked('asset').as('isLocked'))
      .select((eb) =>
        eb
          .fn('to_jsonb', [eb.table('asset_exif')])
          .$castTo<ShallowDehydrateObject<Selectable<AssetExifTable>>>()
          .as('exifInfo'),
      )
      .orderBy('asset_exif.city')
      .execute();
  }

  /**
   * Media per city for the places page (FL-51): the same owners and privacy rules as `getAssetsByCity`
   * (timeline-visible, not Locked, hidden content filtered), but counting photos and videos, so a city
   * with only videos has a count here and no entry in `getAssetsByCity`, which lists photos only.
   */
  @GenerateSql({ params: [[DummyValue.UUID]] })
  getCityAssetCounts(userIds: string[], options: SearchSuggestionPrivacyOptions = {}) {
    return this.db
      .selectFrom('asset_exif')
      .innerJoin('asset', 'asset.id', 'asset_exif.assetId')
      .select((eb) => ['asset_exif.city', eb.fn.countAll<number>().as('count')])
      .where('asset.ownerId', '=', anyUuid(userIds))
      .where(isTimelineVisible('asset'))
      .where('asset.deletedAt', 'is', null)
      .where('asset_exif.city', 'is not', null)
      .$call((qb) => withHiddenContentFilter(qb, options))
      .groupBy('asset_exif.city')
      .orderBy('asset_exif.city')
      .$narrowType<{ city: NotNull }>()
      .execute();
  }

  async upsert(assetId: string, embedding: string): Promise<void> {
    await this.db
      .insertInto('smart_search')
      .values({ assetId, embedding })
      .onConflict((oc) => oc.column('assetId').doUpdateSet((eb) => ({ embedding: eb.ref('excluded.embedding') })))
      .execute();
  }

  async upsertDescriptionEmbedding(assetId: string, embedding: string): Promise<void> {
    await this.db
      .insertInto('smart_search_description')
      .values({ assetId, embedding })
      .onConflict((oc) => oc.column('assetId').doUpdateSet((eb) => ({ embedding: eb.ref('excluded.embedding') })))
      .execute();
  }

  async deleteDescriptionEmbedding(assetId: string): Promise<void> {
    await this.db.deleteFrom('smart_search_description').where('assetId', '=', assetId).execute();
  }

  async getCountries(userIds: string[], options: SearchSuggestionPrivacyOptions = {}): Promise<string[]> {
    const res = await this.getExifField('country', userIds, options).execute();
    return res.map((row) => row.country!);
  }

  @GenerateSql({ params: [[DummyValue.UUID], DummyValue.STRING] })
  async getStates(
    userIds: string[],
    { country, ...options }: GetStatesOptions & SearchSuggestionPrivacyOptions,
  ): Promise<string[]> {
    const res = await this.getExifField('state', userIds, options)
      .$if(!!country, (qb) => qb.where('country', '=', country!))
      .execute();

    return res.map((row) => row.state!);
  }

  @GenerateSql({ params: [[DummyValue.UUID], DummyValue.STRING, DummyValue.STRING] })
  async getCities(
    userIds: string[],
    { country, state, ...options }: GetCitiesOptions & SearchSuggestionPrivacyOptions,
  ): Promise<string[]> {
    const res = await this.getExifField('city', userIds, options)
      .$if(!!country, (qb) => qb.where('country', '=', country!))
      .$if(!!state, (qb) => qb.where('state', '=', state!))
      .execute();

    return res.map((row) => row.city!);
  }

  @GenerateSql({ params: [[DummyValue.UUID], DummyValue.STRING, DummyValue.STRING] })
  async getCameraMakes(
    userIds: string[],
    { model, lensModel, ...options }: GetCameraMakesOptions & SearchSuggestionPrivacyOptions,
  ): Promise<string[]> {
    const res = await this.getExifField('make', userIds, options)
      .$if(!!model, (qb) => qb.where('model', '=', model!))
      .$if(!!lensModel, (qb) => qb.where('lensModel', '=', lensModel!))
      .execute();

    return res.map((row) => row.make!);
  }

  @GenerateSql({ params: [[DummyValue.UUID], DummyValue.STRING, DummyValue.STRING] })
  async getCameraModels(
    userIds: string[],
    { make, lensModel, ...options }: GetCameraModelsOptions & SearchSuggestionPrivacyOptions,
  ): Promise<string[]> {
    const res = await this.getExifField('model', userIds, options)
      .$if(!!make, (qb) => qb.where('make', '=', make!))
      .$if(!!lensModel, (qb) => qb.where('lensModel', '=', lensModel!))
      .execute();

    return res.map((row) => row.model!);
  }

  @GenerateSql({ params: [[DummyValue.UUID], DummyValue.STRING] })
  async getCameraLensModels(
    userIds: string[],
    { make, model, ...options }: GetCameraLensModelsOptions & SearchSuggestionPrivacyOptions,
  ): Promise<string[]> {
    const res = await this.getExifField('lensModel', userIds, options)
      .$if(!!make, (qb) => qb.where('make', '=', make!))
      .$if(!!model, (qb) => qb.where('model', '=', model!))
      .execute();

    return res.map((row) => row.lensModel!);
  }

  @GenerateSql(...searchMetadataV3Examples)
  async searchMetadataV3(pagination: PaginationOptions, options: AssetSearchBuilderV3Options, scope: AssetSearchScope) {
    const items = await withSearchOrder(searchAssetBuilder(this.db, options, scope), options.order)
      .select(columns.searchAsset)
      .select(isLocked('asset').as('isLocked'))
      .limit(pagination.take + 1)
      .offset(pagination.skip ?? 0)
      .execute();
    return paginationHelper(items, pagination.take);
  }

  // TODO(v4): drop the V3 suffix once the legacy methods are removed
  @GenerateSql(...searchRandomV3Examples)
  searchRandomV3(
    size: number,
    options: Omit<AssetSearchBuilderV3Options, 'order'>,
    scope: AssetSearchScope,
  ): Promise<MapAsset[]> {
    return searchAssetBuilder(this.db, options, scope)
      .select(columns.searchAsset)
      .select(isLocked('asset').as('isLocked'))
      .orderBy(sql`random()`)
      .limit(size)
      .execute();
  }

  // TODO(v4): drop the V3 suffix once the legacy methods are removed
  @GenerateSql(...searchSmartV3Examples)
  searchSmartV3(
    pagination: PaginationOptions,
    options: Omit<AssetSearchBuilderV3Options, 'order'> & { embedding: string; query?: string },
    scope: AssetSearchScope,
  ) {
    return this.db.transaction().execute(async (trx) => {
      await sql`set local vchordrq.probes = ${sql.lit(probes[VectorIndex.Clip])}`.execute(trx);
      const items = await searchAssetBuilder(trx, options, scope)
        .select(columns.searchAsset)
        .select(isLocked('asset').as('isLocked'))
        .innerJoin('smart_search', 'asset.id', 'smart_search.assetId')
        .orderBy(this.smartSearchOrder(options))
        .orderBy('asset.id', 'asc')
        .limit(pagination.take + 1)
        .offset(pagination.skip ?? 0)
        .execute();
      return paginationHelper(items, pagination.take);
    });
  }

  // TODO(v4): drop the V3 suffix once the legacy methods are removed
  @GenerateSql(...searchStatisticsV3Examples)
  searchStatisticsV3(options: AssetSearchBuilderV3Options, scope: AssetSearchScope) {
    return searchAssetBuilder(this.db, options, scope)
      .select((qb) => qb.fn.countAll<number>().as('total'))
      .executeTakeFirstOrThrow();
  }

  /** FL-49: facet counts for a legacy (flat) search body */
  @GenerateSql({ params: [legacySearchExample, facetExample] })
  searchFacets(options: AssetSearchOptions, facets: SearchFacetOptions): Promise<SearchFacetResult> {
    return this.facetsOf(searchAssetBuilderLegacy(this.db, options), facets);
  }

  /** FL-49: facet counts for a structured search body */
  @GenerateSql({ params: [{ filter: { isFavorite: { eq: true } } }, v3ScopeExample, facetExample] })
  searchFacetsV3(
    options: AssetSearchBuilderV3Options,
    scope: AssetSearchScope,
    facets: SearchFacetOptions,
  ): Promise<SearchFacetResult> {
    return this.facetsOf(searchAssetBuilder(this.db, options, scope) as MatchedAssets, facets);
  }

  /**
   * FL-46: every tag of the viewer's that the matched assets carry, with how many carry exactly that
   * tag (`count`) and how many carry it or any tag under it (`total`, the tag filter's own closure
   * semantics). Unlike the tags facet there is no limit, since the Tags browser counts every row of
   * its tree. A suppressed tag, and every tag under one, is left out.
   */
  async searchTagStatistics(
    options: AssetSearchOptions,
    { viewerId, suppressedTagIds }: { viewerId: string; suppressedTagIds: string[] },
  ): Promise<TagStatisticsRow[]> {
    const matched = searchAssetBuilderLegacy(this.db, options);
    const { rows } = await sql<{ tagId: string; count: string; total: string }>`
      with matched as materialized (${matched.select('asset.id')})
      select t.id::text as "tagId",
        count(distinct m.id) filter (where ta."tagId" = t.id) as count,
        count(distinct m.id) as total
      from matched m
      inner join tag_asset ta on ta."assetId" = m.id
      inner join tag_closure tc on tc.id_descendant = ta."tagId"
      inner join tag t on t.id = tc.id_ancestor and t."userId" = ${asUuidLiteral(viewerId)}
      where ${suppressedTagIds.length > 0 ? sql`not ${tagIsSuppressed(sql.ref('t.id'), suppressedTagIds)}` : sql`true`}
      group by t.id
      order by t.id
    `.execute(this.db);
    return rows.map((row) => ({ tagId: row.tagId, count: Number(row.count), total: Number(row.total) }));
  }

  /** FL-49: matches per local capture day, month or year for a legacy (flat) search body */
  @GenerateSql({ params: [legacySearchExample, SearchHistogramGranularity.Month] })
  searchHistogram(options: AssetSearchOptions, granularity: SearchHistogramGranularity) {
    return this.histogramOf(searchAssetBuilderLegacy(this.db, options), granularity);
  }

  /** FL-49: matches per local capture day, month or year for a structured search body */
  @GenerateSql({ params: [{}, v3ScopeExample, SearchHistogramGranularity.Day] })
  searchHistogramV3(
    options: AssetSearchBuilderV3Options,
    scope: AssetSearchScope,
    granularity: SearchHistogramGranularity,
  ) {
    return this.histogramOf(searchAssetBuilder(this.db, options, scope) as MatchedAssets, granularity);
  }

  /**
   * FL-49: how many assets smart search would rank for a legacy (flat) body, up to the cap. Smart
   * search orders every eligible asset with an embedding, so this is the size of its result set.
   */
  @GenerateSql({ params: [legacySearchExample] })
  searchSmartCount(options: AssetSearchOptions) {
    return this.cappedCount(
      searchAssetBuilderLegacy(this.db, options).innerJoin('smart_search', 'asset.id', 'smart_search.assetId'),
    );
  }

  /** FL-49: the structured twin of `searchSmartCount` */
  @GenerateSql({ params: [{}, v3ScopeExample] })
  searchSmartCountV3(options: AssetSearchBuilderV3Options, scope: AssetSearchScope) {
    return this.cappedCount(
      (searchAssetBuilder(this.db, options, scope) as MatchedAssets).innerJoin(
        'smart_search',
        'asset.id',
        'smart_search.assetId',
      ),
    );
  }

  private async cappedCount(matched: SelectQueryBuilder<DB, any, any>) {
    const { rows } = await sql<{ total: string }>`
      select count(*) as total from (${matched.select('asset.id').limit(SMART_SEARCH_COUNT_CAP + 1)}) capped
    `.execute(this.db);
    const total = Number(rows[0]?.total ?? 0);
    return { total: Math.min(total, SMART_SEARCH_COUNT_CAP), capped: total > SMART_SEARCH_COUNT_CAP };
  }

  private async histogramOf(matched: MatchedAssets, granularity: SearchHistogramGranularity) {
    const unit = sql.lit({ day: 'day', month: 'month', year: 'year' }[granularity]);
    const { rows } = await sql<{ date: string; count: string }>`
      with matched as (${matched.select('asset.localDateTime')})
      select
        to_char(date_trunc(${unit}, matched."localDateTime" at time zone 'UTC'), 'YYYY-MM-DD') as date,
        count(*) as count
      from matched
      group by 1
      order by 1
    `.execute(this.db);
    return rows.map((row): SearchHistogramRow => ({ date: row.date, count: Number(row.count) }));
  }

  private async facetsOf(matched: MatchedAssets, options: SearchFacetOptions): Promise<SearchFacetResult> {
    const wanted = new Set(options.facets);
    const viewer = asUuidLiteral(options.viewerId);
    // Explore's covers: the newest match per value, from the same matched set as the count
    const cover = options.covers
      ? sql`(array_agg(m.id order by m."fileCreatedAt" desc, m.id desc))[1]::text`
      : sql`null::text`;
    const exifFacet = (field: SearchFacetField, column: string, where: RawBuilder<unknown> = sql`true`) =>
      sql`select ${field}::text as field, ${trimmed(column)} as value, null::text as label, count(*) as count,
          ${cover} as cover
        from matched m
        inner join asset_exif e on e."assetId" = m.id
        where ${trimmed(column)} is not null and ${where}
        group by 2`;
    const locationShared =
      options.locationHiddenOwnerIds.length > 0
        ? sql`not (m."ownerId" = ${anyUuid(options.locationHiddenOwnerIds)})`
        : sql`true`;

    const parts: Array<[SearchFacetField, RawBuilder<unknown>]> = [
      [
        SearchFacetField.Type,
        sql`select ${SearchFacetField.Type}::text as field, m.type::text as value, null::text as label, count(*) as count,
            ${cover} as cover
          from matched m group by 2`,
      ],
      [
        SearchFacetField.IsFavorite,
        // favourites are personal: a partner's favourite is not the viewer's
        sql`select ${SearchFacetField.IsFavorite}::text as field,
            (m."isFavorite" and m."ownerId" = ${viewer})::text as value, null::text as label, count(*) as count,
            ${cover} as cover
          from matched m group by 2`,
      ],
      [
        SearchFacetField.Rating,
        sql`select ${SearchFacetField.Rating}::text as field,
            case when e.rating between 1 and 5 then e.rating::text else 'unrated' end as value,
            null::text as label, count(*) as count, ${cover} as cover
          from matched m left join asset_exif e on e."assetId" = m.id group by 2`,
      ],
      [SearchFacetField.City, exifFacet(SearchFacetField.City, 'e.city', locationShared)],
      [SearchFacetField.Country, exifFacet(SearchFacetField.Country, 'e.country', locationShared)],
      [SearchFacetField.Make, exifFacet(SearchFacetField.Make, 'e.make')],
      [SearchFacetField.Model, exifFacet(SearchFacetField.Model, 'e.model')],
      [SearchFacetField.LensModel, exifFacet(SearchFacetField.LensModel, 'e.lensModel')],
      [
        SearchFacetField.People,
        sql`select ${SearchFacetField.People}::text as field, f."personGroupId"::text as value,
            max(nullif(p.name, '')) as label, count(distinct m.id) as count, ${cover} as cover
          from matched m
          inner join asset_face f on f."assetId" = m.id and f."deletedAt" is null and f."isVisible" is true
          inner join person p on p."personGroupId" = f."personGroupId" and p."ownerId" = ${viewer} and not p."isHidden"
          where ${
            options.suppressedPersonIds.length > 0
              ? sql`not (f."personGroupId" = ${anyUuid(options.suppressedPersonIds)})`
              : sql`true`
          }
          group by f."personGroupId"`,
      ],
      [
        SearchFacetField.Tags,
        // a tag counts the assets tagged with it or with any tag under it, as the tag filter matches
        sql`select ${SearchFacetField.Tags}::text as field, t.id::text as value, max(t.value) as label,
            count(distinct m.id) as count, ${cover} as cover
          from matched m
          inner join tag_asset ta on ta."assetId" = m.id
          inner join tag_closure tc on tc.id_descendant = ta."tagId"
          inner join tag t on t.id = tc.id_ancestor and t."userId" = ${viewer}
          where ${options.suppressedTagIds.length > 0 ? sql`not ${tagIsSuppressed(sql.ref('t.id'), options.suppressedTagIds)}` : sql`true`}
          group by t.id`,
      ],
    ];

    const selected = parts.filter(([field]) => wanted.has(field)).map(([, query]) => query);
    // the total comes from the same matched set in the same statement, so it never needs its own scan
    const total = sql`select 'total'::text as field, null::text as value, null::text as label, count(*) as count,
      null::text as cover
      from matched`;

    const { rows } = await sql<{
      field: SearchFacetField | 'total';
      value: string;
      label: string | null;
      count: string;
      cover: string | null;
    }>`
      with matched as materialized (${matched.select(['asset.id', 'asset.ownerId', 'asset.type', 'asset.isFavorite', 'asset.fileCreatedAt'])}),
      facet_rows as (${sql.join([...selected, total], sql` union all `)}),
      ranked as (
        select *, row_number() over (partition by field order by count desc, value asc) as rank
        from facet_rows
      )
      select field, value, label, count, cover from ranked where rank <= ${options.limit} order by field, rank
    `.execute(this.db);
    return {
      total: Number(rows.find((row) => row.field === 'total')?.count ?? 0),
      rows: rows
        .filter((row): row is typeof row & { field: SearchFacetField } => row.field !== 'total')
        .map(({ cover, ...row }) => ({ ...row, count: Number(row.count), coverAssetId: cover })),
    };
  }

  private smartSearchOrder(options: { embedding: string; query?: string }) {
    const text = options.query?.trim();
    const fusionText = text ? tokenizeForSearch(text).join(' ') : null;
    // CLIP cosine distance is the primary signal. When a raw text query is
    // available, subtract bounded trigram-similarity bonuses from text
    // sidecars (OCR + description) so text-aware matches surface alongside
    // visual matches. Scalar subqueries are used instead of joins to avoid
    // clashing with conditional joins inside searchAssetBuilder.
    // <=> returns [0, 2]; (1 - <->>>) returns [0, 1] when the sidecar row
    // exists, NULL otherwise.
    const visualDistance = sql`(smart_search.embedding <=> ${options.embedding})`;
    // Visual distance vs. (description-text embedding distance scaled toward
    // visual). Take the smaller, so a strong description match can rescue
    // a weak visual one, but never penalizes the rank. NULL distance (no
    // description embedding yet) drops out of the LEAST.
    const blendedClipDistance = sql`least(
      ${visualDistance},
      coalesce(
        ${DESCRIPTION_EMBEDDING_WEIGHT} * (select embedding <=> ${options.embedding} from smart_search_description where "assetId" = asset.id),
        ${visualDistance}
      )
    )`;
    const orderExpr = fusionText
      ? sql`
        ${blendedClipDistance}
        - ${OCR_FUSION_WEIGHT} * coalesce(
            1 - (f_unaccent((select text from ocr_search where "assetId" = asset.id)) <->>> f_unaccent(${fusionText})),
            0
          )
        - ${DESCRIPTION_FUSION_WEIGHT} * coalesce(
            1 - (f_unaccent((select description from asset_exif where "assetId" = asset.id)) <->>> f_unaccent(${fusionText})),
            0
          )
        `
      : blendedClipDistance;
    return orderExpr;
  }

  private getExifField(
    field: 'city' | 'state' | 'country' | 'make' | 'model' | 'lensModel',
    userIds: string[],
    options: SearchSuggestionPrivacyOptions = {},
  ) {
    return this.db
      .selectFrom('asset_exif')
      .select(field)
      .distinctOn(field)
      .innerJoin('asset', 'asset.id', 'asset_exif.assetId')
      .where('ownerId', '=', anyUuid(userIds))
      .where(isTimelineVisible('asset'))
      .where('deletedAt', 'is', null)
      .$call((qb) => withHiddenContentFilter(qb, options))
      .where(field, 'is not', null)
      .where(field, '!=', '');
  }
}
