import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  ForeignKeyColumn,
  PrimaryGeneratedColumn,
  Table,
  UpdateDateColumn,
} from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import type { FolderAlbumOptions } from 'src/utils/folder-albums.js';
import { UpdateIdColumn, UpdatedAtTrigger } from 'src/decorators.js';
import { UserTable } from 'src/schema/tables/user.table.js';

@Table('library')
@UpdatedAtTrigger('library_updatedAt')
export class LibraryTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @Column()
  name!: string;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  ownerId!: string;

  @Column({ type: 'text', array: true })
  importPaths!: string[];

  @Column({ type: 'text', array: true })
  exclusionPatterns!: string[];

  @Column({ type: 'boolean', default: false })
  readOnly!: Generated<boolean>;

  /** FL-838: keep an album for each folder of the library, synced after every scan. */
  @Column({ type: 'boolean', default: false })
  folderAlbums!: Generated<boolean>;

  // FL-1837: which folders become albums; null for a library from before, which makes an album for every folder
  @Column({ type: 'jsonb', nullable: true })
  folderAlbumOptions!: FolderAlbumOptions | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Date>;

  @DeleteDateColumn()
  deletedAt!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  refreshedAt!: Timestamp | null;

  @UpdateIdColumn({ index: true })
  updateId!: Generated<string>;
}
