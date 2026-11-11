import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { DateFinding, DateScanRow } from 'src/utils/date-doctor.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { publicationDatabase } from 'src/queue/transaction.js';
import { DB } from 'src/schema/index.js';
import { hasDateToCheck } from 'src/utils/date-sanity.js';
import { isDefaultVisible, isNotLocked } from 'src/utils/locked.js';

export type DateFindingRow = DateFinding & { createdAt: Date };

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
        // a photo locked since the scan stays out until the next one drops it
        .where(isNotLocked('asset'))
        .orderBy(sql`split_part(asset_date_finding."groupKey", '|', 2)`, 'desc')
        .orderBy('asset_date_finding.groupKey')
        .orderBy('asset_date_finding.currentDate')
        .orderBy('asset_date_finding.assetId')
        .execute() as Promise<DateFindingRow[]>
    );
  }
}
