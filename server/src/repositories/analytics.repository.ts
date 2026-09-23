import { Injectable } from '@nestjs/common';
import { Kysely, RawBuilder, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import {
  AlbumKind,
  AlbumUserRole,
  AnalyticsSampleGrain,
  AnalyticsScopeKind,
  AnalyticsSeriesId,
  AssetType,
  AssetVisibility,
} from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import {
  AnalyticsSampleInsert,
  AnalyticsSampleRow,
  AnalyticsScope,
  assertApprovedSample,
} from 'src/utils/analytics.js';
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

  /** Items per EXIF make and model; `make` and `model` are null when not recorded. */
  async getCameras(scope: AnalyticsScope) {
    const { rows } = await sql<{ make: string | null; model: string | null; items: string }>`
      select nullif(trim(e."make"), '') as make, nullif(trim(e."model"), '') as model, count(*) as items
      from asset a
      left join asset_exif e on e."assetId" = a.id
      where a.type in (${IMAGE}, ${VIDEO}) and a.visibility <> ${HIDDEN} and ${isNotLocked('a')}
        and ${scopeCondition(scope)}
      group by 1, 2
    `.execute(this.db);
    return rows.map((row) => ({ make: row.make, model: row.model, items: num(row.items) }));
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

  /** The newest host volume readings, if any. */
  async getLatestHostSamples(): Promise<AnalyticsSampleRow[]> {
    const rows = await this.db
      .selectFrom('operational_metric_sample')
      .distinctOn('series')
      .select(['series', 'value', 'observedAt'])
      .where('scopeKey', '=', 'host')
      .where('series', 'in', [AnalyticsSeriesId.HostVolumeUsedBytes, AnalyticsSeriesId.HostCapacityBytes])
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
