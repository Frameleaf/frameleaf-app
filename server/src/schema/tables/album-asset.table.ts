import {
  AfterDeleteTrigger,
  CreateDateColumn,
  ForeignKeyColumn,
  Table,
  Trigger,
  UpdateDateColumn,
} from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { UpdateIdColumn, UpdatedAtTrigger } from 'src/decorators.js';
import { album_asset_delete_audit, media_import_collection_removed } from 'src/schema/functions.js';
import { AlbumTable } from 'src/schema/tables/album.table.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { connect_event_album_added } from 'src/schema/tables/connect-event.table.js';

@Trigger({
  name: 'connect_event_album_added',
  timing: 'after',
  actions: ['insert'],
  scope: 'row',
  functionName: connect_event_album_added.name,
})
@Table({ name: 'album_asset' })
@Trigger({
  name: 'media_import_collection_removed',
  timing: 'after',
  actions: ['delete'],
  scope: 'row',
  functionName: media_import_collection_removed.name,
})
@UpdatedAtTrigger('album_asset_updatedAt')
@AfterDeleteTrigger({
  scope: 'statement',
  function: album_asset_delete_audit,
  referencingOldTableAs: 'old',
  when: 'pg_trigger_depth() <= 1',
})
export class AlbumAssetTable {
  @ForeignKeyColumn(() => AlbumTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false, primary: true })
  albumId!: string;

  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false, primary: true })
  assetId!: string;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @UpdateIdColumn({ index: true })
  updateId!: Generated<string>;
}
