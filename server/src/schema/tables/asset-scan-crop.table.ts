import { Column, CreateDateColumn, ForeignKeyColumn, Table } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table.js';

/**
 * FL-923: a photo cut out of a flatbed scan. `assetId` is the new photo, `sourceAssetId` the scan it was cut
 * from, `quad` the print's four corners in the scan's displayed pixels (top-left, top-right, bottom-right,
 * bottom-left) and `rotation` the quarter turns applied after straightening. Deleting the photo or the scan
 * removes the row only: a scan that is deleted leaves its photos in the library.
 */
@Table('asset_scan_crop')
export class AssetScanCropTable {
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', nullable: false, primary: true })
  assetId!: string;

  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', nullable: false, index: true })
  sourceAssetId!: string;

  @Column({ type: 'jsonb' })
  quad!: [number, number][];

  @Column({ type: 'integer' })
  rotation!: number;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
