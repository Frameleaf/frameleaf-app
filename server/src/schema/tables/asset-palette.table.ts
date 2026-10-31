import { Column, ForeignKeyColumn, Index, PrimaryColumn, Table, UpdateDateColumn } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import type { AssetPaletteDto } from 'src/dtos/asset-palette.dto.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';

@Table('asset_palette')
export class AssetPaletteTable {
  @ForeignKeyColumn(() => AssetTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  assetId!: string;

  @Column({ type: 'integer' })
  version!: 1;

  @Column({ type: 'text' })
  sourceRevision!: string;

  @Column({ type: 'boolean', default: false })
  ownerOnly!: Generated<boolean>;

  @Column({ type: 'text' })
  status!: AssetPaletteDto['status'];

  @Column({ type: 'jsonb' })
  swatches!: AssetPaletteDto['swatches'];

  @Column({ type: 'boolean' })
  hasTransparency!: boolean;

  @Column({ type: 'text' })
  representative!: AssetPaletteDto['representative'];

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}

@Table('asset_palette_swatch')
@Index({ name: 'asset_palette_swatch_color_idx', columns: ['l', 'a', 'b', 'weight'] })
export class AssetPaletteSwatchTable {
  @ForeignKeyColumn(() => AssetTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  assetId!: string;

  @PrimaryColumn({ type: 'integer' })
  position!: number;

  @Column({ type: 'double precision' })
  l!: number;

  @Column({ type: 'double precision' })
  a!: number;

  @Column({ type: 'double precision' })
  b!: number;

  @Column({ type: 'double precision' })
  weight!: number;
}
