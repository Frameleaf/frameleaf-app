import {
  Check,
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  ForeignKeyConstraint,
  Index,
  PrimaryGeneratedColumn,
  Table,
  UpdateDateColumn,
} from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { UpdateIdColumn, UpdatedAtTrigger } from 'src/decorators.js';
import { AlbumAssetTable } from 'src/schema/tables/album-asset.table.js';
import { AlbumTable } from 'src/schema/tables/album.table.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { HouseholdRemoteAuthorTable } from 'src/schema/tables/household-comment.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

@Table('activity')
@UpdatedAtTrigger('activity_updatedAt')
@Index({
  name: 'activity_like_idx',
  columns: ['assetId', 'userId', 'albumId'],
  unique: true,
  where: '("isLiked" = true)',
})
@Check({
  name: 'activity_like_check',
  expression: `(comment IS NULL AND "isLiked" = true) OR (comment IS NOT NULL AND "isLiked" = false)`,
})
// FL-1012: a remote author's likes are unique per item and per space, as a local member's are
@Index({
  name: 'activity_remote_asset_like_idx',
  columns: ['albumId', 'assetId', 'remoteAuthorId'],
  unique: true,
  where: '("isLiked" = true AND "assetId" IS NOT NULL AND "remoteAuthorId" IS NOT NULL)',
})
@Index({
  name: 'activity_remote_space_like_idx',
  columns: ['albumId', 'remoteAuthorId'],
  unique: true,
  where: '("isLiked" = true AND "assetId" IS NULL AND "remoteAuthorId" IS NOT NULL)',
})
@Check({
  name: 'activity_author_check',
  expression: `("userId" IS NULL) <> ("remoteAuthorId" IS NULL)`,
})
@ForeignKeyConstraint({
  columns: ['albumId', 'assetId'],
  referenceTable: () => AlbumAssetTable,
  referenceColumns: ['albumId', 'assetId'],
  onUpdate: 'NO ACTION',
  onDelete: 'CASCADE',
})
export class ActivityTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @ForeignKeyColumn(() => AlbumTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  albumId!: string;

  /** Null on a comment from another household (FL-1012), which has `remoteAuthorId` instead. */
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: true })
  userId!: string | null;

  @ForeignKeyColumn(() => HouseholdRemoteAuthorTable, { onDelete: 'CASCADE', nullable: true })
  remoteAuthorId!: string | null;

  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: true })
  assetId!: string | null;

  @Column({ type: 'text', default: null })
  comment!: string | null;

  @Column({ type: 'boolean', default: false })
  isLiked!: Generated<boolean>;

  @UpdateIdColumn({ index: true })
  updateId!: Generated<string>;
}
