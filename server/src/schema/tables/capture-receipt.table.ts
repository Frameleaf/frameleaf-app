import { Column, CreateDateColumn, ForeignKeyColumn, PrimaryColumn, Table } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { UserTable } from 'src/schema/tables/user.table.js';

@Table('capture_receipt')
export class CaptureReceiptTable {
  @ForeignKeyColumn(() => UserTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  ownerId!: string;

  @PrimaryColumn({ type: 'uuid' })
  captureId!: string;

  @Column({ type: 'text' })
  actorId!: string;

  @Column({ type: 'bytea' })
  requestHash!: Buffer;

  @Column({ type: 'text' })
  kind!: 'asset' | 'bookmark';

  // A removed item must never turn a retry of its receipt into another creation.
  @Column({ type: 'uuid' })
  itemId!: string;

  @Column({ type: 'text' })
  status!: 'created' | 'duplicate';

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
