import {
  Check,
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  Table,
  Unique,
} from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import type { ConnectProvenance } from 'src/dtos/connect-media.dto.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { OAuthGrantTable } from 'src/schema/tables/oauth-app.table.js';

@Table('connect_receipt')
@Unique({ columns: ['grantId', 'operation', 'requestId'] })
@Check({ name: 'connect_receipt_hash_check', expression: 'octet_length("requestHash") = 32' })
export class ConnectReceiptTable {
  @PrimaryGeneratedColumn() id!: Generated<string>;
  @ForeignKeyColumn(() => OAuthGrantTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' }) grantId!: string;
  @Column({ type: 'text' }) operation!: 'album-create' | 'upload-start' | 'upload-commit';
  @Column({ type: 'text' }) requestId!: string;
  @Column({ type: 'bytea' }) requestHash!: Buffer;
  @Column({ type: 'text' }) status!: 'pending' | 'committed';
  /** No result FK: deleting media must never turn an old request into a new creation. */
  @Column({ type: 'uuid' }) resultId!: string;
  @Column({ type: 'jsonb' }) result!: Record<string, unknown>;
  @CreateDateColumn() createdAt!: Generated<Timestamp>;
  @Column({ type: 'timestamp with time zone', index: true }) expiresAt!: Timestamp;
}

@Table('connect_rendition_ticket')
export class ConnectRenditionTicketTable {
  @PrimaryColumn({ type: 'bytea' }) tokenHash!: Buffer;
  @ForeignKeyColumn(() => OAuthGrantTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' }) grantId!: string;
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' }) assetId!: string;
  @Column({ type: 'text' }) variant!: 'thumbnail' | 'preview' | 'display' | 'original';
  @Column({ type: 'timestamp with time zone', index: true }) expiresAt!: Timestamp;
}

@Table('connect_provenance')
@Index({ columns: ['assetId'] })
export class ConnectProvenanceTable {
  @PrimaryColumn({ type: 'uuid' }) uploadId!: string;
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false }) assetId!: string;
  @Column({ type: 'jsonb' }) source!: ConnectProvenance;
  @CreateDateColumn() createdAt!: Generated<Timestamp>;
}
