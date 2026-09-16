import { Column, CreateDateColumn, ForeignKeyColumn, PrimaryColumn, Table, UpdateDateColumn } from '@immich/sql-tools';
import type { Generated, Timestamp } from '@immich/sql-tools';
import { UpdatedAtTrigger } from 'src/decorators.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';

@Table('asset_video_duplicate_frame')
@UpdatedAtTrigger('asset_video_duplicate_frame_updatedAt')
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
