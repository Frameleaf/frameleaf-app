import {
  AfterDeleteTrigger,
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  Index,
  Table,
  Trigger,
  UpdateDateColumn,
} from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { UpdateIdColumn, UpdatedAtTrigger } from 'src/decorators.js';
import {
  album_asset_delete_audit,
  asset_print_back_not_shared,
  media_import_collection_removed,
} from 'src/schema/functions.js';
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
// FL-967: the back of a print is never an album item, whichever writer tries
@Trigger({
  name: 'album_asset_print_back_not_shared',
  timing: 'before',
  actions: ['insert'],
  scope: 'row',
  functionName: asset_print_back_not_shared.name,
})
@Trigger({
  name: 'media_import_collection_removed',
  timing: 'after',
  actions: ['delete'],
  scope: 'row',
  functionName: media_import_collection_removed.name,
})
@UpdatedAtTrigger('album_asset_updatedAt')
// FL-869: the album's custom order
@Index({ name: 'album_asset_position_idx', columns: ['albumId', 'position'] })
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

  /** FL-869: place in the album's custom order; null until the album first switches to custom order. */
  @Column({ type: 'double precision', nullable: true, default: null })
  position!: number | null;

  @UpdateIdColumn({ index: true })
  updateId!: Generated<string>;
}
