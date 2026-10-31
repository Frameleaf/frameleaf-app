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

@Table('desktop_worker_challenge')
@Unique({ columns: ['sessionId', 'requestId'] })
@Index({ columns: ['deviceId', 'expiresAt'] })
@Check({ name: 'desktop_worker_challenge_credential_check', expression: 'octet_length("credentialHash") = 32' })
@Check({ name: 'desktop_worker_challenge_size_check', expression: 'octet_length("specJson") BETWEEN 1 AND 1048576' })
@Check({
  name: 'desktop_worker_challenge_receipt_check',
  expression:
    '("reportSha256" IS NULL AND "runtimeFingerprint" IS NULL AND "reportedAt" IS NULL) OR ("reportSha256" IS NOT NULL AND "runtimeFingerprint" IS NOT NULL AND "reportedAt" IS NOT NULL)',
})
export class DesktopWorkerChallengeTable {
  @PrimaryGeneratedColumn() id!: Generated<string>;
  @ForeignKeyColumn(() => DesktopDeviceTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' }) deviceId!: string;
  @ForeignKeyColumn(() => DesktopWorkerSessionTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' }) sessionId!: string;
  @Column({ type: 'uuid' }) requestId!: string;
  @Column({ type: 'integer' }) authorizationEpoch!: number;
  @Column({ type: 'bytea' }) credentialHash!: Buffer;
  @Column() modelKey!: string;
  @Column() profileSha256!: string;
  @Column({ type: 'jsonb' }) runtime!: DesktopRuntimeIdentity;
  @Column() specJson!: string;
  @Column() bindingSha256!: string;
  @CreateDateColumn() createdAt!: Generated<Timestamp>;
  @Column({ type: 'timestamp with time zone' }) expiresAt!: Timestamp;
  @Column({ nullable: true }) reportSha256!: string | null;
  @Column({ nullable: true }) runtimeFingerprint!: string | null;
  @Column({ type: 'timestamp with time zone', nullable: true }) reportedAt!: Timestamp | null;
}
