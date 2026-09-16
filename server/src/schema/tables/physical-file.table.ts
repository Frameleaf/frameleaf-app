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
import type { Generated, Int8, Timestamp } from '@immich/sql-tools';
import { UpdateIdColumn, UpdatedAtTrigger } from 'src/decorators.js';
import { PhysicalFileType } from 'src/enum.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';

@Table('physical_file')
@Unique({ columns: ['path'] })
@Index({ columns: ['canonicalAssetId', 'type'] })
@Index({ columns: ['checksum', 'sizeInBytes', 'type'] })
@UpdatedAtTrigger('physical_file_updatedAt')
export class PhysicalFileTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @Column()
  type!: PhysicalFileType;

  @Column({ type: 'bytea' })
  checksum!: Buffer;

  @Column({ type: 'bigint' })
  sizeInBytes!: Int8;

  @Column()
  path!: string;

  @ForeignKeyColumn(() => AssetTable, { nullable: true, onDelete: 'SET NULL', onUpdate: 'CASCADE' })
  canonicalAssetId!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @UpdateIdColumn({ index: true })
  updateId!: Generated<string>;
}
