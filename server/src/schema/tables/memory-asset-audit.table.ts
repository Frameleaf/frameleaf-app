import { Column, CreateDateColumn, ForeignKeyColumn, Table } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { PrimaryGeneratedUuidV7Column } from 'src/decorators.js';
import { MemoryTable } from 'src/schema/tables/memory.table.js';

@Table('memory_asset_audit')
export class MemoryAssetAuditTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  @ForeignKeyColumn(() => MemoryTable, { type: 'uuid', onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  memoryId!: string;

  @Column({ type: 'uuid', index: true })
  assetId!: string;

  @CreateDateColumn({ default: () => 'clock_timestamp()', index: true })
  deletedAt!: Generated<Timestamp>;
}
