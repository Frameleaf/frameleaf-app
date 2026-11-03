import { CreateDateColumn, ForeignKeyColumn, Table } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { AlbumTable } from 'src/schema/tables/album.table.js';
import { BookmarkTable } from 'src/schema/tables/bookmark.table.js';

@Table('album_bookmark')
export class AlbumBookmarkTable {
  @ForeignKeyColumn(() => AlbumTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  albumId!: string;

  @ForeignKeyColumn(() => BookmarkTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  bookmarkId!: string;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
