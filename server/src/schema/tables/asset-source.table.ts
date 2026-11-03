import {
  Check,
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  PrimaryGeneratedColumn,
  Table,
  Unique,
} from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table.js';

/** Where an imported source came from (FL-653). Null for a source the browser extension saved. */
export type AssetSourceImportedFrom = 'eagle';

@Table('asset_source')
@Unique({ columns: ['captureId'] })
@Check({ name: 'asset_source_importedFrom_check', expression: `"importedFrom" IN ('eagle')` })
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

  /** The app the source was imported from, such as an Eagle library. Null when the extension saved it. */
  @Column({ type: 'character varying', nullable: true })
  importedFrom!: AssetSourceImportedFrom | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
