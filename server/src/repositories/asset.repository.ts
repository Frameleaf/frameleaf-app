import { Injectable } from '@nestjs/common';
import {
  ExpressionBuilder,
  Insertable,
  Kysely,
  NotNull,
  RawBuilder,
  SelectQueryBuilder,
  Selectable,
  ShallowDehydrateObject,
  UpdateResult,
  sql,
} from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { isEmpty, isUndefined, omitBy } from 'lodash-es';
import { InjectKysely } from 'nestjs-kysely';
import type { Updateable } from 'kysely';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { ForkSchemaPhase } from 'src/repositories/fork-schema.repository.js';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import type { LockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import { LockableProperty, Stack } from 'src/database.js';
import { Chunked, ChunkedArray, ChunkedSet, DummyValue, GenerateSql } from 'src/decorators.js';
import {
  AssetFileType,
  AssetLockReason,
  AssetMetadataKey,
  AssetOrder,
  AssetOrderBy,
  AssetStatus,
  AssetType,
  AssetVisibility,
  CalendarHeatmapType,
  TimeBucketDateType,
} from 'src/enum.js';
import { isForkWriteEnabled } from 'src/fork-schema/authority.js';
import { VideoEditVersion } from 'src/repositories/asset-edit.repository.js';
import { getForkSchemaPhase, readsForkSidecar } from 'src/repositories/fork-derived-results.js';
import { ForkEnrichmentRepository } from 'src/repositories/fork-enrichment.repository.js';
import { ForkPrivacyRepository } from 'src/repositories/fork-privacy.repository.js';
import { lockFilePath } from 'src/repositories/physical-file.repository.js';
import { SmartAlbumRepository } from 'src/repositories/smart-album.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetAudioTable, AssetKeyframeTable, AssetVideoTable } from 'src/schema/tables/asset-av.table.js';
import { AssetExifTable } from 'src/schema/tables/asset-exif.table.js';
import { AssetFileTable } from 'src/schema/tables/asset-file.table.js';
import { AssetJobStatusTable } from 'src/schema/tables/asset-job-status.table.js';
import { AssetMetadataTable } from 'src/schema/tables/asset-metadata.table.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { releaseLockedCoverReferences } from 'src/utils/cover-references.js';
import {
  anyUuid,
  asUuid,
  getHiddenContentFilter,
  hasHiddenLockedPrimary,
  hasPeople,
  hasPets,
  hiddenContentAssetIdExists,
  inSharedAlbum,
  isMotionOfLockedStill,
  removeUndefinedKeys,
  truncatedDate,
  unnest,
  withAlbumVisibility,
  withDefaultVisibility,
  withEdits,
  withExif,
  withFaces,
  withFacesAndPeople,
  withFilePath,
  withFiles,
  withHiddenContentFilter,
  withHiddenContentOnly,
  withLibrary,
  withLockedOwnerScope,
  withNsfwAssets,
  withOwner,
  withSmartSearch,
  withTagId,
  withTags,
} from 'src/utils/database.js';
import { lockDerivedResults } from 'src/utils/derivative-locks.js';
import { lockAssetRowsInOrder, onStacksJoined, otherStackMembers } from 'src/utils/locked-stacks.js';
import {
  effectiveVisibility,
  isLocked,
  isNotLocked,
  isTimelineVisible,
  lockReasonOf,
  lockedForReason,
  visibilityIs,
} from 'src/utils/locked.js';
import { getEditedMasterLineagePath } from 'src/utils/media-policy.js';
import { globToPostgresRegex } from 'src/utils/misc.js';
import { deriveIsNsfwFromMetadata } from 'src/utils/nsfw.js';

export type AssetStats = Record<AssetType, number>;

/** What `remove` reports about the files a removed asset held, beyond its generated ones. */
export type RemovedAsset = { originalPath: string; reservationTemporaryPath: string | null; videoEditPaths?: string[] };

/** The file cleanup `remove` queues inside its transaction (FL-169). */
export type AssetFileRelease = {
  /** Every file the removal frees, in the order they are queued. Called with what the removal reports. */
  files: (removed: RemovedAsset) => string[];
  /** Queues their deletion; a failure rolls the removal back. */
  queue: (files: string[]) => Promise<void>;
};

export interface DescriptionStats {
  totalAssets: number;
  withDescription: number;
  withoutDescription: number;
}

export interface BoundingBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

interface AssetStatsOptions extends HiddenContentQueryOptions {
  isFavorite?: boolean;
  isTrashed?: boolean;
  visibility?: AssetVisibility;
}

/**
 * `lockedOwnerId`: the owner, when their session is elevated. Only then may a duplicate lookup name
 * their Locked media; otherwise a Locked match stays unnamed (FL-34).
 */
type AssetChecksumOptions = HiddenContentQueryOptions & LockedVisibilityOptions;

interface LivePhotoSearchOptions {
  ownerId: string;
  libraryId?: string | null;
  livePhotoCID: string;
  otherAssetId: string;
  type: AssetType;
}

interface AssetBuilderOptions extends HiddenContentQueryOptions {
  isFavorite?: boolean;
  isTrashed?: boolean;
  isDuplicate?: boolean;
  albumId?: string;
  tagId?: string;
  personId?: string;
  /** FL-58: one of the viewer's own pets; matched against confirmed pet observations only */
  petId?: string;
  userIds?: string[];
  withStacked?: boolean;
  exifInfo?: boolean;
  status?: AssetStatus;
  assetType?: AssetType;
  visibility?: AssetVisibility;
  withCoordinates?: boolean;
  bbox?: BoundingBox;
  /** owners whose location columns (city, country, latitude, longitude) come back null for this viewer */
  locationHiddenOwnerIds?: string[];
  /**
   * The one owner whose Locked media may show when no visibility is requested: the viewer, in an
   * elevated session, looking at an album (see `withAlbumVisibility`). Never set for the main timeline.
   */
  lockedOwnerId?: string;
  /** FL-34: with `visibility: locked`, only assets locked for one of these reasons. */
  lockReasons?: AssetLockReason[];
  /**
   * FL-34: the owner whose own sensitive marks and detections an ordinary timeline reveals — the viewer,
   * in an elevated session ("Revealed for this session"). Never set for albums or the Locked view.
   */
  revealLockedOwnerId?: string;
}

export interface TimeBucketOptions extends AssetBuilderOptions {
  dateType?: TimeBucketDateType;
  orderBy?: AssetOrderBy;
  order?: AssetOrder;
}

/** FL-30 (S-15): the flat Browse/Work orders the time buckets cannot give. */
export type TimelineOrderedSort = 'filename' | 'rating';

export interface TimelineOrderedPage {
  sort: TimelineOrderedSort;
  skip: number;
  take: number;
}

export interface TimeBucketItem {
  timeBucket: string;
  count: number;
}

/** FL-33: how many places a curated timeline card names */
export const TIMELINE_HIGHLIGHT_PLACES = 3;

export interface TimelineHighlightOptions {
  grouping: 'year' | 'month';
  /** highlights besides the key photo */
  highlightCount: number;
  /** false for a shared link that hides EXIF: no card names a place */
  withPlaces: boolean;
}

export interface TimelineHighlightItem {
  timeBucket: string;
  count: number;
  keyAssetId: string | null;
  highlightAssetIds: string[];
  places: string[];
}

export interface YearMonthDay {
  day: number;
  month: number;
  year: number;
}

interface AssetExploreFieldOptions extends HiddenContentQueryOptions {
  maxFields: number;
  minAssetsPerField: number;
}

interface AssetGetByChecksumOptions {
  ownerId: string;
  checksum: Buffer;
  libraryId?: string;
}

type UpsertAssetFile = Pick<Insertable<AssetFileTable>, 'assetId' | 'path' | 'type'> &
  Partial<Pick<Insertable<AssetFileTable>, 'physicalFileId' | 'isEdited' | 'isProgressive' | 'isTransparent'>>;

interface GetByIdsRelations {
  exifInfo?: boolean;
  faces?: { person?: boolean; withDeleted?: boolean; viewingUserId?: string };
  files?: boolean;
  library?: boolean;
  owner?: boolean;
  smartSearch?: boolean;
  /**
   * `lockedOwnerId`: the viewer, when their session is elevated. A stack whose primary is Locked media
   * someone else owns, or that the viewer has not unlocked, is left off the asset (FL-34).
   */
  stack?: { assets?: boolean; lockedOwnerId?: string };
  tags?: boolean;
  edits?: boolean;
}

type UpsertExifOptions = {
  exif: Insertable<AssetExifTable>;
  audio?: Insertable<AssetAudioTable>;
  video?: Insertable<AssetVideoTable>;
  keyframes?: Insertable<AssetKeyframeTable>;
  lockedPropertiesBehavior: 'override' | 'append' | 'skip';
};

const distinctLocked = <T extends LockableProperty[] | null>(eb: ExpressionBuilder<DB, 'asset_exif'>, columns: T) =>
  sql<T>`nullif(array(select distinct unnest(${eb.ref('asset_exif.lockedProperties')} || ${columns})), '{}')`;

const getBoundingCircle = (bbox: BoundingBox) => {
  const { west, south, east, north } = bbox;
  const eastUnwrapped = west <= east ? east : east + 360;
  const centerLongitude = (((west + eastUnwrapped) / 2 + 540) % 360) - 180;
  const centerLatitude = (south + north) / 2;
  const radius = sql<number>`greatest(
    earth_distance(ll_to_earth_public(${centerLatitude}, ${centerLongitude}), ll_to_earth_public(${south}, ${west})),
    earth_distance(ll_to_earth_public(${centerLatitude}, ${centerLongitude}), ll_to_earth_public(${south}, ${east})),
    earth_distance(ll_to_earth_public(${centerLatitude}, ${centerLongitude}), ll_to_earth_public(${north}, ${west})),
    earth_distance(ll_to_earth_public(${centerLatitude}, ${centerLongitude}), ll_to_earth_public(${north}, ${east}))
  )`;

  return { centerLatitude, centerLongitude, radius };
};

const withBoundingBox = <T>(qb: SelectQueryBuilder<DB, 'asset' | 'asset_exif', T>, bbox: BoundingBox) => {
  const { west, south, east, north } = bbox;
  const withLatitude = qb.where('asset_exif.latitude', '>=', south).where('asset_exif.latitude', '<=', north);

  if (west <= east) {
    return withLatitude.where('asset_exif.longitude', '>=', west).where('asset_exif.longitude', '<=', east);
  }

  return withLatitude.where((eb) =>
    eb.or([eb('asset_exif.longitude', '>=', west), eb('asset_exif.longitude', '<=', east)]),
  );
};

/** FL-54: leaves out assets of owners who hide their locations from the viewer (no-op when there are none). */
const withoutLocationHiddenOwners = <O>(qb: SelectQueryBuilder<DB, 'asset' | 'asset_exif', O>, ownerIds?: string[]) =>
  ownerIds && ownerIds.length > 0 ? qb.where('asset.ownerId', 'not in', ownerIds) : qb;

@Injectable()
export class AssetRepository {
  private readonly forkPrivacy: ForkPrivacyRepository;
  private readonly forkEnrichment: ForkEnrichmentRepository;
  private readonly smartAlbums: SmartAlbumRepository;

  constructor(@InjectKysely() private db: Kysely<DB>) {
    this.forkPrivacy = new ForkPrivacyRepository(db);
    this.forkEnrichment = new ForkEnrichmentRepository(db);
    this.smartAlbums = new SmartAlbumRepository(db);
  }

  @GenerateSql({
    params: [
      {
        exif: { dateTimeOriginal: DummyValue.DATE, lockedProperties: ['dateTimeOriginal'] },
        lockedPropertiesBehavior: 'append',
      },
    ],
  })
  async upsertExif({ exif, audio, video, keyframes, lockedPropertiesBehavior }: UpsertExifOptions): Promise<void> {
    let query = this.db;
    if (audio) {
      (query as any) = this.db.with('audio', (qb) =>
        qb
          .insertInto('asset_audio')
          .values(audio)
          .onConflict((oc) =>
            oc.column('assetId').doUpdateSet(({ ref }) => ({
              bitrate: ref('excluded.bitrate'),
              index: ref('excluded.index'),
              profile: ref('excluded.profile'),
              codecName: ref('excluded.codecName'),
              channels: ref('excluded.channels'),
              channelLayout: ref('excluded.channelLayout'),
              sampleRate: ref('excluded.sampleRate'),
            })),
          ),
      );
    }

    if (video) {
      (query as any) = query.with('video', (qb) =>
        qb
          .insertInto('asset_video')
          .values(video)
          .onConflict((oc) =>
            oc.column('assetId').doUpdateSet(({ ref }) => ({
              bitrate: ref('excluded.bitrate'),
              frameCount: ref('excluded.frameCount'),
              timeBase: ref('excluded.timeBase'),
              index: ref('excluded.index'),
              profile: ref('excluded.profile'),
              level: ref('excluded.level'),
              colorPrimaries: ref('excluded.colorPrimaries'),
              colorTransfer: ref('excluded.colorTransfer'),
              colorMatrix: ref('excluded.colorMatrix'),
              dvProfile: ref('excluded.dvProfile'),
              dvLevel: ref('excluded.dvLevel'),
              dvBlSignalCompatibilityId: ref('excluded.dvBlSignalCompatibilityId'),
              codecName: ref('excluded.codecName'),
              formatName: ref('excluded.formatName'),
              formatLongName: ref('excluded.formatLongName'),
              pixelFormat: ref('excluded.pixelFormat'),
            })),
          ),
      );
    }

    if (keyframes) {
      (query as any) = query.with('keyframe', (qb) =>
        qb
          .insertInto('asset_keyframe')
          .values(keyframes)
          .onConflict((oc) =>
            oc.column('assetId').doUpdateSet(({ ref }) => ({
              pts: ref('excluded.pts'),
              accDuration: ref('excluded.accDuration'),
              ownDuration: ref('excluded.ownDuration'),
              totalDuration: ref('excluded.totalDuration'),
              packetCount: ref('excluded.packetCount'),
              outputFrames: ref('excluded.outputFrames'),
            })),
          ),
      );
    }

    await query
      .insertInto('asset_exif')
      .values(exif)
      .onConflict((oc) =>
        oc.column('assetId').doUpdateSet((eb) => {
          const updateLocked = <T extends keyof AssetExifTable>(col: T) => eb.ref(`excluded.${col}`);
          const skipLocked = <T extends keyof AssetExifTable>(col: T) =>
            eb
              .case()
              .when(sql`${col}`, '=', eb.fn.any('asset_exif.lockedProperties'))
              .then(eb.ref(`asset_exif.${col}`))
              .else(eb.ref(`excluded.${col}`))
              .end();
          const ref = lockedPropertiesBehavior === 'skip' ? skipLocked : updateLocked;
          return {
            ...removeUndefinedKeys(
              {
                description: ref('description'),
                exifImageWidth: ref('exifImageWidth'),
                exifImageHeight: ref('exifImageHeight'),
                fileSizeInByte: ref('fileSizeInByte'),
                orientation: ref('orientation'),
                dateTimeOriginal: ref('dateTimeOriginal'),
                modifyDate: ref('modifyDate'),
                timeZone: ref('timeZone'),
                latitude: ref('latitude'),
                longitude: ref('longitude'),
                projectionType: ref('projectionType'),
                city: ref('city'),
                livePhotoCID: ref('livePhotoCID'),
                autoStackId: ref('autoStackId'),
                state: ref('state'),
                country: ref('country'),
                make: ref('make'),
                model: ref('model'),
                lensModel: ref('lensModel'),
                fNumber: ref('fNumber'),
                focalLength: ref('focalLength'),
                iso: ref('iso'),
                exposureTime: ref('exposureTime'),
                profileDescription: ref('profileDescription'),
                colorspace: ref('colorspace'),
                bitsPerSample: ref('bitsPerSample'),
                rating: ref('rating'),
                fps: ref('fps'),
                tags: ref('tags'),
                lockedProperties:
                  lockedPropertiesBehavior === 'append'
                    ? distinctLocked(eb, exif.lockedProperties ?? null)
                    : ref('lockedProperties'),
              },
              exif,
            ),
          };
        }),
      )
      .execute();
  }

  @GenerateSql({ params: [[DummyValue.UUID], { model: DummyValue.STRING }] })
  @Chunked()
  async updateAllExif(
    ids: string[],
    options: Updateable<AssetExifTable>,
    unlock: readonly LockableProperty[] = [],
  ): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    const locked = Object.keys(options) as LockableProperty[];
    await this.db
      .updateTable('asset_exif')
      .set((eb) => ({
        ...options,
        // `unlock` releases locks the change makes stale (a typed place name at new coordinates)
        lockedProperties:
          unlock.length === 0
            ? distinctLocked(eb, locked)
            : sql<
                LockableProperty[] | null
              >`nullif(array(select distinct property from unnest(${eb.ref('asset_exif.lockedProperties')} || ${locked}) property where not property = any(${[...unlock]})), '{}')`,
      }))
      .where('assetId', 'in', ids)
      .execute();
  }

  /**
   * FL-51: removes the location of these assets (the geolocation utility's "Remove location"): the
   * coordinates and the place names read from them. The coordinates stay locked, so the sidecar is
   * written without them and a later metadata read keeps the location removed instead of reading
   * the original file's coordinates back.
   */
  @Chunked()
  async clearLocation(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    await this.db
      .updateTable('asset_exif')
      .set((eb) => ({
        latitude: null,
        longitude: null,
        city: null,
        state: null,
        country: null,
        lockedProperties: distinctLocked(eb, ['latitude', 'longitude']),
      }))
      .where('assetId', 'in', ids)
      .execute();
  }

  @GenerateSql({ params: [[DummyValue.UUID], DummyValue.NUMBER, DummyValue.STRING] })
  @Chunked()
  updateDateTimeOriginal(ids: string[], delta?: number, timeZone?: string) {
    return this.db
      .updateTable('asset_exif')
      .set((eb) => ({
        dateTimeOriginal: sql`"dateTimeOriginal" + ${(delta ?? 0) + ' minute'}::interval`,
        timeZone,
        lockedProperties: distinctLocked(eb, ['dateTimeOriginal', 'timeZone']),
      }))
      .where('assetId', 'in', ids)
      .returning(['assetId', 'dateTimeOriginal', 'timeZone'])
      .execute();
  }

  /**
   * Set one asset's capture date outright, locking it as `updateDateTimeOriginal` does (FL-32).
   *
   * The durable bulk shift uses this with `recorded start + minutes`, which lands where the relative
   * update would and can be repeated without moving the date again. The time zone is not touched.
   */
  setDateTimeOriginal(assetId: string, dateTimeOriginal: Date) {
    return this.db
      .updateTable('asset_exif')
      .set((eb) => ({
        dateTimeOriginal,
        lockedProperties: distinctLocked(eb, ['dateTimeOriginal', 'timeZone']),
      }))
      .where('assetId', '=', assetId)
      .returning(['assetId', 'dateTimeOriginal'])
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID, ['description']] })
  unlockProperties(assetId: string, properties: LockableProperty[]) {
    return this.db
      .updateTable('asset_exif')
      .where('assetId', '=', assetId)
      .set((eb) => ({
        lockedProperties: sql`nullif(array(select distinct property from unnest(${eb.ref('asset_exif.lockedProperties')}) property where not property = any(${properties})), '{}')`,
      }))
      .execute();
  }

  async upsertJobStatus(...jobStatus: Insertable<AssetJobStatusTable>[]): Promise<void> {
    if (jobStatus.length === 0) {
      return;
    }

    const values = jobStatus.map((row) => ({ ...row, assetId: asUuid(row.assetId) }));
    await this.db
      .insertInto('asset_job_status')
      .values(values)
      .onConflict((oc) =>
        oc.column('assetId').doUpdateSet((eb) =>
          removeUndefinedKeys(
            {
              duplicatesDetectedAt: eb.ref('excluded.duplicatesDetectedAt'),
              facesRecognizedAt: eb.ref('excluded.facesRecognizedAt'),
              metadataExtractedAt: eb.ref('excluded.metadataExtractedAt'),
              ocrAt: eb.ref('excluded.ocrAt'),
            },
            values[0],
          ),
        ),
      )
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getMetadata(assetId: string) {
    return this.db
      .selectFrom('asset_metadata')
      .select(['key', 'value', 'updatedAt'])
      .where('assetId', '=', assetId)
      .execute();
  }

  async upsertMetadata(id: string, items: Array<{ key: string; value: Record<string, unknown> }>, kysely?: Kysely<DB>) {
    if (items.length === 0) {
      return [];
    }

    const execute = async (tx: Kysely<DB>) => {
      const result = await tx
        .insertInto('asset_metadata')
        .values(items.map((item) => ({ assetId: id, ...item })))
        .onConflict((oc) =>
          oc
            .columns(['assetId', 'key'])
            .doUpdateSet((eb) => ({ key: eb.ref('excluded.key'), value: eb.ref('excluded.value') })),
        )
        .returning(['key', 'value', 'updatedAt'])
        .execute();

      await this.syncIsNsfwForItems(
        tx,
        items.map((item) => ({ assetId: id, ...item })),
      );
      return result;
    };

    return kysely ? execute(kysely) : this.db.transaction().execute(execute);
  }

  /** Update the legacy privacy projection inside the caller's transaction. */
  async updateIsNsfw(assetId: string, isNsfw: boolean, kysely: Kysely<DB> = this.db): Promise<void> {
    await kysely
      .updateTable('asset')
      .set({ is_nsfw: isNsfw })
      .where('id', '=', asUuid(assetId))
      .where('is_nsfw', '!=', isNsfw)
      .execute();
  }

  async upsertBulkMetadata(items: Insertable<AssetMetadataTable>[]) {
    return this.db.transaction().execute(async (tx) => {
      const result = await tx
        .insertInto('asset_metadata')
        .values(items)
        .onConflict((oc) =>
          oc
            .columns(['assetId', 'key'])
            .doUpdateSet((eb) => ({ key: eb.ref('excluded.key'), value: eb.ref('excluded.value') })),
        )
        .returning(['assetId', 'key', 'value', 'updatedAt'])
        .execute();

      await this.syncIsNsfwForItems(tx, items);
      return result;
    });
  }

  /**
   * Derive privacy once for every `ml-enrichment` item, update the legacy
   * projection, then mirror the same committed state into the fork sidecar.
   * All three writes share the caller's transaction.
   */
  private async syncIsNsfwForItems(
    kysely: Kysely<DB>,
    items: Array<{ assetId: string; key: string; value: unknown }>,
  ): Promise<void> {
    const privacyAssetIds: string[] = [];
    for (const item of items) {
      if (item.key !== AssetMetadataKey.MlEnrichment) {
        continue;
      }
      const isNsfw = deriveIsNsfwFromMetadata(item.value) ?? false;
      await this.updateIsNsfw(item.assetId, isNsfw, kysely);
      privacyAssetIds.push(item.assetId);
    }
    await this.forkPrivacy.mirrorManyFromLegacy([...new Set(privacyAssetIds)], kysely);
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING] })
  getMetadataByKey(assetId: string, key: string, kysely: Kysely<DB> = this.db) {
    return kysely
      .selectFrom('asset_metadata')
      .select(['key', 'value', 'updatedAt'])
      .where('assetId', '=', assetId)
      .where('key', '=', key)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING] })
  async deleteMetadataByKey(id: string, key: string) {
    await this.db.transaction().execute(async (tx) => {
      await tx.deleteFrom('asset_metadata').where('assetId', '=', id).where('key', '=', key).execute();
      if (key === AssetMetadataKey.MlEnrichment) {
        await this.updateIsNsfw(id, false, tx);
        await this.forkPrivacy.mirrorFromLegacy(id, tx);
      }
    });
  }

  @GenerateSql({ params: [[{ assetId: DummyValue.UUID, key: DummyValue.STRING }]] })
  async deleteBulkMetadata(items: Array<{ assetId: string; key: string }>) {
    if (items.length === 0) {
      return;
    }

    await this.db.transaction().execute(async (tx) => {
      const privacyAssetIds: string[] = [];
      for (const { assetId, key } of items) {
        await tx.deleteFrom('asset_metadata').where('assetId', '=', assetId).where('key', '=', key).execute();
        if (key === AssetMetadataKey.MlEnrichment) {
          await this.updateIsNsfw(assetId, false, tx);
          privacyAssetIds.push(assetId);
        }
      }
      await this.forkPrivacy.mirrorManyFromLegacy([...new Set(privacyAssetIds)], tx);
    });
  }

  /**
   * Creates an asset. With `lock` (FL-34, an upload into the Locked view) its lock record is written
   * in the same transaction, so the asset is never listed unlocked, not even for a moment.
   */
  async create(asset: Insertable<AssetTable>, lock?: { reason: AssetLockReason; lockedBy: string | null }) {
    return this.db.transaction().execute(async (tx) => {
      const result = await tx.insertInto('asset').values(asset).returningAll().executeTakeFirstOrThrow();
      await this.forkPrivacy.mirrorFromLegacy(result.id, tx);
      await this.forkEnrichment.initialize([result.id], tx);
      if (lock) {
        await this.lockIn(tx, [result.id], lock.reason, lock.lockedBy);
      }
      return result;
    });
  }

  @ChunkedArray({ chunkSize: 4000 })
  async createAll(assets: Insertable<AssetTable>[]) {
    if (assets.length === 0) {
      return [];
    }
    return this.inTransaction(async (tx) => {
      const ids = await tx.insertInto('asset').values(assets).returning('id').execute();
      await this.forkPrivacy.mirrorManyFromLegacy(
        ids.map(({ id }) => id),
        tx,
      );
      await this.forkEnrichment.initialize(
        ids.map(({ id }) => id),
        tx,
      );
      return ids.map(({ id }) => id);
    });
  }

  /**
   * One owner's timeline assets in a local-date window, with the place their metadata
   * records, ordered by local capture time (FL-62).
   *
   * `localDateTime` is the wall clock where the photograph was taken, so the bounds are
   * compared as local dates: a trip that crossed a timezone still returns the days the
   * owner lived through, not the server's. Only assets with a generated preview are
   * returned, so a story can always be rendered.
   */
  // No @GenerateSql: the committed snapshots under server/src/queries are generated against
  // a live database, which this slice could not run.
  getEventStoryCandidates(ownerId: string, from: Date, to: Date) {
    return this.db
      .selectFrom('asset')
      .innerJoin('asset_job_status', 'asset.id', 'asset_job_status.assetId')
      .leftJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
      .select([
        'asset.id as id',
        'asset.localDateTime as localDateTime',
        'asset_exif.city as city',
        'asset_exif.state as state',
        'asset_exif.country as country',
      ])
      .where('asset.ownerId', '=', ownerId)
      .where(isTimelineVisible('asset'))
      .where('asset.deletedAt', 'is', null)
      .where('asset.localDateTime', '>=', from)
      .where('asset.localDateTime', '<=', to)
      .where((eb) =>
        eb.exists((qb) =>
          qb
            .selectFrom('asset_file')
            .whereRef('asset_file.assetId', '=', 'asset.id')
            .where('asset_file.type', '=', AssetFileType.Preview),
        ),
      )
      .orderBy('asset.localDateTime', 'asc')
      .orderBy('asset.id', 'asc')
      .execute();
  }

  /**
   * A spread of one owner's assets across a calendar year, for a year-in-review recap
   * (FL-62). Diversity is enforced in SQL: at most `perDay` assets from any one local day
   * and at most `perMonth` from any one local month, so a single busy weekend cannot
   * become the whole year. The year boundaries are the owner's local ones.
   */
  // No @GenerateSql: the committed snapshots under server/src/queries are generated against
  // a live database, which this slice could not run.
  getYearInReviewCandidates(ownerId: string, year: number, perDay = 2, perMonth = 10) {
    return this.db
      .with('candidate', (qb) =>
        qb
          .selectFrom('asset')
          .innerJoin('asset_job_status', 'asset.id', 'asset_job_status.assetId')
          .select([
            'asset.id as id',
            'asset.localDateTime as localDateTime',
            sql<number>`date_part('month', (asset."localDateTime" at time zone 'UTC')::date)::int`.as('month'),
            sql<number>`row_number() over (
              partition by (asset."localDateTime" at time zone 'UTC')::date
              order by asset."localDateTime" asc, asset.id asc
            )`.as('dayRank'),
          ])
          .where('asset.ownerId', '=', ownerId)
          .where(isTimelineVisible('asset'))
          .where('asset.deletedAt', 'is', null)
          .where(sql`date_part('year', (asset."localDateTime" at time zone 'UTC')::date)::int`, '=', year)
          .where((eb) =>
            eb.exists((qb) =>
              qb
                .selectFrom('asset_file')
                .whereRef('asset_file.assetId', '=', 'asset.id')
                .where('asset_file.type', '=', AssetFileType.Preview),
            ),
          ),
      )
      .with('ranked', (qb) =>
        qb
          .selectFrom('candidate')
          .selectAll('candidate')
          .select(
            sql<number>`row_number() over (
              partition by "month"
              order by "localDateTime" asc, "id" asc
            )`.as('monthRank'),
          )
          .where('candidate.dayRank', '<=', perDay),
      )
      .selectFrom('ranked')
      .select(['id', 'localDateTime', 'month'])
      .where('ranked.monthRank', '<=', perMonth)
      .orderBy('localDateTime', 'asc')
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, { year: 2000, day: 1, month: 1 }] })
  getByDayOfYear(ownerIds: string[], { year, day, month }: YearMonthDay) {
    return this.db
      .with('res', (qb) =>
        qb
          .with('today', (qb) =>
            qb
              .selectFrom((eb) =>
                eb
                  .fn('generate_series', [
                    sql`(select date_part('year', min(("localDateTime" at time zone 'UTC')::date))::int from asset)`,
                    sql`${year - 1}`,
                  ])
                  .as('year'),
              )
              .select((eb) => eb.fn('make_date', [sql`year::int`, sql`${month}::int`, sql`${day}::int`]).as('date')),
          )
          .selectFrom('today')
          .innerJoinLateral(
            (qb) =>
              qb
                .selectFrom('asset')
                .select(['asset.id', 'asset.localDateTime'])
                .innerJoin('asset_job_status', 'asset.id', 'asset_job_status.assetId')
                .where(sql`(asset."localDateTime" at time zone 'UTC')::date`, '=', sql`today.date`)
                .where('asset.ownerId', '=', anyUuid(ownerIds))
                .where(isTimelineVisible('asset'))
                .where((eb) =>
                  eb.exists((qb) =>
                    qb
                      .selectFrom('asset_file')
                      .whereRef('assetId', '=', 'asset.id')
                      .where('asset_file.type', '=', AssetFileType.Preview),
                  ),
                )
                .where('asset.deletedAt', 'is', null)
                .orderBy(sql`(asset."localDateTime" at time zone 'UTC')::date`, 'desc')
                .limit(20)
                .as('a'),
            (join) => join.onTrue(),
          )
          .selectAll('a'),
      )
      .selectFrom('res')
      .select(sql<number>`date_part('year', ("localDateTime" at time zone 'UTC')::date)::int`.as('year'))
      .select((eb) => eb.fn.jsonAgg(eb.table('res')).as('assets'))
      .groupBy(sql`("localDateTime" at time zone 'UTC')::date`)
      .orderBy(sql`("localDateTime" at time zone 'UTC')::date`, 'desc')
      .execute();
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  @ChunkedArray()
  getByIds(ids: string[]) {
    return this.db
      .selectFrom('asset')
      .selectAll('asset')
      .select(isLocked('asset').as('isLocked'))
      .where('asset.id', '=', anyUuid(ids))
      .execute();
  }

  /** Which of these assets are locked (FL-34: the lock record), whoever owns them. */
  @ChunkedSet()
  async getLockedAssetIds(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) {
      return new Set();
    }

    const rows = await this.db
      .selectFrom('asset_lock')
      .select('asset_lock.assetId')
      .where('asset_lock.assetId', '=', anyUuid(ids))
      .execute();
    return new Set(rows.map(({ assetId }) => assetId));
  }

  /** Why each of these assets is locked; an asset that is not locked is absent (FL-34). */
  @ChunkedArray()
  getLockReasons(ids: string[]) {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }

    return this.db
      .selectFrom('asset_lock')
      .select(['asset_lock.assetId', 'asset_lock.reason', 'asset_lock.lockedAt'])
      .where('asset_lock.assetId', '=', anyUuid(ids))
      .execute();
  }

  /**
   * Locks assets (FL-34). A lock is metadata: albums, favourites, tags, faces, stack and the stored
   * visibility are left as they are, and every read except the owner's elevated session stops showing
   * the asset. Stacks and live photos lock as a whole: every member of a stack and both parts of a live
   * photo lock with any one of them. An asset that is already locked keeps its lock and reason.
   *
   * In the same transaction every cover, featured photo and face thumbnail the newly locked assets
   * were is released (FL-53, `releaseLockedCoverReferences`), and the assets are touched so clients
   * that sync learn of the change. Returns the ids this call locked, for the caller to queue the
   * released face thumbnails and sidecar writes. With `kysely` (a caller's transaction) the lock
   * commits with the caller's own writes, such as the sensitive review that caused it.
   */
  async lock(ids: string[], reason: AssetLockReason, lockedBy: string | null, kysely?: Kysely<DB>): Promise<string[]> {
    if (ids.length === 0) {
      return [];
    }

    return kysely
      ? this.lockIn(kysely, ids, reason, lockedBy)
      : this.inTransaction((tx) => this.lockIn(tx, ids, reason, lockedBy));
  }

  /**
   * FL-34: takes, in the caller's transaction and in id order, the row locks that a later lock or
   * unlock of `ids` needs on its whole stack and live-photo group. Called first in a transaction that
   * writes one member (its `is_nsfw`, its review) and may then lock the group, so two such
   * transactions for members of one group queue here instead of each holding its own row and waiting
   * on the other's.
   */
  async lockGroupRows(ids: string[], kysely: Kysely<DB>): Promise<void> {
    await lockAssetRowsInOrder(kysely, await this.getLockGroupIds(kysely, ids));
  }

  /**
   * FL-34: the ids a lock or unlock of `ids` covers, read outside any transaction: what a caller takes
   * the per-asset metadata locks of before it takes the group's rows (see `lockGroupMembers`).
   */
  findLockGroupIds(ids: string[]): Promise<string[]> {
    return ids.length === 0 ? Promise.resolve([]) : this.getLockGroupIds(this.db, ids);
  }

  /**
   * FL-34: `lockGroupRows`, returning each member of the group with its owner and whether it is locked
   * as read under those row locks, for a caller that reviews and unlocks the whole group in `kysely`.
   */
  async lockGroupMembers(
    ids: string[],
    kysely: Kysely<DB>,
  ): Promise<{ id: string; ownerId: string; isLocked: boolean }[]> {
    const groupIds = await this.getLockGroupIds(kysely, ids);
    if (groupIds.length === 0) {
      return [];
    }
    await lockAssetRowsInOrder(kysely, groupIds);
    return kysely
      .selectFrom('asset')
      .select(['asset.id', 'asset.ownerId'])
      .select(isLocked('asset').as('isLocked'))
      .where('asset.id', '=', anyUuid(groupIds))
      .orderBy('asset.id')
      .execute();
  }

  /** `lock` inside the caller's transaction `tx`. */
  private async lockIn(
    tx: Kysely<DB>,
    ids: string[],
    reason: AssetLockReason,
    lockedBy: string | null,
  ): Promise<string[]> {
    const targetIds = await this.getLockGroupIds(tx, ids);
    if (targetIds.length === 0) {
      return [];
    }
    // the group's rows before its lock records, in id order, like every lock writer (FL-34)
    await lockAssetRowsInOrder(tx, targetIds);

    const { rows } = await sql<{ assetId: string }>`
      insert into asset_lock ("assetId", "reason", "lockedBy")
      select target.id, ${reason}, ${lockedBy}::uuid
      from unnest(${`{${targetIds}}`}::uuid[]) as target(id)
      on conflict ("assetId") do nothing
      returning "assetId"
    `.execute(tx);
    const lockedIds = rows.map(({ assetId }) => assetId);
    if (lockedIds.length > 0) {
      // This update waits for any Studio export publication holding these rows, so the propagation
      // below sees every version it committed (FL-106).
      await tx.updateTable('asset').set({ updatedAt: new Date() }).where('id', '=', anyUuid(lockedIds)).execute();
      lockedIds.push(...(await lockDerivedResults(tx, lockedIds)));
      await releaseLockedCoverReferences(tx, lockedIds);
    }

    return lockedIds;
  }

  /**
   * Assets that sensitive-content detection flagged, that no owner has reviewed and that are not locked
   * (FL-34): what "hide sensitive detections" locks when it is switched on. The source follows the
   * fork schema phase like `nsfwAssetIdExists` (`asset.is_nsfw` until the cutover, the privacy sidecar
   * once it is `active`), but only positive evidence counts: an asset with no privacy row, which the
   * fail-closed read predicate treats as sensitive, is never locked by this. A manual review, either
   * way, is the owner's and is left alone.
   */
  async getUnlockedDetectionIds(): Promise<string[]> {
    const rows = await this.db
      .selectFrom('asset')
      .select('asset.id')
      .where(
        sql<boolean>`case
        when coalesce((select phase from immich_fork.state where id = 1), 'inactive') = 'active' then exists (
          select 1
          from immich_fork.asset_privacy as privacy_asset
          where privacy_asset."assetId" = asset.id
            and privacy_asset."isNsfw" = true
        )
        else asset.is_nsfw = true
      end`,
      )
      .where('asset.deletedAt', 'is', null)
      .where(isNotLocked('asset'))
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('asset_metadata')
              .select('asset_metadata.assetId')
              .whereRef('asset_metadata.assetId', '=', 'asset.id')
              .where('asset_metadata.key', '=', AssetMetadataKey.MlEnrichment)
              .where(sql`asset_metadata.value #> '{nsfwDetection,review}'`, 'is not', null),
          ),
        ),
      )
      .execute();
    return rows.map(({ id }) => id);
  }

  /**
   * Unlocks assets (FL-34), stacks and live photos as a whole like `lock`. The stored visibility is
   * left as it is, so an item goes back exactly where it was. Returns what was unlocked and why it had
   * been locked. With `kysely` (a caller's transaction) the unlock commits with the caller's writes.
   */
  /**
   * Unlocks `ids` with their whole stacks and live photos. `reasons` limits the release to locks of
   * those reasons (FL-34: Mark Safe answers a sensitive verdict, so it releases marked and detected
   * locks and leaves an item the owner kept in the upstream Locked folder where it is).
   */
  async unlock(
    ids: string[],
    kysely?: Kysely<DB>,
    reasons?: AssetLockReason[],
  ): Promise<{ assetId: string; reason: AssetLockReason }[]> {
    if (ids.length === 0) {
      return [];
    }

    return kysely ? this.unlockIn(kysely, ids, reasons) : this.inTransaction((tx) => this.unlockIn(tx, ids, reasons));
  }

  /** `unlock` inside the caller's transaction `tx`. */
  private async unlockIn(
    tx: Kysely<DB>,
    ids: string[],
    reasons?: AssetLockReason[],
  ): Promise<{ assetId: string; reason: AssetLockReason }[]> {
    const targetIds = await this.getLockGroupIds(tx, ids);
    if (targetIds.length === 0) {
      return [];
    }
    // the group's rows before its lock records, in id order, like every lock writer (FL-34)
    await lockAssetRowsInOrder(tx, targetIds);

    const unlocked = await tx
      .deleteFrom('asset_lock')
      .where('asset_lock.assetId', '=', anyUuid(targetIds))
      .$if(!!reasons, (qb) => qb.where('asset_lock.reason', 'in', reasons!))
      .returning(['asset_lock.assetId', 'asset_lock.reason'])
      .execute();
    if (unlocked.length > 0) {
      const unlockedIds = unlocked.map(({ assetId }) => assetId);
      await tx.updateTable('asset').set({ updatedAt: new Date() }).where('id', '=', anyUuid(unlockedIds)).execute();
    }

    return unlocked;
  }

  /**
   * The ids a lock or unlock of `ids` covers: the assets themselves, the stills whose video part they
   * are, every member of their stacks, and the video parts of all of those.
   */
  private async getLockGroupIds(db: Kysely<DB>, ids: string[]): Promise<string[]> {
    const { rows } = await sql<{ id: string }>`
      with direct as (
        select asset.id, asset."stackId" from asset where asset.id = ${anyUuid(ids)}
        union
        select still.id, still."stackId" from asset as still where still."livePhotoVideoId" = ${anyUuid(ids)}
      ),
      grouped as (
        select direct.id from direct
        union
        select member.id from asset as member inner join direct on member."stackId" = direct."stackId"
      )
      select grouped.id from grouped
      union
      select asset."livePhotoVideoId" as id
      from asset
      inner join grouped on grouped.id = asset.id
      where asset."livePhotoVideoId" is not null
    `.execute(db);
    return rows.map(({ id }) => id);
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  @ChunkedArray({ paramIndex: 0 })
  getByIdsWithAllRelationsButStacks(ids: string[], viewingUserId?: string) {
    return this.db
      .selectFrom('asset')
      .selectAll('asset')
      .select(isLocked('asset').as('isLocked'))
      .select(withFacesAndPeople({ viewingUserId }))
      .select(withTags)
      .$call(withExif)
      .where('asset.id', '=', anyUuid(ids))
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async deleteAll(ownerId: string): Promise<
    {
      originalPath: string;
      reservationTemporaryPath: string | null;
      libraryId: string | null;
      isOffline: boolean;
    }[]
  > {
    return this.db.transaction().execute(async (tx) => {
      const locked = await sql<{
        id: string;
        originalPath: string;
        reservationTemporaryPath: string | null;
        libraryId: string | null;
        isOffline: boolean;
      }>`
        SELECT
          asset.id,
          coalesce(mapping."upstreamPath", reservation."upstreamPath", asset."originalPath") AS "originalPath",
          reservation."temporaryPath" AS "reservationTemporaryPath",
          asset."libraryId",
          asset."isOffline"
        FROM public.asset asset
        LEFT JOIN immich_fork.asset_physical_file mapping ON mapping."assetId" = asset.id
        LEFT JOIN immich_fork.asset_storage_reservation reservation ON reservation."assetId" = asset.id
        WHERE asset."ownerId" = ${ownerId}::uuid
        FOR UPDATE OF asset
      `.execute(tx);
      const assets = locked.rows;
      const ids = assets.map(({ id }) => id);
      // Retained video versions are left to the nightly orphan release, which queues their files
      // for deletion; this bulk path returns only the originals it removed.
      await this.forkPrivacy.delete(ids, tx);
      await this.forkEnrichment.delete(ids, tx);
      await this.smartAlbums.deleteAssets(ids, tx);
      await this.deleteForkDerivedResults(ids, tx);
      // `stack.primaryAssetId` has no ON DELETE action, so stacks have to go before
      // the assets they point at. Upstream never hits this because it deletes the
      // user row and lets a single cascading statement remove `stack` and `asset`
      // together (NO ACTION is only enforced at the end of the statement). The fork
      // deletes the assets in their own statement — to collect fork-managed original
      // paths and clean up the `immich_fork` sidecar rows — so the stacks have to be
      // removed first, including any owned by someone else that points at one of
      // these assets.
      await tx
        .deleteFrom('stack')
        .where((eb) => eb.or([eb('ownerId', '=', asUuid(ownerId)), eb('primaryAssetId', '=', anyUuid(ids))]))
        .execute();
      await tx.deleteFrom('asset').where('ownerId', '=', ownerId).execute();
      return assets.map(({ originalPath, reservationTemporaryPath, libraryId, isOffline }) => ({
        originalPath,
        reservationTemporaryPath,
        libraryId,
        isOffline,
      }));
    });
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING] })
  getByLibraryIdAndOriginalPath(libraryId: string, originalPath: string) {
    return this.db
      .selectFrom('asset')
      .selectAll('asset')
      .where('libraryId', '=', asUuid(libraryId))
      .where('originalPath', '=', originalPath)
      .limit(1)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getLivePhotoCount(motionId: string): Promise<number> {
    const [{ count }] = await this.db
      .selectFrom('asset')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('livePhotoVideoId', '=', asUuid(motionId))
      .execute();
    return count;
  }

  @GenerateSql()
  getFileSamples() {
    return this.db.selectFrom('asset_file').select(['assetId', 'path']).limit(sql.lit(3)).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForCopy(id: string) {
    return this.db
      .selectFrom('asset')
      .select(['id', 'stackId', 'originalPath', 'isFavorite'])
      .select(withFiles)
      .where('id', '=', asUuid(id))
      .limit(1)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getById(
    id: string,
    { exifInfo, faces, files, library, owner, smartSearch, stack, tags, edits }: GetByIdsRelations = {},
  ) {
    return this.db
      .selectFrom('asset')
      .selectAll('asset')
      .select(isLocked('asset').as('isLocked'))
      .where('asset.id', '=', asUuid(id))
      .$if(!!exifInfo, withExif)
      .$if(!!faces, (qb) =>
        qb
          .select(faces?.person ? withFacesAndPeople({ viewingUserId: faces.viewingUserId! }) : withFaces)
          .$narrowType<{ faces: NotNull }>(),
      )
      .$if(!!library, (qb) => qb.select(withLibrary))
      .$if(!!owner, (qb) => qb.select(withOwner))
      .$if(!!smartSearch, withSmartSearch)
      .$if(!!stack, (qb) =>
        qb
          .leftJoin('stack', (join) =>
            join
              .onRef('stack.id', '=', 'asset.stackId')
              .on((eb) => eb.not(hasHiddenLockedPrimary(eb, stack!.lockedOwnerId))),
          )
          .$if(!stack!.assets, (qb) =>
            qb.select((eb) => eb.fn.toJson(eb.table('stack')).$castTo<Stack | null>().as('stack')),
          )
          .$if(!!stack!.assets, (qb) =>
            qb
              .leftJoinLateral(
                (eb) =>
                  eb
                    .selectFrom('asset as stacked')
                    .selectAll('stack')
                    .select(
                      sql<
                        ShallowDehydrateObject<Selectable<AssetTable>>[]
                      >`array_agg(to_json(stacked) ORDER BY stacked."fileCreatedAt" ASC)`.as('assets'),
                    )
                    .whereRef('stacked.stackId', '=', 'stack.id')
                    .whereRef('stacked.id', '!=', 'stack.primaryAssetId')
                    .where('stacked.deletedAt', 'is', null)
                    .where('stacked.visibility', '=', AssetVisibility.Timeline)
                    // stacks lock as a whole (FL-34); a member whose lock differs never rides along
                    .where(sql<boolean>`${isLocked('stacked')} = ${isLocked('asset')}`)
                    .groupBy('stack.id')
                    .as('stacked_assets'),
                (join) => join.on('stack.id', 'is not', null),
              )
              .select((eb) => eb.fn.toJson(eb.table('stacked_assets')).as('stack')),
          ),
      )
      .$if(!!files, (qb) => qb.select(withFiles))
      .$if(!!tags, (qb) => qb.select(withTags))
      .$if(!!edits, (qb) => qb.select(withEdits))
      .limit(1)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [[DummyValue.UUID], {}] })
  @Chunked()
  async updateAll(ids: string[], options: Updateable<AssetTable>): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    // `locked` is never stored (FL-34): it is a lock record. `AssetService` translates a request for
    // it before it gets here; any other caller that still asks gets the lock, and nothing is stored.
    if (options.visibility === AssetVisibility.Locked) {
      const { visibility: _visibility, ...rest } = options;
      if (!isEmpty(omitBy(rest, isUndefined))) {
        await this.db.updateTable('asset').set(rest).where('id', '=', anyUuid(ids)).execute();
      }
      await this.lock(ids, AssetLockReason.Marked, null);
      return;
    }

    await this.db.updateTable('asset').set(options).where('id', '=', anyUuid(ids)).execute();
  }

  async updateByLibraryId(libraryId: string, options: Updateable<AssetTable>): Promise<void> {
    await this.db.updateTable('asset').set(options).where('libraryId', '=', asUuid(libraryId)).execute();
  }

  /**
   * The ids of every other member of the stacks `assetIds` belong to (FL-53). Call it after `update` or
   * `updateAll` moves `assetIds` into or out of the Locked folder, so the caller can give every stack
   * sibling the same real-time update the moved assets get: the cascade in `locked-stacks.ts` moves the
   * whole stack in the same transaction, so by the time this reads, every sibling already reflects it.
   */
  async getStackSiblingIds(assetIds: string[]): Promise<string[]> {
    if (assetIds.length === 0) {
      return [];
    }

    const rows = await otherStackMembers(this.db, assetIds).execute();
    return rows.map(({ id }) => id);
  }

  async update(input: Updateable<AssetTable> & { id: string }) {
    let asset = input;
    // `locked` is never stored (FL-34); see `updateAll`
    if (input.visibility === AssetVisibility.Locked) {
      const { visibility: _visibility, ...rest } = input;
      await this.lock([input.id], AssetLockReason.Marked, null);
      asset = rest;
    }

    const value = omitBy(asset, isUndefined);
    delete value.id;
    if (isEmpty(value)) {
      return this.getById(asset.id, { exifInfo: true, faces: {}, edits: true });
    }

    const updateAndSelect = (db: Kysely<DB>) =>
      db
        .with('asset', (qb) => qb.updateTable('asset').set(asset).where('id', '=', asUuid(asset.id)).returningAll())
        .selectFrom('asset')
        .selectAll('asset')
        .$call(withExif)
        .$call((qb) => qb.select(withFaces))
        .$call((qb) => qb.select(withEdits))
        .executeTakeFirst();

    if (!asset.stackId) {
      return updateAndSelect(this.db);
    }

    // a stack that holds a locked photo is locked as a whole (FL-53, FL-34): joining one locks the rest
    return this.inTransaction(async (tx) => {
      const updated = await updateAndSelect(tx);
      await onStacksJoined(tx, [asset.stackId!]);
      return updated;
    });
  }

  /** Runs `callback` in a transaction, joining the current one when this repository is bound to it. */
  private inTransaction<T>(callback: (tx: Kysely<DB>) => Promise<T>): Promise<T> {
    return this.db.isTransaction ? callback(this.db) : this.db.transaction().execute(callback);
  }

  /**
   * Removes an asset row and everything the fork keeps for it, in one transaction.
   *
   * FL-169: with `release`, the deletion of the files the removal frees is queued inside that
   * transaction, while it holds the path lock of every one of them. A failure to queue rolls the
   * removal back, so the row (and a retry's way to its files) survives; once the row is gone, the
   * cleanup is already queued. FileDelete takes the same path locks, so it cannot count references
   * before this transaction ends: after a commit the removed rows no longer protect the files, and
   * after a rollback they still do. Files another asset still references are kept either way.
   */
  async remove(asset: { id: string }, release?: AssetFileRelease): Promise<RemovedAsset | undefined> {
    return this.db.transaction().execute(async (tx) => {
      const lockedPaths = new Set<string>();
      const lockPaths = async (paths: string[]) => {
        for (const path of [...new Set(paths)].filter((path) => !lockedPaths.has(path)).toSorted()) {
          await lockFilePath(tx, path);
          lockedPaths.add(path);
        }
      };

      if (release) {
        // Path locks come before the asset row lock, the order every other path-locking writer uses.
        // The paths are read again under the row lock below; one that changed in between is locked then.
        const unlocked = await this.readRemovedPaths(tx, asset.id, false);
        if (unlocked) {
          const videoEditPaths = await this.getReleasableVideoEditPaths([asset.id], tx);
          await lockPaths(release.files({ ...unlocked, videoEditPaths }));
        }
      }

      const lockedAsset = await this.readRemovedPaths(tx, asset.id, true);
      if (!lockedAsset) {
        return;
      }
      const videoEditPaths = await this.deleteVideoEditVersions([asset.id], tx);
      await this.forkPrivacy.delete([asset.id], tx);
      await this.forkEnrichment.delete([asset.id], tx);
      await this.smartAlbums.deleteAssets([asset.id], tx);
      await this.deleteForkDerivedResults([asset.id], tx);
      await tx.deleteFrom('asset').where('id', '=', asUuid(asset.id)).execute();
      const removed: RemovedAsset = { ...lockedAsset, ...(videoEditPaths.length > 0 && { videoEditPaths }) };

      if (release) {
        const files = release.files(removed);
        await lockPaths(files);
        await release.queue(files);
      }

      return removed;
    });
  }

  private async readRemovedPaths(tx: Kysely<DB>, id: string, lock: boolean) {
    const rows = await sql<{ originalPath: string; reservationTemporaryPath: string | null }>`
      SELECT
        coalesce(mapping."upstreamPath", reservation."upstreamPath", asset."originalPath") AS "originalPath",
        reservation."temporaryPath" AS "reservationTemporaryPath"
      FROM public.asset asset
      LEFT JOIN immich_fork.asset_physical_file mapping ON mapping."assetId" = asset.id
      LEFT JOIN immich_fork.asset_storage_reservation reservation ON reservation."assetId" = asset.id
      WHERE asset.id = ${id}::uuid
      ${lock ? sql`FOR UPDATE OF asset` : sql``}
    `.execute(tx);
    return rows.rows[0];
  }

  /**
   * The files of the assets' saved video versions, when the versions can be deleted with them now.
   * While fork writes are disabled or a handoff runs, the rows are left behind as orphans: the asset
   * delete must not fail, and the nightly orphan release reclaims their files later.
   */
  private async getReleasableVideoEditPaths(ids: string[], db: Kysely<DB>): Promise<string[] | undefined> {
    return (await this.getReleasableVideoEditVersions(ids, db))?.paths;
  }

  private async getReleasableVideoEditVersions(
    ids: string[],
    db: Kysely<DB>,
  ): Promise<{ count: number; paths: string[] } | undefined> {
    if (ids.length === 0) return;
    const phase = await sql<{
      phase: ForkSchemaPhase;
    }>`SELECT phase FROM immich_fork.state WHERE id=1 FOR SHARE`.execute(db);
    if (!phase.rows[0] || !isForkWriteEnabled(phase.rows[0].phase)) return;
    const handoff = await sql`SELECT 1 FROM immich_fork.migration_audit WHERE status='running'
      AND name IN ('official-handoff-preparation','fork-return-reconciliation') LIMIT 1`.execute(db);
    if (handoff.rows.length > 0) return;
    const retained = await sql<Pick<VideoEditVersion, 'masterPath' | 'proxyPath' | 'files'>>`
      SELECT "masterPath", "proxyPath", files FROM immich_fork.video_edit_version WHERE "assetId"=ANY(${ids}::uuid[])
      UNION ALL SELECT payload->>'masterPath', payload->>'proxyPath', payload->'files' FROM immich_fork.orphaned_records
      WHERE "sourceTable"='video_edit_version' AND payload->>'assetId'=ANY(${ids}::text[])`.execute(db);
    const paths = retained.rows
      .flatMap((version) => [
        version.masterPath,
        version.masterPath && getEditedMasterLineagePath(version.masterPath),
        version.proxyPath,
        ...version.files.map((file) => file.path),
      ])
      .filter((path): path is string => !!path);
    return { count: retained.rows.length, paths: [...new Set(paths)] };
  }

  private async deleteVideoEditVersions(ids: string[], db: Kysely<DB>): Promise<string[]> {
    const releasable = await this.getReleasableVideoEditVersions(ids, db);
    if (!releasable || releasable.count === 0) return [];
    const { paths } = releasable;
    await sql`DELETE FROM immich_fork.video_edit_selection WHERE "assetId"=ANY(${ids}::uuid[])`.execute(db);
    await sql`DELETE FROM immich_fork.video_edit_version WHERE "assetId"=ANY(${ids}::uuid[])`.execute(db);
    await sql`DELETE FROM immich_fork.orphaned_records WHERE "sourceTable" IN ('video_edit_selection','video_edit_version')
      AND payload->>'assetId'=ANY(${ids}::text[])`.execute(db);
    // FileDelete checks all remaining public and private references under a path lock.
    return paths;
  }

  private async deleteForkDerivedResults(ids: string[], db: Kysely<DB>): Promise<void> {
    if (ids.length === 0 || !isForkWriteEnabled(await getForkSchemaPhase(db))) {
      return;
    }
    await sql`
      DELETE FROM immich_fork.asset_health_candidate candidate
      USING immich_fork.asset_health health
      WHERE candidate."healthId" = health.id AND health."assetId" = ANY(${ids}::uuid[])
    `.execute(db);
    await sql`DELETE FROM immich_fork.asset_health WHERE "assetId" = ANY(${ids}::uuid[])`.execute(db);
    await sql`DELETE FROM immich_fork.asset_best_photo_score WHERE "assetId" = ANY(${ids}::uuid[])`.execute(db);
    await sql`DELETE FROM immich_fork.asset_video_duplicate_frame WHERE "assetId" = ANY(${ids}::uuid[])`.execute(db);
    await sql`DELETE FROM immich_fork.asset_storage_reservation WHERE "assetId" = ANY(${ids}::uuid[])`.execute(db);
    await sql`DELETE FROM immich_fork.asset_checksum WHERE "assetId" = ANY(${ids}::uuid[])`.execute(db);
    await sql`DELETE FROM immich_fork.asset_physical_file WHERE "assetId" = ANY(${ids}::uuid[])`.execute(db);
    await sql`
      DELETE FROM immich_fork.physical_file physical
      WHERE NOT EXISTS (
        SELECT 1 FROM immich_fork.asset_physical_file mapping
        WHERE mapping."physicalFileId" = physical.id
      )
    `.execute(db);
  }

  @GenerateSql({ params: [{ ownerId: DummyValue.UUID, libraryId: DummyValue.UUID, checksum: DummyValue.BUFFER }] })
  getByChecksum({ ownerId, libraryId, checksum }: AssetGetByChecksumOptions) {
    return this.db
      .selectFrom('asset')
      .selectAll('asset')
      .where('ownerId', '=', asUuid(ownerId))
      .where('checksum', '=', checksum)
      .$call((qb) => (libraryId ? qb.where('libraryId', '=', asUuid(libraryId)) : qb.where('libraryId', 'is', null)))
      .limit(1)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.BUFFER], { excludeNsfw: true }] })
  getByChecksums(userId: string, checksums: Buffer[], options: AssetChecksumOptions = {}) {
    return this.db
      .selectFrom('asset')
      .select(['id', 'checksum', 'deletedAt'])
      .where('ownerId', '=', asUuid(userId))
      .where('checksum', 'in', checksums)
      .$call((qb) => withLockedOwnerScope(qb, options.lockedOwnerId))
      .$call((qb) => withHiddenContentFilter(qb, options))
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.BUFFER, { excludeNsfw: true }] })
  async getUploadAssetIdByChecksum(
    ownerId: string,
    checksum: Buffer,
    options: AssetChecksumOptions = {},
  ): Promise<string | undefined> {
    const asset = await this.db
      .selectFrom('asset')
      .select('id')
      .where('ownerId', '=', asUuid(ownerId))
      .where('checksum', '=', checksum)
      .where('libraryId', 'is', null)
      .$call((qb) => withLockedOwnerScope(qb, options.lockedOwnerId))
      .$call((qb) => withHiddenContentFilter(qb, options))
      .limit(1)
      .executeTakeFirst();

    return asset?.id;
  }

  findLivePhotoMatch(options: LivePhotoSearchOptions) {
    const { ownerId, otherAssetId, livePhotoCID, type } = options;
    return this.db
      .selectFrom('asset')
      .select(['asset.id', 'asset.ownerId'])
      .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
      .where('id', '!=', asUuid(otherAssetId))
      .where('ownerId', '=', asUuid(ownerId))
      .where('type', '=', type)
      .where('asset_exif.livePhotoCID', '=', livePhotoCID)
      .limit(1)
      .executeTakeFirst();
  }

  getStatistics(ownerId: string, options: AssetStatsOptions): Promise<AssetStats> {
    const { visibility, isFavorite, isTrashed } = options;
    return this.db
      .selectFrom('asset')
      .select((eb) => eb.fn.countAll<number>().filterWhere('type', '=', AssetType.Audio).as(AssetType.Audio))
      .select((eb) => eb.fn.countAll<number>().filterWhere('type', '=', AssetType.Image).as(AssetType.Image))
      .select((eb) => eb.fn.countAll<number>().filterWhere('type', '=', AssetType.Video).as(AssetType.Video))
      .select((eb) => eb.fn.countAll<number>().filterWhere('type', '=', AssetType.Other).as(AssetType.Other))
      .where('ownerId', '=', asUuid(ownerId))
      .$if(visibility === undefined, withDefaultVisibility)
      .$if(!!visibility, (qb) => qb.where(visibilityIs(visibility!, 'asset')))
      .$if(isFavorite !== undefined, (qb) => qb.where('isFavorite', '=', isFavorite!))
      .$if(!!isTrashed, (qb) => qb.where('asset.status', '!=', AssetStatus.Deleted))
      .$call((qb) => withHiddenContentFilter(qb, options))
      .where('deletedAt', isTrashed ? 'is not' : 'is', null)
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({
    params: [DummyValue.UUID, { from: DummyValue.DATE, to: DummyValue.DATE, type: CalendarHeatmapType.Upload }],
  })
  getCalendarHeatmap(
    ownerId: string,
    dto: { from: Date; to: Date; type: CalendarHeatmapType; lockedOwnerId?: string },
  ) {
    const dateColumns: Record<CalendarHeatmapType, { order: AssetOrderBy; column: 'createdAt' | 'localDateTime' }> = {
      [CalendarHeatmapType.Upload]: { order: AssetOrderBy.CreatedAt, column: 'createdAt' },
      [CalendarHeatmapType.Taken]: { order: AssetOrderBy.TakenAt, column: 'localDateTime' },
    } as const;

    const { order, column } = dateColumns[dto.type];

    const date = truncatedDate<Date>(order, 'DAY');

    return (
      this.db
        .selectFrom('asset')
        .select(date.as('date'))
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('ownerId', '=', asUuid(ownerId))
        .where(column, '>=', dto.from)
        .where(column, '<', dto.to)
        .where('deletedAt', 'is', null)
        // Locked media counts only for its owner's elevated session (`lockedOwnerId`, FL-34)
        .$call((qb) => withLockedOwnerScope(qb, dto.lockedOwnerId))
        .groupBy(date)
        .orderBy('date', 'asc')
        .execute()
    );
  }

  /**
   * The assets a timeline request may show, with the bucket each one falls in. Shared by the bucket
   * counts and the curated highlights (FL-33) so both apply the very same owner, partner, album,
   * visibility, Locked and hidden-content rules.
   */
  private timelineAssets(options: TimeBucketOptions, auth: AuthDto | undefined, timeBucketDate: RawBuilder<Date>) {
    return (
      this.db
        .selectFrom('asset')
        .select(timeBucketDate.as('timeBucket'))
        .$if(!!options.isTrashed, (qb) => qb.where('asset.status', '!=', AssetStatus.Deleted))
        .where('asset.deletedAt', options.isTrashed ? 'is not' : 'is', null)
        .$if(!!options.bbox, (qb) => {
          const bbox = options.bbox!;
          const circle = getBoundingCircle(bbox);

          const withBoundingCircle = qb
            .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
            .where(
              sql`earth_box(ll_to_earth_public(${circle.centerLatitude}, ${circle.centerLongitude}), ${circle.radius})`,
              '@>',
              sql`ll_to_earth_public(asset_exif.latitude, asset_exif.longitude)`,
            );

          // FL-54: matching a place reveals it, so owners who hide their locations never match
          return withoutLocationHiddenOwners(withBoundingBox(withBoundingCircle, bbox), options.locationHiddenOwnerIds);
        })
        .$if(options.visibility === undefined, (qb) => withAlbumVisibility(qb, options.lockedOwnerId))
        .$if(!!options.visibility, (qb) =>
          qb.where(visibilityIs(options.visibility!, 'asset', options.revealLockedOwnerId)),
        )
        .$if(options.visibility === AssetVisibility.Locked && !!options.lockReasons, (qb) =>
          qb.where(lockedForReason(options.lockReasons!, 'asset')),
        )
        // hidden assets include live-photo motion parts; those of Locked stills stay private (FL-34)
        .$if(options.visibility === AssetVisibility.Hidden, (qb) => qb.where((eb) => eb.not(isMotionOfLockedStill(eb))))
        .$call((qb) => withHiddenContentFilter(qb, options))
        .$if(!!options.albumId, (qb) =>
          qb
            .innerJoin('album_asset', 'asset.id', 'album_asset.assetId')
            .where('album_asset.albumId', '=', asUuid(options.albumId!)),
        )
        .$if(!!options.personId, (qb) => hasPeople(qb, [options.personId!]))
        .$if(!!options.petId, (qb) => hasPets(qb, [options.petId!], auth?.user.id))
        .$if(!!options.withStacked, (qb) =>
          qb
            .leftJoin('stack', (join) =>
              join.onRef('stack.id', '=', 'asset.stackId').onRef('stack.primaryAssetId', '=', 'asset.id'),
            )
            .where((eb) => eb.or([eb('asset.stackId', 'is', null), eb(eb.table('stack'), 'is not', null)])),
        )
        .$if(!!options.userIds, (qb) =>
          qb.where((eb) => {
            // TODO this should become a shared `hasAccess` style helper once implement sharing in more places
            const isOwner = eb('asset.ownerId', '=', anyUuid(options.userIds!));
            // a person's shared-album media widens the owner scope, except for a Locked request:
            // Locked media is owner-private, so other members' Locked items never join it
            const widenToSharedAlbums = !!options.personId && !!auth && options.visibility !== AssetVisibility.Locked;
            return widenToSharedAlbums ? eb.or([isOwner, inSharedAlbum(eb, auth!.user.id)]) : isOwner;
          }),
        )
        .$if(options.isFavorite !== undefined, (qb) => qb.where('asset.isFavorite', '=', options.isFavorite!))
        .$if(!!options.assetType, (qb) => qb.where('asset.type', '=', options.assetType!))
        .$if(options.isDuplicate !== undefined, (qb) =>
          qb.where('asset.duplicateId', options.isDuplicate ? 'is not' : 'is', null),
        )
        .$if(!!options.tagId, (qb) => withTagId(qb, options.tagId!))
    );
  }

  private timelineBucketDate(options: TimeBucketOptions, size: 'MONTH' | 'YEAR' = 'MONTH') {
    return options.dateType === TimeBucketDateType.Added || options.orderBy === AssetOrderBy.CreatedAt
      ? sql<Date>`date_trunc(${sql.lit(size)}, asset."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`
      : sql<Date>`date_trunc(${sql.lit(size)}, "localDateTime" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
  }

  @GenerateSql({ params: [{}, { user: { id: DummyValue.UUID } }] })
  async getTimeBuckets(options: TimeBucketOptions, auth?: AuthDto): Promise<TimeBucketItem[]> {
    return this.db
      .with('asset', () => this.timelineAssets(options, auth, this.timelineBucketDate(options)))
      .selectFrom('asset')
      .select(sql<string>`("timeBucket" AT TIME ZONE 'UTC')::date::text`.as('timeBucket'))
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .groupBy('timeBucket')
      .orderBy('timeBucket', options.order ?? 'desc')
      .execute() as any as Promise<TimeBucketItem[]>;
  }

  /**
   * FL-33: one curated card per year or month of a timeline request. Each card carries its count,
   * its key photo (highest Best Photos score, then highest star rating, then the most recent
   * capture, then id), up to `highlightCount` more highlights in capture order, and its three
   * busiest places (city, else state, else country). The set of assets is exactly the one the
   * matching `getTimeBuckets` request counts; places leave out owners who hide their locations from
   * the viewer (`locationHiddenOwnerIds`) and every place when `withPlaces` is false.
   */
  @GenerateSql({
    params: [{}, { user: { id: DummyValue.UUID } }, { grouping: 'month', highlightCount: 4, withPlaces: true }],
  })
  async getTimelineHighlights(
    options: TimeBucketOptions,
    auth: AuthDto | undefined,
    { grouping, highlightCount, withPlaces }: TimelineHighlightOptions,
  ): Promise<TimelineHighlightItem[]> {
    const phase = await getForkSchemaPhase(this.db);
    const scoreTable = sql.table(`${readsForkSidecar(phase) ? 'immich_fork' : 'public'}.asset_best_photo_score`);
    const order = options.order === AssetOrder.Asc ? sql`asc` : sql`desc`;
    const hiddenOwnerIds = options.locationHiddenOwnerIds ?? [];
    const size = grouping === 'year' ? 'YEAR' : 'MONTH';
    // the same date the cards are grouped by breaks ties and orders the highlights
    const sortDate =
      options.dateType === TimeBucketDateType.Added || options.orderBy === AssetOrderBy.CreatedAt
        ? sql<Date>`asset."createdAt"`
        : sql<Date>`asset."localDateTime"`;
    const place = sql`coalesce(nullif(trim(e.city), ''), nullif(trim(e.state), ''), nullif(trim(e.country), ''))`;
    const locationShared = hiddenOwnerIds.length > 0 ? sql`not (a."ownerId" = ${anyUuid(hiddenOwnerIds)})` : sql`true`;

    const { rows } = await sql<{
      timeBucket: string;
      count: string;
      keyAssetId: string | null;
      highlightAssetIds: string[] | null;
      places: string[] | null;
    }>`
      with asset as (
        ${this.timelineAssets(options, auth, this.timelineBucketDate(options, size)).select([
          'asset.id',
          'asset.ownerId',
          sortDate.as('sortDate'),
        ])}
      ),
      ranked as (
        select
          a.id,
          a."timeBucket",
          a."sortDate",
          row_number() over (
            partition by a."timeBucket"
            order by
              s.score desc nulls last,
              nullif(greatest(e.rating, 0), 0) desc nulls last,
              a."sortDate" desc,
              a.id asc
          ) as rank
        from asset a
        left join asset_exif e on e."assetId" = a.id
        left join ${scoreTable} s on s."assetId" = a.id
      ),
      places as (
        select
          a."timeBucket",
          ${place} as place,
          row_number() over (partition by a."timeBucket" order by count(*) desc, ${place} asc) as rank
        from asset a
        inner join asset_exif e on e."assetId" = a.id
        where ${withPlaces ? sql`true` : sql`false`} and ${locationShared} and ${place} is not null
        group by a."timeBucket", ${place}
      )
      select
        (r."timeBucket" at time zone 'UTC')::date::text as "timeBucket",
        count(*) as count,
        (array_agg(r.id::text) filter (where r.rank = 1))[1] as "keyAssetId",
        array_agg(r.id::text order by r."sortDate" ${order}, r.id) filter (
          where r.rank > 1 and r.rank <= ${1 + highlightCount}
        ) as "highlightAssetIds",
        (
          select array_agg(p.place order by p.rank)
          from places p
          where p."timeBucket" = r."timeBucket" and p.rank <= ${TIMELINE_HIGHLIGHT_PLACES}
        ) as places
      from ranked r
      group by r."timeBucket"
      order by r."timeBucket" ${order}
    `.execute(this.db);

    return rows.map((row) => ({
      timeBucket: row.timeBucket,
      count: Number(row.count),
      keyAssetId: row.keyAssetId,
      highlightAssetIds: row.highlightAssetIds ?? [],
      places: row.places ?? [],
    }));
  }

  @GenerateSql({
    params: [DummyValue.TIME_BUCKET, { withStacked: true }, { user: { id: DummyValue.UUID } }],
  })
  getTimeBucket(timeBucket: string, options: TimeBucketOptions, auth: AuthDto) {
    return this.timelineAssetColumns(options, auth, { timeBucket });
  }

  /**
   * FL-30 (S-15): one page of the timeline's assets in a flat order — by file name or by rating —
   * for the Browse and Work layouts. It is the time bucket's own query without the bucket filter,
   * so everything that decides what a bucket may show (Locked and the elevated session, partners who
   * hide their locations, hidden content, suppressed-only, lock reasons, stacks, a shared link that
   * hides EXIF) decides this page identically, and the response has the bucket's columnar shape.
   */
  @GenerateSql({
    params: [{ withStacked: true }, { user: { id: DummyValue.UUID } }, { sort: 'filename', skip: 0, take: 100 }],
  })
  getTimelineOrdered(options: TimeBucketOptions, auth: AuthDto, page: TimelineOrderedPage) {
    return this.timelineAssetColumns(options, auth, { page });
  }

  private timelineAssetColumns(
    options: TimeBucketOptions,
    auth: AuthDto,
    target: { timeBucket: string; page?: undefined } | { timeBucket?: undefined; page: TimelineOrderedPage },
  ) {
    const { timeBucket, page } = target;
    const order = options.order ?? 'desc';
    const withPlaces = !auth.sharedLink || auth.sharedLink.showExif;
    // partners who hide their locations from this viewer (FL-54): their location columns are nulled in SQL
    // so the pre-jsonified bucket never carries them; the plain column selects stay untouched otherwise
    const hiddenOwnerIds = options.locationHiddenOwnerIds ?? [];
    const hidesLocation = hiddenOwnerIds.length > 0;
    const locationColumn = <C extends 'city' | 'country' | 'latitude' | 'longitude'>(column: C) =>
      sql<(C extends 'city' | 'country' ? string : number) | null>`case when asset."ownerId" = ${anyUuid(
        hiddenOwnerIds,
      )} then null else asset_exif.${sql.ref(column)} end`.as(column);
    const useAddedDate = options.dateType === TimeBucketDateType.Added || options.orderBy === AssetOrderBy.CreatedAt;
    const timeBucketDate = useAddedDate
      ? sql`date_trunc(${sql.lit('MONTH')}, asset."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`
      : truncatedDate();
    const timelineDate = useAddedDate
      ? sql`asset."createdAt" at time zone 'utc'`
      : sql`asset."fileCreatedAt" at time zone 'utc'`;
    const localOffsetHours = useAddedDate
      ? sql`0::real`
      : sql`extract(epoch from (asset."localDateTime" AT TIME ZONE 'UTC' - asset."fileCreatedAt" at time zone 'UTC'))::real / 3600`;
    const orderDate = useAddedDate
      ? sql`(asset."createdAt" AT TIME ZONE 'UTC')::date`
      : sql`(asset."localDateTime" AT TIME ZONE 'UTC')::date`;
    const orderTimestamp = useAddedDate ? sql`asset."createdAt"` : sql`asset."fileCreatedAt"`;
    const hiddenContent = getHiddenContentFilter(options);
    const livePhotoVideoId = hiddenContent
      ? sql`case when ${hiddenContentAssetIdExists(sql.ref('asset.livePhotoVideoId'), hiddenContent)} then null else asset."livePhotoVideoId" end`.as(
          'livePhotoVideoId',
        )
      : 'asset.livePhotoVideoId';
    const query = this.db
      .with('cte', (qb) =>
        qb
          .selectFrom('asset')
          .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
          .select((eb) => [
            'asset.duration',
            'asset.id',
            effectiveVisibility('asset').as('visibility'),
            sql`asset."isFavorite" and asset."ownerId" = ${auth.user.id}`.as('isFavorite'),
            sql`asset.type = 'IMAGE'`.as('isImage'),
            sql`asset."deletedAt" is not null`.as('isTrashed'),
            // FL-33 (T-17): the tile's Offline badge (AssetTile.jsx `asset.isOffline`).
            'asset.isOffline',
            livePhotoVideoId,
            localOffsetHours.as('localOffsetHours'),
            'asset.ownerId',
            'asset.status',
            timelineDate.as('fileCreatedAt'),
            sql`asset."createdAt" at time zone 'utc'`.as('createdAt'),
            eb.fn('encode', ['asset.thumbhash', sql.lit('base64')]).as('thumbhash'),
            'asset_exif.projectionType',
            eb.fn
              .coalesce(
                eb
                  .case()
                  .when(sql`asset."height" = 0 or asset."width" = 0`)
                  .then(eb.lit(1))
                  .else(sql`round(asset."width"::numeric / asset."height"::numeric, 3)`)
                  .end(),
                eb.lit(1),
              )
              .as('ratio'),
          ])
          .$if(options.visibility === AssetVisibility.Locked || !!options.revealLockedOwnerId, (qb) =>
            qb.select(lockReasonOf('asset').as('lockReason')),
          )
          // FL-33: Work shows each tile's file name on request; hidden with the rest of the metadata
          .$if(withPlaces, (qb) => qb.select(['asset_exif.rating', 'asset.originalFileName']))
          // S-15: the list view's dimensions and size column; hidden with the rest of the metadata
          .$if(withPlaces, (qb) => qb.select(['asset.width', 'asset.height', 'asset_exif.fileSizeInByte']))
          .$if(withPlaces && !hidesLocation, (qb) => qb.select(['asset_exif.city', 'asset_exif.country']))
          .$if(withPlaces && hidesLocation, (qb) => qb.select([locationColumn('city'), locationColumn('country')]))
          .$if(!!options.withCoordinates && !hidesLocation, (qb) =>
            qb.select(['asset_exif.latitude', 'asset_exif.longitude']),
          )
          .$if(!!options.withCoordinates && hidesLocation, (qb) =>
            qb.select([locationColumn('latitude'), locationColumn('longitude')]),
          )
          .where('asset.deletedAt', options.isTrashed ? 'is not' : 'is', null)
          .$if(options.visibility === undefined, (qb) => withAlbumVisibility(qb, options.lockedOwnerId))
          .$if(!!options.visibility, (qb) =>
            qb.where(visibilityIs(options.visibility!, 'asset', options.revealLockedOwnerId)),
          )
          .$if(options.visibility === AssetVisibility.Locked && !!options.lockReasons, (qb) =>
            qb.where(lockedForReason(options.lockReasons!, 'asset')),
          )
          // hidden assets include live-photo motion parts; those of Locked stills stay private (FL-34)
          .$if(options.visibility === AssetVisibility.Hidden, (qb) =>
            qb.where((eb) => eb.not(isMotionOfLockedStill(eb))),
          )
          .$call((qb) => withHiddenContentFilter(qb, options))
          .$if(!!options.bbox, (qb) => {
            const bbox = options.bbox!;
            const circle = getBoundingCircle(bbox);

            const withBoundingCircle = qb.where(
              sql`earth_box(ll_to_earth_public(${circle.centerLatitude}, ${circle.centerLongitude}), ${circle.radius})`,
              '@>',
              sql`ll_to_earth_public(asset_exif.latitude, asset_exif.longitude)`,
            );

            // FL-54: matching a place reveals it, so owners who hide their locations never match
            return withoutLocationHiddenOwners(
              withBoundingBox(withBoundingCircle, bbox),
              options.locationHiddenOwnerIds,
            );
          })
          .$if(timeBucket !== undefined, (qb) => qb.where(timeBucketDate, '=', timeBucket!.replace(/^[+-]/, '')))
          .$if(!!options.albumId, (qb) =>
            qb.where((eb) =>
              eb.exists(
                eb
                  .selectFrom('album_asset')
                  .whereRef('album_asset.assetId', '=', 'asset.id')
                  .where('album_asset.albumId', '=', asUuid(options.albumId!)),
              ),
            ),
          )
          .$if(!!options.personId, (qb) => hasPeople(qb, [options.personId!]))
          .$if(!!options.petId, (qb) => hasPets(qb, [options.petId!], auth.user.id))
          .$if(!!options.userIds, (qb) =>
            qb.where((eb) => {
              const isOwner = eb('asset.ownerId', '=', anyUuid(options.userIds!));
              // see getTimeBuckets: a Locked request never widens to other members' shared-album media
              const widenToSharedAlbums = !!options.personId && options.visibility !== AssetVisibility.Locked;
              return widenToSharedAlbums ? eb.or([isOwner, inSharedAlbum(eb, auth.user.id)]) : isOwner;
            }),
          )
          .$if(options.isFavorite !== undefined, (qb) => qb.where('asset.isFavorite', '=', options.isFavorite!))
          .$if(!!options.withStacked, (qb) =>
            qb
              .where((eb) =>
                eb.not(
                  eb.exists(
                    eb
                      .selectFrom('stack')
                      .whereRef('stack.id', '=', 'asset.stackId')
                      .whereRef('stack.primaryAssetId', '!=', 'asset.id'),
                  ),
                ),
              )
              .leftJoinLateral(
                (eb) =>
                  eb
                    .selectFrom('asset as stacked')
                    .select(sql`array[stacked."stackId"::text, count('stacked')::text]`.as('stack'))
                    .whereRef('stacked.stackId', '=', 'asset.stackId')
                    .where('stacked.deletedAt', 'is', null)
                    .where('stacked.visibility', '=', AssetVisibility.Timeline)
                    // stacks lock as a whole (FL-34); a member whose lock differs is never counted
                    .where(sql<boolean>`${isLocked('stacked')} = ${isLocked('asset')}`)
                    .$call((qb) => withHiddenContentFilter(qb, options, 'stacked'))
                    .groupBy('stacked.stackId')
                    .as('stacked_assets'),
                (join) => join.onTrue(),
              )
              .select('stack'),
          )
          .$if(!!options.assetType, (qb) => qb.where('asset.type', '=', options.assetType!))
          .$if(options.isDuplicate !== undefined, (qb) =>
            qb.where('asset.duplicateId', options.isDuplicate ? 'is not' : 'is', null),
          )
          .$if(!!options.isTrashed, (qb) => qb.where('asset.status', '!=', AssetStatus.Deleted))
          .$if(!!options.tagId, (qb) => withTagId(qb, options.tagId!))
          .$if(!page, (qb) =>
            qb.orderBy(orderDate, order).orderBy(orderTimestamp, order).orderBy('asset.originalFileName', order),
          )
          // File names in the ICU root collation (`und-x-icu`): letters compare regardless of case and
          // accents first, as a person reads a list, rather than by byte value. Digits still compare
          // one by one ("IMG_10" before "IMG_2"). This needs a Postgres built with ICU, which the Immich
          // Postgres images (production and e2e) are. The newest capture, then the id, break ties so
          // pages never overlap.
          .$if(page?.sort === 'filename', (qb) =>
            qb
              .orderBy(sql`asset."originalFileName" collate "und-x-icu"`, 'asc')
              .orderBy('asset.fileCreatedAt', 'desc')
              .orderBy('asset.id', 'asc'),
          )
          // Highest rating first; an unrated item counts as 0, below every star and above rejected.
          .$if(page?.sort === 'rating', (qb) =>
            qb
              .orderBy(sql`coalesce(asset_exif.rating, 0)`, 'desc')
              .orderBy('asset.fileCreatedAt', 'desc')
              .orderBy('asset.id', 'asc'),
          )
          .$if(!!page, (qb) => qb.offset(page!.skip).limit(page!.take)),
      )
      .with('agg', (qb) =>
        qb
          .selectFrom('cte')
          .select((eb) => [
            eb.fn.coalesce(eb.fn('array_agg', ['duration']), sql.lit('{}')).as('duration'),
            eb.fn.coalesce(eb.fn('array_agg', ['id']), sql.lit('{}')).as('id'),
            eb.fn.coalesce(eb.fn('array_agg', ['visibility']), sql.lit('{}')).as('visibility'),
            eb.fn.coalesce(eb.fn('array_agg', ['isFavorite']), sql.lit('{}')).as('isFavorite'),
            eb.fn.coalesce(eb.fn('array_agg', ['isImage']), sql.lit('{}')).as('isImage'),
            // TODO: isTrashed is redundant as it will always be all true or false depending on the options
            eb.fn.coalesce(eb.fn('array_agg', ['isTrashed']), sql.lit('{}')).as('isTrashed'),
            eb.fn.coalesce(eb.fn('array_agg', ['isOffline']), sql.lit('{}')).as('isOffline'),
            eb.fn.coalesce(eb.fn('array_agg', ['livePhotoVideoId']), sql.lit('{}')).as('livePhotoVideoId'),
            eb.fn.coalesce(eb.fn('array_agg', ['fileCreatedAt']), sql.lit('{}')).as('fileCreatedAt'),
            eb.fn.coalesce(eb.fn('array_agg', ['createdAt']), sql.lit('{}')).as('createdAt'),
            eb.fn.coalesce(eb.fn('array_agg', ['localOffsetHours']), sql.lit('{}')).as('localOffsetHours'),
            eb.fn.coalesce(eb.fn('array_agg', ['ownerId']), sql.lit('{}')).as('ownerId'),
            eb.fn.coalesce(eb.fn('array_agg', ['projectionType']), sql.lit('{}')).as('projectionType'),
            eb.fn.coalesce(eb.fn('array_agg', ['ratio']), sql.lit('{}')).as('ratio'),
            eb.fn.coalesce(eb.fn('array_agg', ['status']), sql.lit('{}')).as('status'),
            eb.fn.coalesce(eb.fn('array_agg', ['thumbhash']), sql.lit('{}')).as('thumbhash'),
          ])
          .$if(options.visibility === AssetVisibility.Locked || !!options.revealLockedOwnerId, (qb) =>
            qb.select((eb) => eb.fn.coalesce(eb.fn('array_agg', ['lockReason']), sql.lit('{}')).as('lockReason')),
          )
          .$if(!auth.sharedLink || auth.sharedLink.showExif, (qb) =>
            qb.select((eb) => [
              eb.fn.coalesce(eb.fn('array_agg', ['city']), sql.lit('{}')).as('city'),
              eb.fn.coalesce(eb.fn('array_agg', ['country']), sql.lit('{}')).as('country'),
              eb.fn.coalesce(eb.fn('array_agg', ['rating']), sql.lit('{}')).as('rating'),
              eb.fn.coalesce(eb.fn('array_agg', ['originalFileName']), sql.lit('{}')).as('originalFileName'),
              eb.fn.coalesce(eb.fn('array_agg', ['width']), sql.lit('{}')).as('width'),
              eb.fn.coalesce(eb.fn('array_agg', ['height']), sql.lit('{}')).as('height'),
              eb.fn.coalesce(eb.fn('array_agg', ['fileSizeInByte']), sql.lit('{}')).as('fileSizeInByte'),
            ]),
          )
          .$if(!!options.withCoordinates, (qb) =>
            qb.select((eb) => [
              eb.fn.coalesce(eb.fn('array_agg', ['latitude']), sql.lit('{}')).as('latitude'),
              eb.fn.coalesce(eb.fn('array_agg', ['longitude']), sql.lit('{}')).as('longitude'),
            ]),
          )
          .$if(!!options.withStacked, (qb) =>
            qb.select((eb) => eb.fn.coalesce(eb.fn('json_agg', ['stack']), sql.lit('[]')).as('stack')),
          ),
      )
      .selectFrom('agg')
      .select(sql<string>`to_json(agg)::text`.as('assets'));

    return query.executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID, { minAssetsPerField: 5, maxFields: 12 }] })
  async getAssetIdByCity(ownerId: string, options: AssetExploreFieldOptions) {
    const { minAssetsPerField, maxFields } = options;
    const items = await this.db
      .with('cities', (qb) =>
        qb
          .selectFrom('asset_exif')
          .select('city')
          .where('city', 'is not', null)
          .groupBy('city')
          .having((eb) => eb.fn('count', [eb.ref('assetId')]), '>=', minAssetsPerField),
      )
      .selectFrom('asset')
      .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
      .innerJoin('cities', 'asset_exif.city', 'cities.city')
      .distinctOn('asset_exif.city')
      .select(['assetId as data', 'asset_exif.city as value'])
      .$narrowType<{ value: NotNull }>()
      .where('ownerId', '=', asUuid(ownerId))
      .where(isTimelineVisible('asset'))
      .where('type', '=', AssetType.Image)
      .where('deletedAt', 'is', null)
      .$call((qb) => withHiddenContentFilter(qb, options))
      .limit(maxFields)
      .execute();

    return { fieldName: 'exifInfo.city', items };
  }

  @GenerateSql({ params: [DummyValue.UUID, { minAssetsPerField: 5, maxFields: 12 }] })
  async getRecentlyCreatedAssetIds(ownerId: string, options: AssetExploreFieldOptions) {
    const { maxFields } = options;
    const items = await this.db
      .selectFrom('asset')
      .select(['id as data', 'createdAt as value'])
      .where('ownerId', '=', asUuid(ownerId))
      .where(isTimelineVisible('asset'))
      .where('type', '=', AssetType.Image)
      .where('deletedAt', 'is', null)
      .$call((qb) => withHiddenContentFilter(qb, options))
      .orderBy('value', 'desc')
      .limit(maxFields)
      .execute();

    return { fieldName: 'createdAt', items };
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  @ChunkedArray()
  async getNsfwAssetIds(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) {
      return new Set();
    }

    const rows = await this.db
      .selectFrom('asset')
      .select('asset.id')
      .where('asset.id', '=', anyUuid(ids))
      .$call(withNsfwAssets)
      .execute();
    return new Set(rows.map(({ id }) => id));
  }

  async getHiddenContentAssetIds(ids: string[], options: HiddenContentQueryOptions): Promise<Set<string>> {
    const hiddenContent = getHiddenContentFilter(options);
    if (ids.length === 0 || !hiddenContent) {
      return new Set();
    }

    const rows = await this.db
      .selectFrom('asset')
      .select('asset.id')
      .where('asset.id', '=', anyUuid(ids))
      .$call((qb) => withHiddenContentOnly(qb, hiddenContent))
      .execute();
    return new Set(rows.map(({ id }) => id));
  }

  async upsertFile(file: UpsertAssetFile): Promise<void> {
    await this.db
      .insertInto('asset_file')
      .values(file)
      .onConflict((oc) =>
        oc.columns(['assetId', 'type', 'isEdited']).doUpdateSet((eb) => ({
          path: eb.ref('excluded.path'),
          physicalFileId: sql`coalesce(${eb.ref('excluded.physicalFileId')}, ${eb.ref('asset_file.physicalFileId')})`,
        })),
      )
      .execute();
  }

  async upsertFiles(files: UpsertAssetFile[]): Promise<void> {
    if (files.length === 0) {
      return;
    }

    await this.db
      .insertInto('asset_file')
      .values(files)
      .onConflict((oc) =>
        oc.columns(['assetId', 'type', 'isEdited']).doUpdateSet((eb) => ({
          path: eb.ref('excluded.path'),
          physicalFileId: sql`coalesce(${eb.ref('excluded.physicalFileId')}, ${eb.ref('asset_file.physicalFileId')})`,
          isProgressive: eb.ref('excluded.isProgressive'),
          isTransparent: eb.ref('excluded.isTransparent'),
        })),
      )
      .execute();
  }

  async deleteFile({
    assetId,
    type,
    edited,
  }: {
    assetId: string;
    type: AssetFileType;
    edited?: boolean;
  }): Promise<void> {
    await this.db
      .deleteFrom('asset_file')
      .where('assetId', '=', asUuid(assetId))
      .where('type', '=', type)
      .$if(edited !== undefined, (qb) => qb.where('isEdited', '=', edited!))
      .execute();
  }

  async deleteFiles(files: Pick<Selectable<AssetFileTable>, 'id'>[]): Promise<void> {
    if (files.length === 0) {
      return;
    }

    await this.db
      .deleteFrom('asset_file')
      .where('id', '=', anyUuid(files.map((file) => file.id)))
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.STRING], [DummyValue.STRING]] })
  async detectOfflineExternalAssets(
    libraryId: string,
    importPaths: string[],
    exclusionPatterns: string[],
  ): Promise<UpdateResult> {
    const paths = importPaths.map((importPath) => `${importPath}%`);
    const exclusions = exclusionPatterns.map((pattern) => globToPostgresRegex(pattern));

    return this.db
      .updateTable('asset')
      .set({
        isOffline: true,
        deletedAt: new Date(),
      })
      .where('isOffline', '=', false)
      .where('isExternal', '=', true)
      .where('libraryId', '=', asUuid(libraryId))
      .where((eb) =>
        eb.or([
          eb.not(eb.or(paths.map((path) => eb('originalPath', 'like', path)))),
          eb.or(exclusions.map((pattern) => eb('originalPath', '~', pattern))),
        ]),
      )
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.STRING]] })
  async filterNewExternalAssetPaths(libraryId: string, paths: string[]): Promise<string[]> {
    const result = await this.db
      .selectFrom(unnest(paths).as('path'))
      .select('path')
      .where((eb) =>
        eb.not(
          eb.exists(
            this.db
              .selectFrom('asset')
              .select('originalPath')
              .whereRef('asset.originalPath', '=', eb.ref('path'))
              .where('libraryId', '=', asUuid(libraryId))
              .where('isExternal', '=', true),
          ),
        ),
      )
      .execute();

    return result.map((row) => row.path as string);
  }

  async getLibraryAssetCount(libraryId: string): Promise<number> {
    const { count } = await this.db
      .selectFrom('asset')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('libraryId', '=', asUuid(libraryId))
      .executeTakeFirstOrThrow();

    return count;
  }

  private buildGetForOriginal(ids: string[], isEdited: boolean) {
    return this.db
      .selectFrom('asset')
      .select(['asset.id', 'asset.ownerId'])
      .select('originalFileName')
      .where('asset.id', 'in', ids)
      .$if(isEdited, (qb) =>
        qb
          .leftJoin('asset_file', (join) =>
            join
              .onRef('asset.id', '=', 'asset_file.assetId')
              .on('asset_file.isEdited', '=', true)
              .on('asset_file.type', '=', AssetFileType.FullSize),
          )
          .select('asset_file.path as editedPath'),
      )
      .select('originalPath');
  }

  @GenerateSql({ params: [DummyValue.UUID, true] })
  getForOriginal(id: string, isEdited: boolean) {
    return this.buildGetForOriginal([id], isEdited).executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [[DummyValue.UUID], true] })
  getForOriginals(ids: string[], isEdited: boolean) {
    return this.buildGetForOriginal(ids, isEdited).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, AssetFileType.Preview, true] })
  async getForThumbnail(id: string, type: AssetFileType, isEdited: boolean) {
    return this.db
      .selectFrom('asset')
      .where('asset.id', '=', id)
      .leftJoin('asset_file', (join) =>
        join.onRef('asset.id', '=', 'asset_file.assetId').on('asset_file.type', '=', type),
      )
      .select(['asset.ownerId', 'asset.originalPath', 'asset.originalFileName', 'asset_file.path as path'])
      .orderBy('asset_file.isEdited', isEdited ? 'desc' : 'asc')
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getForVideo(id: string) {
    return this.db
      .selectFrom('asset')
      .select(['asset.originalPath', 'asset.ownerId'])
      .select((eb) => withFilePath(eb, AssetFileType.EncodedVideo).as('encodedVideoPath'))
      .select((eb) => withFilePath(eb, AssetFileType.EncodedVideo, true).as('editedVideoPath'))
      .where('asset.id', '=', id)
      .where('asset.type', '=', AssetType.Video)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getForOcr(id: string) {
    return this.db
      .selectFrom('asset')
      .where('asset.id', '=', id)
      .select(withEdits)
      .innerJoin('asset_exif', (join) => join.onRef('asset_exif.assetId', '=', 'asset.id'))
      .select(['asset_exif.exifImageWidth', 'asset_exif.exifImageHeight', 'asset_exif.orientation'])
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getForEdit(id: string) {
    return this.db
      .selectFrom('asset')
      .select([
        'asset.type',
        'asset.duration',
        'asset.livePhotoVideoId',
        'asset.originalPath',
        'asset.originalFileName',
      ])
      .where('asset.id', '=', id)
      .innerJoin('asset_exif', (join) => join.onRef('asset_exif.assetId', '=', 'asset.id'))
      .select([
        'asset_exif.exifImageWidth',
        'asset_exif.exifImageHeight',
        'asset_exif.orientation',
        'asset_exif.projectionType',
      ])
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getForMetadataExtractionTags(id: string) {
    return this.db
      .selectFrom('asset_exif')
      .select('asset_exif.tags')
      .where('asset_exif.assetId', '=', id)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getForFaces(id: string) {
    return this.db
      .selectFrom('asset')
      .innerJoin('asset_exif', (join) => join.onRef('asset_exif.assetId', '=', 'asset.id'))
      .select(['asset_exif.exifImageHeight', 'asset_exif.exifImageWidth', 'asset_exif.orientation'])
      .select(withEdits)
      .where('asset.id', '=', id)
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getForUpdateTags(id: string) {
    return this.db
      .selectFrom('asset')
      .select((eb) =>
        jsonArrayFrom(
          eb
            .selectFrom('tag')
            .select('tag.value')
            .innerJoin('tag_asset', 'tag.id', 'tag_asset.tagId')
            .whereRef('asset.id', '=', 'tag_asset.assetId'),
        ).as('tags'),
      )
      .where('asset.id', '=', id)
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [] })
  async getDescriptionStats(): Promise<DescriptionStats> {
    // Mirrors the same filters used by streamForImageDescriptionJob / streamForImageEnrichmentTask
    // so that the counts returned here reflect exactly what the requeue job will process.
    const result = await this.db
      .selectFrom('asset')
      .innerJoin('asset_job_status as job_status', 'job_status.assetId', 'asset.id')
      .where('asset.type', '=', sql.lit(AssetType.Image))
      .where('asset.deletedAt', 'is', null)
      // stored visibility only, like the job: background work includes locked media (FL-34)
      .where('asset.visibility', 'in', [sql.lit(AssetVisibility.Archive), sql.lit(AssetVisibility.Timeline)])
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('asset_file')
            .whereRef('asset_file.assetId', '=', 'asset.id')
            .where('asset_file.type', '=', sql.lit(AssetFileType.Preview)),
        ),
      )
      .select((eb) => eb.fn.countAll<number>().as('totalAssets'))
      .select((eb) =>
        eb.fn
          .count<number>('asset.id')
          .filterWhere(
            eb.exists(
              eb
                .selectFrom('asset_metadata')
                .select('asset_metadata.assetId')
                .whereRef('asset_metadata.assetId', '=', 'asset.id')
                .where('asset_metadata.key', '=', AssetMetadataKey.MlEnrichment)
                .where(sql<string>`asset_metadata.value -> 'description' ->> 'status'`, '=', 'success'),
            ),
          )
          .as('withDescription'),
      )
      .executeTakeFirstOrThrow();

    const totalAssets = Number(result.totalAssets);
    const withDescription = Number(result.withDescription);
    return {
      totalAssets,
      withDescription,
      withoutDescription: totalAssets - withDescription,
    };
  }
}
