import {
  Check,
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  Index,
  PrimaryGeneratedColumn,
  Table,
  UpdateDateColumn,
} from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { UpdateIdColumn, UpdatedAtTrigger } from 'src/decorators.js';
import { AlbumTable } from 'src/schema/tables/album.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/** FL-881: a heading and a short paragraph placed between an album's photos, in the album's custom order. */
@Table('album_text_card')
@UpdatedAtTrigger('album_text_card_updatedAt')
@Index({ name: 'album_text_card_position_idx', columns: ['albumId', 'position'] })
@Check({ name: 'album_text_card_heading_check', expression: 'char_length(heading) <= 120' })
@Check({ name: 'album_text_card_body_check', expression: 'char_length(body) <= 2000' })
export class AlbumTextCardTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  // Covered by album_text_card_position_idx, which leads with albumId.
  @ForeignKeyColumn(() => AlbumTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  albumId!: string;

  @Column({ type: 'double precision' })
  position!: number;

  @Column({ type: 'text', default: '' })
  heading!: Generated<string>;

  @Column({ type: 'text', default: '' })
  body!: Generated<string>;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  createdById!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @UpdateIdColumn({ index: true })
  updateId!: Generated<string>;
}
