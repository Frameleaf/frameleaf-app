import { Column, ForeignKeyColumn, PrimaryColumn, Table } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { UserTable } from 'src/schema/tables/user.table.js';
import type { CloudBackupDateRange, CloudBackupDecisionReason } from 'src/utils/cloud-backup-selection.js';

/**
 * FL-362: what one account chose for one backup destination (only `cloud` so far). No row means
 * Everything. A photo the account owns is kept when it matches any choice. Lives only in this database:
 * never in a manifest, a run report or coverage. Mirrors migration 2100000002990-CloudBackupSelection.
 */
@Table('cloud_backup_selection')
export class CloudBackupSelectionTable {
  @ForeignKeyColumn(() => UserTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  userId!: string;

  @PrimaryColumn({ type: 'text' })
  destination!: 'cloud';

  @Column({ type: 'uuid', array: true, default: [] })
  albumIds!: Generated<string[]>;

  @Column({ type: 'uuid', array: true, default: [] })
  collectionIds!: Generated<string[]>;

  /** The API's person ids (`asset_face.personGroupId`). */
  @Column({ type: 'uuid', array: true, default: [] })
  personIds!: Generated<string[]>;

  /** A tag also chooses the tags inside it. */
  @Column({ type: 'uuid', array: true, default: [] })
  tagIds!: Generated<string[]>;

  /** Folder paths as the Folders view names them; a folder also chooses the folders inside it. */
  @Column({ type: 'text', array: true, default: [] })
  folders!: Generated<string[]>;

  @Column({ type: 'boolean', default: false })
  favorites!: Generated<boolean>;

  @Column({ type: 'jsonb', default: '[]' })
  dateRanges!: Generated<CloudBackupDateRange[]>;

  @Column({ type: 'timestamp with time zone', default: () => 'now()' })
  updatedAt!: Generated<Timestamp>;
}

/**
 * FL-362: one run's inventory, written before the run's database copy so that copy carries it. Only the
 * latest run's record is kept here; each backed-up database copy holds its own.
 */
@Table('cloud_backup_decision_run')
export class CloudBackupDecisionRunTable {
  @PrimaryColumn({ type: 'uuid' })
  runId!: string;

  /** The manifest the run writes: how a restore finds the decision of the backup it restores. */
  @Column({ type: 'text' })
  manifestKey!: string;

  @Column({ type: 'timestamp with time zone' })
  inventoryAt!: Timestamp;

  /** The licence coverage the run's grant gave: `all`, `users`, `none`, or `own-bucket` (no Cloud gate). */
  @Column({ type: 'text' })
  licenceScope!: 'all' | 'users' | 'none' | 'own-bucket';

  @Column({ type: 'timestamp with time zone', default: () => 'now()' })
  createdAt!: Generated<Timestamp>;
}

/** FL-362: one account in a run's inventory, every account included. */
@Table('cloud_backup_decision_account')
export class CloudBackupDecisionAccountTable {
  @ForeignKeyColumn(() => CloudBackupDecisionRunTable, {
    primary: true,
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    index: false,
  })
  runId!: string;

  @PrimaryColumn({ type: 'uuid' })
  userId!: string;

  /** The opaque `fingerprint.user` binding the licence uses; the only account reference Cloud gets. */
  @Column({ type: 'text' })
  userFingerprint!: string;

  /** SHA-256 of the account's choice when the run took its inventory; null for Everything. Local only. */
  @Column({ type: 'text', nullable: true })
  selectionHash!: string | null;

  @Column({ type: 'integer' })
  totalOriginals!: number;

  @Column({ type: 'integer' })
  selectedOriginals!: number;

  @Column({ type: 'boolean' })
  licenceEligible!: boolean;

  /** Originals of the account in the run's committed manifest; null until it is committed. */
  @Column({ type: 'integer', nullable: true })
  includedOriginals!: number | null;
}

/** FL-362: one owned original in a run's inventory and why it is, or is not, backed up. */
@Table('cloud_backup_decision_asset')
export class CloudBackupDecisionAssetTable {
  @ForeignKeyColumn(() => CloudBackupDecisionRunTable, {
    primary: true,
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    index: false,
  })
  runId!: string;

  @PrimaryColumn({ type: 'uuid' })
  assetId!: string;

  /** The owner when the inventory was taken. */
  @Column({ type: 'uuid' })
  ownerId!: string;

  @Column({ type: 'text' })
  reason!: CloudBackupDecisionReason;
}

/** FL-362: a run's coverage report as published, or still to be published, to Frameleaf Cloud. */
export type CloudBackupCoverageStatus = 'local' | 'pending' | 'published' | 'rejected' | 'expired';

/**
 * FL-362: one run's numeric coverage for Frameleaf Cloud (FC-149). The page bodies are kept as the exact
 * text first sent, so every retry sends the same bytes.
 */
@Table('cloud_backup_coverage_report')
export class CloudBackupCoverageReportTable {
  @PrimaryColumn({ type: 'uuid' })
  runId!: string;

  /** The Frameleaf Cloud instance it belongs to; another instance (a restored copy) never sends it. */
  @Column({ type: 'uuid', nullable: true })
  instanceId!: string | null;

  @Column({ type: 'uuid' })
  revisionId!: string;

  @Column({ type: 'integer' })
  sequence!: number;

  @Column({ type: 'timestamp with time zone' })
  inventoryAt!: Timestamp;

  @Column({ type: 'integer' })
  accountCount!: number;

  @Column({ type: 'integer' })
  pageCount!: number;

  @Column({ type: 'jsonb', nullable: true })
  snapshot!: Record<string, unknown> | null;

  @Column({ type: 'text', array: true })
  pages!: string[];

  /** The run report it depends on, resent first when Frameleaf Cloud does not know the run yet. */
  @Column({ type: 'jsonb', nullable: true })
  runReport!: Record<string, unknown> | null;

  /** Frameleaf Cloud accepted this revision's header: from then on its body never changes. */
  @Column({ type: 'boolean', default: false })
  revisionAccepted!: Generated<boolean>;

  @Column({ type: 'text' })
  status!: CloudBackupCoverageStatus;

  @Column({ type: 'integer', default: 0 })
  attempts!: Generated<number>;

  @Column({ type: 'timestamp with time zone', nullable: true })
  nextAttemptAt!: Timestamp | null;

  @Column({ type: 'text', nullable: true })
  lastError!: string | null;

  @Column({ type: 'timestamp with time zone', default: () => 'now()' })
  createdAt!: Generated<Timestamp>;

  @Column({ type: 'timestamp with time zone', nullable: true })
  publishedAt!: Timestamp | null;
}
