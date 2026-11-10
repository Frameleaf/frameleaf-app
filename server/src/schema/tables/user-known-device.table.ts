import { Column, CreateDateColumn, ForeignKeyColumn, Table } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { UserTable } from 'src/schema/tables/user.table.js';

@Table({ name: 'user_known_device' })
export class UserKnownDeviceTable {
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true })
  userId!: string;

  @Column({ type: 'bytea', primary: true })
  fingerprintHash!: Buffer;

  @CreateDateColumn()
  firstSeenAt!: Generated<Timestamp>;

  @CreateDateColumn()
  lastSeenAt!: Generated<Timestamp>;
}
