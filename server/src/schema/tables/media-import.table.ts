import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  Index,
  Table,
  Unique,
  UpdateDateColumn,
} from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import type { MediaDownloadEntry, MediaDownloadInspection } from 'src/repositories/media-downloader.repository.js';
import { PrimaryGeneratedUuidV7Column } from 'src/decorators.js';
import { AlbumTable } from 'src/schema/tables/album.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

export type MediaImportState =
  | 'inspecting'
  | 'ready'
  | 'queued'
  | 'downloading'
  | 'assembling'
  | 'importing'
  | 'saved'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'paused';
export type MediaHistory = { mode: 'all' | 'since' | 'new'; since?: string };

@Table('media_connection')
@Index({ columns: ['ownerId'] })
export class MediaConnectionTable {
  @PrimaryGeneratedUuidV7Column() id!: Generated<string>;
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' }) ownerId!: string;
  @Column() provider!: string;
  @Column() label!: string;
  @Column({ type: 'jsonb' }) domains!: string[];
  @Column({ type: 'text', nullable: true }) encryptedSession!: string | null;
  @Column({ default: 'connected' }) status!: Generated<'connected' | 'expired' | 'disconnected'>;
  @Column({ type: 'integer', default: 1 }) revision!: Generated<number>;
  @CreateDateColumn() createdAt!: Generated<Timestamp>;
  @UpdateDateColumn() updatedAt!: Generated<Timestamp>;
}

@Table('media_subscription')
@Unique({ columns: ['ownerId', 'idempotencyKey'] })
@Index({ columns: ['ownerId'] })
@Index({ columns: ['status', 'nextCheckAt'] })
export class MediaSubscriptionTable {
  @PrimaryGeneratedUuidV7Column() id!: Generated<string>;
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' }) ownerId!: string;
  @Column() idempotencyKey!: string;
  @Column() requestHash!: string;
  @Column() provider!: string;
  @Column() creatorId!: string;
  @Column() creator!: string;
  @Column({ type: 'text' }) url!: string;
  @Column({ type: 'text', nullable: true }) extractionUrl!: string | null;
  @ForeignKeyColumn(() => AlbumTable, { nullable: true, onDelete: 'SET NULL', onUpdate: 'CASCADE' }) albumId!:
    string | null;
  @ForeignKeyColumn(() => MediaConnectionTable, { nullable: true, onDelete: 'SET NULL', onUpdate: 'CASCADE' })
  connectionId!: string | null;
  @Column({ type: 'uuid', nullable: true }) apiKeyId!: string | null;
  @Column({ type: 'jsonb' }) history!: MediaHistory;
  @Column({ type: 'integer', default: 60 }) intervalMinutes!: Generated<number>;
  @Column({ default: 'active' }) status!: Generated<'active' | 'paused' | 'attention' | 'unsubscribed'>;
  @Column({ type: 'integer', default: 1 }) generation!: Generated<number>;
  @Column({ type: 'text', nullable: true }) checkpoint!: string | null;
  @Column({ type: 'boolean', default: false }) historyComplete!: Generated<boolean>;
  @Column({ type: 'timestamp with time zone', default: () => 'now()' }) nextCheckAt!: Generated<Timestamp>;
  @Column({ type: 'timestamp with time zone', nullable: true }) lastSuccessAt!: Timestamp | null;
  @Column({ type: 'timestamp with time zone', nullable: true }) lastReconcileAt!: Timestamp | null;
  @Column({ type: 'text', nullable: true }) limitation!: string | null;
  @Column({ type: 'text', nullable: true }) error!: string | null;
  @CreateDateColumn() createdAt!: Generated<Timestamp>;
  @UpdateDateColumn() updatedAt!: Generated<Timestamp>;
}

@Table('media_import')
@Unique({ columns: ['ownerId', 'idempotencyKey'] })
@Index({ columns: ['ownerId', 'createdAt'] })
@Index({ columns: ['state'] })
export class MediaImportTable {
  @PrimaryGeneratedUuidV7Column() id!: Generated<string>;
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' }) ownerId!: string;
  @Column({ nullable: true }) idempotencyKey!: string | null;
  @Column({ nullable: true }) requestHash!: string | null;
  @Column({ default: 'media-import.create' }) authorization!: Generated<
    'media-import.create' | 'media-subscription.write'
  >;
  @Column({ type: 'uuid', nullable: true }) apiKeyId!: string | null;
  @ForeignKeyColumn(() => MediaSubscriptionTable, { nullable: true, onDelete: 'SET NULL', onUpdate: 'CASCADE' })
  subscriptionId!: string | null;
  @Column({ type: 'integer', nullable: true }) subscriptionGeneration!: number | null;
  @ForeignKeyColumn(() => MediaConnectionTable, { nullable: true, onDelete: 'SET NULL', onUpdate: 'CASCADE' })
  connectionId!: string | null;
  @Column({ type: 'integer', nullable: true }) connectionRevision!: number | null;
  @ForeignKeyColumn(() => AlbumTable, { nullable: true, onDelete: 'SET NULL', onUpdate: 'CASCADE' }) albumId!:
    string | null;
  @Column({ type: 'jsonb', default: '[]' }) tagIds!: Generated<string[]>;
  @Column({ type: 'jsonb' }) urls!: string[];
  @Column({ default: 'inspecting' }) state!: Generated<MediaImportState>;
  @Column({ type: 'integer', default: 1 }) generation!: Generated<number>;
  @Column({ type: 'uuid', nullable: true }) jobRunId!: string | null;
  @Column({ type: 'boolean', default: false }) streamMp4!: Generated<boolean>;
  @Column({ type: 'boolean', default: false }) overrideSuppression!: Generated<boolean>;
  @Column({ type: 'jsonb', nullable: true }) inspection!: Omit<MediaDownloadInspection, 'entries'> | null;
  @Column({ type: 'text', nullable: true }) error!: string | null;
  @Column({ type: 'integer', default: 0 }) retries!: Generated<number>;
  @Column({ type: 'timestamp with time zone', default: () => 'now()' }) availableAt!: Generated<Timestamp>;
  @Column({ type: 'jsonb', default: '[]' }) retryKeys!: Generated<string[]>;
  @CreateDateColumn() createdAt!: Generated<Timestamp>;
  @UpdateDateColumn() updatedAt!: Generated<Timestamp>;
}

@Table('media_import_item')
@Unique({ columns: ['importId', 'sourceKey'] })
@Index({ columns: ['ownerId', 'sourceKey'] })
@Index({ columns: ['assetId'] })
export class MediaImportItemTable {
  @PrimaryGeneratedUuidV7Column() id!: Generated<string>;
  @ForeignKeyColumn(() => MediaImportTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' }) importId!: string;
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' }) ownerId!: string;
  @Column() sourceKey!: string;
  @Column({ type: 'jsonb' }) entry!: MediaDownloadEntry;
  @Column({ default: 'discovered' }) state!: Generated<
    'discovered' | 'downloading' | 'assembling' | 'importing' | 'saved' | 'skipped' | 'failed'
  >;
  /** Receipts survive deletion; never infer that a missing asset was never imported. */
  @Column({ type: 'uuid', nullable: true }) assetId!: string | null;
  @Column({ type: 'uuid', nullable: true }) uploadId!: string | null;
  @Column({ type: 'text', nullable: true }) suppression!: 'owner' | 'subscription' | null;
  @Column({ type: 'text', nullable: true }) error!: string | null;
  @Column({ type: 'double precision', default: 0 }) bytes!: Generated<number>;
  @CreateDateColumn() createdAt!: Generated<Timestamp>;
  @UpdateDateColumn() updatedAt!: Generated<Timestamp>;
}
