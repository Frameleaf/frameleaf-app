import { Column, ForeignKeyColumn, Table, UpdateDateColumn } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import type { AssetAnnotationItem } from 'src/dtos/asset-annotation.dto.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';

/** FL-652: one Boards annotation document per picture, kept beside the file and never written into it. */
@Table('asset_annotation')
export class AssetAnnotationTable {
  @ForeignKeyColumn(() => AssetTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  assetId!: string;

  @Column({ type: 'integer' })
  version!: 1;

  @Column({ type: 'text' })
  sourceRevision!: string;

  @Column({ type: 'jsonb' })
  items!: AssetAnnotationItem[];

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}
