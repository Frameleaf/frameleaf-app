import { Column, ForeignKeyColumn, Index, Table } from '@frameleaf/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { PhysicalFileTable } from 'src/schema/tables/physical-file.table.js';

/** Additional originals of one logical photo; asset.originalPath remains its selected primary. */
@Table('asset_original')
@Index({ name: 'asset_original_physicalFileId_idx', columns: ['physicalFileId'] })
export class AssetOriginalTable {
  @ForeignKeyColumn(() => AssetTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  assetId!: string;

  @ForeignKeyColumn(() => PhysicalFileTable, { primary: true, onDelete: 'RESTRICT', onUpdate: 'CASCADE', index: false })
  physicalFileId!: string;

  @Column()
  originalFileName!: string;
}
