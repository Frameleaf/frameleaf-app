import { CreateDateColumn, ForeignKeyColumn, Table } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * FL-786: a person's own favourite on an item someone else owns, seen through a shared album or space. The heart is
 * theirs alone; an owner's favourite stays `asset.isFavorite`. Mirrors migration 1794740000000-AssetFavorite.
 */
@Table('asset_favorite')
export class AssetFavoriteTable {
  @ForeignKeyColumn(() => UserTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  userId!: string;

  @ForeignKeyColumn(() => AssetTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  assetId!: string;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
