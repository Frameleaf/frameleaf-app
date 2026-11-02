import { Column, CreateDateColumn, ForeignKeyColumn, Table } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { AlbumTable } from 'src/schema/tables/album.table.js';
import { AssetFaceTable } from 'src/schema/tables/asset-face.table.js';
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

/**
 * FL-1094: what a person is wearing, as a CLIP image embedding of the torso under one face. Made only for
 * album trip photos and photos that need a date, never the whole library. A null embedding means the face
 * leaves no torso in the frame; the row still records that the face was looked at with `modelName`.
 */
@Table({ name: 'asset_face_outfit' })
export class AssetFaceOutfitTable {
  @ForeignKeyColumn(() => AssetFaceTable, { onDelete: 'CASCADE', nullable: false, primary: true })
  faceId!: string;

  @Column({ type: 'text' })
  modelName!: string;

  // ponytail: text, not vector; a trip's outfits are compared in memory, so no index or fixed dimension.
  @Column({ type: 'text', nullable: true })
  embedding!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
