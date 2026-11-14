import { Column, ForeignKeyColumn, PrimaryGeneratedColumn, Table } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { PhotographyPaymentTable } from 'src/schema/tables/photography-payment.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

export type BookingAddOn = { id: string; name: string; price: number; maxQuantity: number };
export type BookedAddOn = { id: string; name: string; price: number; quantity: number };

/** FL-1049: a session clients can request from the studio website, with its price, deposit and paid add-ons. */
@Table('photography_booking_type')
export class PhotographyBookingTypeTable {
  @PrimaryGeneratedColumn() id!: Generated<string>;
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', index: false }) ownerId!: string;
  @Column() name!: string;
  @Column({ default: '' }) description!: Generated<string>;
  @Column({ type: 'integer' }) durationMinutes!: number;
  @Column({ type: 'integer' }) price!: number;
  @Column({ type: 'integer', default: 0 }) deposit!: Generated<number>;
  @Column() currency!: string;
  @Column({ type: 'boolean', default: true }) active!: Generated<boolean>;
  @Column({ type: 'jsonb', default: '[]' }) addOns!: Generated<BookingAddOn[]>;
  @Column({ type: 'integer', default: 0 }) order!: Generated<number>;
  @Column({ type: 'timestamp with time zone', default: () => 'now()' }) createdAt!: Generated<Timestamp>;
}
/** FL-1049: a client's booking request, priced on the server; `status` is requested, confirmed, declined or cancelled. */
@Table('photography_booking')
export class PhotographyBookingTable {
  @PrimaryGeneratedColumn() id!: Generated<string>;
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', index: false }) ownerId!: string;
  @ForeignKeyColumn(() => PhotographyBookingTypeTable, { onDelete: 'SET NULL', nullable: true, index: false })
  bookingTypeId!: string | null;
  @Column() typeName!: string;
  @Column() clientName!: string;
  @Column() clientEmail!: string;
  @Column({ default: '' }) message!: Generated<string>;
  @Column({ type: 'jsonb', default: '[]' }) preferredDates!: Generated<string[]>;
  @Column({ type: 'jsonb', default: '[]' }) addOns!: Generated<BookedAddOn[]>;
  @Column({ type: 'integer' }) total!: number;
  @Column({ type: 'integer', default: 0 }) deposit!: Generated<number>;
  @Column() currency!: string;
  @ForeignKeyColumn(() => PhotographyPaymentTable, { onDelete: 'SET NULL', nullable: true, index: false })
  depositPaymentId!: string | null;
  @Column({ default: 'requested' }) status!: Generated<string>;
  @Column({ type: 'timestamp with time zone', default: () => 'now()' }) requestedAt!: Generated<Timestamp>;
}
