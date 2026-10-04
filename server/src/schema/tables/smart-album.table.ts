import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  PrimaryGeneratedColumn,
  Table,
  Unique,
} from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { AlbumTable } from 'src/schema/tables/album.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

@Table({ name: 'smart_album' })
@Unique({ columns: ['ownerId', 'kind'] })
export class SmartAlbumTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @Column({ type: 'text' })
  kind!: string;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', nullable: false, index: true })
  ownerId!: string;

  @ForeignKeyColumn(() => AlbumTable, { onDelete: 'CASCADE', nullable: false })
  albumId!: string;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
