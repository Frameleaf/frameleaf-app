import {
  Check,
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  Index,
  PrimaryGeneratedColumn,
  Table,
  Unique,
} from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import type { DesktopRuntimeIdentity } from 'src/utils/desktop-qualification.js';
import { DesktopDeviceTable } from 'src/schema/tables/desktop-device.table.js';
import { DesktopWorkerSessionTable } from 'src/schema/tables/desktop-worker-session.table.js';

@Table('desktop_worker_qualification')
@Unique({ columns: ['sessionId', 'modelKey'] })
@Index({ columns: ['deviceId', 'expiresAt'] })
@Check({ name: 'desktop_worker_qualification_kind_check', expression: `"inputKind" IN ('image', 'text')` })
@Check({
  name: 'desktop_worker_qualification_lifetime_check',
  expression: `"expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + interval '1 hour'`,
})
export class DesktopWorkerQualificationTable {
  @PrimaryGeneratedColumn() id!: Generated<string>;
  @ForeignKeyColumn(() => DesktopDeviceTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' }) deviceId!: string;
  @ForeignKeyColumn(() => DesktopWorkerSessionTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' }) sessionId!: string;
  @Column({ type: 'integer' }) authorizationEpoch!: number;
  @Column() modelKey!: string;
  @Column() profileSha256!: string;
  @Column() configSha256!: string;
  @Column() inputKind!: 'image' | 'text';
  @Column({ type: 'jsonb' }) runtime!: DesktopRuntimeIdentity;
  @Column() runtimeFingerprint!: string;
  @Column() reportSha256!: string;
  @CreateDateColumn() createdAt!: Generated<Timestamp>;
  @Column({ type: 'timestamp with time zone' }) expiresAt!: Timestamp;
}

export type DesktopQualificationTables = { desktop_worker_qualification: DesktopWorkerQualificationTable };
