import { Column, ForeignKeyColumn, PrimaryGeneratedColumn, Table } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { UserTable } from 'src/schema/tables/user.table.js';

/** FL-1041: a studio's payment link; the payer can't change its amount. */
@Table('photography_payment_link')
export class PhotographyPaymentLinkTable {
  @PrimaryGeneratedColumn() id!: Generated<string>;
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', index: false }) ownerId!: string;
  @Column({ unique: true }) slug!: string;
  @Column() title!: string;
  @Column({ default: '' }) description!: Generated<string>;
  @Column({ type: 'integer' }) amount!: number;
  @Column() currency!: string;
  @Column({ type: 'boolean', default: true }) reusable!: Generated<boolean>;
  @Column({ type: 'boolean', default: true }) active!: Generated<boolean>;
  @Column({ type: 'timestamp with time zone', default: () => 'now()' }) createdAt!: Generated<Timestamp>;
}
/** FL-1041: one payment attempt and how it ended (`pending`, `paid`, `failed`, `expired`, `refunded`). */
@Table('photography_payment')
export class PhotographyPaymentTable {
  @PrimaryGeneratedColumn() id!: Generated<string>;
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', index: false }) ownerId!: string;
  @ForeignKeyColumn(() => PhotographyPaymentLinkTable, { onDelete: 'SET NULL', nullable: true, index: false })
  linkId!: string | null;
  @Column({ type: 'integer' }) amount!: number;
  @Column() currency!: string;
  @Column() payerEmail!: string;
  @Column({ nullable: true }) checkoutId!: string | null;
  @Column({ nullable: true }) providerRef!: string | null;
  @Column({ default: 'pending' }) status!: Generated<string>;
  @Column({ type: 'timestamp with time zone', default: () => 'now()' }) createdAt!: Generated<Timestamp>;
  @Column({ type: 'timestamp with time zone', nullable: true }) paidAt!: Timestamp | null;
}
