import {
  Check,
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  Index,
  PrimaryGeneratedColumn,
  Table,
} from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { DevelopExportTable } from 'src/schema/tables/photo-tools.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

@Index({ name: 'IDX_develop_batch_ownerId', columns: ['ownerId'] })
@Index({ name: 'IDX_develop_batch_owner_cursor', columns: ['ownerId', 'createdAt', 'id'] })
@Table('develop_batch')
@Check({ name: 'develop_batch_status_check', expression: "status IN ('open','cancelled')" })
export class DevelopBatchTable {
  @PrimaryGeneratedColumn() id!: Generated<string>;
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', index: false }) ownerId!: string;
  @Column({ type: 'text', default: 'open' }) status!: Generated<string>;
  @Column({ type: 'boolean', default: true }) includeSidecars!: Generated<boolean>;
  @CreateDateColumn() createdAt!: Generated<Timestamp>;
}
@Table('develop_batch_item')
@Index({ name: 'IDX_develop_batch_item_batchId_assetId', columns: ['batchId', 'assetId'], unique: true })
@Index({ name: 'IDX_develop_batch_item_assetId', columns: ['assetId'] })
@Index({ name: 'IDX_develop_batch_item_exportId', columns: ['exportId'] })
@Check({ name: 'develop_batch_item_status_check', expression: "status IN ('pending','prepared','failed')" })
export class DevelopBatchItemTable {
  @PrimaryGeneratedColumn() id!: Generated<string>;
  @ForeignKeyColumn(() => DevelopBatchTable, { onDelete: 'CASCADE', index: false }) batchId!: string;
  @Column({ type: 'uuid' }) assetId!: string;
  @ForeignKeyColumn(() => DevelopExportTable, { onDelete: 'SET NULL', nullable: true, index: false }) exportId!:
    string | null;
  @Column({ type: 'text' }) fileName!: string;
  @Column({ type: 'boolean', default: false }) hasSidecar!: Generated<boolean>;
  @Column({ type: 'text', nullable: true }) error!: string | null;
  @Column({ type: 'text', nullable: true }) errorCode!: string | null;
  @Column({ type: 'text' }) exportName!: string;
  @Column({ type: 'text', default: 'pending' }) status!: Generated<string>;
  @CreateDateColumn() createdAt!: Generated<Timestamp>;
}
@Table('develop_batch_return')
@Index({ name: 'IDX_develop_batch_return_itemId_checksum', columns: ['itemId', 'checksum'], unique: true })
@Index({ name: 'IDX_develop_batch_return_revisionId', columns: ['revisionId'], unique: true })
@Index({
  name: 'IDX_develop_batch_return_pending',
  columns: ['stagedAt'],
  where: '"pendingMasterPath" IS NOT NULL AND "revisionId" IS NULL',
})
@Check({
  name: 'develop_batch_return_status_check',
  expression: "status IN ('confirmed','imported','completed','conflict','failed','cancelled')",
})
export class DevelopBatchReturnTable {
  @PrimaryGeneratedColumn() id!: Generated<string>;
  @ForeignKeyColumn(() => DevelopBatchItemTable, { onDelete: 'CASCADE', index: false }) itemId!: string;
  @Column({ type: 'text' }) checksum!: string;
  @Column({ type: 'uuid' }) confirmationId!: string;
  @Column({ type: 'boolean', default: false }) activationInvalidated!: Generated<boolean>;
  @Column({ type: 'uuid', nullable: true }) expectedCurrentRevisionId!: string | null;
  @Column({ type: 'uuid', nullable: true }) revisionId!: string | null;
  @Column({ type: 'text', nullable: true }) pendingMasterPath!: string | null;
  @Column({ type: 'timestamp with time zone', nullable: true }) stagedAt!: Timestamp | null;
  @Column({ type: 'bytea', nullable: true }) sourceIdentity!: Buffer | null;
  @Column({ type: 'boolean' }) locked!: boolean;
  @Column({ type: 'uuid', nullable: true }) sessionId!: string | null;
  @Column({ type: 'uuid', nullable: true }) apiKeyId!: string | null;
  @Column({ type: 'text', default: 'confirmed' }) status!: Generated<string>;
  @Column({ type: 'text', nullable: true }) error!: string | null;
  @Column({ type: 'text', nullable: true }) errorCode!: string | null;
  @CreateDateColumn() createdAt!: Generated<Timestamp>;
}
