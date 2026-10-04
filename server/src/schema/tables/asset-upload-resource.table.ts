import { Column, CreateDateColumn, ForeignKeyColumn, Index, PrimaryGeneratedColumn, Table } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import type { Int8Writable } from 'src/schema/int8-writable.js';
import type { AssetUploadMetadata } from 'src/utils/asset-upload-resource.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/** Keep orphaned file ownership after account deletion until the cleanup has completed. */
@Table('asset_upload_resource')
export class AssetUploadResourceTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;
  @ForeignKeyColumn(() => UserTable, { nullable: true, onDelete: 'SET NULL', onUpdate: 'CASCADE' })
  ownerId!: string | null;
  @Column({ type: 'jsonb' })
  metadata!: AssetUploadMetadata;
  @Column({ type: 'bytea' })
  expectedChecksum!: Buffer;
  @Column({ type: 'text' })
  contentType!: string;
  @Column({ type: 'bigint', nullable: true })
  expectedSize!: Int8Writable | null;
  @Column({ type: 'bigint', default: 0 })
  offset!: Generated<Int8Writable>;
  @Column({ type: 'bigint' })
  maxSize!: Int8Writable;
  @Column({ type: 'bigint' })
  maxAppendSize!: Int8Writable;
  @Column({ type: 'text', default: 'receiving' })
  state!: Generated<
    | 'receiving'
    | 'pair-receiving'
    | 'finalizing'
    | 'pair-finalizing'
    | 'verified'
    | 'pair-verified'
    | 'published'
    | 'rejected'
    | 'cancelled'
  >;
  @Column({ type: 'text', nullable: true })
  finalPath!: string | null;
  @Column({ type: 'bytea', nullable: true })
  verifiedChecksum!: Buffer | null;
  @Column({ type: 'bytea', nullable: true })
  legacyChecksum!: Buffer | null;
  /** No target FK: deletion does not turn an uncertain publication into a new creation. */
  @Column({ type: 'uuid', nullable: true })
  resultAssetId!: string | null;
  @Column({ type: 'text', nullable: true })
  resultStatus!: 'created' | 'duplicate' | null;
  @Column({ type: 'boolean', default: false })
  ingested!: Generated<boolean>;
  @Column({ type: 'uuid', nullable: true })
  ingestionToken!: string | null;
  @Column({ type: 'timestamp with time zone', nullable: true })
  ingestionLeaseExpiresAt!: Timestamp | null;
  @Column({ type: 'timestamp with time zone', index: true })
  expiresAt!: Timestamp;
  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}

@Table('asset_upload_part')
@Index({ columns: ['resourceId', 'offset'], unique: true })
export class AssetUploadPartTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;
  @ForeignKeyColumn(() => AssetUploadResourceTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  resourceId!: string;
  @Column({ type: 'text' })
  path!: string;
  @Column({ type: 'bigint' })
  offset!: Int8Writable;
  @Column({ type: 'bigint' })
  size!: Int8Writable;
  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
