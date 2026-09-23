import { Column, CreateDateColumn, ForeignKeyColumn, Index, Table, Unique, UpdateDateColumn } from '@immich/sql-tools';
import type { Generated, Int8, Timestamp } from '@immich/sql-tools';
import { PrimaryGeneratedUuidV7Column, UpdateIdColumn, UpdatedAtTrigger } from 'src/decorators.js';
import { StudioPreviewQuality, StudioPreviewStatus } from 'src/enum.js';
import { MediaOperationTable } from 'src/schema/tables/media-operation.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * One remote preview frame, bound to one exact project revision (FL-96, `STU-402`).
 *
 * The row is the cache entry *and* the request. There is no separate queue: a preview request
 * is a durable media operation of kind `studio_preview` (FL-104's model), and this row is the
 * revision-bound key that operation renders for. Two requests from the same account for the
 * same frame of the same revision share the row and the operation rather than each heating up a
 * GPU. Two accounts never share a row: the owner is part of the key.
 *
 * Three things make it safe:
 *
 * - **`cacheKey` is the identity.** It is a digest over owner, project, revision digest,
 *   canonical rational time, quality and viewport. It is unique, so the store cannot hold two rows that
 *   claim to be the same frame, and it cannot be forged by a project id containing a separator.
 * - **`revisionDigest` is never ordered or compared for recency.** It is matched for equality
 *   against the revision the project is on now. A frame whose digest no longer matches is
 *   refused — `superseded` — and the ETag contains the digest verbatim so a conditional request
 *   cannot revalidate a stale frame into being served.
 * - **Time is rational.** `timeNumerator` / `timeDenominator` are exact. A float seconds column
 *   would make a preview at 1001/30000 address a different frame than the export does, which is
 *   precisely the class of bug the timing work exists to eliminate.
 *
 * `projectId` and `revisionDigest` are plain columns with no foreign key. Studio project
 * storage is owned by another story still in flight; the private-sidecar rule in the Studio
 * plan forbids adding a public foreign key for it, and an equality match against the revision
 * authority is what this story actually needs.
 */
@Index({ columns: ['ownerId', 'projectId', 'revisionDigest'] })
@Index({ columns: ['projectId', 'requestedAt'] })
@Index({ columns: ['status', 'expiresAt'] })
@Unique({ columns: ['cacheKey'] })
@Table('studio_preview_frame')
@UpdatedAtTrigger('studio_preview_frame_updatedAt')
export class StudioPreviewFrameTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  /** The only account allowed to ask for, or receive, this frame. */
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  ownerId!: string;

  /** The Studio project. No foreign key: project storage is owned by a story in flight. */
  @Column()
  projectId!: string;

  /**
   * What this frame is bound to: FL-90's authorized manifest digest for the stored project
   * revision (FL-89). Matched for equality only — never parsed, never ordered.
   *
   * Binding to the manifest digest is strictly stronger than binding to the graph alone: the
   * digest changes when the revision changes *and* when the project is re-resolved, so a frame
   * also stops being deliverable when a source is untrashed, unshared, relocked or replaced.
   */
  @Column()
  revisionDigest!: string;

  /**
   * The stored project revision the manifest was resolved at. Frame delivery requires it to be
   * the project's head, and a committed revision supersedes every row below it for every
   * account. Null only on rows recorded before previews were bound to project storage.
   */
  @Column({ type: 'integer', nullable: true })
  projectRevision!: number | null;

  /**
   * The FL-90 preview read grant, signed for this viewer session. Frame delivery verifies it on
   * every request, so a grant that has expired, or whose manifest was re-resolved, stops the
   * frame rather than merely stopping the next render.
   */
  @Column({ type: 'text', nullable: true })
  grantToken!: string | null;

  /** The viewer session the grant was issued to. A grant is worthless in another session. */
  @Column({ nullable: true })
  grantSessionId!: string | null;

  /** Digest over owner, project, revision, canonical time, quality and viewport. The store key. */
  @Column()
  cacheKey!: string;

  /** Exact sequence time, as a rational. Never a float. */
  @Column({ type: 'bigint' })
  timeNumerator!: Int8;

  @Column({ type: 'bigint' })
  timeDenominator!: Int8;

  @Column()
  quality!: StudioPreviewQuality;

  @Column({ type: 'integer' })
  viewportWidth!: number;

  @Column({ type: 'integer' })
  viewportHeight!: number;

  @Column({ default: StudioPreviewStatus.Pending })
  status!: Generated<StudioPreviewStatus>;

  /**
   * The durable job rendering this frame. Cancelling a superseded preview cancels the
   * operation; the row stays so the refusal keeps its reason.
   */
  @ForeignKeyColumn(() => MediaOperationTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  operationId!: string | null;

  /**
   * The client's seek generation for this request. A frame arriving for an older generation is
   * discarded by the client rather than painted; storing it lets the server report which seek
   * a frame answers instead of leaving the client to guess.
   */
  @Column({ type: 'bigint', default: 0 })
  seekGeneration!: Generated<Int8>;

  /** Where the validated frame is on disk. Null until a worker publishes one. */
  @Column({ nullable: true })
  framePath!: string | null;

  @Column({ nullable: true })
  contentType!: string | null;

  @Column({ type: 'bigint', nullable: true })
  sizeInBytes!: Int8 | null;

  @Column({ type: 'bytea', nullable: true })
  frameChecksum!: Buffer | null;

  /** The delivered frame's own presentation timestamp and timebase, for frame identity. */
  @Column({ type: 'bigint', nullable: true })
  framePts!: Int8 | null;

  @Column({ nullable: true })
  framePtsTimebase!: string | null;

  /**
   * The frame is an explicitly tone-mapped SDR rendering of HDR material. It is labelled
   * because it is never the colour authority and never an export source; a viewer that cannot
   * show HDR gets a preview that says so rather than one that silently lies.
   */
  @Column({ type: 'boolean', default: false })
  toneMapped!: Generated<boolean>;

  /** Stable code the client turns into a message. Operator detail stays on the operation. */
  @Column({ nullable: true })
  errorCode!: string | null;

  @CreateDateColumn()
  requestedAt!: Generated<Timestamp>;

  @Column({ type: 'timestamp with time zone', nullable: true })
  readyAt!: Timestamp | null;

  /** Drives least-recently-used eviction: scrubbing back over a frame should keep it. */
  @CreateDateColumn()
  lastAccessedAt!: Generated<Timestamp>;

  /** Retention boundary. A frame past it is reported gone rather than served from a stale path. */
  @Column({ type: 'timestamp with time zone', nullable: true })
  expiresAt!: Timestamp | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @UpdateIdColumn()
  updateId!: Generated<string>;
}
