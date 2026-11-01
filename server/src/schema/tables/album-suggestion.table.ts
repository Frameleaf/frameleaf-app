import { CreateDateColumn, ForeignKeyColumn, Table } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { AlbumTable } from 'src/schema/tables/album.table.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/** FL-1092: "Not from this trip". The photo is never suggested for this album again. */
@Table({ name: 'album_suggestion_dismissal' })
export class AlbumSuggestionDismissalTable {
  @ForeignKeyColumn(() => AlbumTable, { onDelete: 'CASCADE', nullable: false, primary: true })
  albumId!: string;

  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', nullable: false, primary: true })
  assetId!: string;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}

/**
 * FL-1092: "Keep adding new photos from this trip". Very likely matches from `userId`'s library are added
 * as they finish processing; that person's access to the album is rechecked every time.
 */
@Table({ name: 'album_suggestion_auto_add' })
export class AlbumSuggestionAutoAddTable {
  @ForeignKeyColumn(() => AlbumTable, { onDelete: 'CASCADE', nullable: false, primary: true })
  albumId!: string;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', nullable: false, primary: true })
  userId!: string;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
