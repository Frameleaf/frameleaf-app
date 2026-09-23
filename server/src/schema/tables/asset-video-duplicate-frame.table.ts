import {
  BeforeUpdateTrigger,
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  PrimaryColumn,
  Table,
  UpdateDateColumn,
} from '@immich/sql-tools';
import type { Generated, Timestamp } from '@immich/sql-tools';
import { media_health_updated_at } from 'src/schema/functions.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';

@Table('asset_video_duplicate_frame')
// No updateId column (the fork v2 sidecar mirrors this table), so the trigger only stamps updatedAt.
@BeforeUpdateTrigger({ name: 'asset_video_duplicate_frame_updatedAt', scope: 'row', function: media_health_updated_at })
export class AssetVideoDuplicateFrameTable {
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true })
  assetId!: string;

  @PrimaryColumn({ type: 'integer' })
  frameIndex!: number;

  @Column({ type: 'integer' })
  timestampMs!: number;

  @Column()
  path!: string;

  @Column({ type: 'vector', length: 512, storage: 'external', synchronize: false })
  embedding!: string;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}
