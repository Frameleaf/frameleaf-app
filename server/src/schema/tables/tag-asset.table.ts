import { AfterDeleteTrigger, BeforeUpdateTrigger, ForeignKeyColumn, Index, Table } from '@frameleaf/sql-tools';
import type { Generated } from '@frameleaf/sql-tools';
import { UpdateIdColumn } from 'src/decorators.js';
import { tag_asset_delete_audit, tag_asset_update_id } from 'src/schema/functions.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { TagTable } from 'src/schema/tables/tag.table.js';

@Index({ columns: ['assetId', 'tagId'] })
@AfterDeleteTrigger({ scope: 'statement', function: tag_asset_delete_audit, referencingOldTableAs: 'old' })
@BeforeUpdateTrigger({ scope: 'row', function: tag_asset_update_id })
@Table('tag_asset')
export class TagAssetTable {
  @UpdateIdColumn({ index: true })
  updateId!: Generated<string>;

  @ForeignKeyColumn(() => AssetTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE', primary: true, index: true })
  assetId!: string;

  @ForeignKeyColumn(() => TagTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE', primary: true, index: true })
  tagId!: string;
}
