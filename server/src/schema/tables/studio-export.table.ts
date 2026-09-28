import { Column, CreateDateColumn, ForeignKeyColumn, Index, Table, Unique } from '@immich/sql-tools';
import type { Generated, Timestamp } from '@immich/sql-tools';
import type { Int8Writable } from 'src/schema/int8-writable.js';
import { PrimaryGeneratedUuidV7Column } from 'src/decorators.js';
import {
  AssetLockReason,
  MediaOperationDestination,
  StudioExportRemoteReason,
  StudioExportScope,
  StudioExportVersionState,
} from 'src/enum.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { MediaOperationTable } from 'src/schema/tables/media-operation.table.js';
import { StudioProjectTable } from 'src/schema/tables/studio-project.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * One export of a Studio project, from the render that produces it to the version it becomes
 * (FL-106, `STU-404`).
 *
 * A row is written with the render job and moves only forward: `rendering`, then `staged` once the
 * render reported a file, then `published`, or `failed` / `cancelled`. Nothing about an earlier
 * published version changes when a later one fails, is cancelled or is interrupted: `version` is
 * assigned in the publication transaction, so a version number always names a finished result.
 *
 * - **Output.** The staged file sits in the owner's private exports folder, under a directory named
 *   after the render job, until publication. A `library` result's file then belongs to the asset
 *   it became (`resultAssetId`); a `project` result's file stays with this row.
 * - **Privacy.** `privacy` is the evidence the publication transaction installed: the union of every
 *   source's Locked and sensitive evidence, read under row locks in that same transaction.
 * - **Provenance.** Every source the render read is a `studio_export_version_source` row, kept after
 *   the source is deleted, so a result can always say what it was made from.
 */
@Index({ columns: ['projectId', 'createdAt'] })
@Index({ columns: ['state', 'updatedAt'] })
@Unique({ columns: ['renderOperationId'] })
@Unique({ columns: ['projectId', 'version'] })
@Table('studio_export_version')
export class StudioExportVersionTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  /** Who asked for the export and owns the result. */
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  ownerId!: string;

  /** Null once the project is deleted for good; a library result outlives its project. */
  @ForeignKeyColumn(() => StudioProjectTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  projectId!: string | null;

  /** The stored project revision that was rendered, and its digest. Immutable. */
  @Column({ type: 'integer' })
  revision!: number;

  @Column()
  revisionDigest!: string;

  @ForeignKeyColumn(() => MediaOperationTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  renderOperationId!: string | null;

  @ForeignKeyColumn(() => MediaOperationTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  publishOperationId!: string | null;

  @Column({ default: StudioExportVersionState.Rendering })
  state!: Generated<StudioExportVersionState>;

  /** 1, 2, 3… per project, assigned when the result is published. Null until then. */
  @Column({ type: 'integer', nullable: true })
  version!: number | null;

  @Column({ nullable: true })
  scope!: StudioExportScope | null;

  @Column()
  destination!: MediaOperationDestination;

  /** Format, colour and resolution as the person chose them. */
  @Column({ type: 'jsonb' })
  settings!: Record<string, unknown>;

  /** The render worker that produced the output, and the engine it reported at admission. */
  @Column({ nullable: true })
  workerId!: string | null;

  @Column({ nullable: true })
  engineDigest!: string | null;

  @Column({ nullable: true })
  outputPath!: string | null;

  /** SHA-256 of the output, as the render reported it and as publication verified it. */
  @Column({ type: 'bytea', nullable: true })
  outputChecksum!: Buffer | null;

  @Column({ type: 'bigint', nullable: true })
  outputSizeInBytes!: Int8Writable | null;

  @Column({ nullable: true })
  outputContentType!: string | null;

  /** What the remote destination calls its copy of the output, when it kept one. */
  @Column({ nullable: true })
  outputRemoteRef!: string | null;

  /** Retention removed a file that no published result referenced. The row stays for lineage. */
  @Column({ type: 'timestamp with time zone', nullable: true })
  outputRemovedAt!: Timestamp | null;

  /** A `library` result: the asset it became. */
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  resultAssetId!: string | null;

  /** The privacy the publication installed (see {@link StudioExportVersionTable}). */
  @Column({ type: 'jsonb', nullable: true })
  privacy!: Record<string, unknown> | null;

  @Column({ nullable: true })
  errorCode!: string | null;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  /** Written by every state change; there is deliberately no trigger on this table. */
  @Column({ type: 'timestamp with time zone', default: () => 'now()' })
  updatedAt!: Generated<Timestamp>;

  @Column({ type: 'timestamp with time zone', nullable: true })
  publishedAt!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  cancelledAt!: Timestamp | null;
}

/**
 * One source a Studio export read (FL-106 provenance).
 *
 * Written at every render claim from the manifest the claim was granted — the checksums the worker
 * was allowed to read — and completed by the publication transaction with the privacy evidence it
 * found. `assetId` and `ownerId` deliberately carry no foreign key: provenance must survive the
 * deletion of the source and of its owner.
 */
@Index({ columns: ['assetId'] })
@Table('studio_export_version_source')
export class StudioExportVersionSourceTable {
  @ForeignKeyColumn(() => StudioExportVersionTable, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: false,
    primary: true,
  })
  versionId!: string;

  /** FL-90's reference key, unique within the graph. */
  @Column({ primary: true })
  key!: string;

  @Column()
  kind!: string;

  /** The resource id the graph names. A library asset id for library sources. */
  @Column()
  resourceId!: string;

  @Column({ type: 'uuid', nullable: true })
  assetId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  ownerId!: string | null;

  @Column({ nullable: true })
  checksum!: string | null;

  /** `owner`, `shared`, `project`, `deployment` or `graph`, as FL-90 decided it. */
  @Column()
  sourceAccess!: string;

  @Column({ type: 'boolean', nullable: true })
  locked!: boolean | null;

  @Column({ nullable: true })
  lockReason!: AssetLockReason | null;

  @Column({ type: 'boolean', nullable: true })
  sensitive!: boolean | null;
}

/**
 * Something a remote destination holds for a Studio export that it must be told to drop: a render
 * to stop, or a copy of an output to delete (FL-106).
 *
 * Kept until the remote acknowledges it, whatever happens in the meantime. It has no foreign key to
 * the owner or the render job on purpose: deleting an account, purging a project or handing the
 * database to the official server must not forget a job still running, or a copy still stored, on
 * somebody else's hardware.
 */
@Index({ columns: ['workerId', 'acknowledgedAt'] })
@Unique({ columns: ['operationId', 'workerId', 'reason'] })
@Table('studio_export_remote_reference')
export class StudioExportRemoteReferenceTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  @ForeignKeyColumn(() => StudioExportVersionTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  versionId!: string | null;

  /** The render job; not a foreign key, so the reference outlives the job row. */
  @Column({ type: 'uuid' })
  operationId!: string;

  @Column({ type: 'uuid', nullable: true })
  ownerId!: string | null;

  /** The render worker holding the data. */
  @Column({ nullable: true })
  workerId!: string | null;

  @Column()
  destination!: MediaOperationDestination;

  @Column({ nullable: true })
  remoteRef!: string | null;

  @Column()
  reason!: StudioExportRemoteReason;

  @CreateDateColumn()
  requestedAt!: Generated<Timestamp>;

  @Column({ type: 'timestamp with time zone', nullable: true })
  acknowledgedAt!: Timestamp | null;
}
