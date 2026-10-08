import {
  Check,
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  ForeignKeyConstraint,
  Index,
  PrimaryColumn,
  Table,
  Unique,
} from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/** Frameleaf local transition order, never provider revision order. Bigints cross the API as decimal text. */
@Table('asset_local_effect_stream')
@Check({ name: 'asset_local_effect_stream_sequence_check', expression: '"nextSequence" > 0' })
export class AssetLocalEffectStreamTable {
  @ForeignKeyColumn(() => UserTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE' }) ownerId!: string;
  @Column({ type: 'uuid' }) streamEpoch!: string;
  @Column({ type: 'bigint', default: 1 }) nextSequence!: Generated<string>;
}

@Table('asset_local_effect')
@Unique({ name: 'asset_local_effect_id_uq', columns: ['effectId'] })
@Check({ name: 'asset_local_effect_sequence_check', expression: 'sequence > 0' })
@Check({ name: 'asset_local_effect_digest_check', expression: 'octet_length("bundleSha256") = 32' })
@Check({
  name: 'asset_local_effect_bundle_check',
  expression: `jsonb_typeof(bundle) = 'object' AND bundle->>'formatVersion' = '1'`,
})
export class AssetLocalEffectTable {
  @ForeignKeyColumn(() => AssetLocalEffectStreamTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  ownerId!: string;
  @PrimaryColumn({ type: 'bigint' }) sequence!: string;
  @Column({ type: 'uuid' }) effectId!: string;
  @Column({ type: 'jsonb' }) bundle!: Record<string, unknown>;
  @Column({ type: 'bytea' }) bundleSha256!: Buffer;
  @CreateDateColumn() createdAt!: Generated<Timestamp>;
}

/** Separate physical row: awaited dispatch never holds the producer counter row. */
@Table('asset_local_effect_cursor')
@Check({
  name: 'asset_local_effect_cursor_sequence_check',
  expression: '"acknowledgedSequence" IS NULL OR "acknowledgedSequence" > 0',
})
@ForeignKeyConstraint({
  columns: ['ownerId', 'acknowledgedSequence'],
  referenceTable: () => AssetLocalEffectTable,
  referenceColumns: ['ownerId', 'sequence'],
  onDelete: 'NO ACTION',
  onUpdate: 'NO ACTION',
})
export class AssetLocalEffectCursorTable {
  @ForeignKeyColumn(() => AssetLocalEffectStreamTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  ownerId!: string;
  @Column({ type: 'bigint', nullable: true }) acknowledgedSequence!: string | null;
}

/** Restoration never deletes or resets the last real Trash transition. */
@Table('asset_source_epoch')
@Index({ name: 'asset_source_epoch_owner_sequence_idx', columns: ['ownerId', 'lastTrashSequence', 'assetId'] })
@Check({ name: 'asset_source_epoch_sequence_check', expression: '"lastTrashSequence" > 0' })
@ForeignKeyConstraint({
  columns: ['ownerId', 'lastTrashSequence'],
  referenceTable: () => AssetLocalEffectTable,
  referenceColumns: ['ownerId', 'sequence'],
  onDelete: 'NO ACTION',
  onUpdate: 'NO ACTION',
})
export class AssetSourceEpochTable {
  @ForeignKeyColumn(() => AssetTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE' }) assetId!: string;
  @ForeignKeyColumn(() => AssetLocalEffectStreamTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' }) ownerId!: string;
  @Column({ type: 'bigint' }) lastTrashSequence!: string;
}
