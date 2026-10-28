import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  ForeignKeyColumn,
  Index,
  PrimaryGeneratedColumn,
  Table,
  UpdateDateColumn,
} from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import type { CaptureSourceDto } from 'src/dtos/bookmark.dto.js';
import { UpdateIdColumn, UpdatedAtTrigger } from 'src/decorators.js';
import { LibraryScope } from 'src/enum.js';
import { library_scope_enum } from 'src/schema/enums.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

@Table('bookmark')
@UpdatedAtTrigger('bookmark_updatedAt')
@Index({ columns: ['ownerId', 'libraryScope'] })
export class BookmarkTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  // The owner/scope index also covers owner foreign-key lookups.
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  ownerId!: string;

  @Column({ type: 'text' })
  url!: string;

  @Column({ type: 'text' })
  title!: string;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  source!: CaptureSourceDto | null;

  @ForeignKeyColumn(() => AssetTable, { nullable: true, onDelete: 'SET NULL', onUpdate: 'CASCADE' })
  previewAssetId!: string | null;

  @Column({ enum: library_scope_enum, default: LibraryScope.Design })
  libraryScope!: Generated<LibraryScope>;

  @Column({ type: 'boolean', default: false })
  isArchived!: Generated<boolean>;

  @Column({ type: 'boolean', default: false })
  isLocked!: Generated<boolean>;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @DeleteDateColumn()
  deletedAt!: Timestamp | null;

  @UpdateIdColumn({ index: true })
  updateId!: Generated<string>;
}
