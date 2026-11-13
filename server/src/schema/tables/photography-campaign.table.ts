import { Column, ForeignKeyColumn, PrimaryGeneratedColumn, Table } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { UserTable } from 'src/schema/tables/user.table.js';

@Table('photography_contact')
export class PhotographyContactTable {
  @PrimaryGeneratedColumn() id!: Generated<string>;
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', index: false }) ownerId!: string;
  @Column() email!: string;
  @Column() name!: string;
  @Column() source!: string;
  @Column() unsubscribeToken!: string;
  @Column({ type: 'timestamp with time zone', nullable: true }) unsubscribedAt!: Timestamp | null;
}
@Table('photography_campaign')
export class PhotographyCampaignTable {
  @PrimaryGeneratedColumn() id!: Generated<string>;
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', index: false }) ownerId!: string;
  @Column() name!: string;
  @Column() templateKey!: string;
  @Column() subject!: string;
  @Column() body!: string;
  @Column({ type: 'jsonb' }) audience!: { source: string; workflowId?: string };
  @Column({ type: 'uuid', default: () => 'gen_random_uuid()' }) revision!: Generated<string>;
  @Column({ default: 'draft' }) status!: Generated<string>;
  @Column({ type: 'timestamp with time zone', nullable: true }) scheduledFor!: Timestamp | null;
  @Column({ type: 'timestamp with time zone', default: () => 'now()' }) createdAt!: Generated<Timestamp>;
  @Column({ type: 'timestamp with time zone', nullable: true }) lastTestAt!: Timestamp | null;
  @Column({ type: 'timestamp with time zone', nullable: true }) pausedUntil!: Timestamp | null;
}
@Table('photography_campaign_delivery')
export class PhotographyCampaignDeliveryTable {
  @ForeignKeyColumn(() => PhotographyCampaignTable, { primary: true, onDelete: 'CASCADE', index: false })
  campaignId!: string;
  @ForeignKeyColumn(() => PhotographyContactTable, { primary: true, onDelete: 'CASCADE', index: false })
  contactId!: string;
  @Column({ default: 'pending' }) status!: Generated<string>;
  @Column({ type: 'timestamp with time zone', nullable: true }) attemptedAt!: Timestamp | null;
}
