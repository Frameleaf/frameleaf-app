import { Column, CreateDateColumn, ForeignKeyColumn, Index, Table, Unique, UpdateDateColumn } from '@immich/sql-tools';
import type { Generated, Timestamp } from '@immich/sql-tools';
import { PrimaryGeneratedUuidV7Column, UpdateIdColumn, UpdatedAtTrigger } from 'src/decorators.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { MediaOperationTable } from 'src/schema/tables/media-operation.table.js';
import { MlDestinationTable } from 'src/schema/tables/ml-destination.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * One preview-first restoration of one asset (FL-115). Mirrors migration
 * 2100000000240-AddAssetRestorationTable.
 *
 * The row is a revision, not a replacement. It records the reviewed binding — destination,
 * workload, mode, upscale and the checksum of the exact source it previewed — and the full render
 * may only ever run against that same binding. The original file is never written; every output
 * path here is a new file beside the asset's other derived images.
 *
 * Status values are `AssetRestorationStatus` (see `src/dtos/asset-restoration.dto.ts`). The
 * durable progress, cancellation and lineage live on the linked `media_operation` rows.
 */
@Index({ columns: ['ownerId', 'createdAt'] })
@Index({ columns: ['status', 'previewExpiresAt'] })
@Index({ columns: ['resultExpiresAt'] })
@Index({ name: 'asset_restoration_assetId_isCurrent_uq', columns: ['assetId'], where: '"isCurrent"', unique: true })
@Unique({ columns: ['assetId', 'revision'] })
@Table('asset_restoration')
@UpdatedAtTrigger('asset_restoration_updatedAt')
export class AssetRestorationTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  assetId!: string;

  /** The only account allowed to see or act on this restoration. */
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  ownerId!: string;

  /** Per-asset sequence number; the first restoration of an asset is revision 1. */
  @Column({ type: 'integer' })
  revision!: number;

  @Column({ default: 'preview_queued' })
  status!: Generated<string>;

  /** `faithful` or `creative`; selects the workload and the model family. Immutable after submit. */
  @Column()
  mode!: string;

  /** 1, 2 or 4. The output is additionally capped at 4K. Immutable after submit. */
  @Column({ type: 'integer', default: 1 })
  upscale!: Generated<number>;

  @Column({ type: 'boolean', default: false })
  keepGrain!: Generated<boolean>;

  /** The `MlWorkload` the mode resolved to; the admission the full render must pass again. */
  @Column()
  workload!: string;

  /** The destination the preview was admitted on. Null once the administrator removed it. */
  @ForeignKeyColumn(() => MlDestinationTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  destinationId!: string | null;

  /** Kept so the row still says where the preview ran after the destination row is gone. */
  @Column()
  destinationKind!: string;

  @Column()
  destinationName!: string;

  /** `image` or `video`. */
  @Column()
  sourceType!: string;

  /** The asset checksum at request time. A full render whose source no longer matches is refused. */
  @Column({ type: 'bytea' })
  sourceChecksum!: Buffer;

  @Column({ type: 'integer' })
  sourceWidth!: number;

  @Column({ type: 'integer' })
  sourceHeight!: number;

  @Column({ type: 'double precision', nullable: true })
  sourceDurationSeconds!: number | null;

  /** `{ x, y, w, h }` as fractions of the frame, plus `startSeconds` and `durationSeconds` for video. */
  @Column({ type: 'jsonb' })
  previewRegion!: Record<string, unknown>;

  @ForeignKeyColumn(() => MediaOperationTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  previewOperationId!: string | null;

  @ForeignKeyColumn(() => MediaOperationTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  fullOperationId!: string | null;

  @Column({ nullable: true })
  previewBeforePath!: string | null;

  @Column({ nullable: true })
  previewAfterPath!: string | null;

  /** The full-resolution restored derivative. A new file; never the original. */
  @Column({ nullable: true })
  resultPath!: string | null;

  @Column({ nullable: true })
  resultPreviewPath!: string | null;

  @Column({ type: 'integer', nullable: true })
  outputWidth!: number | null;

  @Column({ type: 'integer', nullable: true })
  outputHeight!: number | null;

  /** What the adapter reported it ran. Provenance, so the result stays inspectable. */
  @Column({ nullable: true })
  modelName!: string | null;

  @Column({ nullable: true })
  modelVersion!: string | null;

  @Column({ type: 'jsonb', default: '{}' })
  provenance!: Generated<Record<string, unknown>>;

  /** Measured estimate at submit, or null when nothing has been measured. Never invented. */
  @Column({ type: 'jsonb', nullable: true })
  estimate!: Record<string, unknown> | null;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  /** The owner chose this restoration as the asset's playback version. Explicit; never set by a job. */
  @Column({ type: 'boolean', default: false })
  isCurrent!: Generated<boolean>;

  @Column({ type: 'timestamp with time zone', nullable: true })
  previewReadyAt!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  reviewedAt!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  restoredAt!: Timestamp | null;

  /** When the preview files are removed by the retention sweep. */
  @Column({ type: 'timestamp with time zone', nullable: true })
  previewExpiresAt!: Timestamp | null;

  /** When a rejected or discarded result's files are removed by the retention sweep. */
  @Column({ type: 'timestamp with time zone', nullable: true })
  resultExpiresAt!: Timestamp | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @UpdateIdColumn()
  updateId!: Generated<string>;
}
