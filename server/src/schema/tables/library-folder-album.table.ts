import { Column, ForeignKeyColumn, PrimaryGeneratedColumn, Table, Unique } from '@frameleaf/sql-tools';
import type { Generated } from '@frameleaf/sql-tools';
import { AlbumTable } from 'src/schema/tables/album.table.js';
import { LibraryTable } from 'src/schema/tables/library.table.js';

/**
 * FL-838: the album made for one folder of a library. `folderPath` is the folder as the scan sees it (no trailing
 * slash). `isUserEdited` is set once the owner renamed the album or put photos from elsewhere in it: the album then
 * keeps its name and those photos, and is kept when its folder empties.
 */
@Table('library_folder_album')
@Unique({ name: 'library_folder_album_libraryId_folderPath_uq', columns: ['libraryId', 'folderPath'] })
export class LibraryFolderAlbumTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  // the unique (libraryId, folderPath) constraint serves lookups by library
  @ForeignKeyColumn(() => LibraryTable, { onDelete: 'CASCADE', nullable: false, index: false })
  libraryId!: string;

  @Column({ type: 'text' })
  folderPath!: string;

  @ForeignKeyColumn(() => AlbumTable, { onDelete: 'CASCADE', nullable: false })
  albumId!: string;

  @Column({ type: 'boolean', default: false })
  isUserEdited!: Generated<boolean>;

  // FL-1837: kept as made when the library's rules changed ("new folders only"): it keeps its own folder's photos
  @Column({ type: 'boolean', default: false })
  isKept!: Generated<boolean>;
}
