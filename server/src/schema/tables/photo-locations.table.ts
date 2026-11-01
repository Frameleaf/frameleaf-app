import { Column, CreateDateColumn, ForeignKeyColumn, Index, PrimaryGeneratedColumn, Table } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import type { LocationScanSummary } from 'src/dtos/photo-locations.dto.js';
import type { PhotoLocationInsight } from 'src/utils/photo-locations.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

export type PhotoLocationScanState = {
  inputPath?: string;
  sha256?: string;
  compressedBytes?: number;
  pointCount?: number;
  cloudCreated?: boolean;
  cloudCreateAttempted?: boolean;
  cloudStarted?: boolean;
  resultOffset?: number;
  cleanupPending?: boolean;
};

@Table('photo_location_scan')
@Index({ name: 'photo_location_scan_owner_created_idx', columns: ['ownerId', 'createdAt'] })
@Index({
  name: 'photo_location_scan_one_active_idx',
  columns: ['ownerId'],
  unique: true,
  where: "status IN ('queued', 'preparing', 'uploading', 'running', 'paused')",
})
export class PhotoLocationScanTable {
  @PrimaryGeneratedColumn() id!: Generated<string>;
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE' }) ownerId!: string;
  @Column({ type: 'text' }) status!: LocationScanSummary['status'];
  @Column({ type: 'boolean' }) refresh!: boolean;
  @Column({ type: 'integer', default: 0 }) total!: Generated<number>;
  @Column({ type: 'integer', default: 0 }) processed!: Generated<number>;
  @Column({ type: 'integer', default: 0 }) matched!: Generated<number>;
  @Column({ type: 'integer', default: 0 }) unmatched!: Generated<number>;
  @Column({ type: 'integer', default: 0 }) skipped!: Generated<number>;
  @Column({ type: 'integer', default: 0 }) failed!: Generated<number>;
  @Column({ type: 'text', nullable: true }) error!: string | null;
  @Column({ type: 'text', nullable: true }) reason!: string | null;
  @Column({ type: 'text' }) cloudUrl!: string;
  @Column({ type: 'uuid' }) instanceId!: string;
  @Column({ type: 'text' }) linkedAt!: string;
  @Column({ type: 'jsonb', default: '{}' }) state!: Generated<PhotoLocationScanState>;
  @Column({ type: 'uuid', nullable: true }) leaseToken!: string | null;
  @Column({ type: 'timestamp with time zone', nullable: true }) leaseUntil!: Timestamp | null;
  @Column({ type: 'timestamp with time zone', default: () => 'now()' }) nextAttemptAt!: Generated<Timestamp>;
  @CreateDateColumn() createdAt!: Generated<Timestamp>;
}

@Table('photo_location_scan_item')
@Index({ name: 'photo_location_scan_item_point_idx', columns: ['scanId', 'itemKey'] })
export class PhotoLocationScanItemTable {
  @ForeignKeyColumn(() => PhotoLocationScanTable, { primary: true, onDelete: 'CASCADE' }) scanId!: string;
  @ForeignKeyColumn(() => AssetTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE' }) assetId!: string;
  @Column({ type: 'text' }) itemKey!: string;
  @Column({ type: 'double precision' }) latitude!: number;
  @Column({ type: 'double precision' }) longitude!: number;
  @Column({ type: 'double precision', nullable: true }) accuracyM!: number | null;
  @Column({ type: 'boolean', default: false }) completed!: Generated<boolean>;
}

@Table('asset_location_insight')
export class AssetLocationInsightTable {
  @ForeignKeyColumn(() => AssetTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE' }) assetId!: string;
  @Column({ type: 'double precision' }) latitude!: number;
  @Column({ type: 'double precision' }) longitude!: number;
  @Column({ type: 'jsonb', nullable: true }) insight!: PhotoLocationInsight | null;
  @Column({ type: 'boolean', default: false }) dismissed!: Generated<boolean>;
  @CreateDateColumn() createdAt!: Generated<Timestamp>;
}
