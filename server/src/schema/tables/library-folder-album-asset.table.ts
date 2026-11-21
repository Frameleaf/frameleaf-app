import { ForeignKeyColumn, Table } from '@frameleaf/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { LibraryFolderAlbumTable } from 'src/schema/tables/library-folder-album.table.js';

/**
 * FL-838: a folder photo the sync has put in its folder album once. The sync adds only photos it has not put in
 * before, so one the owner took out of the album stays out. The row goes when the photo's file is gone and the sync
 * takes it out of the album, so a photo that comes back with its folder joins the album again.
 */
@Table('library_folder_album_asset')
export class LibraryFolderAlbumAssetTable {
  @ForeignKeyColumn(() => LibraryFolderAlbumTable, { onDelete: 'CASCADE', nullable: false, primary: true })
  folderAlbumId!: string;

  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', nullable: false, primary: true, index: true })
  assetId!: string;
}
