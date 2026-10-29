import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  PrimaryGeneratedColumn,
  Table,
  Unique,
} from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table.js';

@Table('asset_source')
@Unique({ columns: ['captureId'] })
export class AssetSourceTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  assetId!: string;

  @Column({ type: 'uuid' })
  captureId!: string;

  @Column({ type: 'text' })
  pageUrl!: string;

  @Column({ type: 'text', nullable: true })
  mediaUrl!: string | null;

  @Column({ type: 'text' })
  title!: string;

  @Column({ type: 'timestamp with time zone' })
  capturedAt!: Timestamp;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ type: 'text', nullable: true })
  creator!: string | null;

  @Column({ type: 'text', nullable: true })
  licenseUrl!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
