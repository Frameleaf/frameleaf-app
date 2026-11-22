import { ForeignKeyColumn, Table, Trigger } from '@frameleaf/sql-tools';
import { asset_print_back_not_shared } from 'src/schema/functions.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { SharedLinkTable } from 'src/schema/tables/shared-link.table.js';

@Table('shared_link_asset')
// FL-967: the back of a print is never in a shared link, whichever writer tries
@Trigger({
  name: 'shared_link_asset_print_back_not_shared',
  timing: 'before',
  actions: ['insert'],
  scope: 'row',
  functionName: asset_print_back_not_shared.name,
})
export class SharedLinkAssetTable {
  @ForeignKeyColumn(() => AssetTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE', primary: true })
  assetId!: string;

  @ForeignKeyColumn(() => SharedLinkTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE', primary: true })
  sharedLinkId!: string;
}
