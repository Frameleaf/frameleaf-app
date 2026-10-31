import { Column, ForeignKeyColumn, Table } from '@frameleaf/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table.js';

/**
 * FL-651: one video's timeline fingerprint, a difference hash per seek-bar filmstrip frame (frames at
 * the centre of equal slices of `durationMs`), `null` where the frame is too flat to compare.
 */
@Table('asset_video_fingerprint')
export class AssetVideoFingerprintTable {
  @ForeignKeyColumn(() => AssetTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  assetId!: string;

  @Column({ type: 'integer' })
  durationMs!: number;

  /** Signed 64-bit hashes; the driver reads bigint as decimal strings. */
  @Column({ type: 'bigint', array: true })
  hashes!: Array<string | null>;
}
