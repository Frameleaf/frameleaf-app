import { Column, CreateDateColumn, ForeignKeyColumn, Index, Table, Unique, UpdateDateColumn } from '@immich/sql-tools';
import type { Generated, Timestamp } from '@immich/sql-tools';
import type { Int8Writable } from 'src/schema/int8-writable.js';
import type { RenderColorPrecision } from 'src/utils/render-admission.js';
import { PrimaryGeneratedUuidV7Column, UpdateIdColumn, UpdatedAtTrigger } from 'src/decorators.js';
import { MediaOperationDestination, MediaOperationKind, RenderWorkerAuditEvent, RenderWorkerStatus } from 'src/enum.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * Render worker identities, sessions, limits and audit (FL-95 `STU-401`).
 *
 * Four tables, split by who writes them and how long they live:
 *
 * - `render_worker` is the identity an administrator enrolled: where it runs, what kinds of work
 *   it may take, the engine digest it must keep reporting and the ceilings it may not exceed. The
 *   enrolment secret is stored as a SHA-256 digest, the same way an API key is, and is shown to
 *   the administrator exactly once at creation.
 * - `render_worker_session` is what admission hands out. It is scoped to the worker's kinds,
 *   expires on its own and records the evidence the worker presented: the GPU memory it was
 *   admitted with is the memory it may be asked to use, and the conformance timestamp is what
 *   makes a replayed report detectable.
 * - `render_worker_limit` carries the per-account ceilings, with one `instance` row for the
 *   default. Limits are administration, not preference: they are enforced on the server at
 *   claim time and on every heartbeat, never in a client.
 * - `render_worker_audit` records enrolment, admission, refusal and revocation. It carries no
 *   foreign keys on purpose: a revoked worker's history must outlive the worker, and an audit
 *   row about an operation must outlive the operation. It never carries a secret and never a
 *   media path.
 */
@Index({ columns: ['status', 'destination'] })
@Table('render_worker')
@UpdatedAtTrigger('render_worker_updatedAt')
export class RenderWorkerTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  /** What the administrator calls it. Also what `destinationDetail` on an operation may name. */
  @Column()
  name!: string;

  /** Where this worker runs. A worker only ever claims operations submitted to its destination. */
  @Column()
  destination!: MediaOperationDestination;

  @Column({ default: RenderWorkerStatus.Active })
  status!: Generated<RenderWorkerStatus>;

  /** SHA-256 of the enrolment secret. The secret itself is never stored. */
  @Column({ type: 'bytea', index: true })
  enrolmentSecret!: Buffer;

  /** The operation kinds this worker may claim. A session's scopes are copied from here. */
  @Column({ array: true, type: 'character varying' })
  kinds!: MediaOperationKind[];

  /**
   * The engine and patch digest this worker was qualified with. Admission refuses a worker that
   * reports any other digest: a worker that upgraded itself is not the worker that was tested.
   */
  @Column({ nullable: true })
  engineDigest!: string | null;

  /** How old the conformance evidence may be at admission, in milliseconds. */
  @Column({ type: 'integer', default: 7 * 24 * 60 * 60 * 1000 })
  conformanceMaxAgeMs!: Generated<number>;

  /** The newest conformance report accepted. An older or equal timestamp is a replay. */
  @Column({ type: 'timestamp with time zone', nullable: true })
  lastConformanceReportedAt!: Timestamp | null;

  /** Operations this worker may hold at once. */
  @Column({ type: 'integer', default: 1 })
  maxConcurrentOperations!: Generated<number>;

  /** Longest a single operation may run on this worker, in milliseconds. Null means no ceiling. */
  @Column({ type: 'bigint', nullable: true })
  maxWallClockMs!: Int8Writable | null;

  /** Most output bytes one operation may produce here. Null means no ceiling. */
  @Column({ type: 'bigint', nullable: true })
  maxOutputBytes!: Int8Writable | null;

  /** GPU memory the worker was qualified with, in bytes. An operation asking for more is refused. */
  @Column({ type: 'bigint', nullable: true })
  gpuMemoryBytes!: Int8Writable | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  lastAdmittedAt!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  lastSeenAt!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  revokedAt!: Timestamp | null;

  /** The administrator who enrolled it. Kept for the audit view; nulled if the account goes. */
  @ForeignKeyColumn(() => UserTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  createdBy!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @UpdateIdColumn()
  updateId!: Generated<string>;
}

@Index({ columns: ['workerId', 'expiresAt'] })
@Table('render_worker_session')
export class RenderWorkerSessionTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  @ForeignKeyColumn(() => RenderWorkerTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  workerId!: string;

  /** SHA-256 of the session credential. The credential itself is never stored. */
  @Column({ type: 'bytea', index: true })
  token!: Buffer;

  /** The kinds this session may claim. Copied from the worker at admission and never widened. */
  @Column({ array: true, type: 'character varying' })
  scopes!: MediaOperationKind[];

  /** What the worker reported at admission. This — not a later claim — is what it may use. */
  @Column({ type: 'bigint', nullable: true })
  gpuMemoryBytes!: Int8Writable | null;

  @Column({ nullable: true })
  engineDigest!: string | null;

  @Column({ type: 'timestamp with time zone' })
  conformanceReportedAt!: Timestamp;

  /**
   * FL-42: the encoders and decoders the conformance check verified, and the colour precision it
   * verified. Exports are offered only to what a live session verified. Added by fork migration
   * 0000000000172-RenderSessionOutputEvidence, not the schema generator.
   */
  @Column({ array: true, type: 'character varying', nullable: true, synchronize: false })
  codecs!: string[] | null;

  @Column({ type: 'jsonb', nullable: true, synchronize: false })
  colorPrecision!: RenderColorPrecision | null;

  @Column({ type: 'timestamp with time zone' })
  expiresAt!: Timestamp;

  @Column({ type: 'timestamp with time zone', nullable: true })
  revokedAt!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  lastUsedAt!: Timestamp | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}

/** The subject of the instance-wide default row. Every other row's subject is a user id. */
export const RENDER_WORKER_LIMIT_INSTANCE_SUBJECT = 'instance';

@Unique({ columns: ['subject'] })
@Table('render_worker_limit')
@UpdatedAtTrigger('render_worker_limit_updatedAt')
export class RenderWorkerLimitTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  /** `instance` for the default, otherwise the user id as text so the unique constraint holds. */
  @Column()
  subject!: string;

  /** Set for a per-account row so the row goes when the account does. */
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: true })
  userId!: string | null;

  /** Operations one account may have claimed across every worker at once. */
  @Column({ type: 'integer', default: 2 })
  maxConcurrentOperations!: Generated<number>;

  @Column({ type: 'bigint', nullable: true })
  maxWallClockMs!: Int8Writable | null;

  @Column({ type: 'bigint', nullable: true })
  maxOutputBytes!: Int8Writable | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @UpdateIdColumn()
  updateId!: Generated<string>;
}

@Index({ columns: ['workerId', 'createdAt'] })
@Index({ columns: ['operationId'] })
@Table('render_worker_audit')
export class RenderWorkerAuditTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  /** No foreign key: the history of a revoked worker outlives the worker. */
  @Column({ type: 'uuid', nullable: true })
  workerId!: string | null;

  @Column()
  event!: RenderWorkerAuditEvent;

  /** A `RenderWorkerRefusalReason` when the event is a refusal. */
  @Column({ nullable: true })
  reason!: string | null;

  /** The operation concerned, when there is one. No foreign key: the row outlives the job. */
  @Column({ type: 'uuid', nullable: true })
  operationId!: string | null;

  /** The administrator who acted, for enrolment, update and revocation. */
  @Column({ type: 'uuid', nullable: true })
  actorId!: string | null;

  /** Operator detail: reported digests, memory figures, limits. Never a secret or a path. */
  @Column({ type: 'jsonb', nullable: true })
  detail!: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
