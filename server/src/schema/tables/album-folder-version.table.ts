import { Column, ForeignKeyColumn, Index, Table } from '@frameleaf/sql-tools';
import { AlbumTable } from 'src/schema/tables/album.table.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';

/**
 * FL-1838: the same photo in more than one folder of an album made from a folder (IMG_4821.CR3, IMG_4821.JPG,
 * IMG_4821-edit.jpg). Each member of a group has a row naming the version in front; with "show it once" the album
 * shows only the front, with the others behind it in the viewer. Worked out again when the album's photos or its
 * folder choices change (`matchAlbumVersions`).
 */
@Table('album_folder_version')
@Index({ name: 'album_folder_version_albumId_frontAssetId_idx', columns: ['albumId', 'frontAssetId'] })
export class AlbumFolderVersionTable {
  // the primary key and the (albumId, frontAssetId) index serve lookups by album
  @ForeignKeyColumn(() => AlbumTable, { onDelete: 'CASCADE', nullable: false, primary: true, index: false })
  albumId!: string;

  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', nullable: false, primary: true, index: true })
  assetId!: string;

  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', nullable: false, index: false })
  frontAssetId!: string;

  /** 'name' or 'time': how this file was matched to its group */
  @Column({ type: 'text' })
  matchedBy!: string;
}
