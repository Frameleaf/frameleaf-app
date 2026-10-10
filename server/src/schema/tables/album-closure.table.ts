import { ForeignKeyColumn, Table } from '@frameleaf/sql-tools';
import { AlbumTable } from 'src/schema/tables/album.table.js';

@Table('album_closure')
export class AlbumClosureTable {
  @ForeignKeyColumn(() => AlbumTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'NO ACTION', index: true })
  id_ancestor!: string;

  @ForeignKeyColumn(() => AlbumTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'NO ACTION', index: true })
  id_descendant!: string;
}
