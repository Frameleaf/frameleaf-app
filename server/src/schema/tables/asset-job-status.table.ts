import { connect_event_asset_ready } from 'src/schema/tables/connect-event.table.js';
import { Column, ForeignKeyColumn, Table, Trigger } from '@frameleaf/sql-tools';
import type { Timestamp } from '@frameleaf/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table.js';

@Trigger({
  name: 'connect_event_metadata_ready',
  timing: 'after',
  actions: ['insert', 'update'],
  scope: 'row',
  functionName: connect_event_asset_ready.name,
})
@Table('asset_job_status')
export class AssetJobStatusTable {
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true })
  assetId!: string;

  @Column({ type: 'timestamp with time zone', nullable: true })
  facesRecognizedAt!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  metadataExtractedAt!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  duplicatesDetectedAt!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  ocrAt!: Timestamp | null;

  @Column({ type: 'text', nullable: true })
  transcodeSkippedFor!: string | null;
}
