import { Injectable } from '@nestjs/common';
import { Kysely, type Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { DateLock } from 'src/schema/tables/date-fix.table.js';
import type { DateFinding, DateFindingCause, DateScanRow } from 'src/utils/date-doctor.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { publicationDatabase } from 'src/queue/transaction.js';
import { DB } from 'src/schema/index.js';
import { hasDateToCheck } from 'src/utils/date-sanity.js';
import { isDefaultVisible } from 'src/utils/locked.js';

export type DateFindingRow = DateFinding & { createdAt: Date };

/** FL-930: a photo's date as a fix reads it, with what it had before an earlier fix that is still in place. */
export type DateFixCurrent = {
  assetId: string;
  takenAt: Date;
  localDateTime: Date;
  dateTimeOriginal: Date | null;
  timeZone: string | null;
  /** Which of the date and zone are locked now. */
  locks: DateLock[];
  earlier: Omit<
    DateFixWrite,
    'assetId' | 'currentTakenAt' | 'currentLocalDateTime' | 'currentZone' | 'newDate' | 'newZone' | 'newLocalDateTime'
  > | null;
};

/** FL-930: one photo of an Apply. `current*` must still hold when it is written, or the photo is left alone. */
export type DateFixWrite = {
  assetId: string;
  currentTakenAt: Date;
  currentLocalDateTime: Date;
  currentZone: string | null;
  previousDate: Date | null;
  previousZone: string | null;
  previousTakenAt: Date;
  previousLocalDateTime: Date;
  previousLocks: DateLock[];
  newDate: Date;
  newZone: string | null;
  newLocalDateTime: Date;
};

/** FL-930: an open proposal, with the date and zone the photo had when the scan made it. */
export type DateProposal = {
  assetId: string;
  cause: DateFindingCause;
  proposedDate: Date;
  proposedZone: string | null;
  currentDate: Date;
  currentZone: string | null;
};

/** FL-930: what an Apply was asked to do, kept with its batch. */
export type DateFixAsked = { cause: DateFindingCause | null; shiftMinutes: number | null; timeZone: string | null };

/** FL-930: work that commits with the date change: partner copies, sidecars. */
export type DateFixEffects = (tx: Transaction<DB>, assetIds: string[]) => Promise<void>;

const asJson = (rows: unknown[]) => JSON.stringify(rows);

/** FL-912: the Date & Time Doctor's reads and its findings. */
@Injectable()
export class DateDoctorRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {
    // a scan's findings commit with the job that found them, never from an attempt the queue gave up on
    this.db = publicationDatabase(this.db);
  }

  /** Everyone who owns a photo, for the weekly scan. */
  @GenerateSql()
  async getOwnerIds(): Promise<string[]> {
    const rows = await this.db.selectFrom('user').select('id').where('deletedAt', 'is', null).execute();
    return rows.map(({ id }) => id);
  }

  /**
   * One owner's photos as the Doctor reads them, and as the timeline counts them: with an EXIF row, their own, not in
   * Trash, on the timeline or in the archive and not locked (`isDefaultVisible`; the hidden halves of Live Photos are
   * left out too). A partner's copy that still follows its source's date is left out: its date is the source's.
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  getScanRows(ownerId: string): Promise<DateScanRow[]> {
    return this.db
      .selectFrom('asset')
      .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select([
        'asset.id',
        'asset.originalFileName',
        'asset.fileCreatedAt as takenAt',
        'asset.localDateTime',
        'asset_exif.timeZone',
        'asset_exif.latitude',
        'asset_exif.longitude',
        'asset_exif.make',
        'asset_exif.model',
        'asset_exif.offsetTimeOriginal',
        'asset_exif.offsetTime',
        sql<boolean>`coalesce('dateTimeOriginal' = any(asset_exif."lockedProperties"), false)`.as('dateLocked'),
        sql<boolean>`coalesce('timeZone' = any(asset_exif."lockedProperties"), false)`.as('zoneLocked'),
        hasDateToCheck('asset').as('toCheck'),
      ])
      .where('asset.ownerId', '=', ownerId)
      .where('asset.deletedAt', 'is', null)
      .where(isDefaultVisible('asset'))
      .where(
        sql<boolean>`not exists (select 1 from public.asset_origin o where o."assetId" = asset.id and o.following
          and o."sourceAssetId" is not null and not ('dateTimeOriginal' = any(o."overriddenFields")))`,
      )
      .execute() as Promise<DateScanRow[]>;
  }

  /**
   * A scan's result replaces the owner's open findings. A dismissed finding stays, and the same cause is not raised
   * again for that photo.
   */
  async replaceFindings(ownerId: string, findings: DateFinding[]): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      await tx
        .deleteFrom('asset_date_finding')
        .where('dismissedAt', 'is', null)
        .where('assetId', 'in', (eb) => eb.selectFrom('asset').select('id').where('ownerId', '=', ownerId))
        .execute();
      // ponytail: one statement per 1,000 rows keeps the bind count far below Postgres's 65,535
      for (let i = 0; i < findings.length; i += 1000) {
        await tx
          .insertInto('asset_date_finding')
          .values(findings.slice(i, i + 1000))
          .onConflict((oc) => oc.columns(['assetId', 'cause']).doNothing())
          .execute();
      }
    });
  }

  /** The owner's open findings, a shoot (camera and day) together, newest day first. */
  @GenerateSql({ params: [DummyValue.UUID] })
  getFindings(ownerId: string): Promise<DateFindingRow[]> {
    return (
      this.db
        .selectFrom('asset_date_finding')
        .innerJoin('asset', 'asset.id', 'asset_date_finding.assetId')
        .selectAll('asset_date_finding')
        .where('asset.ownerId', '=', ownerId)
        .where('asset.deletedAt', 'is', null)
        .where('asset_date_finding.dismissedAt', 'is', null)
        // a photo locked or hidden since the scan stays out until the next one drops it
        .where(isDefaultVisible('asset'))
        // FL-930: a photo still carrying a fix is out; undoing the fix brings its findings back
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('date_fix_item')
                .innerJoin('date_fix_batch', 'date_fix_batch.id', 'date_fix_item.batchId')
                .innerJoin('asset_exif', 'asset_exif.assetId', 'date_fix_item.assetId')
                .select('date_fix_item.assetId')
                .whereRef('date_fix_item.assetId', '=', 'asset.id')
                .where('date_fix_batch.undoneAt', 'is', null)
                .whereRef('date_fix_item.newDate', '=', 'asset.fileCreatedAt')
                .whereRef('date_fix_item.newLocalDateTime', '=', 'asset.localDateTime')
                .where(sql<boolean>`date_fix_item."newZone" is not distinct from asset_exif."timeZone"`),
            ),
          ),
        )
        .orderBy(sql`right(asset_date_finding."groupKey", 10)`, 'desc')
        .orderBy('asset_date_finding.groupKey')
        .orderBy('asset_date_finding.currentDate')
        .orderBy('asset_date_finding.assetId')
        .execute() as Promise<DateFindingRow[]>
    );
  }

  /** FL-930: each of the owner's photos among `ids` with an open proposal that has a date: its surest one. */
  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  getProposals(ownerId: string, ids: string[]) {
    return this.db
      .selectFrom('asset_date_finding')
      .innerJoin('asset', 'asset.id', 'asset_date_finding.assetId')
      .distinctOn('asset_date_finding.assetId')
      .select([
        'asset_date_finding.assetId',
        'asset_date_finding.cause',
        'asset_date_finding.proposedDate',
        'asset_date_finding.proposedZone',
        'asset_date_finding.currentDate',
        'asset_date_finding.currentZone',
      ])
      .where(sql<boolean>`asset_date_finding."assetId" = any(${ids}::uuid[])`)
      .where('asset.ownerId', '=', ownerId)
      .where('asset_date_finding.dismissedAt', 'is', null)
      .where('asset_date_finding.proposedDate', 'is not', null)
      .orderBy('asset_date_finding.assetId')
      .orderBy('asset_date_finding.confidence', 'desc')
      .orderBy('asset_date_finding.cause')
      .execute() as Promise<DateProposal[]>;
  }

  /**
   * FL-930: the owner's photos among `ids` (not in Trash, with an EXIF row) as a fix reads them. `earlier` is the
   * newest batch not undone whose fix the photo still has: a second fix keeps what the photo had before the first.
   */
  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  async getCurrent(ownerId: string, ids: string[]): Promise<DateFixCurrent[]> {
    const rows = await this.db
      .selectFrom('asset')
      .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .leftJoinLateral(
        (eb) =>
          eb
            .selectFrom('date_fix_item')
            .innerJoin('date_fix_batch', 'date_fix_batch.id', 'date_fix_item.batchId')
            .select([
              'date_fix_item.previousDate',
              'date_fix_item.previousZone',
              'date_fix_item.previousTakenAt',
              'date_fix_item.previousLocalDateTime',
              'date_fix_item.previousLocks',
            ])
            .whereRef('date_fix_item.assetId', '=', 'asset.id')
            .whereRef('date_fix_batch.userId', '=', 'asset.ownerId')
            .where('date_fix_batch.undoneAt', 'is', null)
            .whereRef('date_fix_item.newDate', '=', 'asset.fileCreatedAt')
            .whereRef('date_fix_item.newLocalDateTime', '=', 'asset.localDateTime')
            .where(sql<boolean>`date_fix_item."newZone" is not distinct from asset_exif."timeZone"`)
            .orderBy('date_fix_batch.createdAt', 'desc')
            .limit(1)
            .as('earlier'),
        (join) => join.onTrue(),
      )
      .select([
        'asset.id as assetId',
        'asset.fileCreatedAt as takenAt',
        'asset.localDateTime',
        'asset_exif.dateTimeOriginal',
        'asset_exif.timeZone',
        sql<DateLock[]>`array(select property from unnest(coalesce(asset_exif."lockedProperties", '{}')) property
          where property in ('dateTimeOriginal', 'timeZone') order by property)`.as('locks'),
        'earlier.previousDate',
        'earlier.previousZone',
        'earlier.previousTakenAt',
        'earlier.previousLocalDateTime',
        'earlier.previousLocks',
      ])
      .where(sql<boolean>`asset.id = any(${ids}::uuid[])`)
      .where('asset.ownerId', '=', ownerId)
      .where('asset.deletedAt', 'is', null)
      .execute();
    return rows.map(
      ({ previousDate, previousZone, previousTakenAt, previousLocalDateTime, previousLocks, ...row }) => ({
        ...(row as Omit<DateFixCurrent, 'earlier'>),
        earlier:
          previousTakenAt && previousLocalDateTime
            ? {
                previousDate: previousDate as Date | null,
                previousZone,
                previousTakenAt: previousTakenAt as Date,
                previousLocalDateTime: previousLocalDateTime as Date,
                previousLocks: (previousLocks ?? []) as DateLock[],
              }
            : null,
      }),
    );
  }

  /**
   * FL-930: writes the new dates and zones, locked, and records them as one batch with what was asked. A photo whose
   * date moved since it was read is left out. Returns the batch and the photos written, or nothing when none was.
   */
  async applyFixes(ownerId: string, items: DateFixWrite[], asked: DateFixAsked, effects: DateFixEffects) {
    return this.db.transaction().execute(async (tx) => {
      const { rows } = await sql<{
        id: string;
      }>`update asset set "fileCreatedAt" = v."newDate", "localDateTime" = v."newLocalDateTime"
        from jsonb_to_recordset(${asJson(items)}::text::jsonb) as v("assetId" uuid, "currentTakenAt" timestamptz,
          "currentLocalDateTime" timestamptz, "currentZone" text, "newDate" timestamptz, "newLocalDateTime" timestamptz)
        where asset.id = v."assetId" and asset."ownerId" = ${ownerId}::uuid and asset."deletedAt" is null
          and asset."fileCreatedAt" = v."currentTakenAt" and asset."localDateTime" = v."currentLocalDateTime"
          and exists (select 1 from asset_exif exif where exif."assetId" = asset.id
            and exif."timeZone" is not distinct from v."currentZone")
        returning asset.id`.execute(tx);
      if (rows.length === 0) {
        return;
      }
      const written = new Set(rows.map(({ id }) => id));
      const kept = items.filter(({ assetId }) => written.has(assetId));
      await sql`update asset_exif set "dateTimeOriginal" = v."newDate", "timeZone" = v."newZone",
          "lockedProperties" = nullif(array(select distinct unnest(asset_exif."lockedProperties"
            || array['dateTimeOriginal', 'timeZone']::varchar[])), '{}')
        from jsonb_to_recordset(${asJson(kept)}::text::jsonb) as v("assetId" uuid, "newDate" timestamptz, "newZone" text)
        where asset_exif."assetId" = v."assetId"`.execute(tx);
      const batch = await tx
        .insertInto('date_fix_batch')
        .values({ userId: ownerId, count: kept.length, ...asked })
        .returningAll()
        .executeTakeFirstOrThrow();
      // ponytail: 1,000 rows (10,000 binds) a statement keeps far below Postgres's 65,535
      for (let i = 0; i < kept.length; i += 1000) {
        await tx
          .insertInto('date_fix_item')
          .values(
            kept.slice(i, i + 1000).map((item) => ({
              batchId: batch.id,
              assetId: item.assetId,
              previousDate: item.previousDate,
              previousZone: item.previousZone,
              previousTakenAt: item.previousTakenAt,
              previousLocalDateTime: item.previousLocalDateTime,
              previousLocks: item.previousLocks,
              newDate: item.newDate,
              newZone: item.newZone,
              newLocalDateTime: item.newLocalDateTime,
            })),
          )
          .execute();
      }
      await effects(tx, [...written]);
      return { batch, assetIds: [...written] };
    });
  }

  /**
   * FL-930: puts back what the batch's photos had before, where the batch's date is still theirs (a later edit
   * wins), and marks it undone. The date stays locked until the sidecar has been rewritten (`releaseDateLock`).
   * Nothing when the owner has no such batch since `since`.
   */
  async undoBatch(
    ownerId: string,
    batchId: string,
    since: Date,
    effects: (tx: Transaction<DB>, restored: { assetId: string; previousLocks: DateLock[] }[]) => Promise<void>,
  ) {
    return this.db.transaction().execute(async (tx) => {
      const batch = await tx
        .selectFrom('date_fix_batch')
        .selectAll()
        .where('id', '=', batchId)
        .where('userId', '=', ownerId)
        .where('createdAt', '>=', since)
        .forUpdate()
        .executeTakeFirst();
      if (!batch) {
        return;
      }
      if (batch.undoneAt) {
        return { batch, restored: [], alreadyUndone: true };
      }
      const { rows: restored } = await sql<{ assetId: string; previousLocks: DateLock[] }>`update asset
        set "fileCreatedAt" = item."previousTakenAt", "localDateTime" = item."previousLocalDateTime"
        from date_fix_item item join asset_exif exif on exif."assetId" = item."assetId"
        where item."batchId" = ${batchId}::uuid and asset.id = item."assetId" and asset."ownerId" = ${ownerId}::uuid
          and asset."fileCreatedAt" = item."newDate" and asset."localDateTime" = item."newLocalDateTime"
          and exif."timeZone" is not distinct from item."newZone"
        returning asset.id as "assetId", item."previousLocks"`.execute(tx);
      await sql`update asset_exif set "dateTimeOriginal" = item."previousDate", "timeZone" = item."previousZone"
        from date_fix_item item
        where item."batchId" = ${batchId}::uuid and asset_exif."assetId" = item."assetId"
          and item."assetId" = any(${restored.map(({ assetId }) => assetId)}::uuid[])`.execute(tx);
      const undone = await tx
        .updateTable('date_fix_batch')
        .set({ undoneAt: new Date() })
        .where('id', '=', batchId)
        .returningAll()
        .executeTakeFirstOrThrow();
      await effects(tx, restored);
      return { batch: undone, restored, alreadyUndone: false };
    });
  }

  /** FL-930: the owner's batches since `since`, newest first. */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.DATE] })
  getBatches(ownerId: string, since: Date) {
    return this.db
      .selectFrom('date_fix_batch')
      .selectAll()
      .where('userId', '=', ownerId)
      .where('createdAt', '>=', since)
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .execute();
  }

  /** FL-930: batches older than `before` can no longer be undone; removes them and their items. */
  async pruneBatches(before: Date): Promise<number> {
    // ponytail: one batch (at most MAX_DATE_FIXES items, through the cascade) a statement keeps each delete small
    let removed = 0;
    for (;;) {
      const result = await this.db
        .deleteFrom('date_fix_batch')
        .where('id', '=', (eb) =>
          eb.selectFrom('date_fix_batch').select('id').where('createdAt', '<', before).orderBy('createdAt').limit(1),
        )
        .executeTakeFirst();
      if (Number(result.numDeletedRows) === 0) {
        return removed;
      }
      removed++;
    }
  }

  /** FL-930: the photos a batch of the owner's holds, for the undo's access check. */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  async getBatchAssetIds(ownerId: string, batchId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('date_fix_item')
      .innerJoin('date_fix_batch', 'date_fix_batch.id', 'date_fix_item.batchId')
      .select('date_fix_item.assetId')
      .where('date_fix_batch.id', '=', batchId)
      .where('date_fix_batch.userId', '=', ownerId)
      .execute();
    return rows.map(({ assetId }) => assetId);
  }
}
