import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AssetStatus, AssetVisibility } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DerivativePrivacyRepository } from 'src/repositories/derivative-privacy.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { asUuid } from 'src/utils/database.js';
import { ScanPoint } from 'src/utils/scan-split.js';

/** One rendered print, ready to become a photo. */
export type ScanCropPublication = {
  asset: Insertable<AssetTable> & { id: string };
  sizeInBytes: number;
  width: number;
  height: number;
  quad: ScanPoint[];
  rotation: number;
};

/** The new photos would not fit in the owner's storage quota; nothing was added. */
export class ScanSplitQuotaError extends Error {}
/** The scan was deleted, or moved to the trash, while its prints were being cut out; nothing was added. */
export class ScanSplitGoneError extends Error {}

@Injectable()
export class ScanSplitRepository {
  constructor(
    @InjectKysely() private db: Kysely<DB>,
    private assets: AssetRepository,
    private privacy: DerivativePrivacyRepository,
  ) {}

  /** The scan, with the size and zone its metadata recorded. */
  @GenerateSql({ params: [DummyValue.UUID] })
  getScan(id: string) {
    return this.db
      .selectFrom('asset')
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select([
        'asset.id',
        'asset.ownerId',
        'asset.type',
        'asset.originalPath',
        'asset.originalFileName',
        'asset.fileCreatedAt',
        'asset.fileModifiedAt',
        'asset.localDateTime',
        'asset.deletedAt',
        'asset.isOffline',
        'asset_exif.exifImageWidth',
        'asset_exif.exifImageHeight',
        'asset_exif.orientation',
        'asset_exif.timeZone',
        'asset_exif.make',
        'asset_exif.model',
        'asset_exif.latitude',
        'asset_exif.longitude',
        'asset_exif.fileSizeInByte',
      ])
      .where('asset.id', '=', asUuid(id))
      .executeTakeFirst();
  }

  /**
   * The photos cut from a scan before, each with what decides whether a new split replaces it.
   *
   * `edited` is the whole rule for "the owner has worked on this photo": it has edits (`asset.isEdited`, set by
   * the first row in `asset_edit`), a Develop revision or a video version, or the owner changed its metadata
   * (date, place, description, rating: each such change adds the field to `asset_exif.lockedProperties`, which
   * a photo cut from a scan starts without). Albums, favourites, tags and people do not count. `trashed` photos
   * are already out of the library.
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getCrops(sourceAssetId: string) {
    const rows = await this.db
      .selectFrom('asset_scan_crop')
      .innerJoin('asset', 'asset.id', 'asset_scan_crop.assetId')
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select(['asset_scan_crop.assetId', 'asset_scan_crop.quad', 'asset_scan_crop.rotation'])
      .select([
        sql<boolean>`asset."deletedAt" is not null or asset.status != ${sql.lit(AssetStatus.Active)}`.as('trashed'),
        sql<boolean>`
          asset."isEdited"
          or coalesce(cardinality(asset_exif."lockedProperties"), 0) > 0
          or exists (select 1 from public.asset_develop_revision revision where revision."assetId" = asset.id)
          or exists (select 1 from public.video_edit_version version where version."assetId" = asset.id)
        `.as('edited'),
      ])
      .where('asset_scan_crop.sourceAssetId', '=', asUuid(sourceAssetId))
      .orderBy('asset_scan_crop.createdAt')
      .orderBy('asset_scan_crop.assetId')
      .execute();
    return rows.map((row) => ({ ...row, trashed: !!row.trashed, edited: !!row.edited }));
  }

  /**
   * Adds the rendered prints to the scan owner's library in one transaction, or adds nothing.
   *
   * - The scan's row is share-locked first, so it cannot be locked, unlocked, trashed or change owner before
   *   the commit. A scan in the Locked folder locks each new photo with the same reason; a sensitive scan
   *   marks them sensitive.
   * - The owner's quota is charged for every new file at once and refused if they do not all fit
   *   (`ScanSplitQuotaError`). The scan keeps counting as it did: scan and photos count once each.
   * - Each photo gets its ledger row (`scan-split`), its size, the scan's time zone and its
   *   `asset_scan_crop` row.
   * - The scan moves to the archive if it was on the timeline.
   *
   * Answers whether the new photos are Locked.
   */
  publish(scanId: string, crops: ScanCropPublication[], timeZone: string | null): Promise<{ locked: boolean }> {
    return this.db.transaction().execute(async (tx) => {
      const source = (await this.privacy.lockSources(tx, [scanId])).get(scanId);
      if (!source || source.deleted) {
        throw new ScanSplitGoneError('The scan is no longer in the library');
      }
      const total = crops.reduce((sum, crop) => sum + crop.sizeInBytes, 0);
      const charged = await tx
        .updateTable('user')
        .set({ quotaUsageInBytes: sql`"quotaUsageInBytes" + ${total}` })
        .where('id', '=', asUuid(source.ownerId))
        .where(sql<boolean>`("quotaSizeInBytes" IS NULL OR "quotaUsageInBytes" + ${total} <= "quotaSizeInBytes")`)
        .returning('id')
        .executeTakeFirst();
      if (!charged) {
        throw new ScanSplitQuotaError('Quota has been exceeded!');
      }
      const lock = source.lockReason ? { reason: source.lockReason, lockedBy: null } : undefined;
      for (const crop of crops) {
        await this.assets.create({ ...crop.asset, ownerId: source.ownerId }, lock, tx, 'scan-split');
        await tx
          .insertInto('asset_exif')
          .values({
            assetId: crop.asset.id,
            fileSizeInByte: crop.sizeInBytes,
            exifImageWidth: crop.width,
            exifImageHeight: crop.height,
            // the zone the scan's date is read in, so the photo's date reads the same
            timeZone,
          })
          .execute();
        await this.privacy.install(tx, crop.asset.id, { lockReason: null, sensitive: source.sensitive });
        await tx
          .insertInto('asset_scan_crop')
          .values({
            assetId: crop.asset.id,
            sourceAssetId: scanId,
            quad: JSON.stringify(crop.quad) as unknown as ScanPoint[],
            rotation: crop.rotation,
          })
          .execute();
      }
      await tx
        .updateTable('asset')
        .set({ visibility: AssetVisibility.Archive })
        .where('id', '=', asUuid(scanId))
        .where('visibility', '=', AssetVisibility.Timeline)
        .execute();
      return { locked: !!lock };
    });
  }

  /** Forgets that these photos were cut from a scan (they were replaced, or were in the trash already). */
  @GenerateSql({ params: [[DummyValue.UUID]] })
  async removeCrops(assetIds: string[]): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }
    await this.db.deleteFrom('asset_scan_crop').where('assetId', 'in', assetIds).execute();
  }
}
