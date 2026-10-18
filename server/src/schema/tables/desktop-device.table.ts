import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  PrimaryGeneratedColumn,
  Table,
  Unique,
} from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import type { DesktopEnrollmentDto } from 'src/dtos/desktop.dto.js';
import { UserTable } from 'src/schema/tables/user.table.js';

@Table('desktop_device')
@Unique({ columns: ['userId', 'installationId'] })
export class DesktopDeviceTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  userId!: string;

  @Column({ type: 'uuid' })
  installationId!: string;

  @Column()
  publicKey!: string;

  @Column()
  name!: string;

  @Column()
  platform!: DesktopEnrollmentDto['platform'];

  @Column()
  architecture!: DesktopEnrollmentDto['architecture'];

  @Column()
  mode!: DesktopEnrollmentDto['mode'];

  @Column()
  state!: 'awaiting-approval' | 'preparing' | 'paused' | 'revoked';

  @Column({ type: 'integer', default: 1 })
  authorizationEpoch!: Generated<number>;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @Column({ type: 'timestamp with time zone', nullable: true })
  revokedAt!: Timestamp | null;
}
