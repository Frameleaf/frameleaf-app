import { Column, Index, PrimaryColumn, Table } from '@frameleaf/sql-tools';
import type { Timestamp } from '@frameleaf/sql-tools';

/** Latest actual physical deletion. No asset/user FK: capture survives cascades and audit pruning.
 * ponytail: retain conservatively; authoritative kept-history/parent-motion pruning needs a later bounded job.
 */
@Table('asset_backup_deletion')
// FL-813: every upload asks whether the owner deleted these bytes
@Index({ name: 'asset_backup_deletion_ownerId_checksum_idx', columns: ['ownerId', 'checksum'] })
export class AssetBackupDeletionTable {
  @PrimaryColumn({ type: 'uuid' }) assetId!: string;
  @Column({ type: 'uuid', index: true }) ownerId!: string;
  @Column({ type: 'timestamp with time zone' }) deletedAt!: Timestamp;
  @Column({ type: 'text' }) visibility!: string;
  @Column({ type: 'boolean' }) wasLocked!: boolean;
  @Column({ type: 'bytea', nullable: true }) checksum!: Buffer | null;
  @Column({ type: 'text', nullable: true }) checksumAlgorithm!: string | null;
  @Column({ type: 'uuid', nullable: true, index: true }) livePhotoVideoId!: string | null;
  @Column({ type: 'integer' }) evidenceVersion!: number;
  @Column({ type: 'boolean' }) modernPrivacyEvidenceUnavailable!: boolean;
}
