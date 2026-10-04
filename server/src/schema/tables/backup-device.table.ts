import { Column, ForeignKeyColumn, PrimaryGeneratedColumn, Table, Unique } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import type { ReconciliationProgress } from 'src/utils/backup-reconciliation.js';
import { UserTable } from 'src/schema/tables/user.table.js';

@Table('backup_device')
@Unique({ columns: ['ownerId', 'deviceKey'] })
export class BackupDeviceTable {
  @PrimaryGeneratedColumn() id!: Generated<string>;
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' }) ownerId!: string;
  @Column({ type: 'uuid' }) deviceKey!: string;
  @Column({ type: 'text' }) displayName!: string;
  @Column({ type: 'text' }) model!: string;
  @Column({ type: 'text' }) platform!: string;
  @Column({ type: 'text' }) appVersion!: string;
  @Column({ type: 'timestamp with time zone', default: () => 'clock_timestamp()' }) reportedAt!: Generated<Timestamp>;
  @Column({ type: 'timestamp with time zone', nullable: true }) lastSuccessfulBackupAt!: Timestamp | null;
  @Column({ type: 'integer' }) pendingCount!: number;
  @Column({ type: 'timestamp with time zone', nullable: true }) deletedAt!: Timestamp | null;
}

/** Inventory audit history survives device removal (soft delete), never deletes originals. */
@Table('backup_reconciliation')
export class BackupReconciliationTable {
  @PrimaryGeneratedColumn() id!: Generated<string>;
  @ForeignKeyColumn(() => BackupDeviceTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' }) deviceId!: string;
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' }) ownerId!: string;
  @Column({ type: 'timestamp with time zone', default: () => 'clock_timestamp()' }) startedAt!: Generated<Timestamp>;
  @Column({ type: 'timestamp with time zone' }) checkedAt!: Timestamp;
  @Column({ type: 'timestamp with time zone', nullable: true }) completedAt!: Timestamp | null;
  @Column({ type: 'integer' }) itemsChecked!: number;
  @Column({ type: 'integer' }) itemsMissing!: number;
  @Column({ type: 'jsonb' }) progress!: ReconciliationProgress;
}
