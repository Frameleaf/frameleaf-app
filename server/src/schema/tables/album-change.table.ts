import { Column, ForeignKeyColumn, PrimaryColumn, Table } from '@frameleaf/sql-tools';
import { AlbumChangeRunTable } from 'src/schema/tables/album-change-run.table.js';
import { AlbumTable } from 'src/schema/tables/album.table.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';

/**
 * FL-1298: one change a run made, in order. `kind` picks the reverser that undoes it; `before` and
 * `after` are that reverser's to read. An album or asset deleted since leaves its reference null.
 */
@Table('album_change')
export class AlbumChangeTable {
  @ForeignKeyColumn(() => AlbumChangeRunTable, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    primary: true,
    index: false,
  })
  runId!: string;

  @PrimaryColumn({ type: 'integer' })
  seq!: number;

  @Column({ type: 'text' })
  kind!: string;

  @ForeignKeyColumn(() => AlbumTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  albumId!: string | null;

  @ForeignKeyColumn(() => AssetTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  assetId!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  before!: unknown;

  @Column({ type: 'jsonb', nullable: true })
  after!: unknown;
}
