import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  PrimaryGeneratedColumn,
  Table,
  Unique,
} from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { DesktopDeviceTable } from 'src/schema/tables/desktop-device.table.js';
import { SessionTable } from 'src/schema/tables/session.table.js';

@Table('desktop_worker_session')
@Unique({ columns: ['deviceId'] })
export class DesktopWorkerSessionTable {
  @PrimaryGeneratedColumn() id!: Generated<string>;
  @ForeignKeyColumn(() => DesktopDeviceTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' }) deviceId!: string;
  @ForeignKeyColumn(() => SessionTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' }) photoSessionId!: string;
  @Column({ type: 'bytea' }) tokenHash!: Buffer;
  @Column({ type: 'integer' }) authorizationEpoch!: number;
  @Column({ type: 'integer', default: 0 }) lastSequence!: Generated<number>;
  @Column({ type: 'jsonb', default: '[]' }) modelKeys!: Generated<string[]>;
  @Column({ type: 'timestamp with time zone' }) expiresAt!: Timestamp;
  @Column({ type: 'timestamp with time zone', nullable: true }) revokedAt!: Timestamp | null;
  @CreateDateColumn() createdAt!: Generated<Timestamp>;
}
