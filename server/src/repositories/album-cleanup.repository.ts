import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { AlbumCleanupFacts, AlbumCleanupOperation } from 'src/dtos/album-cleanup.dto.js';
import type { AlbumReadOptions } from 'src/repositories/album.repository.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AlbumKind, AlbumUserRole, LibraryScope } from 'src/enum.js';
import { SAVED_NAME } from 'src/repositories/album-suggestion.repository.js';
import { DB } from 'src/schema/index.js';
import { AlbumChangeRunKind, AlbumChangeRunStatus } from 'src/schema/tables/album-change-run.table.js';
import { AlbumCleanupVariant } from 'src/schema/tables/album-cleanup-snapshot.table.js';
import { anyUuid, withAlbumVisibility, withHiddenContentFilter } from 'src/utils/database.js';
import { libraryScopePredicate } from 'src/utils/library-scope.js';
import { isLocked } from 'src/utils/locked.js';

/** The size of a GPS grid cell, in degrees: about 55 km, so a 100 km home area spans a few of them. */
const HOME_BIN_DEGREES = 0.5;

/** One album on the person's Albums page. Read-only rows are listed but never changed. */
export type CleanupAlbumRow = {
  id: string;
  name: string;
  createdAt: Date;
  isLocked: boolean;
  shared: boolean;
  parentId: string | null;
  /** A collection, a partner's copy, or an album someone else owns. */
  readOnly: boolean;
};

export type CleanupCollectionRow = { id: string; name: string; parentId: string | null; createdAt: Date };

export type CleanupApplyRow = {
  runId: string;
  userId: string;
  status: AlbumChangeRunStatus;
  operations: AlbumCleanupOperation[];
  nextIndex: number;
  targets: Record<string, string>;
  tally: Record<string, number>;
  elevated: boolean;
  progressAt: Date;
};

const jsonb = (value: unknown) => sql<never>`${value}::jsonb`;

/** FL-1300: the reads behind the cleanup scan, and the state of a cleanup while it is applied. */
@Injectable()
export class AlbumCleanupRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /** Everything on a person's Albums page. Smart albums are excluded by the caller, which has their rules. */
  @GenerateSql({ params: [DummyValue.UUID] })
  getScanAlbums(userId: string): Promise<CleanupAlbumRow[]> {
    return (
      this.db
        .selectFrom('album')
        .innerJoin('album_user as viewer', (join) =>
          join.onRef('viewer.albumId', '=', 'album.id').on('viewer.userId', '=', userId),
        )
        .where('album.deletedAt', 'is', null)
        .where((eb) =>
          eb.or([eb('viewer.role', '!=', AlbumUserRole.Owner), libraryScopePredicate(LibraryScope.Personal, 'album')]),
        )
        // Someone else's locked album is theirs to reveal.
        .where((eb) => eb.or([eb('viewer.role', '=', AlbumUserRole.Owner), eb('album.isLocked', '=', false)]))
        .select([
          'album.id',
          'album.albumName as name',
          'album.createdAt',
          'album.isLocked',
          'album.parentId',
          sql<boolean>`(
          viewer.role <> ${AlbumUserRole.Owner}
          or album.kind <> ${AlbumKind.Album}
          or exists (select 1 from public.album_origin origin where origin."albumId" = album.id)
        )`.as('readOnly'),
          sql<boolean>`(
          exists (select 1 from album_user member where member."albumId" = album.id and member.role <> ${AlbumUserRole.Owner})
          or exists (select 1 from shared_link where shared_link."albumId" = album.id)
          or exists (select 1 from shared_space_album linked where linked."linkedAlbumId" = album.id)
        )`.as('shared'),
        ])
        .orderBy('album.createdAt')
        .orderBy('album.id')
        .$castTo<CleanupAlbumRow>()
        .execute()
    );
  }

  /** Every collection the person owns, at any depth: existing structure to reuse. */
  @GenerateSql({ params: [DummyValue.UUID] })
  getCollections(userId: string): Promise<CleanupCollectionRow[]> {
    return this.db
      .selectFrom('album')
      .innerJoin('album_user as owner', (join) =>
        join
          .onRef('owner.albumId', '=', 'album.id')
          .on('owner.userId', '=', userId)
          .on('owner.role', '=', AlbumUserRole.Owner),
      )
      .where('album.deletedAt', 'is', null)
      .where('album.kind', '=', AlbumKind.Collection)
      .select(['album.id', 'album.albumName as name', 'album.parentId', 'album.createdAt'])
      .orderBy('album.createdAt')
      .orderBy('album.id')
      .$castTo<CleanupCollectionRow>()
      .execute();
  }

  /**
   * FL-1404: whether anything on a person's Albums page changed after their scan began. Every write to an album
   * moves its `updatedAt` (adding photos included), and an album that is deleted or left, or a photo taken out of
   * one, leaves an audit row behind. Compared in the database, where both sides keep their microseconds.
   */
  @GenerateSql({ params: [DummyValue.UUID, AlbumCleanupVariant.Ordinary] })
  async hasChangedSinceScan(userId: string, variant: AlbumCleanupVariant): Promise<boolean> {
    const { changed } = await this.db
      .selectNoFrom(
        sql<boolean>`coalesce(
          greatest(
            (
              select max(album."updatedAt")
              from album
              inner join album_user viewer on viewer."albumId" = album.id
              where viewer."userId" = ${userId}
            ),
            (select max(album_audit."deletedAt") from album_audit where album_audit."userId" = ${userId}),
            (
              select max(removed."deletedAt")
              from album_asset_audit removed
              inner join album_user viewer on viewer."albumId" = removed."albumId"
              where viewer."userId" = ${userId}
            )
          ) > (
            select snapshot."computedAt"
            from album_cleanup_snapshot snapshot
            where snapshot."userId" = ${userId} and snapshot.variant = ${variant}
          ),
          false
        )`.as('changed'),
      )
      .executeTakeFirstOrThrow();
    return changed;
  }

  /** Everyone with an album on their Albums page: who the overnight scan is for. */
  @GenerateSql()
  async getUserIdsWithAlbums(): Promise<string[]> {
    const rows = await this.db.selectFrom('album_user').select('userId').distinct().execute();
    return rows.map(({ userId }) => userId);
  }

  /**
   * The database's clock, which stamps every album change. A scan is dated by it, as text so that no microseconds
   * are lost on the way back, and the two compare exactly.
   */
  @GenerateSql()
  async getTime(): Promise<string> {
    const { now } = await this.db
      .selectNoFrom(sql<string>`clock_timestamp()::text`.as('now'))
      .executeTakeFirstOrThrow();
    return now;
  }

  private visible(options: AlbumReadOptions) {
    return this.db
      .selectFrom('asset')
      .$call((qb) => withAlbumVisibility(qb, options.lockedOwnerId))
      .$call((qb) => withHiddenContentFilter(qb, options))
      .where('asset.deletedAt', 'is', null);
  }

  /** Counts and dates per album, as this variant may see them. An estimated date proves nothing, so it is left out. */
  @GenerateSql({ params: [[DummyValue.UUID], {}] })
  getAlbumStats(albumIds: string[], options: AlbumReadOptions) {
    const estimated = sql<boolean>`coalesce(asset_exif."estimatedDateTimeOriginal" = asset_exif."dateTimeOriginal", false)`;
    return this.visible(options)
      .innerJoin('album_asset', 'album_asset.assetId', 'asset.id')
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .where('album_asset.albumId', '=', anyUuid(albumIds))
      .groupBy('album_asset.albumId')
      .select([
        'album_asset.albumId',
        sql<number>`count(*)::int`.as('count'),
        sql<number>`(count(*) filter (where asset_exif.latitude is not null and asset_exif.longitude is not null))::int`.as(
          'located',
        ),
        sql<Date | null>`min(asset."localDateTime") filter (where not ${estimated})`.as('from'),
        sql<Date | null>`max(asset."localDateTime") filter (where not ${estimated})`.as('to'),
        sql<Date | null>`percentile_disc(0.5) within group (order by asset."localDateTime") filter (where not ${estimated})`.as(
          'middle',
        ),
      ])
      .execute();
  }

  /** Photos per album per city, with where in that city they were taken. */
  @GenerateSql({ params: [[DummyValue.UUID], {}] })
  getAlbumLocations(albumIds: string[], options: AlbumReadOptions) {
    return this.visible(options)
      .innerJoin('album_asset', 'album_asset.assetId', 'asset.id')
      .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .where('album_asset.albumId', '=', anyUuid(albumIds))
      .where('asset_exif.city', 'is not', null)
      .where('asset_exif.latitude', 'is not', null)
      .where('asset_exif.longitude', 'is not', null)
      .groupBy(['album_asset.albumId', 'asset_exif.city'])
      .select([
        'album_asset.albumId',
        'asset_exif.city',
        sql<number>`count(*)::int`.as('count'),
        sql<number>`avg(asset_exif.latitude)::float8`.as('lat'),
        sql<number>`avg(asset_exif.longitude)::float8`.as('lon'),
      ])
      .execute();
  }

  /** How many photos each pair of these albums has in common, as this variant may see them. */
  @GenerateSql({ params: [[DummyValue.UUID], {}] })
  getOverlaps(albumIds: string[], options: AlbumReadOptions) {
    return this.visible(options)
      .innerJoin('album_asset as first', 'first.assetId', 'asset.id')
      .innerJoin('album_asset as second', (join) =>
        join.onRef('second.assetId', '=', 'asset.id').onRef('second.albumId', '>', 'first.albumId'),
      )
      .where('first.albumId', '=', anyUuid(albumIds))
      .where('second.albumId', '=', anyUuid(albumIds))
      .groupBy(['first.albumId', 'second.albumId'])
      .select(['first.albumId as firstId', 'second.albumId as secondId', sql<number>`count(*)::int`.as('shared')])
      .execute();
  }

  /** How many photos each named group holds once, as this variant may see them. */
  async getUnionCounts(groups: { key: string; albumIds: string[] }[], options: AlbumReadOptions) {
    if (groups.length === 0) {
      return new Map<string, number>();
    }
    const keys = groups.flatMap(({ key, albumIds }) => albumIds.map(() => key));
    const ids = groups.flatMap(({ albumIds }) => albumIds);
    const visible = this.visible(options).select('asset.id');
    const { rows } = await sql<{ key: string; count: number }>`
      select member.key, count(distinct album_asset."assetId")::int as count
      from unnest(${keys}::text[], ${ids}::uuid[]) as member(key, "albumId")
      join album_asset on album_asset."albumId" = member."albumId"
      join (${visible}) as visible on visible.id = album_asset."assetId"
      group by member.key
    `.execute(this.db);
    return new Map(rows.map(({ key, count }) => [key, count]));
  }

  /** The library's photos on a coarse GPS grid, each cell with its most common city. */
  @GenerateSql({ params: [DummyValue.UUID, {}] })
  getHomeBins(userId: string, options: AlbumReadOptions) {
    // Inlined, so Postgres sees one expression in the select and the group.
    const bin = sql.raw(String(HOME_BIN_DEGREES));
    const lat = sql<number>`round((asset_exif.latitude / ${bin})::numeric) * ${bin}`;
    const lon = sql<number>`round((asset_exif.longitude / ${bin})::numeric) * ${bin}`;
    return this.visible(options)
      .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .where('asset.ownerId', '=', userId)
      .where('asset_exif.latitude', 'is not', null)
      .where('asset_exif.longitude', 'is not', null)
      .groupBy([lat, lon])
      .select([
        sql<number>`(${lat})::float8`.as('lat'),
        sql<number>`(${lon})::float8`.as('lon'),
        sql<number>`count(*)::int`.as('count'),
        sql<string | null>`mode() within group (order by asset_exif.city)`.as('city'),
      ])
      .execute();
  }

  /** Albums holding at least one photo that may have lost its date: only these are worth reading in full. */
  @GenerateSql({ params: [[DummyValue.UUID], {}] })
  async getLostDateCandidates(albumIds: string[], options: AlbumReadOptions): Promise<string[]> {
    const rows = await this.visible(options)
      .innerJoin('album_asset', 'album_asset.assetId', 'asset.id')
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .where('album_asset.albumId', '=', anyUuid(albumIds))
      .where(
        sql<boolean>`(asset."originalFileName" ~* ${SAVED_NAME} or (asset_exif.make is null and asset_exif.model is null
          and asset_exif."timeZone" is null))`,
      )
      .select('album_asset.albumId')
      .distinct()
      .execute();
    return rows.map(({ albumId }) => albumId);
  }

  /** Which of these albums hold a Locked photo at all. Only those can differ between the two variants. */
  @GenerateSql({ params: [[DummyValue.UUID]] })
  async getAlbumsWithLocked(albumIds: string[]): Promise<Set<string>> {
    const rows = await this.db
      .selectFrom('album_asset')
      .innerJoin('asset', 'asset.id', 'album_asset.assetId')
      .where('album_asset.albumId', '=', anyUuid(albumIds))
      .where(isLocked('asset'))
      .select('album_asset.albumId')
      .distinct()
      .execute();
    return new Set(rows.map(({ albumId }) => albumId));
  }

  /** Covers this variant may be shown. */
  @GenerateSql({ params: [[DummyValue.UUID], {}] })
  async getVisibleCovers(albumIds: string[], options: AlbumReadOptions): Promise<Map<string, string>> {
    const rows = await this.visible(options)
      .innerJoin('album', 'album.albumThumbnailAssetId', 'asset.id')
      .where('album.id', '=', anyUuid(albumIds))
      .select(['album.id as albumId', 'asset.id as assetId'])
      .execute();
    return new Map(rows.map(({ albumId, assetId }) => [albumId, assetId]));
  }

  @GenerateSql({ params: [DummyValue.UUID, AlbumCleanupVariant.Ordinary, {}, 0, DummyValue.DATE] })
  async saveSnapshot(
    userId: string,
    variant: AlbumCleanupVariant,
    facts: AlbumCleanupFacts,
    suggestionCount: number,
    computedAt: Date | string,
  ): Promise<void> {
    await this.db
      .insertInto('album_cleanup_snapshot')
      .values({ userId, variant, facts: jsonb(facts), suggestionCount, computedAt })
      .onConflict((oc) =>
        oc.columns(['userId', 'variant']).doUpdateSet((eb) => ({
          facts: eb.ref('excluded.facts'),
          suggestionCount: eb.ref('excluded.suggestionCount'),
          computedAt: eb.ref('excluded.computedAt'),
        })),
      )
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, AlbumCleanupVariant.Ordinary] })
  getSnapshot(userId: string, variant: AlbumCleanupVariant) {
    return this.db
      .selectFrom('album_cleanup_snapshot')
      .select(['facts', 'suggestionCount', 'computedAt'])
      .where('userId', '=', userId)
      .where('variant', '=', variant)
      .$castTo<{ facts: AlbumCleanupFacts; suggestionCount: number; computedAt: Date }>()
      .executeTakeFirst();
  }

  /** The cheap read behind the banner and Library Care: no facts. */
  @GenerateSql({ params: [DummyValue.UUID, AlbumCleanupVariant.Ordinary] })
  getSnapshotSummary(userId: string, variant: AlbumCleanupVariant) {
    return this.db
      .selectFrom('album_cleanup_snapshot')
      .select(['suggestionCount', 'computedAt'])
      .where('userId', '=', userId)
      .where('variant', '=', variant)
      .$castTo<{ suggestionCount: number; computedAt: Date }>()
      .executeTakeFirst();
  }

  async createApply(
    db: Kysely<DB>,
    apply: { runId: string; operations: AlbumCleanupOperation[]; elevated: boolean },
  ): Promise<void> {
    await db
      .insertInto('album_cleanup_apply')
      .values({ runId: apply.runId, operations: jsonb(apply.operations), elevated: apply.elevated })
      .execute();
  }

  /** Whether a cleanup is still being applied, held until the caller's transaction ends. */
  async isApplying(db: Kysely<DB>, userId: string): Promise<boolean> {
    const row = await db
      .selectFrom('album_change_run')
      .select('id')
      .where('userId', '=', userId)
      .where('kind', '=', AlbumChangeRunKind.Cleanup)
      .where('status', '=', AlbumChangeRunStatus.Running)
      .forUpdate()
      .executeTakeFirst();
    return !!row;
  }

  /** Whether a run is still going, held until the caller's transaction ends, as recording a change holds it. */
  async holdIfRunning(db: Kysely<DB>, runId: string): Promise<boolean> {
    const row = await db
      .selectFrom('album_change_run')
      .select('id')
      .where('id', '=', runId)
      .where('status', '=', AlbumChangeRunStatus.Running)
      .forNoKeyUpdate()
      .executeTakeFirst();
    return !!row;
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getApply(runId: string, db: Kysely<DB> = this.db): Promise<CleanupApplyRow | undefined> {
    return db
      .selectFrom('album_cleanup_apply')
      .innerJoin('album_change_run', 'album_change_run.id', 'album_cleanup_apply.runId')
      .select([
        'album_cleanup_apply.runId',
        'album_change_run.userId',
        'album_change_run.status',
        'album_cleanup_apply.operations',
        'album_cleanup_apply.nextIndex',
        'album_cleanup_apply.targets',
        'album_cleanup_apply.tally',
        'album_cleanup_apply.elevated',
        'album_cleanup_apply.progressAt',
      ])
      .where('album_cleanup_apply.runId', '=', runId)
      .$castTo<CleanupApplyRow>()
      .executeTakeFirst();
  }

  /** Records how far the job has got, in the transaction that made the change. */
  async advanceApply(
    db: Kysely<DB>,
    runId: string,
    progress: { nextIndex: number; targets: Record<string, string>; tally: Record<string, number> },
  ): Promise<void> {
    await db
      .updateTable('album_cleanup_apply')
      .set({
        nextIndex: progress.nextIndex,
        targets: jsonb(progress.targets),
        tally: jsonb(progress.tally),
        progressAt: new Date(),
      })
      .where('runId', '=', runId)
      .execute();
  }

  /** The person's newest cleanup they have not undone, with how far it has got. */
  @GenerateSql({ params: [DummyValue.UUID] })
  getLatestApply(userId: string) {
    return this.db
      .selectFrom('album_cleanup_apply')
      .innerJoin('album_change_run', 'album_change_run.id', 'album_cleanup_apply.runId')
      .where('album_change_run.userId', '=', userId)
      .where('album_change_run.status', '!=', AlbumChangeRunStatus.Undone)
      .orderBy('album_change_run.createdAt', 'desc')
      .limit(1)
      .select([
        'album_cleanup_apply.runId',
        'album_change_run.status',
        'album_cleanup_apply.nextIndex',
        sql<number>`jsonb_array_length(album_cleanup_apply.operations)::int`.as('total'),
        'album_cleanup_apply.progressAt',
      ])
      .$castTo<{
        runId: string;
        status: AlbumChangeRunStatus;
        nextIndex: number;
        total: number;
        progressAt: Date;
      }>()
      .executeTakeFirst();
  }
}
