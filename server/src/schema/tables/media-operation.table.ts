import { Column, CreateDateColumn, ForeignKeyColumn, Index, Table, Unique, UpdateDateColumn } from '@immich/sql-tools';
import type { Generated, Timestamp } from '@immich/sql-tools';
import type { Int8Writable } from 'src/schema/int8-writable.js';
import { PrimaryGeneratedUuidV7Column, UpdateIdColumn, UpdatedAtTrigger } from 'src/decorators.js';
import {
  MediaOperationCheckpointState,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
} from 'src/enum.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * A durable, user-visible media operation (FL-43 `FN-303`, FL-104 `STU-403`).
 *
 * The row is the job. Nothing about a running job lives in a browser tab, a timer or local
 * storage: closing the browser, restarting the server and losing the network all leave the same
 * row, and the Activity page is a view of these rows.
 *
 * Three groups of columns matter and they are deliberately separate:
 *
 * - **The immutable snapshot.** `kind`, `destination`, `snapshot`, `settings` and the revision
 *   references are written once at submit and never updated. A different destination, revision or
 *   output profile is a different job, which is why retry copies them into a new row instead of
 *   editing this one.
 * - **The claim.** `claimToken`, `claimedBy` and `claimExpiresAt` are the lease. Every worker
 *   write is conditioned on the token it was handed, so a worker that was presumed dead and then
 *   wakes up cannot publish over the job its replacement is running.
 * - **Cancellation and lineage.** `cancelRequestedAt` records the intent, `cancelAcknowledgedAt`
 *   the remote's answer and `remoteReleasedAt` the confirmed cleanup. A remote job handle is kept
 *   until it is acknowledged, including after owner deletion, so nothing is left running and
 *   billing on a cloud destination that we stopped watching.
 */
@Index({ columns: ['ownerId', 'createdAt'] })
@Index({ columns: ['status', 'claimExpiresAt'] })
@Index({ columns: ['kind', 'status'] })
// FL-59: one enrichment plan per owner and client idempotency key (migration 2100000000380).
@Index({
  name: 'media_operation_enrichment_plan_requestKey_uq',
  expression: `"ownerId", ("snapshot" ->> 'requestKey')`,
  unique: true,
  where: `"kind" = 'enrichment_plan' AND ("snapshot" ->> 'requestKey') IS NOT NULL`,
  synchronize: false,
})
// FL-43: at most one unfinished retry per job, so two retry requests racing queue one retry
// (migration 2100000000590).
@Index({
  name: 'media_operation_retryOfId_active_uq',
  columns: ['retryOfId'],
  unique: true,
  where: `"retryOfId" IS NOT NULL AND "status" NOT IN ('completed', 'cancelled', 'failed')`,
  synchronize: false,
})
@Table('media_operation')
@UpdatedAtTrigger('media_operation_updatedAt')
export class MediaOperationTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  /** The only account allowed to see or act on this job. */
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  ownerId!: string;

  @Column()
  kind!: MediaOperationKind;

  @Column({ default: MediaOperationStatus.Queued })
  status!: Generated<MediaOperationStatus>;

  /** Immutable. Chosen by the person at submit; never inferred and never changed by a failure. */
  @Column()
  destination!: MediaOperationDestination;

  /** Which worker or endpoint the destination resolved to, so "LAN" is never ambiguous later. */
  @Column({ nullable: true })
  destinationDetail!: string | null;

  /** What the person sees in Activity. Not a path and not an identifier. */
  @Column()
  label!: string;

  /** The source asset, when the workload has exactly one. */
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  assetId!: string | null;

  /** Lineage: the asset a completed job published. Null until a validated output is adopted. */
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  resultAssetId!: string | null;

  /** Lineage: the job this one retries. Retries are new rows, so the history stays readable. */
  @ForeignKeyColumn(() => MediaOperationTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  retryOfId!: string | null;

  /** The Studio project and the exact revision of it this job rendered. Both immutable. */
  @Column({ nullable: true })
  projectId!: string | null;

  @Column({ nullable: true })
  revisionId!: string | null;

  /**
   * The immutable binding: graph and resource checksums, source PTS maps, engine and patch
   * digest, colour policy, output profile, model identity and seed. Written once.
   */
  @Column({ type: 'jsonb' })
  snapshot!: Record<string, unknown>;

  /** The user-visible settings Activity shows: resolution, format, mode, upscale, preview. */
  @Column({ type: 'jsonb' })
  settings!: Record<string, unknown>;

  /** Measured estimate at submit: `{ seconds, sizeBytes, cloudCost }`. Never invented. */
  @Column({ type: 'jsonb', nullable: true })
  estimate!: Record<string, unknown> | null;

  /**
   * What actually happened, as it happens. The one deliberately mutable JSON column (FL-32).
   *
   * `snapshot` above says what was asked for and never changes; this says what the server has done
   * about it so far. A bulk operation records its counts and its per-item refusals here after every
   * batch, so a browser that closed, a worker that died and a server that restarted all come back
   * to the same answer — including which items still need retrying.
   */
  @Column({ type: 'jsonb', nullable: true })
  result!: Record<string, unknown> | null;

  /** 0 to 100. Derived from completed units, persisted so a reconnect shows the real figure. */
  @Column({ type: 'double precision', default: 0 })
  progress!: Generated<number>;

  @Column({ type: 'bigint', default: 0 })
  processedUnits!: Generated<Int8Writable>;

  @Column({ type: 'bigint', nullable: true })
  totalUnits!: Int8Writable | null;

  /** Increments on every claim. A job that exhausts `maxAttempts` fails instead of requeuing. */
  @Column({ type: 'integer', default: 0 })
  attempt!: Generated<number>;

  @Column({ type: 'integer', default: 3 })
  maxAttempts!: Generated<number>;

  /**
   * Automatic retries this job has used (FL-104, owner decision September 22, 2026). Every job
   * that fails gets `MEDIA_OPERATION_AUTO_RETRIES` of them before it is reported failed; a manual
   * retry is a new row and starts again from zero.
   */
  @Column({ type: 'integer', default: 0 })
  autoRetries!: Generated<number>;

  /** A requeued job is not claimed before this moment. Null means claimable as soon as it is queued. */
  @Column({ type: 'timestamp with time zone', nullable: true })
  retryAt!: Timestamp | null;

  /** The lease. A write carrying any other token is stale and must be rejected. */
  @Column({ type: 'uuid', nullable: true })
  claimToken!: string | null;

  /** The authenticated worker identity admission handed out (FL-95). */
  @Column({ nullable: true })
  claimedBy!: string | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  claimExpiresAt!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  heartbeatAt!: Timestamp | null;

  /**
   * Admission bookkeeping (FL-95). When a worker looked at this job and was refused by a limit,
   * the reason is written here so the owner sees why a queued job is still queued, and the count
   * shows whether it is a passing shortage or a job that will never fit anywhere.
   */
  @Column({ nullable: true })
  lastAdmissionRefusalReason!: string | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  lastAdmissionRefusedAt!: Timestamp | null;

  @Column({ type: 'integer', default: 0 })
  admissionRefusals!: Generated<number>;

  /**
   * Output bytes the current attempt has reported so far. Compared against the output ceiling on
   * heartbeat and reset to zero by every claim, so a re-dispatched attempt is not charged for the
   * bytes a failed one produced.
   */
  @Column({ type: 'bigint', default: 0 })
  outputBytes!: Generated<Int8Writable>;

  /**
   * When the current attempt was claimed (FL-95). `startedAt` keeps the first attempt's start for
   * Activity; the wall-clock ceiling is measured from this one, so the automatic retry every
   * operation gets (owner decision, September 22, 2026) starts its clock from zero.
   */
  @Column({ type: 'timestamp with time zone', nullable: true })
  attemptStartedAt!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  cancelRequestedAt!: Timestamp | null;

  /**
   * The owner asked for this job to pause (FL-104, owner request September 23, 2026). A queued job
   * is paused at once; a claimed one keeps working until its next checkpoint, where the worker hands
   * the claim back and the job becomes `paused`. Resume clears it. Never set on a finished job.
   */
  @Column({ type: 'timestamp with time zone', nullable: true })
  pauseRequestedAt!: Timestamp | null;

  /** The remote's answer. Until it arrives the job stays `cancelling`, not `cancelled`. */
  @Column({ type: 'timestamp with time zone', nullable: true })
  cancelAcknowledgedAt!: Timestamp | null;

  /** The remote handle, retained until cleanup is acknowledged even if the owner deletes the job. */
  @Column({ nullable: true })
  remoteJobId!: string | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  remoteReleasedAt!: Timestamp | null;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  /** A stable code the client turns into a translated message; `error` stays operator detail. */
  @Column({ nullable: true })
  errorCode!: string | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  startedAt!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  finishedAt!: Timestamp | null;

  /** The owner cleared a finished job from their list. The row survives for lineage and cleanup. */
  @Column({ type: 'timestamp with time zone', nullable: true })
  dismissedAt!: Timestamp | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @UpdateIdColumn()
  updateId!: Generated<string>;
}

/**
 * One checkpointed chunk of a render.
 *
 * A chunk is reusable only when every digest that went into it still matches: the inputs, the
 * complete effect and audio history that precedes it, the configuration and the seed. Matching
 * chunk numbers prove nothing, which is why `chunkKey` — not `sequence` — is the reuse key.
 *
 * `requiresSequentialContext` marks chunks whose filters carry serialized state across the
 * boundary. Resuming into one of those is not allowed: the resume boundary walks back to the last
 * chunk that can legitimately start a render, and the region after it is rendered again.
 */
@Index({ columns: ['operationId', 'chunkKey'] })
@Unique({ columns: ['operationId', 'sequence'] })
@Table('media_operation_checkpoint')
@UpdatedAtTrigger('media_operation_checkpoint_updatedAt')
export class MediaOperationCheckpointTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  @ForeignKeyColumn(() => MediaOperationTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  operationId!: string;

  /** Chunk order within the render. Ordering only; never a reuse key on its own. */
  @Column({ type: 'integer' })
  sequence!: number;

  @Column({ default: MediaOperationCheckpointState.Pending })
  state!: Generated<MediaOperationCheckpointState>;

  /** The full digest over every input below. Two chunks are the same work only if this matches. */
  @Column()
  chunkKey!: string;

  /** Source media, trims and resource checksums feeding this chunk. */
  @Column()
  inputDigest!: string;

  /** The effect and audio history up to this chunk's start, including preroll. */
  @Column()
  historyDigest!: string;

  /** Engine, codec, colour policy and output profile. */
  @Column()
  configDigest!: string;

  /** Model seed, when the workload has one. A different seed is different work. */
  @Column({ nullable: true })
  seed!: string | null;

  /** Rational timebase, e.g. `30000/1001`. Ticks below are in it; no float seconds anywhere. */
  @Column()
  timebase!: string;

  @Column({ type: 'bigint' })
  startTicks!: Int8Writable;

  @Column({ type: 'bigint' })
  endTicks!: Int8Writable;

  /** Ticks of preroll this chunk needs before its start to reproduce filter and audio state. */
  @Column({ type: 'bigint', default: 0 })
  prerollTicks!: Generated<Int8Writable>;

  /** True when a filter in this chunk carries serialized state; a render may not start here. */
  @Column({ type: 'boolean', default: false })
  requiresSequentialContext!: Generated<boolean>;

  @Column({ nullable: true })
  outputPath!: string | null;

  @Column({ type: 'bytea', nullable: true })
  outputChecksum!: Buffer | null;

  @Column({ type: 'bigint', nullable: true })
  sizeInBytes!: Int8Writable | null;

  @Column({ type: 'integer', default: 0 })
  attempt!: Generated<number>;

  /** The claim that produced this chunk. A stale token may not mark a chunk complete. */
  @Column({ type: 'uuid', nullable: true })
  claimToken!: string | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  completedAt!: Timestamp | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  /**
   * Written by the shared `updated_at()` trigger on every update. Without it the trigger fails and
   * no chunk could ever be completed or re-planned (FL-43, migration 2100000000590).
   */
  @UpdateIdColumn()
  updateId!: Generated<string>;
}
