import { Column, ForeignKeyColumn, PrimaryGeneratedColumn, Table } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { UserTable } from 'src/schema/tables/user.table.js';

@Table('photography_contract_template')
export class PhotographyContractTemplateTable {
  @PrimaryGeneratedColumn() id!: Generated<string>;
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', index: false }) ownerId!: string;
  @Column() name!: string;
  @Column() body!: string;
  @Column({ type: 'timestamp with time zone', default: () => 'now()' }) createdAt!: Generated<Timestamp>;
  @Column({ type: 'timestamp with time zone', default: () => 'now()' }) updatedAt!: Generated<Timestamp>;
}
@Table('photography_contract')
export class PhotographyContractTable {
  @PrimaryGeneratedColumn() id!: Generated<string>;
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', index: false }) ownerId!: string;
  @ForeignKeyColumn(() => PhotographyContractTemplateTable, { onDelete: 'SET NULL', nullable: true, index: false })
  templateId!: string | null;
  @Column() name!: string;
  @Column() clientName!: string;
  @Column() clientEmail!: string;
  @Column() body!: string;
  @Column() documentSha256!: string;
  @Column({ default: 'draft' }) status!: Generated<string>;
  @Column({ nullable: true }) tokenHash!: string | null;
  @Column({ type: 'timestamp with time zone', nullable: true }) tokenExpiresAt!: Timestamp | null;
  @Column({ type: 'timestamp with time zone', default: () => 'now()' }) createdAt!: Generated<Timestamp>;
  @Column({ type: 'timestamp with time zone', nullable: true }) sentAt!: Timestamp | null;
  @Column({ type: 'timestamp with time zone', nullable: true }) signedAt!: Timestamp | null;
  @Column({ nullable: true }) signerName!: string | null;
  @Column({ nullable: true }) signatureType!: string | null;
  @Column({ type: 'bytea', nullable: true }) signaturePng!: Buffer | null;
  @Column({ nullable: true }) pdfPath!: string | null;
  @Column({ nullable: true }) finalPdfSha256!: string | null;
}
@Table('photography_contract_event')
export class PhotographyContractEventTable {
  @ForeignKeyColumn(() => PhotographyContractTable, { primary: true, onDelete: 'CASCADE', index: false })
  contractId!: string;
  @Column({ type: 'integer', primary: true }) seq!: number;
  @Column() type!: string;
  @Column() actor!: string;
  @Column({ type: 'timestamp with time zone' }) at!: Timestamp;
  @Column({ nullable: true }) ip!: string | null;
  @Column({ nullable: true }) userAgent!: string | null;
  @Column({ type: 'jsonb' }) data!: Record<string, unknown>;
  @Column({ nullable: true }) prevEventSha256!: string | null;
  @Column() sha256!: string;
}
