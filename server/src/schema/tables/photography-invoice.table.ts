import { Column, ForeignKeyColumn, PrimaryGeneratedColumn, Table } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { UserTable } from 'src/schema/tables/user.table.js';

export type InvoiceLine = { description: string; quantity: number; unitPrice: number };
export type InvoiceScheduleItem = { dueOn: string; amount: number };

/** FL-1081: an itemised invoice. Amounts are integers in the smallest currency unit; payments are photography_payment rows. */
@Table('photography_invoice')
export class PhotographyInvoiceTable {
  @PrimaryGeneratedColumn() id!: Generated<string>;
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', index: false }) ownerId!: string;
  @Column({ type: 'integer' }) number!: number;
  @Column() clientName!: string;
  @Column() clientEmail!: string;
  @Column({ type: 'jsonb' }) lines!: InvoiceLine[];
  @Column({ type: 'integer' }) taxBasisPoints!: number;
  @Column() currency!: string;
  @Column({ type: 'integer' }) subtotal!: number;
  @Column({ type: 'integer' }) tax!: number;
  @Column({ type: 'integer' }) total!: number;
  @Column({ type: 'jsonb' }) schedule!: InvoiceScheduleItem[];
  @Column({ type: 'boolean', default: true }) reminders!: Generated<boolean>;
  @Column({ default: 'draft' }) status!: Generated<string>;
  /** SHA-256 of every link emailed for this invoice (sending and reminders); voiding clears them. */
  @Column({ type: 'text', array: true, default: [] }) tokenHashes!: Generated<string[]>;
  @Column({ type: 'timestamp with time zone', nullable: true }) sentAt!: Timestamp | null;
  @Column({ type: 'date', nullable: true }) lastReminderOn!: string | null;
  @Column({ type: 'timestamp with time zone', default: () => 'now()' }) createdAt!: Generated<Timestamp>;
}
