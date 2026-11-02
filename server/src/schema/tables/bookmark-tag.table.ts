import { ForeignKeyColumn, Table } from '@frameleaf/sql-tools';
import { BookmarkTable } from 'src/schema/tables/bookmark.table.js';
import { TagTable } from 'src/schema/tables/tag.table.js';

@Table('bookmark_tag')
export class BookmarkTagTable {
  @ForeignKeyColumn(() => BookmarkTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  bookmarkId!: string;

  @ForeignKeyColumn(() => TagTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  tagId!: string;
}
