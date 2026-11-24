import { Injectable } from '@nestjs/common';
import { type Insertable, Kysely, type Updateable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type {
  LocationFillProposalTable,
  LocationFillRunTable,
  LocationFillStatus,
} from 'src/schema/tables/location-fill.table.js';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import type { FillPoint } from 'src/utils/location-fill.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { DB } from 'src/schema/index.js';
import { withHiddenContentFilter } from 'src/utils/database.js';
import { isDefaultVisible } from 'src/utils/locked.js';

const RUN_COLUMNS = [
  'id',
  'ownerId',
  'createdAt',
  'status',
  'maxGapMinutes',
  'takenAfter',
  'takenBefore',
  'candidateCount',
  'proposalCount',
  'appliedCount',
  'appliedAt',
  'undoneAt',
  'error',
] as const;

const POINT_COLUMNS = ['recordedAt', 'latitude', 'longitude'] as const;

/** A photo without a location, as a run reads it. */
export type FillCandidate = {
  id: string;
  /** The moment it was taken, right only when `timeZone` is known. */
  takenAt: Date;
  /** The clock time where it was taken, in UTC fields. */
  localDateTime: Date;
  timeZone: string | null;
};

/**
 * FL-964: runs that propose locations for photos from their owner's location history. Every read names the owner or
 * a run already checked to be theirs. History places are read here and nowhere else outside the import.
 */
@Injectable()
export class LocationFillRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [DummyValue.UUID] })
  async hasHistory(ownerId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('location_point')
      .select('sourceId')
      .where('ownerId', '=', ownerId)
      .limit(1)
      .executeTakeFirst();
    return !!row;
  }

  createRun(run: Insertable<LocationFillRunTable>) {
    return this.db.insertInto('location_fill_run').values(run).returning(RUN_COLUMNS).executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  getRun(ownerId: string, id: string) {
    return this.db
      .selectFrom('location_fill_run')
      .select(RUN_COLUMNS)
      .where('ownerId', '=', ownerId)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  /** For the run's own jobs, which are handed the id by its owner's request. */
  @GenerateSql({ params: [DummyValue.UUID] })
  getRunForJob(id: string) {
    return this.db.selectFrom('location_fill_run').select(RUN_COLUMNS).where('id', '=', id).executeTakeFirst();
  }

  /** The owner's runs, newest first. */
  @GenerateSql({ params: [DummyValue.UUID] })
  getRuns(ownerId: string) {
    return this.db
      .selectFrom('location_fill_run')
      .select(RUN_COLUMNS)
      .where('ownerId', '=', ownerId)
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .limit(20)
      .execute();
  }

  /** A run of the owner's that is still working. */
  @GenerateSql({ params: [DummyValue.UUID] })
  async hasWorkingRun(ownerId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('location_fill_run')
      .select('id')
      .where('ownerId', '=', ownerId)
      .where('status', 'in', ['proposing', 'applying', 'undoing'])
      .limit(1)
      .executeTakeFirst();
    return !!row;
  }

  /** Runs that changed nothing and never will: a new run replaces them. */
  @GenerateSql({ params: [DummyValue.UUID] })
  async deleteIdleRuns(ownerId: string) {
    await this.db
      .deleteFrom('location_fill_run')
      .where('ownerId', '=', ownerId)
      .where('status', 'in', ['ready', 'failed', 'undone'])
      .where('appliedCount', '=', 0)
      .execute();
  }

  async updateRun(id: string, changes: Updateable<LocationFillRunTable>) {
    return this.db
      .updateTable('location_fill_run')
      .set(changes)
      .where('id', '=', id)
      .returning(RUN_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /** Move a run from one of `from` to `status`; undefined when it was somewhere else (two requests at once). */
  async moveRun(ownerId: string, id: string, from: LocationFillStatus[], status: LocationFillStatus) {
    return this.db
      .updateTable('location_fill_run')
      .set({ status, error: null })
      .where('ownerId', '=', ownerId)
      .where('id', '=', id)
      .where('status', 'in', from)
      .returning(RUN_COLUMNS)
      .executeTakeFirst();
  }

  /**
   * The owner's photos a run may place, a page at a time by id: their own, not in Trash, on the timeline or in the
   * archive and not Locked (`isDefaultVisible`), with no location at all. A partner's copy that still follows its
   * source is left out: its location is the source's.
   */
  getCandidates(
    ownerId: string,
    range: { takenAfter: Date | null; takenBefore: Date | null },
    afterId: string | null,
    limit: number,
  ): Promise<FillCandidate[]> {
    return this.db
      .selectFrom('asset')
      .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select(['asset.id', 'asset.fileCreatedAt as takenAt', 'asset.localDateTime', 'asset_exif.timeZone'])
      .where('asset.ownerId', '=', ownerId)
      .where('asset.deletedAt', 'is', null)
      .where(isDefaultVisible('asset'))
      .where('asset_exif.latitude', 'is', null)
      .where('asset_exif.longitude', 'is', null)
      .where(
        sql<boolean>`not exists (select 1 from public.asset_origin o where o."assetId" = asset.id and o.following
          and o."sourceAssetId" is not null)`,
      )
      .$if(!!range.takenAfter, (qb) => qb.where('asset.localDateTime', '>=', range.takenAfter!))
      .$if(!!range.takenBefore, (qb) => qb.where('asset.localDateTime', '<=', range.takenBefore!))
      .$if(!!afterId, (qb) => qb.where('asset.id', '>', afterId!))
      .orderBy('asset.id')
      .limit(limit)
      .execute();
  }

  /** The owner's last history place at or before a moment and first at or after it, each within `gapSeconds`. */
  async getAround(
    ownerId: string,
    at: Date,
    gapSeconds: number,
  ): Promise<{ before: FillPoint | null; after: FillPoint | null }> {
    const from = new Date(at.getTime() - gapSeconds * 1000);
    const to = new Date(at.getTime() + gapSeconds * 1000);
    const points = this.db.selectFrom('location_point').select(POINT_COLUMNS).where('ownerId', '=', ownerId);
    const [before, after] = await Promise.all([
      points
        .where('recordedAt', '<=', at)
        .where('recordedAt', '>=', from)
        .orderBy('recordedAt', 'desc')
        .limit(1)
        .executeTakeFirst(),
      points
        .where('recordedAt', '>=', at)
        .where('recordedAt', '<=', to)
        .orderBy('recordedAt', 'asc')
        .limit(1)
        .executeTakeFirst(),
    ]);
    return { before: before ?? null, after: after ?? null };
  }

  /**
   * `getAround` for many moments in one query: for each `{ id, at }`, the owner's last history place at or before
   * `at` and first at or after it, each within `gapSeconds`. Every id is in the result.
   */
  async getAroundMany(
    ownerId: string,
    moments: Array<{ id: string; at: Date }>,
    gapSeconds: number,
  ): Promise<Map<string, { before: FillPoint | null; after: FillPoint | null }>> {
    const result = new Map<string, { before: FillPoint | null; after: FillPoint | null }>();
    if (moments.length === 0) {
      return result;
    }
    const { rows } = await sql<{
      id: string;
      beforeAt: Date | null;
      beforeLatitude: number | null;
      beforeLongitude: number | null;
      afterAt: Date | null;
      afterLatitude: number | null;
      afterLongitude: number | null;
    }>`
      select
        moment.id,
        before_point."recordedAt" as "beforeAt",
        before_point.latitude as "beforeLatitude",
        before_point.longitude as "beforeLongitude",
        after_point."recordedAt" as "afterAt",
        after_point.latitude as "afterLatitude",
        after_point.longitude as "afterLongitude"
      from unnest(
        ${moments.map(({ id }) => id)}::uuid[],
        ${moments.map(({ at }) => at.toISOString())}::timestamptz[]
      ) as moment(id, at)
      left join lateral (
        select "recordedAt", latitude, longitude
        from location_point
        where "ownerId" = ${ownerId}::uuid
          and "recordedAt" <= moment.at
          and "recordedAt" >= moment.at - make_interval(secs => ${gapSeconds}::double precision)
        order by "recordedAt" desc
        limit 1
      ) as before_point on true
      left join lateral (
        select "recordedAt", latitude, longitude
        from location_point
        where "ownerId" = ${ownerId}::uuid
          and "recordedAt" >= moment.at
          and "recordedAt" <= moment.at + make_interval(secs => ${gapSeconds}::double precision)
        order by "recordedAt" asc
        limit 1
      ) as after_point on true
    `.execute(this.db);
    for (const row of rows) {
      result.set(row.id, {
        before:
          row.beforeAt === null
            ? null
            : { recordedAt: row.beforeAt, latitude: row.beforeLatitude!, longitude: row.beforeLongitude! },
        after:
          row.afterAt === null
            ? null
            : { recordedAt: row.afterAt, latitude: row.afterLatitude!, longitude: row.afterLongitude! },
      });
    }
    return result;
  }

  /** One history place an hour between two moments: enough to say which time zones the owner was in. */
  async getHourlySample(ownerId: string, from: Date, to: Date): Promise<FillPoint[]> {
    const { rows } = await sql<FillPoint>`
      select distinct on (date_trunc('hour', "recordedAt")) "recordedAt", "latitude", "longitude"
      from "location_point"
      where "ownerId" = ${ownerId}::uuid and "recordedAt" >= ${from} and "recordedAt" <= ${to}
      order by date_trunc('hour', "recordedAt"), "recordedAt"
    `.execute(this.db);
    return rows;
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async deleteProposals(runId: string) {
    await this.db.deleteFrom('location_fill_proposal').where('runId', '=', runId).execute();
  }

  async insertProposals(proposals: Insertable<LocationFillProposalTable>[]) {
    if (proposals.length > 0) {
      await this.db
        .insertInto('location_fill_proposal')
        .values(proposals)
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
  }

  /**
   * A run's proposals the session may see: their photo is not in the Trash, not Locked (`isDefaultVisible`) and
   * not hidden from the session by the owner's Locked rules or sensitive-content setting (`options`, from
   * `getHiddenContentQueryOptions`). A photo locked or hidden since the run looked is no longer listed, with its
   * place and time.
   */
  private visibleProposals(runId: string, options: HiddenContentQueryOptions) {
    return this.db
      .selectFrom('location_fill_proposal as proposal')
      .innerJoin('asset', 'asset.id', 'proposal.assetId')
      .where('proposal.runId', '=', runId)
      .where('asset.deletedAt', 'is', null)
      .where(isDefaultVisible('asset'))
      .$call((qb) => withHiddenContentFilter(qb, options));
  }

  /** A run's proposals in the order the photos were taken, with one more than `size` when there is a next page. */
  getProposals(runId: string, offset: number, size: number, options: HiddenContentQueryOptions = {}) {
    return this.visibleProposals(runId, options)
      .select([
        'proposal.assetId',
        'proposal.latitude',
        'proposal.longitude',
        'proposal.method',
        'proposal.gapSeconds',
        'proposal.appliedAt',
        'proposal.undoneAt',
        'asset.localDateTime',
      ])
      .orderBy('asset.localDateTime')
      .orderBy('proposal.assetId')
      .offset(offset)
      .limit(size + 1)
      .execute();
  }

  /** How many proposals `getProposals` lists across all its pages. */
  async countProposals(runId: string, options: HiddenContentQueryOptions = {}): Promise<number> {
    const { count } = await this.visibleProposals(runId, options)
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();
    return Number(count);
  }

  /**
   * Mark proposals to apply: all that are not on their photo now, or those of `assetIds`, and only ones the
   * session may see (`getProposals`), so "apply all" never reaches a photo the list did not show. Returns how many.
   */
  async requestApply(runId: string, assetIds?: string[], options: HiddenContentQueryOptions = {}): Promise<number> {
    const result = await this.db
      .updateTable('location_fill_proposal')
      .set({ requestedAt: new Date(), undoneAt: null })
      .where('runId', '=', runId)
      .where((eb) => eb.or([eb('appliedAt', 'is', null), eb('undoneAt', 'is not', null)]))
      .$if(!!assetIds, (qb) => qb.where('assetId', 'in', assetIds!))
      .where('assetId', 'in', this.visibleProposals(runId, options).select('proposal.assetId'))
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  /** Proposals asked for and not on their photo yet, a page at a time by photo id. */
  getToApply(runId: string, afterAssetId: string | null, limit: number) {
    return this.db
      .selectFrom('location_fill_proposal')
      .select(['assetId', 'latitude', 'longitude'])
      .where('runId', '=', runId)
      .where('requestedAt', 'is not', null)
      .where('appliedAt', 'is', null)
      .$if(!!afterAssetId, (qb) => qb.where('assetId', '>', afterAssetId!))
      .orderBy('assetId')
      .limit(limit)
      .execute();
  }

  /** Proposals that are on their photo, a page at a time by photo id. */
  getApplied(runId: string, afterAssetId: string | null, limit: number) {
    return this.db
      .selectFrom('location_fill_proposal')
      .select(['assetId', 'latitude', 'longitude'])
      .where('runId', '=', runId)
      .where('appliedAt', 'is not', null)
      .where('undoneAt', 'is', null)
      .$if(!!afterAssetId, (qb) => qb.where('assetId', '>', afterAssetId!))
      .orderBy('assetId')
      .limit(limit)
      .execute();
  }

  async markProposal(runId: string, assetId: string, changes: Updateable<LocationFillProposalTable>) {
    await this.db
      .updateTable('location_fill_proposal')
      .set(changes)
      .where('runId', '=', runId)
      .where('assetId', '=', assetId)
      .execute();
  }

  /** How many photos hold a location from this run now. */
  @GenerateSql({ params: [DummyValue.UUID] })
  async countApplied(runId: string): Promise<number> {
    const { count } = await this.db
      .selectFrom('location_fill_proposal')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('runId', '=', runId)
      .where('appliedAt', 'is not', null)
      .where('undoneAt', 'is', null)
      .executeTakeFirstOrThrow();
    return Number(count);
  }

  /** Where these of the owner's photos are now; a photo that is gone, or someone else's, is not returned. */
  async getLocations(ownerId: string, assetIds: string[]) {
    if (assetIds.length === 0) {
      return new Map<string, { latitude: number | null; longitude: number | null }>();
    }
    const rows = await this.db
      .selectFrom('asset')
      .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select(['asset.id', 'asset_exif.latitude', 'asset_exif.longitude'])
      .where('asset.ownerId', '=', ownerId)
      .where('asset.deletedAt', 'is', null)
      .where('asset.id', 'in', assetIds)
      .execute();
    return new Map(rows.map(({ id, latitude, longitude }) => [id, { latitude, longitude }]));
  }
}
