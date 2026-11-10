import { Column, Index, PrimaryColumn, Table } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';

/**
 * FL-879: one restore drill and its signed report. The id is the drill's `cloud_backup` operation id.
 * `report` is the canonical JSON that was signed; `signature` is its Ed25519 signature (base64url) by
 * the server identity key named by `keyFingerprint` (RFC 7638 thumbprint) and `signerKey` (public JWK).
 */
@Table('backup_restore_report')
@Index({ columns: ['startedAt'] })
export class BackupRestoreReportTable {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'text' })
  target!: string;

  @Column({ type: 'text', default: 'manual' })
  trigger!: Generated<string>;

  @Column({ type: 'timestamp with time zone' })
  startedAt!: Timestamp;

  @Column({ type: 'timestamp with time zone', nullable: true })
  finishedAt!: Timestamp | null;

  @Column({ type: 'text', default: 'running' })
  result!: Generated<string>;

  @Column({ type: 'text', nullable: true })
  failedStep!: string | null;

  @Column({ type: 'jsonb', default: '{}' })
  counts!: Generated<Record<string, unknown>>;

  @Column({ type: 'integer', default: 0 })
  sampleSize!: Generated<number>;

  @Column({ type: 'jsonb', default: '[]' })
  mismatches!: Generated<unknown[]>;

  @Column({ type: 'jsonb', nullable: true })
  report!: Record<string, unknown> | null;

  @Column({ type: 'text', nullable: true })
  signature!: string | null;

  @Column({ type: 'text', nullable: true })
  keyFingerprint!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  signerKey!: Record<string, unknown> | null;
}
