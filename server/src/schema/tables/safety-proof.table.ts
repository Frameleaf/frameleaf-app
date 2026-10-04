import { Column, ForeignKeyColumn, PrimaryColumn, Table } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { CloudBackupManifestTable } from 'src/schema/tables/cloud-backup.table.js';
import { MediaOperationTable } from 'src/schema/tables/media-operation.table.js';

export type IntegrityVerificationResult = 'passed' | 'mismatched' | 'missing' | 'unreadable';
export type CloudBackupVerificationMethod = 'sha256-get' | 'size-head';
export type CloudBackupVerificationResult = 'passed' | 'missing' | 'mismatched';

/** The latest actual check, separate from the immutable original checksum baseline. */
@Table('asset_integrity_verification')
export class AssetIntegrityVerificationTable {
  @ForeignKeyColumn(() => AssetTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  assetId!: string;

  @Column({ type: 'text' })
  originalPath!: string;

  @Column({ type: 'bytea' })
  expectedChecksum!: Buffer;

  @Column({ type: 'text', nullable: true })
  checksumAlgorithm!: string | null;

  @Column({ type: 'text', nullable: true })
  actualSha256!: string | null;

  @Column({ type: 'text' })
  result!: IntegrityVerificationResult;

  @Column({ type: 'timestamp with time zone', default: () => 'clock_timestamp()' })
  checkedAt!: Generated<Timestamp>;
}

/** Durable original membership; deleted assets remain history, never current library membership. */
@Table('cloud_backup_manifest_original')
export class CloudBackupManifestOriginalTable {
  @ForeignKeyColumn(() => CloudBackupManifestTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  manifestId!: string;

  @PrimaryColumn({ type: 'uuid' })
  assetId!: string;

  @Column({ type: 'text' })
  sha256!: string;
}

/** Actual object checks. A row alone does not prove that its verification run completed. */
@Table('cloud_backup_object_verification')
export class CloudBackupObjectVerificationTable {
  @PrimaryColumn({ type: 'text' })
  bucket!: string;

  @PrimaryColumn({ type: 'text' })
  sha256!: string;

  @ForeignKeyColumn(() => MediaOperationTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  operationId!: string;

  @Column({ type: 'text' })
  method!: CloudBackupVerificationMethod;

  @Column({ type: 'text' })
  result!: CloudBackupVerificationResult;

  @Column({ type: 'timestamp with time zone', default: () => 'clock_timestamp()' })
  checkedAt!: Generated<Timestamp>;
}
