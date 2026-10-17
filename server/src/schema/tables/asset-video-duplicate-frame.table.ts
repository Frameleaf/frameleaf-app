import {
  BeforeUpdateTrigger,
  Check,
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  PrimaryColumn,
  Table,
  TriggerFunction,
  UpdateDateColumn,
} from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { desktop_clip_producer_guard, media_health_updated_at } from 'src/schema/functions.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { DesktopClipProducerTable } from 'src/schema/tables/desktop-clip-index.table.js';

@Table('asset_video_duplicate_frame')
// No updateId column (the fork v2 sidecar mirrors this table), so the trigger only stamps updatedAt.
@BeforeUpdateTrigger({ name: 'asset_video_duplicate_frame_updatedAt', scope: 'row', function: media_health_updated_at })
@Check({
  name: 'asset_video_duplicate_frame_producer_key_check',
  expression: `"producerModelKey" IS NULL OR "producerModelKey" ~ '^clip:[a-f0-9]{64}$'`,
})
@TriggerFunction({
  name: 'asset_video_duplicate_frame_producer_guard',
  timing: 'before',
  actions: ['insert', 'update'],
  scope: 'row',
  function: desktop_clip_producer_guard,
})
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

  @Column({ nullable: true })
  producerModelKey!: string | null;

  @ForeignKeyColumn(() => DesktopClipProducerTable, {
    type: 'text',
    default: 'legacy',
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  })
  producerAdmissionKey!: Generated<string>;
}
