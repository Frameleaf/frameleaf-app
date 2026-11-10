import { Column, ForeignKeyColumn, Table, UpdateDateColumn } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import type { FontAxis, FontFace, FontInstance } from 'src/utils/font-file.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';

/** FL-1359: what a font in Boards says about itself, read once when its specimen picture is made. */
@Table('asset_font')
export class AssetFontTable {
  @ForeignKeyColumn(() => AssetTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  assetId!: string;

  @Column({ type: 'text' })
  family!: string;

  @Column({ type: 'text' })
  style!: string;

  @Column({ type: 'integer', nullable: true })
  weight!: number | null;

  @Column({ type: 'boolean', default: false })
  italic!: Generated<boolean>;

  @Column({ type: 'integer', default: 0 })
  glyphCount!: Generated<number>;

  @Column({ type: 'jsonb', default: '[]' })
  axes!: Generated<FontAxis[]>;

  @Column({ type: 'jsonb', default: '[]' })
  instances!: Generated<FontInstance[]>;

  @Column({ type: 'jsonb', default: '[]' })
  features!: Generated<string[]>;

  @Column({ type: 'jsonb', default: '[]' })
  scripts!: Generated<string[]>;

  @Column({ type: 'text', nullable: true })
  license!: string | null;

  @Column({ type: 'text', nullable: true })
  licenseUrl!: string | null;

  @Column({ type: 'jsonb', default: '[]' })
  faces!: Generated<FontFace[]>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}
