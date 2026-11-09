import { Column, ForeignKeyColumn, PrimaryColumn, Table } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * Year in Review groundwork: how often a person opened an asset in the viewer, one row per person per asset per
 * (server) day. Web, iOS and Android all report through `POST /assets/:id/views`.
 */
@Table('asset_view')
export class AssetViewTable {
  @ForeignKeyColumn(() => UserTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  userId!: string;

  @ForeignKeyColumn(() => AssetTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  assetId!: string;

  @PrimaryColumn({ type: 'date' })
  viewedOn!: Generated<string>;

  @Column({ type: 'integer', default: 1 })
  viewCount!: Generated<number>;

  @Column({ type: 'timestamp with time zone', default: () => 'now()' })
  lastViewedAt!: Generated<Timestamp>;
}
