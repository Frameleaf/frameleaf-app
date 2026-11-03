import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  Table,
  Unique,
} from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { PhotoSourceTable } from 'src/schema/tables/photo-source.table.js';
import { SessionTable } from 'src/schema/tables/session.table.js';

@Table('source_resource_grant')
@Unique({ columns: ['sourceId'] })
export class SourceResourceGrantTable {
  @PrimaryGeneratedColumn() id!: Generated<string>;
  @ForeignKeyColumn(() => PhotoSourceTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  sourceId!: string;
  @ForeignKeyColumn(() => SessionTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' }) photoSessionId!: string;
  @Column({ type: 'bytea' }) tokenHash!: Buffer;
  @Column() scopeFingerprint!: string;
  @Column({ type: 'integer' }) authorizationEpoch!: number;
  @Column({ type: 'integer', default: 0 }) lastSequence!: Generated<number>;
  @Column({ type: 'timestamp with time zone' }) expiresAt!: Timestamp;
  @Column({ type: 'timestamp with time zone', nullable: true }) revokedAt!: Timestamp | null;
  @CreateDateColumn() createdAt!: Generated<Timestamp>;
}

@Table('source_resource_grant_nonce')
export class SourceResourceGrantNonceTable {
  @ForeignKeyColumn(() => PhotoSourceTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  sourceId!: string;
  @PrimaryColumn({ type: 'uuid' }) requestId!: string;
  @Column({ type: 'timestamp with time zone' }) expiresAt!: Timestamp;
}
