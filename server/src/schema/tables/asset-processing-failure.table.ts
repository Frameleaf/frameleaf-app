import { Column, ForeignKeyColumn, PrimaryColumn, Table } from '@frameleaf/sql-tools';
import type { Timestamp } from '@frameleaf/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table.js';

@Table('asset_processing_failure')
export class AssetProcessingFailureTable {
  @ForeignKeyColumn(() => AssetTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  assetId!: string;

  @PrimaryColumn({ type: 'text' })
  step!: string;

  @Column({ type: 'integer' })
  attempts!: number;

  @Column({ type: 'text' })
  lastError!: string;

  @Column({ type: 'timestamp with time zone' })
  lastFailedAt!: Timestamp;

  @Column({ type: 'timestamp with time zone', nullable: true })
  quarantinedAt!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  dismissedAt!: Timestamp | null;
}
