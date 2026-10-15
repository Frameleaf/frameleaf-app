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
import { DesktopDeviceTable } from 'src/schema/tables/desktop-device.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

@Table('desktop_ml_task')
@Index({ columns: ['modelKey', 'state', 'createdAt'] })
@Check({
  name: 'desktop_ml_task_state_check',
  expression: `state IN ('pending', 'running', 'completed', 'cancelled', 'failed', 'consumed')`,
})
@Check({ name: 'desktop_ml_task_kind_check', expression: `"inputKind" IN ('image', 'text')` })
@Check({ name: 'desktop_ml_task_input_size_check', expression: `octet_length(input) <= 16777216` })
export class DesktopMlTaskTable {
  @PrimaryGeneratedColumn() id!: Generated<string>;
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' }) ownerId!: string;
  @Column() modelKey!: string;
  @Column() authorityKey!: string;
  @Column({ type: 'jsonb' }) config!: Record<string, unknown>;
  @Column() configSha256!: string;
  @Column() inputSha256!: string;
  @Column() inputKind!: 'image' | 'text';
  @Column({ type: 'bytea', nullable: true }) input!: Buffer | null;
  @Column({ default: 'pending' }) state!: Generated<
    'pending' | 'running' | 'completed' | 'cancelled' | 'failed' | 'consumed'
  >;
  @Column({ type: 'integer', default: 0 }) generation!: Generated<number>;
  @Column({ type: 'uuid', nullable: true }) attemptId!: string | null;
  @Column({ nullable: true }) resultSha256!: string | null;
  @Column({ type: 'jsonb', nullable: true }) result!: Record<string, unknown> | null;
  @CreateDateColumn() createdAt!: Generated<Timestamp>;
  @Column({ type: 'timestamp with time zone' }) deadlineAt!: Timestamp;
}

@Table('desktop_ml_attempt')
@Unique({ columns: ['taskId', 'generation'] })
@Index({ columns: ['taskId', 'createdAt'] })
@Index({ columns: ['deviceId', 'expiresAt'] })
export class DesktopMlAttemptTable {
  @PrimaryGeneratedColumn() id!: Generated<string>;
  @ForeignKeyColumn(() => DesktopMlTaskTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' }) taskId!: string;
  @ForeignKeyColumn(() => DesktopDeviceTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' }) deviceId!: string;
  @Column({ type: 'uuid', nullable: true }) workerSessionId!: string | null;
  @Column({ type: 'integer' }) authorizationEpoch!: number;
  @Column({ type: 'integer' }) generation!: number;
  @CreateDateColumn() createdAt!: Generated<Timestamp>;
  @Column({ type: 'timestamp with time zone' }) expiresAt!: Timestamp;
  @Column({ nullable: true }) outcome!: 'expired' | 'completed' | 'cancelled' | 'failed' | null;
}
