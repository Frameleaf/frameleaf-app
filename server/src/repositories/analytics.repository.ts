import { Injectable } from '@nestjs/common';
import { Kysely, RawBuilder, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import {
  AlbumKind,
  AlbumUserRole,
  AnalyticsSampleGrain,
  AnalyticsScopeKind,
  AnalyticsSeriesId,
  AssetType,
  AssetVisibility,
  ColorTransfer,
  PetObservationState,
} from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import {
  ANALYTICS_TOP_PEOPLE_LIMIT,
  AnalyticsSampleInsert,
  AnalyticsSampleRow,
  AnalyticsScope,
  assertApprovedSample,
} from 'src/utils/analytics.js';
import { anyUuid, getHiddenContentFilter, hiddenContentAssetIdExists } from 'src/utils/database.js';
import { isNotLocked } from 'src/utils/locked.js';
import { mimeTypes } from 'src/utils/mime-types.js';

/**
 * Reads and writes for scoped library analytics (FL-79). Counts and sizes only.
 *
 * Every asset read here leaves Locked media out (FL-34): analytics are shown to administrators and
 * in ordinary sessions, and a Locked item's existence is only ever shown to its owner's elevated
 * session. Live Photo motion parts (`hidden`) are not items, but their files are counted in bytes,
 * because they are originals on disk. Items in Trash are still items until they are deleted.
 */

export type AnalyticsInventory = {
  photos: number;
  videos: number;
  raw: number;
  timelinePhotos: number;
  timelineVideos: number;
  archivePhotos: number;
  archiveVideos: number;
  trashPhotos: number;
  trashVideos: number;
  favoritePhotos: number;
  favoriteVideos: number;
  withCaptureDate: number;
  withLocation: number;
  withCameraModel: number;
  withAiDescription: number;
  /** Original files, Live Photo motion parts included. */
  files: number;
  /** Original files whose size has not been read. They are left out of every byte total. */
  unmeasuredFiles: number;
  logicalBytes: number;
  uploadedLogicalBytes: number;
  externalLogicalBytes: number;
};

export type AnalyticsPhysical = {
  physicalBytes: number;
  uploadedPhysicalBytes: number;
  externalPhysicalBytes: number;
  /** Items in the selection that share an original file with another item in the selection. */
  sharedReferences: number;
};

export type AnalyticsCollectorRow = {
  kind: AnalyticsScopeKind;
  id: string | null;
  items: number;
  photos: number;
  videos: number;
  logicalBytes: number;
  physicalBytes: number;
};

export type AnalyticsAlbumRow = {
  id: string;
  name: string;
  ownerId: string;
  ownerName: string;
  members: number;
  viewerHasAccess: boolean;
};

export type AnalyticsScopeTargets = {
  users: Array<{ id: string; name: string; deletedAt: Date | null }>;
  libraries: Array<{ id: string; name: string; ownerId: string; deletedAt: Date | null }>;
};

const RAW_EXTENSION_PATTERN = String.raw`\.(${Object.keys(mimeTypes.raw)
  .map((extension) => extension.slice(1).replaceAll(/[^a-z0-9]/gi, ''))
  .join('|')})$`;

const num = (value: unknown) => Number(value ?? 0);

const scopeCondition = (scope: AnalyticsScope, alias = 'a'): RawBuilder<boolean> => {
  switch (scope.kind) {
    case AnalyticsScopeKind.Host: {
      return sql<boolean>`true`;
    }
    case AnalyticsScopeKind.Account: {
      return sql<boolean>`${sql.ref(`${alias}.ownerId`)} = ${scope.userId}`;
    }
    case AnalyticsScopeKind.Library: {
      return sql<boolean>`${sql.ref(`${alias}.libraryId`)} = ${scope.libraryId}`;
    }
  }
};

/** FL-79: file extensions per photo format; RAW is decided first with the same pattern as `summary.raw` */
const HEIC_EXTENSION_PATTERN = String.raw`\.(heic|heif|hif)$`;
const JPEG_EXTENSION_PATTERN = String.raw`\.(jpe?g|jfif)$`;
const PNG_EXTENSION_PATTERN = String.raw`\.png$`;

export type AnalyticsInsightOptions = {
  /** the scope's owner, when the reader is that owner: only then are names, people and places read */
  ownerId: string | null;
  /** people and pets the owner keeps Locked; never named while the session is locked */
  suppressedPersonIds: string[];
  suppressedPetIds: string[];
  /** the reading session's hidden-content rules */
  privacy?: HiddenContentQueryOptions;
  /** FL-1196: everyday subjects as CLIP text embeddings, for "What the AI sees"; absent when visual search is off */
  seenLabels?: Array<{ id: string; embedding: string }>;
};

export type AnalyticsInsightRows = {
  /** the items every breakdown partitions: the summary's items minus those the session keeps hidden */
  items: number;
  years: Array<{ year: number; count: number }>;
  punchcard: Array<{ weekday: number; hour: number; count: number }>;
  lenses: Array<{ name: string | null; count: number }>;
  focalLengths: Array<{ bucket: string; count: number }>;
  photoFormats: Array<{ format: string; count: number }>;
  videoResolutions: Array<{ resolution: string; count: number }>;
  orientation: Array<{ orientation: string; count: number }>;
  livePhotos: number;
  hdr: { probedVideos: number; hdrVideos: number; dolbyVisionVideos: number };
  /** items face detection has run on, and items with a smart-search embedding */
  coverage: { facesChecked: number; searchIndexed: number };
  records: {
    oldest: { localDateTime: Date; name: string } | null;
    largest: { bytes: number; name: string } | null;
    longest: { durationMs: number; name: string } | null;
    videoDurationMs: number;
  };
  /** Library magic (approved design, 2026-11-04): a band of answers for the curious. */
  magic?: AnalyticsMagicRows;
  people: {
    faces: number;
    itemsWithFaces: number;
    namedPeople: number;
    pets: number;
    topPeople: Array<{ id: string; name: string; count: number }>;
    geotagged: number;
    countries: number;
    cities: number;
    places: Array<{ name: string | null; count: number }>;
  } | null;
};

export type AnalyticsMagicRows = {
  /** Per local capture month, the photos' average thumbnail colour in ThumbHash's L, P and Q (each 0-63). */
  colour: Array<{ month: number; photos: number; l: number; p: number; q: number }>;
  /** Photos with a place and an instant, by how high the sun stood there then. */
  light: { goldenMorning: number; goldenEvening: number; blueHour: number; daylight: number; night: number };
  /** Items per local capture month; `south` is null for items without a location. */
  months: Array<{ month: number; south: boolean | null; count: number }>;
  /** The owner's own tags on the most items; empty unless the owner reads their own scope. */
  topTags: Array<{ name: string; count: number }>;
  /** Where the photos were taken; null unless the owner reads their own scope, or nothing has a location. */
  farAndWide: {
    travelledKm: number;
    farthest: { km: number; place: string | null } | null;
    northernmost: { latitude: number; place: string | null } | null;
    southernmost: { latitude: number; place: string | null } | null;
    highest: { metres: number; place: string | null } | null;
  } | null;
  underTheHood: { searchVectors: number; faceVectors: number; previews: number; databaseRows: number };
  /** Each camera's highest recorded shutter count (FL-1196). */
  shutter: Array<{ make: string | null; model: string | null; count: number }>;
  /** The nearest everyday subject to each photo's visual-search embedding, for a sample of the newest. */
  seen: { described: number; labels: Array<{ id: string; count: number }> } | null;
};

/** Great-circle distance in km between two points in degrees, for SQL. */
const haversineKm = (
  lat1: RawBuilder<unknown>,
  lon1: RawBuilder<unknown>,
  lat2: RawBuilder<unknown>,
  lon2: RawBuilder<unknown>,
) =>
  // least(1, …): rounding near opposite points of the globe can push asin's argument just past 1
  sql`(2 * 6371 * asin(least(1, sqrt(power(sin(radians(${lat2} - ${lat1}) / 2), 2) + cos(radians(${lat1})) * cos(radians(${lat2})) * power(sin(radians(${lon2} - ${lon1}) / 2), 2)))))`;

/** Leaves out the assets (`a`) the reading session keeps hidden: Locked people and tags, sensitive content. */
const visibleTo = (privacy?: HiddenContentQueryOptions): RawBuilder<boolean> => {
  const hiddenContent = getHiddenContentFilter(privacy);
  return hiddenContent
    ? sql<boolean>`not ${hiddenContentAssetIdExists(sql.ref('a.id'), hiddenContent)}`
    : sql<boolean>`true`;
};

/** The newest photos read for "What the AI sees": enough to be telling, quick on a large library. */
const SEEN_SAMPLE = 20_000;
const IMAGE = sql.lit(AssetType.Image);
const VIDEO = sql.lit(AssetType.Video);
const HIDDEN = sql.lit(AssetVisibility.Hidden);
const ARCHIVE = sql.lit(AssetVisibility.Archive);

@Injectable()
export class AnalyticsRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /** Accounts and external libraries a report or the collector can be scoped to. */
  async getScopeTargets(): Promise<AnalyticsScopeTargets> {
    const [users, libraries] = await Promise.all([
      this.db
        .selectFrom('user')
        .select(['user.id', 'user.name', 'user.deletedAt'])
        .orderBy('user.createdAt', 'asc')
        .execute(),
      this.db
        .selectFrom('library')
        .select(['library.id', 'library.name', 'library.ownerId', 'library.deletedAt'])
        .orderBy('library.createdAt', 'asc')
        .execute(),
    ]);
    return {
      users: users.map((user) => ({ ...user, deletedAt: user.deletedAt ? new Date(user.deletedAt) : null })),
      libraries: libraries.map((library) => ({
        ...library,
        deletedAt: library.deletedAt ? new Date(library.deletedAt) : null,
      })),
    };
  }

  async getInventory(scope: AnalyticsScope): Promise<AnalyticsInventory> {
    const { rows } = await sql<Record<keyof AnalyticsInventory, string | number | null>>`
      select
        count(*) filter (where a.type = ${IMAGE} and a.visibility <> ${HIDDEN}) as "photos",
        count(*) filter (where a.type = ${VIDEO} and a.visibility <> ${HIDDEN}) as "videos",
        count(*) filter (
          where a.type = ${IMAGE} and a.visibility <> ${HIDDEN} and lower(a."originalFileName") ~ ${RAW_EXTENSION_PATTERN}
        ) as "raw",
        count(*) filter (
          where a.type = ${IMAGE} and a.visibility not in (${HIDDEN}, ${ARCHIVE}) and a."deletedAt" is null
        ) as "timelinePhotos",
        count(*) filter (
          where a.type = ${VIDEO} and a.visibility not in (${HIDDEN}, ${ARCHIVE}) and a."deletedAt" is null
        ) as "timelineVideos",
        count(*) filter (where a.type = ${IMAGE} and a.visibility = ${ARCHIVE} and a."deletedAt" is null) as "archivePhotos",
        count(*) filter (where a.type = ${VIDEO} and a.visibility = ${ARCHIVE} and a."deletedAt" is null) as "archiveVideos",
        count(*) filter (where a.type = ${IMAGE} and a.visibility <> ${HIDDEN} and a."deletedAt" is not null) as "trashPhotos",
        count(*) filter (where a.type = ${VIDEO} and a.visibility <> ${HIDDEN} and a."deletedAt" is not null) as "trashVideos",
        count(*) filter (
          where a.type = ${IMAGE} and a.visibility <> ${HIDDEN} and a."deletedAt" is null and a."isFavorite"
        ) as "favoritePhotos",
        count(*) filter (
          where a.type = ${VIDEO} and a.visibility <> ${HIDDEN} and a."deletedAt" is null and a."isFavorite"
        ) as "favoriteVideos",
        count(*) filter (
          where a.type in (${IMAGE}, ${VIDEO}) and a.visibility <> ${HIDDEN} and e."dateTimeOriginal" is not null
        ) as "withCaptureDate",
        count(*) filter (
          where a.type in (${IMAGE}, ${VIDEO}) and a.visibility <> ${HIDDEN}
            and e."latitude" is not null and e."longitude" is not null
        ) as "withLocation",
        count(*) filter (
          where a.type in (${IMAGE}, ${VIDEO}) and a.visibility <> ${HIDDEN} and nullif(trim(e."model"), '') is not null
        ) as "withCameraModel",
        count(*) filter (
          where a.type in (${IMAGE}, ${VIDEO}) and a.visibility <> ${HIDDEN}
            and position('AI description:' in coalesce(e."description", '')) > 0
        ) as "withAiDescription",
        count(*) as "files",
        count(*) filter (where e."fileSizeInByte" is null) as "unmeasuredFiles",
        coalesce(sum(e."fileSizeInByte"), 0) as "logicalBytes",
        coalesce(sum(e."fileSizeInByte") filter (where a."libraryId" is null), 0) as "uploadedLogicalBytes",
        coalesce(sum(e."fileSizeInByte") filter (where a."libraryId" is not null), 0) as "externalLogicalBytes"
      from asset a
      left join asset_exif e on e."assetId" = a.id
      where a.type in (${IMAGE}, ${VIDEO}) and ${isNotLocked('a')} and ${scopeCondition(scope)}
    `.execute(this.db);
    const row = rows[0];
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, num(value)])) as AnalyticsInventory;
  }

  /**
   * Original bytes with every physical file counted once. Items that point at the same
   * `physical_file` share one original; an item without one is its own file. A file shared across
   * two selections counts fully in each, and once in a selection holding both: physical bytes are
   * never divided between accounts.
   */
  async getPhysical(scope: AnalyticsScope): Promise<AnalyticsPhysical> {
    const { rows } = await sql<Record<keyof AnalyticsPhysical, string | number | null>>`
      select
        coalesce(sum(t.size), 0) as "physicalBytes",
        coalesce(sum(t.size) filter (where not t.external), 0) as "uploadedPhysicalBytes",
        coalesce(sum(t.size) filter (where t.external), 0) as "externalPhysicalBytes",
        coalesce(sum(t.items) filter (where t.items > 1), 0) as "sharedReferences"
      from (
        select
          coalesce(p.id::text, a.id::text) as key,
          max(coalesce(p."sizeInBytes", e."fileSizeInByte")) as size,
          bool_or(a."libraryId" is not null) as external,
          count(*) filter (where a.visibility <> ${HIDDEN}) as items
        from asset a
        left join asset_exif e on e."assetId" = a.id
        left join physical_file p on p.id = a."physicalOriginalFileId"
        where a.type in (${IMAGE}, ${VIDEO}) and ${isNotLocked('a')} and ${scopeCondition(scope)}
        group by 1
      ) t
    `.execute(this.db);
    const row = rows[0];
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, num(value)])) as AnalyticsPhysical;
  }

  /**
   * One reading of every collected library series for the host, every account and every external
   * library, in two scans. Accounts and libraries with nothing get no row here; the caller records
   * them as zero.
   */
  async getCollectorSnapshot(): Promise<AnalyticsCollectorRow[]> {
    const { rows } = await sql<{
      kind: AnalyticsScopeKind;
      id: string | null;
      items: string;
      photos: string;
      videos: string;
      logicalBytes: string;
      physicalBytes: string;
    }>`
      with refs as (
        select
          a."ownerId",
          a."libraryId",
          a.type,
          a.visibility,
          e."fileSizeInByte" as "logicalSize",
          coalesce(p.id::text, a.id::text) as key,
          coalesce(p."sizeInBytes", e."fileSizeInByte") as "physicalSize"
        from asset a
        left join asset_exif e on e."assetId" = a.id
        left join physical_file p on p.id = a."physicalOriginalFileId"
        where a.type in (${IMAGE}, ${VIDEO}) and ${isNotLocked('a')}
      ),
      counts as (
        select
          case when grouping("ownerId") = 0 then 'account' when grouping("libraryId") = 0 then 'library' else 'host' end as kind,
          coalesce("ownerId"::text, "libraryId"::text) as id,
          count(*) filter (where visibility <> ${HIDDEN}) as items,
          count(*) filter (where visibility <> ${HIDDEN} and type = ${IMAGE}) as photos,
          count(*) filter (where visibility <> ${HIDDEN} and type = ${VIDEO}) as videos,
          coalesce(sum("logicalSize"), 0) as "logicalBytes"
        from refs
        group by grouping sets ((), ("ownerId"), ("libraryId"))
      ),
      physical as (
        select 'host' as kind, null::text as id, coalesce(sum(size), 0) as "physicalBytes"
        from (select distinct key, "physicalSize" as size from refs) t
        union all
        select 'account', "ownerId"::text, coalesce(sum(size), 0)
        from (select distinct "ownerId", key, "physicalSize" as size from refs) t
        group by "ownerId"
        union all
        select 'library', "libraryId"::text, coalesce(sum(size), 0)
        from (select distinct "libraryId", key, "physicalSize" as size from refs where "libraryId" is not null) t
        group by "libraryId"
      )
      select c.kind, c.id, c.items, c.photos, c.videos, c."logicalBytes", coalesce(p."physicalBytes", 0) as "physicalBytes"
      from counts c
      left join physical p on p.kind = c.kind and p.id is not distinct from c.id
      where not (c.kind = 'library' and c.id is null)
    `.execute(this.db);
    return rows.map((row) => ({
      kind: row.kind,
      id: row.id,
      items: num(row.items),
      photos: num(row.photos),
      videos: num(row.videos),
      logicalBytes: num(row.logicalBytes),
      physicalBytes: num(row.physicalBytes),
    }));
  }

  /** Items still in the selection, by the UTC day they were added. */
  async getArrivalsByDay(scope: AnalyticsScope, from: string, through: string) {
    const { rows } = await sql<{ day: string; photos: string; videos: string }>`
      select
        to_char((a."createdAt" at time zone 'UTC')::date, 'YYYY-MM-DD') as day,
        count(*) filter (where a.type = ${IMAGE}) as photos,
        count(*) filter (where a.type = ${VIDEO}) as videos
      from asset a
      where a.type in (${IMAGE}, ${VIDEO}) and a.visibility <> ${HIDDEN} and ${isNotLocked('a')}
        and ${scopeCondition(scope)}
        and a."createdAt" >= ${from}::date at time zone 'UTC'
        and a."createdAt" < (${through}::date + 1) at time zone 'UTC'
      group by 1
    `.execute(this.db);
    return rows.map((row) => ({ day: row.day, photos: num(row.photos), videos: num(row.videos) }));
  }

  /** Items still in the selection, by the local calendar date they were taken. */
  async getCapturesByDay(scope: AnalyticsScope, from: string, through: string) {
    const { rows } = await sql<{ day: string; items: string }>`
      select to_char((a."localDateTime" at time zone 'UTC')::date, 'YYYY-MM-DD') as day, count(*) as items
      from asset a
      where a.type in (${IMAGE}, ${VIDEO}) and a.visibility <> ${HIDDEN} and ${isNotLocked('a')}
        and ${scopeCondition(scope)}
        and (a."localDateTime" at time zone 'UTC')::date between ${from}::date and ${through}::date
      group by 1
    `.execute(this.db);
    return rows.map((row) => ({ day: row.day, items: num(row.items) }));
  }

  /**
   * Items per EXIF make and model; `make` and `model` are null when not recorded. The reading
   * session's hidden content is left out, as in the insights, so the cameras add up to the same items.
   */
  async getCameras(scope: AnalyticsScope, privacy?: HiddenContentQueryOptions) {
    const { rows } = await sql<{ make: string | null; model: string | null; items: string }>`
      select nullif(trim(e."make"), '') as make, nullif(trim(e."model"), '') as model, count(*) as items
      from asset a
      left join asset_exif e on e."assetId" = a.id
      where a.type in (${IMAGE}, ${VIDEO}) and a.visibility <> ${HIDDEN} and ${isNotLocked('a')}
        and ${scopeCondition(scope)} and ${visibleTo(privacy)}
      group by 1, 2
    `.execute(this.db);
    return rows.map((row) => ({ make: row.make, model: row.model, items: num(row.items) }));
  }

  /**
   * FL-79: the dashboard breakdowns. Every item query reads the same items as `summary.items` (photos
   * and videos, Trash included, Locked media and Live Photo motion parts excluded), so each
   * partition adds up to it, or to `summary.photos`/`summary.videos` for the per-type ones. Names
   * (file names, people, places) are read only for the scope's owner reading their own scope.
   */
  async getInsights(scope: AnalyticsScope, options: AnalyticsInsightOptions): Promise<AnalyticsInsightRows> {
    // what the reading session keeps hidden (Locked people and tags, sensitive content) is left out of
    // every breakdown, so no record, place or lens can point at it
    const visible = visibleTo(options.privacy);
    const items = sql`
      select
        a.id, a.type, a."localDateTime", a."originalFileName", a.duration, a."livePhotoVideoId",
        coalesce(a.width, case when e.orientation in ('5', '6', '7', '8') then e."exifImageHeight" else e."exifImageWidth" end) as width,
        coalesce(a.height, case when e.orientation in ('5', '6', '7', '8') then e."exifImageWidth" else e."exifImageHeight" end) as height,
        nullif(trim(e."lensModel"), '') as "lensModel", e."focalLength", nullif(trim(e.city), '') as city,
        nullif(trim(e.country), '') as country, e.latitude, e.longitude, e."fileSizeInByte",
        a."fileCreatedAt", nullif(trim(e.make), '') as make, nullif(trim(e.model), '') as model,
        e.altitude, e."shutterCount",
        case when length(a.thumbhash) >= 3
          then get_byte(a.thumbhash, 0) | (get_byte(a.thumbhash, 1) << 8) | (get_byte(a.thumbhash, 2) << 16)
        end as "thumbhashHeader"
      from asset a
      left join asset_exif e on e."assetId" = a.id
      where a.type in (${IMAGE}, ${VIDEO}) and a.visibility <> ${HIDDEN} and ${isNotLocked('a')} and ${scopeCondition(scope)}
        and ${visible}
    `;

    // the item set is read once per report into a temporary table that ends with the transaction
    return this.db.transaction().execute(async (trx) => {
      await sql`create temporary table analytics_insight_items on commit drop as ${items}`.execute(trx);
      const run = async <T>(query: RawBuilder<unknown>) =>
        (await sql<T>`with items as (select * from analytics_insight_items) ${query}`.execute(trx)).rows;
      return this.readInsights(run, options);
    });
  }

  private async readInsights(
    run: <T>(query: RawBuilder<unknown>) => Promise<T[]>,
    options: AnalyticsInsightOptions,
  ): Promise<AnalyticsInsightRows> {
    const local = sql`(items."localDateTime" at time zone 'UTC')`;
    const fileName = sql`lower(items."originalFileName")`;
    const withNames = !!options.ownerId;
    const name = (column: RawBuilder<unknown>) => (withNames ? column : sql`null::text`);

    const [years, punchcard, lenses, focalLengths, photoFormats, videoResolutions, orientation, counts, records] =
      await Promise.all([
        run<{ year: number; count: string }>(sql`
          select extract(year from ${local})::int as year, count(*) as count from items group by 1 order by 1`),
        run<{ weekday: number; hour: number; count: string }>(sql`
          select extract(isodow from ${local})::int as weekday, extract(hour from ${local})::int as hour, count(*) as count
          from items group by 1, 2`),
        run<{ name: string | null; count: string }>(sql`
          select items."lensModel" as name, count(*) as count from items group by 1`),
        run<{ bucket: string; count: string }>(sql`
          select
            case
              when items."focalLength" is null or items."focalLength" <= 0 then 'unknown'
              when items."focalLength" <= 16 then '0-16'
              when items."focalLength" <= 28 then '17-28'
              when items."focalLength" <= 40 then '29-40'
              when items."focalLength" <= 70 then '41-70'
              when items."focalLength" <= 135 then '71-135'
              when items."focalLength" <= 300 then '136-300'
              else '301+'
            end as bucket,
            count(*) as count
          from items group by 1`),
        run<{ format: string; count: string }>(sql`
          select
            case
              when ${fileName} ~ ${RAW_EXTENSION_PATTERN} then 'RAW'
              when ${fileName} ~ ${HEIC_EXTENSION_PATTERN} then 'HEIC'
              when ${fileName} ~ ${JPEG_EXTENSION_PATTERN} then 'JPEG'
              when ${fileName} ~ ${PNG_EXTENSION_PATTERN} then 'PNG'
              else 'OTHER'
            end as format,
            count(*) as count
          from items where items.type = ${IMAGE} group by 1`),
        run<{ resolution: string; count: string }>(sql`
          select
            case
              when coalesce(items.width, 0) <= 0 or coalesce(items.height, 0) <= 0 then 'unknown'
              when greatest(items.width, items.height) >= 3840 or least(items.width, items.height) >= 2160 then '4K'
              when least(items.width, items.height) >= 1080 then '1080p'
              when least(items.width, items.height) >= 720 then '720p'
              else 'SD'
            end as resolution,
            count(*) as count
          from items where items.type = ${VIDEO} group by 1`),
        run<{ orientation: string; count: string }>(sql`
          select
            case
              when coalesce(items.width, 0) <= 0 or coalesce(items.height, 0) <= 0 then 'unknown'
              when greatest(items.width, items.height)::float / least(items.width, items.height) >= 2 then 'panorama'
              when greatest(items.width, items.height)::float / least(items.width, items.height) < 1.05 then 'square'
              when items.width > items.height then 'landscape'
              else 'portrait'
            end as orientation,
            count(*) as count
          from items group by 1`),
        run<{
          items: string;
          livePhotos: string;
          probedVideos: string;
          hdrVideos: string;
          dolbyVisionVideos: string;
          videoDurationMs: string;
          facesChecked: string;
          searchIndexed: string;
        }>(sql`
          select
            count(*) as items,
            count(*) filter (where items.type = ${IMAGE} and items."livePhotoVideoId" is not null) as "livePhotos",
            count(v."assetId") filter (where items.type = ${VIDEO}) as "probedVideos",
            count(v."assetId") filter (
              where items.type = ${VIDEO}
                and (v."colorTransfer" in (${sql.lit(ColorTransfer.Smpte2084)}, ${sql.lit(ColorTransfer.AribStdB67)}) or v."dvProfile" is not null)
            ) as "hdrVideos",
            count(v."assetId") filter (where items.type = ${VIDEO} and v."dvProfile" is not null) as "dolbyVisionVideos",
            coalesce(sum(items.duration) filter (where items.type = ${VIDEO} and items.duration > 0), 0) as "videoDurationMs",
            count(*) filter (where j."facesRecognizedAt" is not null) as "facesChecked",
            count(*) filter (where exists (select 1 from smart_search s where s."assetId" = items.id)) as "searchIndexed"
          from items
          left join asset_video v on v."assetId" = items.id
          left join asset_job_status j on j."assetId" = items.id`),
        run<{ kind: string; localDateTime: Date | null; name: string | null; value: string | null }>(sql`
          (select 'oldest' as kind, items."localDateTime", ${name(sql`items."originalFileName"`)} as name, null::bigint as value
            from items order by items."localDateTime" asc, items.id limit 1)
          union all
          (select 'largest', null, ${name(sql`items."originalFileName"`)}, items."fileSizeInByte"
            from items where items."fileSizeInByte" is not null order by items."fileSizeInByte" desc, items.id limit 1)
          union all
          (select 'longest', null, ${name(sql`items."originalFileName"`)}, items.duration
            from items where items.type = ${VIDEO} and items.duration > 0 order by items.duration desc, items.id limit 1)`),
      ]);

    const people = options.ownerId ? await this.getOwnerPeopleAndPlaces(run, options) : null;
    const magic = await this.readMagic(run, options);
    const record = (kind: string) => records.find((row) => row.kind === kind);
    const oldest = record('oldest');
    const largest = record('largest');
    const longest = record('longest');
    const count = <T extends { count: string | number }>(rows: T[]) =>
      rows.map((row) => ({ ...row, count: num(row.count) }));

    return {
      items: num(counts[0]?.items),
      years: count(years),
      punchcard: count(punchcard),
      lenses: count(lenses),
      focalLengths: count(focalLengths),
      photoFormats: count(photoFormats),
      videoResolutions: count(videoResolutions),
      orientation: count(orientation),
      livePhotos: num(counts[0]?.livePhotos),
      hdr: {
        probedVideos: num(counts[0]?.probedVideos),
        hdrVideos: num(counts[0]?.hdrVideos),
        dolbyVisionVideos: num(counts[0]?.dolbyVisionVideos),
      },
      coverage: {
        facesChecked: num(counts[0]?.facesChecked),
        searchIndexed: num(counts[0]?.searchIndexed),
      },
      records: {
        oldest: oldest?.localDateTime
          ? { localDateTime: new Date(oldest.localDateTime), name: oldest.name ?? '' }
          : null,
        largest: largest ? { bytes: num(largest.value), name: largest.name ?? '' } : null,
        longest: longest ? { durationMs: num(longest.value), name: longest.name ?? '' } : null,
        videoDurationMs: num(counts[0]?.videoDurationMs),
      },
      magic,
      people,
    };
  }

  /**
   * Library magic (approved design, 2026-11-04). The colour comes from each photo's ThumbHash (its average
   * colour sits in the first three bytes); the light from the sun's height at the photo's place and instant
   * (a low-precision solar position, good to about a degree); tags and places only for the scope's owner.
   */
  private async readMagic(
    run: <T>(query: RawBuilder<unknown>) => Promise<T[]>,
    options: AnalyticsInsightOptions,
  ): Promise<AnalyticsMagicRows> {
    const local = sql`(items."localDateTime" at time zone 'UTC')`;
    const located = sql`items.latitude is not null and items.longitude is not null`;
    const place = sql`nullif(concat_ws(', ', items.city, items.country), '')`;
    const labels = options.seenLabels ?? [];
    const [shutter, seen] = await Promise.all([
      run<{ make: string | null; model: string | null; count: number }>(sql`
        select items.make, items.model, max(items."shutterCount")::int as count
        from items where items."shutterCount" is not null
        group by 1, 2 order by 3 desc limit 6`),
      labels.length === 0
        ? Promise.resolve(null)
        : run<{ id: string; count: string }>(sql`
            select nearest.id, count(*) as count
            from (
              select s.embedding from smart_search s inner join items on items.id = s."assetId"
              order by items."localDateTime" desc limit ${SEEN_SAMPLE}
            ) sample
            cross join lateral (
              select labels.id
              from (values ${sql.join(labels.map((label) => sql`(${label.id}, ${label.embedding}::vector)`))}) as labels(id, embedding)
              order by sample.embedding <=> labels.embedding limit 1
            ) nearest
            group by 1 order by 2 desc, 1 asc`),
    ]);
    const [colour, light, months, underTheHood] = await Promise.all([
      run<{ month: number; photos: string; l: number; p: number; q: number }>(sql`
        select extract(month from ${local})::int as month, count(*) as photos,
          avg(items."thumbhashHeader" & 63)::float as l,
          avg((items."thumbhashHeader" >> 6) & 63)::float as p,
          avg((items."thumbhashHeader" >> 12) & 63)::float as q
        from items where items.type = ${IMAGE} and items."thumbhashHeader" is not null
        group by 1 order by 1`),
      run<{ goldenMorning: string; goldenEvening: string; blueHour: string; daylight: string; night: string }>(sql`
        select
          count(*) filter (where sun.elevation >= 6) as daylight,
          count(*) filter (where sun.elevation >= -4 and sun.elevation < 6 and extract(hour from ${local}) < 12) as "goldenMorning",
          count(*) filter (where sun.elevation >= -4 and sun.elevation < 6 and extract(hour from ${local}) >= 12) as "goldenEvening",
          count(*) filter (where sun.elevation >= -6 and sun.elevation < -4) as "blueHour",
          count(*) filter (where sun.elevation < -6) as night
        from items
        cross join lateral (select extract(epoch from items."fileCreatedAt") / 86400.0 - 10957.5 as d) t
        cross join lateral (
          select radians(357.529 + 0.98560028 * t.d) as g, 280.459 + 0.98564736 * t.d as q,
            radians(23.439 - 0.00000036 * t.d) as e
        ) m
        cross join lateral (select radians(m.q + 1.915 * sin(m.g) + 0.020 * sin(2 * m.g)) as l) ec
        cross join lateral (
          select asin(sin(m.e) * sin(ec.l)) as dec, degrees(atan2(cos(m.e) * sin(ec.l), cos(ec.l))) as ra,
            18.697374558 + 24.06570982441908 * t.d as gmst
        ) s
        cross join lateral (
          select degrees(asin(least(1, greatest(-1,
            sin(radians(items.latitude)) * sin(s.dec)
            + cos(radians(items.latitude)) * cos(s.dec) * cos(radians(s.gmst * 15 + items.longitude - s.ra))
          )))) as elevation
        ) sun
        where items.type = ${IMAGE} and ${located} and items."fileCreatedAt" is not null`),
      run<{ month: number; south: boolean | null; count: string }>(sql`
        select extract(month from ${local})::int as month, (items.latitude < 0) as south, count(*) as count
        from items group by 1, 2`),
      run<{ searchVectors: string; faceVectors: string; previews: string; databaseRows: string }>(sql`
        select
          (select count(*) from smart_search s inner join items on items.id = s."assetId") as "searchVectors",
          (select count(*) from face_search fs inner join asset_face f on f.id = fs."faceId"
            inner join items on items.id = f."assetId") as "faceVectors",
          (select count(*) from asset_file af inner join items on items.id = af."assetId") as previews,
          (select coalesce(sum(greatest(c.reltuples, 0)), 0)::bigint from pg_class c
            where c.relkind = 'r' and c.relnamespace = 'public'::regnamespace) as "databaseRows"`),
    ]);

    let topTags: AnalyticsMagicRows['topTags'] = [];
    let farAndWide: AnalyticsMagicRows['farAndWide'] = null;
    if (options.ownerId) {
      const [tags, home] = await Promise.all([
        run<{ name: string; count: string }>(sql`
          select t.value as name, count(distinct ta."assetId") as count
          from tag_asset ta
          inner join items on items.id = ta."assetId"
          inner join tag t on t.id = ta."tagId" and t."userId" = ${options.ownerId}
          group by 1 order by 2 desc, 1 asc limit 8`),
        run<{ latitude: number; longitude: number }>(sql`
          select round(items.latitude::numeric, 1)::float as latitude, round(items.longitude::numeric, 1)::float as longitude
          from items where ${located} group by 1, 2 order by count(*) desc, 1, 2 limit 1`),
      ]);
      topTags = tags.map((row) => ({ name: row.name, count: num(row.count) }));
      if (home[0]) {
        const { latitude, longitude } = home[0];
        const [travelled, extremes] = await Promise.all([
          run<{ km: number | null }>(sql`
            select sum(step.km)::float as km from (
              select ${haversineKm(
                sql`lag(items.latitude) over w`,
                sql`lag(items.longitude) over w`,
                sql`items.latitude`,
                sql`items.longitude`,
              )} as km
              from items where ${located}
              window w as (order by items."localDateTime", items.id)
            ) step`),
          run<{ kind: string; value: number; place: string | null }>(sql`
            (select 'farthest' as kind, ${haversineKm(sql`${latitude}`, sql`${longitude}`, sql`items.latitude`, sql`items.longitude`)}::float as value, ${place} as place
              from items where ${located} order by 2 desc limit 1)
            union all
            (select 'north', items.latitude::float, ${place} from items where ${located} order by items.latitude desc limit 1)
            union all
            (select 'south', items.latitude::float, ${place} from items where ${located} order by items.latitude asc limit 1)
            union all
            (select 'highest', items.altitude::float, ${place} from items where items.altitude is not null
              order by items.altitude desc limit 1)`),
        ]);
        const extreme = (kind: string) => extremes.find((row) => row.kind === kind);
        const farthest = extreme('farthest');
        const north = extreme('north');
        const south = extreme('south');
        const highest = extreme('highest');
        farAndWide = {
          travelledKm: Math.round(travelled[0]?.km ?? 0),
          farthest: farthest ? { km: Math.round(farthest.value), place: farthest.place } : null,
          northernmost: north ? { latitude: north.value, place: north.place } : null,
          southernmost: south ? { latitude: south.value, place: south.place } : null,
          highest: highest ? { metres: Math.round(highest.value), place: highest.place } : null,
        };
      }
    }

    return {
      colour: colour.map((row) => ({ month: row.month, photos: num(row.photos), l: row.l, p: row.p, q: row.q })),
      light: {
        goldenMorning: num(light[0]?.goldenMorning),
        goldenEvening: num(light[0]?.goldenEvening),
        blueHour: num(light[0]?.blueHour),
        daylight: num(light[0]?.daylight),
        night: num(light[0]?.night),
      },
      months: months.map((row) => ({ month: row.month, south: row.south, count: num(row.count) })),
      topTags,
      farAndWide,
      underTheHood: {
        searchVectors: num(underTheHood[0]?.searchVectors),
        faceVectors: num(underTheHood[0]?.faceVectors),
        previews: num(underTheHood[0]?.previews),
        databaseRows: num(underTheHood[0]?.databaseRows),
      },
      shutter: shutter.map((row) => ({ make: row.make, model: row.model, count: num(row.count) })),
      seen: seen && {
        described: seen.reduce((sum, row) => sum + num(row.count), 0),
        labels: seen.map((row) => ({ id: row.id, count: num(row.count) })),
      },
    };
  }

  private async getOwnerPeopleAndPlaces(
    run: <T>(query: RawBuilder<unknown>) => Promise<T[]>,
    { ownerId, suppressedPersonIds, suppressedPetIds }: AnalyticsInsightOptions,
  ): Promise<NonNullable<AnalyticsInsightRows['people']>> {
    const notSuppressedPerson =
      suppressedPersonIds.length > 0 ? sql`not (p."personGroupId" = ${anyUuid(suppressedPersonIds)})` : sql`true`;
    const notSuppressedPet = suppressedPetIds.length > 0 ? sql`not (pet.id = ${anyUuid(suppressedPetIds)})` : sql`true`;
    const faces = sql`
      select f."assetId", f."personGroupId"
      from asset_face f
      inner join items on items.id = f."assetId"
      where f."deletedAt" is null and f."isVisible" is true`;
    const named = sql`
      select p."personGroupId" as id, p.name, count(distinct f."assetId") as count
      from (${faces}) f
      inner join person p on p."personGroupId" = f."personGroupId" and p."ownerId" = ${ownerId}
      where not p."isHidden" and p.name <> '' and ${notSuppressedPerson}
      group by p."personGroupId", p.name`;

    const [faceCounts, topPeople, namedPeople, pets, placeCounts, cities] = await Promise.all([
      run<{ faces: string; itemsWithFaces: string }>(sql`
        select count(*) as faces, count(distinct f."assetId") as "itemsWithFaces" from (${faces}) f`),
      run<{ id: string; name: string; count: string }>(sql`
        select * from (${named}) n order by n.count desc, n.name asc limit ${ANALYTICS_TOP_PEOPLE_LIMIT}`),
      run<{ count: string }>(sql`select count(*) as count from (${named}) n`),
      run<{ count: string }>(sql`
        select count(distinct pet.id) as count
        from pet_observation po
        inner join items on items.id = po."assetId"
        inner join pet on pet.id = po."petId" and pet."ownerId" = ${ownerId}
        where po.state = ${sql.lit(PetObservationState.Confirmed)} and not pet."isHidden" and ${notSuppressedPet}`),
      run<{ geotagged: string; countries: string; cities: string }>(sql`
        select
          count(*) filter (where items.latitude is not null and items.longitude is not null) as geotagged,
          count(distinct items.country) as countries,
          count(distinct (items.city, items.country)) filter (where items.city is not null) as cities
        from items`),
      // Paris, France and Paris, Texas are two places, not one
      run<{ name: string | null; country: string | null; count: string }>(
        sql`select items.city as name, case when items.city is not null then items.country end as country,
          count(*) as count from items group by 1, 2`,
      ),
    ]);

    const seen = new Set<string>();
    const sharedCityNames = new Set<string>();
    for (const { name } of cities) {
      if (name && seen.has(name)) sharedCityNames.add(name);
      if (name) seen.add(name);
    }

    return {
      faces: num(faceCounts[0]?.faces),
      itemsWithFaces: num(faceCounts[0]?.itemsWithFaces),
      namedPeople: num(namedPeople[0]?.count),
      pets: num(pets[0]?.count),
      topPeople: topPeople.map((row) => ({ id: row.id, name: row.name, count: num(row.count) })),
      geotagged: num(placeCounts[0]?.geotagged),
      countries: num(placeCounts[0]?.countries),
      cities: num(placeCounts[0]?.cities),
      places: cities.map((row) => ({
        name: row.name && row.country && sharedCityNames.has(row.name) ? `${row.name}, ${row.country}` : row.name,
        count: num(row.count),
      })),
    };
  }

  /**
   * Albums (not collections or shared spaces) in the selection: every album for the host, the
   * albums an account owns or belongs to, the albums holding a library's items. `viewerHasAccess`
   * says whether `viewerId` owns or belongs to it; only those albums may be named to the viewer.
   */
  async getAlbums(scope: AnalyticsScope, viewerId: string): Promise<AnalyticsAlbumRow[]> {
    const condition =
      scope.kind === AnalyticsScopeKind.Account
        ? sql`exists (select 1 from album_user x where x."albumId" = al.id and x."userId" = ${scope.userId})`
        : scope.kind === AnalyticsScopeKind.Library
          ? sql`exists (
              select 1 from album_asset aa join asset a on a.id = aa."assetId"
              where aa."albumId" = al.id and a."libraryId" = ${scope.libraryId} and ${isNotLocked('a')}
            )`
          : sql`true`;
    const { rows } = await sql<{
      id: string;
      name: string;
      ownerId: string;
      ownerName: string;
      members: string;
      viewerHasAccess: boolean;
    }>`
      select
        al.id,
        al."albumName" as name,
        o."userId" as "ownerId",
        u.name as "ownerName",
        (select count(*) from album_user m where m."albumId" = al.id and m.role <> ${sql.lit(AlbumUserRole.Owner)}) as members,
        exists (select 1 from album_user v where v."albumId" = al.id and v."userId" = ${viewerId}) as "viewerHasAccess"
      from album al
      join album_user o on o."albumId" = al.id and o.role = ${sql.lit(AlbumUserRole.Owner)}
      join "user" u on u.id = o."userId"
      where al."deletedAt" is null and al.kind = ${sql.lit(AlbumKind.Album)} and ${condition}
      order by al."createdAt" asc
    `.execute(this.db);
    return rows.map((row) => ({ ...row, members: num(row.members) }));
  }

  /** Machine-learning requests per UTC day, with the estimated cost of those that had a rate. */
  async getProcessingByDay(from: string, through: string) {
    const { rows } = await sql<{
      day: string;
      completed: string;
      failed: string;
      durationMs: string;
      costUsd: string | null;
      costed: string;
    }>`
      select
        to_char((w."startedAt" at time zone 'UTC')::date, 'YYYY-MM-DD') as day,
        count(*) filter (where w.outcome = 'success') as completed,
        count(*) filter (where w.outcome = 'failure') as failed,
        coalesce(sum(w."durationMs"), 0) as "durationMs",
        sum(w."costUsd") as "costUsd",
        count(w."costUsd") as costed
      from ml_workload_accounting w
      where w."startedAt" >= ${from}::date at time zone 'UTC'
        and w."startedAt" < (${through}::date + 1) at time zone 'UTC'
      group by 1
    `.execute(this.db);
    return rows.map((row) => ({
      day: row.day,
      completed: num(row.completed),
      failed: num(row.failed),
      durationMs: num(row.durationMs),
      costUsd: row.costUsd === null ? 0 : Number(row.costUsd),
      costed: num(row.costed),
    }));
  }

  /** Collector samples for one scope observed on or after `since`. */
  async getSamples(scopeKey: string, series: readonly AnalyticsSeriesId[], since: Date): Promise<AnalyticsSampleRow[]> {
    if (series.length === 0) {
      return [];
    }
    const rows = await this.db
      .selectFrom('operational_metric_sample')
      .select(['series', 'value', 'observedAt'])
      .where('scopeKey', '=', scopeKey)
      .where('series', 'in', [...series])
      .where('observedAt', '>=', since)
      .orderBy('observedAt', 'asc')
      .execute();
    return rows.map((row) => ({ series: row.series, value: num(row.value), observedAt: new Date(row.observedAt) }));
  }

  /** The newest collector sample for one scope, or null when it has never been collected. */
  async getLatestObservation(scopeKey: string): Promise<Date | null> {
    const row = await this.db
      .selectFrom('operational_metric_sample')
      .select((eb) => eb.fn.max('observedAt').as('observedAt'))
      .where('scopeKey', '=', scopeKey)
      .executeTakeFirst();
    return row?.observedAt ? new Date(row.observedAt as unknown as string) : null;
  }

  /**
   * The size of this server's database on disk (`pg_database_size`). Read only for the whole-server
   * report an administrator opens.
   */
  async getDatabaseBytes(): Promise<number> {
    const { rows } = await sql<{ bytes: string }>`select pg_database_size(current_database()) as bytes`.execute(
      this.db,
    );
    return num(rows[0]?.bytes);
  }

  /** The newest host readings of the given series (the volume by default), if any. */
  async getLatestHostSamples(
    series: AnalyticsSeriesId[] = [AnalyticsSeriesId.HostVolumeUsedBytes, AnalyticsSeriesId.HostCapacityBytes],
  ): Promise<AnalyticsSampleRow[]> {
    const rows = await this.db
      .selectFrom('operational_metric_sample')
      .distinctOn('series')
      .select(['series', 'value', 'observedAt'])
      .where('scopeKey', '=', 'host')
      .where('series', 'in', series)
      .orderBy('series')
      .orderBy('observedAt', 'desc')
      .execute();
    return rows.map((row) => ({ series: row.series, value: num(row.value), observedAt: new Date(row.observedAt) }));
  }

  /**
   * Write one collection. A second run on the same day replaces that day's rows, so the collector
   * and its automatic retry are idempotent. Every row is checked by `assertApprovedSample` first.
   */
  async upsertSamples(samples: AnalyticsSampleInsert[]): Promise<void> {
    const approved = samples.map((sample) => assertApprovedSample(sample));
    for (let index = 0; index < approved.length; index += 1000) {
      await this.db
        .insertInto('operational_metric_sample')
        .values(approved.slice(index, index + 1000))
        .onConflict((oc) =>
          oc.columns(['series', 'scopeKey', 'grain', 'bucketStart']).doUpdateSet((eb) => ({
            value: eb.ref('excluded.value'),
            observedAt: eb.ref('excluded.observedAt'),
            userId: eb.ref('excluded.userId'),
            libraryId: eb.ref('excluded.libraryId'),
          })),
        )
        .execute();
    }
  }

  /**
   * Retention and downsampling, in one transaction:
   *
   * 1. Day rows older than `dayCutoff` become week rows (Monday start). A week keeps the newest day
   *    it had, as these series are readings, not totals; a week already holding a newer reading
   *    keeps it.
   * 2. Those day rows are deleted.
   * 3. Week rows older than `weekCutoff` are deleted.
   *
   * Running it twice changes nothing the second time.
   */
  async applyRetention(dayCutoff: Date, weekCutoff: Date): Promise<{ downsampled: number; deleted: number }> {
    return this.db.transaction().execute(async (trx) => {
      const day = sql.lit(AnalyticsSampleGrain.Day);
      const week = sql.lit(AnalyticsSampleGrain.Week);
      const inserted = await sql`
        insert into operational_metric_sample ("series", "scopeKey", "userId", "libraryId", "grain", "bucketStart", "value", "observedAt")
        select distinct on (s."series", s."scopeKey", date_trunc('week', s."bucketStart" at time zone 'UTC'))
          s."series", s."scopeKey", s."userId", s."libraryId", ${week},
          date_trunc('week', s."bucketStart" at time zone 'UTC') at time zone 'UTC',
          s."value", s."observedAt"
        from operational_metric_sample s
        where s."grain" = ${day} and s."bucketStart" < ${dayCutoff}
        order by s."series", s."scopeKey", date_trunc('week', s."bucketStart" at time zone 'UTC'), s."observedAt" desc
        on conflict ("series", "scopeKey", "grain", "bucketStart") do update
          set "value" = excluded."value", "observedAt" = excluded."observedAt"
          where excluded."observedAt" > operational_metric_sample."observedAt"
      `.execute(trx);
      const days = await trx
        .deleteFrom('operational_metric_sample')
        .where('grain', '=', AnalyticsSampleGrain.Day)
        .where('bucketStart', '<', dayCutoff)
        .executeTakeFirst();
      const weeks = await trx
        .deleteFrom('operational_metric_sample')
        .where('grain', '=', AnalyticsSampleGrain.Week)
        .where('bucketStart', '<', weekCutoff)
        .executeTakeFirst();
      return {
        downsampled: Number(inserted.numAffectedRows ?? 0),
        deleted: Number(days.numDeletedRows ?? 0) + Number(weeks.numDeletedRows ?? 0),
      };
    });
  }
}
