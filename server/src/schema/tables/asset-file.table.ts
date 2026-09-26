import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  Index,
  PrimaryGeneratedColumn,
  Table,
  Unique,
  UpdateDateColumn,
} from '@immich/sql-tools';
import type { Generated, Timestamp } from '@immich/sql-tools';
import { UpdateIdColumn, UpdatedAtTrigger } from 'src/decorators.js';
import { AssetFileType } from 'src/enum.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { PhysicalFileTable } from 'src/schema/tables/physical-file.table.js';

@Table('asset_file')
@Unique({ columns: ['assetId', 'type', 'isEdited'] })
// FL-179 (migration 2100000000640): storage moves and FileDelete look file rows up by path
// a Frameleaf name, so an index upstream adds with the default name cannot collide with it
@Index({ name: 'asset_file_path_frameleaf_idx', columns: ['path'] })
@UpdatedAtTrigger('asset_file_updatedAt')
export class AssetFileTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  assetId!: string;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @Column()
  type!: AssetFileType;

  @Column()
  path!: string;

  @ForeignKeyColumn(() => PhysicalFileTable, { nullable: true, onDelete: 'SET NULL', onUpdate: 'CASCADE', index: true })
  physicalFileId!: string | null;

  @UpdateIdColumn({ index: true })
  updateId!: Generated<string>;

  @Column({ type: 'boolean', default: false })
  isEdited!: Generated<boolean>;

  @Column({ type: 'boolean', default: false })
  isProgressive!: Generated<boolean>;

  @Column({ type: 'boolean', default: false })
  isTransparent!: Generated<boolean>;
}
