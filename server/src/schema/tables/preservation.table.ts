import { Column, CreateDateColumn, ForeignKeyColumn, Index, Table, Unique, UpdateDateColumn } from '@immich/sql-tools';
import type { Generated, Int8, Timestamp } from '@immich/sql-tools';
import { PrimaryGeneratedUuidV7Column, UpdateIdColumn, UpdatedAtTrigger } from 'src/decorators.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * Preservation packages (FL-74, `IMP-006`). Mirrors migration 2100000000510-AddPreservationPackages.
 *
 * A package is an independent copy of the owner's originals with checksums, metadata sidecars and
 * the library's organization, in the portable layout `src/utils/preservation.ts` defines. The work
 * on it — writing it, verifying it, reviewing it for restoration and restoring it — is done by
 * durable `media_operation` jobs; these tables are what those jobs record item by item, so a job
 * that stops (a pause, a restart, its one automatic retry) carries on from the items it has not
 * finished and never does one twice.
 *
 * Three kinds of package share the table, told apart by `origin`:
 *
 * - `export`: written by this server from a frozen selection, as a directory under the owner's
 *   private exports folder. Downloaded as one ZIP stream.
 * - `upload`: a package ZIP the owner uploaded, kept for a bounded time for verification and
 *   restoration.
 * - `server`: a package an administrator named by path on this server (a directory or a ZIP),
 *   outside managed storage. Read only; never modified or removed by the server.
 *
 * `path` is a server path and is never returned to a client.
 */
@Index({ columns: ['ownerId', 'createdAt'] })
@Table('preservation_package')
@UpdatedAtTrigger('preservation_package_updatedAt')
export class PreservationPackageTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  /** The only account that may see, download, verify, restore or remove it. */
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  ownerId!: string;

  /** `export`, `upload` or `server`. */
  @Column()
  origin!: string;

  @Column()
  name!: string;

  /** `building`, `ready`, `incomplete`, `unreadable` or `removed`. */
  @Column({ default: 'building' })
  status!: Generated<string>;

  /** `directory` or `zip`. */
  @Column()
  format!: string;

  /** Server path of the package. Never returned to a client. */
  @Column()
  path!: string;

  /** The file name an upload arrived with. */
  @Column({ nullable: true })
  originalFileName!: string | null;

  @Column({ type: 'bigint', nullable: true })
  sizeBytes!: Int8 | null;

  /** SHA-256, hex, of an uploaded or named ZIP as it was when registered. */
  @Column({ nullable: true })
  digest!: string | null;

  /** Locked items were chosen, from an unlocked session, to travel in this package. */
  @Column({ type: 'boolean', default: false })
  includeLocked!: Generated<boolean>;

  /** Metadata sidecars and edit recipes travel with the originals. Checksums always do. */
  @Column({ type: 'boolean', default: true })
  includeMetadata!: Generated<boolean>;

  /** The selection as it was asked for, described for people: never re-evaluated. */
  @Column({ type: 'jsonb', nullable: true })
  scope!: Record<string, unknown> | null;

  /** The validated manifest summary, once the package has one. */
  @Column({ type: 'jsonb', nullable: true })
  manifest!: Record<string, unknown> | null;

  /** The last verification's counts and outcome. */
  @Column({ type: 'jsonb', nullable: true })
  verification!: Record<string, unknown> | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  verifiedAt!: Timestamp | null;

  /** When an uploaded package is discarded. Null for exports and server packages. */
  @Column({ type: 'timestamp with time zone', nullable: true })
  expiresAt!: Timestamp | null;

  /** Its files were removed; the row stays for the lineage of restorations made from it. */
  @Column({ type: 'timestamp with time zone', nullable: true })
  removedAt!: Timestamp | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  /** Written by the `updated_at` trigger with every change. */
  @UpdateIdColumn()
  updateId!: Generated<string>;
}

/**
 * One original in a package: the export's per-item journal, and the latest verification of it.
 *
 * For an export the rows are the frozen selection, written at submit; `sourceAssetId` is the
 * library asset. For an uploaded or named package they are read from the package's index by the
 * first verification. `(packageId, sourceAssetId)` is unique, so re-reading the index never adds a
 * second row for an item.
 */
@Unique({ columns: ['packageId', 'sourceAssetId'] })
@Index({ columns: ['packageId', 'state'] })
@Table('preservation_item')
@UpdatedAtTrigger('preservation_item_updatedAt')
export class PreservationItemTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  // [packageId, sourceAssetId] is the unique constraint, which already indexes packageId
  @ForeignKeyColumn(() => PreservationPackageTable, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: false,
    index: false,
  })
  packageId!: string;

  /** The asset id on the server that wrote the package. Not a foreign key: it may be another server. */
  @Column({ type: 'uuid' })
  sourceAssetId!: string;

  /** For an export, the library asset while it exists. */
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  assetId!: string | null;

  /** `pending`, `copied`, `failed` or `skipped` for an export; `listed` for a read package. */
  @Column({ default: 'pending' })
  state!: Generated<string>;

  /** The item was Locked when it was written or listed. */
  @Column({ type: 'boolean', default: false })
  locked!: Generated<boolean>;

  /** The index line for this item: paths, byte counts and digests. */
  @Column({ type: 'jsonb', nullable: true })
  entry!: Record<string, unknown> | null;

  /**
   * How many times the export has tried this item. Every item gets one automatic retry (owner
   * decision, September 22, 2026); a manual retry starts the count again.
   */
  @Column({ type: 'integer', default: 0 })
  attempts!: Generated<number>;

  /** `ok`, `missing` or `changed`, from the latest verification. */
  @Column({ nullable: true })
  verifyState!: string | null;

  /** A stable code the client turns into a translated message. */
  @Column({ nullable: true })
  reasonKey!: string | null;

  /** Operator detail; never a server path. */
  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  /** Written by the `updated_at` trigger with every change. */
  @UpdateIdColumn()
  updateId!: Generated<string>;
}

/**
 * One restoration of a package into its owner's library.
 *
 * `status` moves `reviewing` → `ready` → `restoring` → `completed`; a review that could not read the
 * package is `unreadable`. The review and the restore are separate media operations, so the owner
 * reads the conflicts, records their choices and only then restores. `packageIdentity` is the
 * package's own id from its manifest: albums and people this restoration creates have ids derived
 * from it, so restoring the same package twice, or retrying, finds them instead of making more.
 */
@Index({ columns: ['ownerId', 'createdAt'] })
@Table('preservation_restore')
@UpdatedAtTrigger('preservation_restore_updatedAt')
export class PreservationRestoreTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  ownerId!: string;

  /** Kept as null when the package is deleted, so the record of what was restored survives it. */
  @ForeignKeyColumn(() => PreservationPackageTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  packageId!: string | null;

  @Column()
  name!: string;

  @Column({ default: 'reviewing' })
  status!: Generated<string>;

  /** The manifest's package id; the namespace of the ids this restoration derives. */
  @Column({ nullable: true })
  packageIdentity!: string | null;

  /** What the owner chose to restore: edit recipes, people, albums, Locked records. */
  @Column({ type: 'jsonb' })
  options!: Record<string, unknown>;

  /** Counts from the review and the restore. */
  @Column({ type: 'jsonb', nullable: true })
  summary!: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  /** Written by the `updated_at` trigger with every change. */
  @UpdateIdColumn()
  updateId!: Generated<string>;
}

/**
 * One original of a restoration: what the review found and what the restore did.
 *
 * `decisions` holds the owner's choices, field by field, and is never written by a job. A restore
 * that is retried applies the same choices to the items it had not finished; an item with
 * `appliedAt` set is never applied again, so anything the owner changed after it was restored stays
 * as they left it.
 */
@Unique({ columns: ['restoreId', 'sourceAssetId'] })
@Index({ columns: ['restoreId', 'state'] })
@Table('preservation_restore_item')
@UpdatedAtTrigger('preservation_restore_item_updatedAt')
export class PreservationRestoreItemTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  // [restoreId, sourceAssetId] is the unique constraint, which already indexes restoreId
  @ForeignKeyColumn(() => PreservationRestoreTable, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: false,
    index: false,
  })
  restoreId!: string;

  @Column({ type: 'uuid' })
  sourceAssetId!: string;

  /**
   * `ready`, `failed`, `creating`, `restored`, `matched` or `skipped`. `creating` is written before a
   * new original is added, so a retry after a crash recognizes the asset it made.
   */
  @Column({ default: 'ready' })
  state!: Generated<string>;

  /** `new`, `existing` or `trashed`: what the review found in the library for these bytes. */
  @Column({ nullable: true })
  match!: string | null;

  /** The library asset this item became or matched. */
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  assetId!: string | null;

  /** The package says the item was Locked; it is restored Locked. */
  @Column({ type: 'boolean', default: false })
  locked!: Generated<boolean>;

  @Column({ type: 'jsonb', nullable: true })
  entry!: Record<string, unknown> | null;

  /** The verified metadata sidecar, kept for the restore and as provenance. */
  @Column({ type: 'jsonb', nullable: true })
  sidecar!: Record<string, unknown> | null;

  /** Fields where the package and the library disagree, found by the review. */
  @Column({ type: 'jsonb', nullable: true })
  conflicts!: Record<string, unknown>[] | null;

  /** The owner's choices. */
  @Column({ type: 'jsonb', nullable: true })
  decisions!: Record<string, unknown> | null;

  /** What the restore left for the owner to look at: provenance kept, relationships not made. */
  @Column({ type: 'jsonb', nullable: true })
  findings!: string[] | null;

  @Column({ nullable: true })
  reasonKey!: string | null;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  /** How many times the restore has tried this item; one automatic retry, like the export. */
  @Column({ type: 'integer', default: 0 })
  attempts!: Generated<number>;

  @Column({ type: 'timestamp with time zone', nullable: true })
  creatingAt!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  appliedAt!: Timestamp | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  /** Written by the `updated_at` trigger with every change. */
  @UpdateIdColumn()
  updateId!: Generated<string>;
}
