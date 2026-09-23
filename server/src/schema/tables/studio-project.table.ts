import { Column, CreateDateColumn, ForeignKeyColumn, Index, Table, Unique, UpdateDateColumn } from '@immich/sql-tools';
import type { Generated, Int8, Timestamp } from '@immich/sql-tools';
import { PrimaryGeneratedUuidV7Column, UpdateIdColumn, UpdatedAtTrigger } from 'src/decorators.js';
import { AlbumTable } from 'src/schema/tables/album.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * A Studio project (FL-89, `STU-202`).
 *
 * The project row is the head pointer and the lease; the document itself lives in
 * {@link StudioProjectRevisionTable}, one immutable row per accepted save. Three groups of columns
 * matter and they are deliberately separate:
 *
 * - **Identity and access.** `ownerId` is the only account that may write. `spaceId` is the one
 *   way to share a project: a shared space (an album with `kind = 'space'`) whose members may
 *   review the project read-only. Membership is re-read from `album_user` on every request, so
 *   removing someone from the space revokes their review access at once, and deleting the space
 *   sets the column to null rather than deleting anybody's project.
 * - **The head.** `currentRevision` is the number the next save must name as `expectedRevision`.
 *   It only ever moves forward, and only inside the same transaction that inserts the revision it
 *   points at, which is what makes an optimistic save decidable in one conditional `UPDATE`.
 * - **The lease.** One writer at a time, ninety seconds, renewed by the client that holds it.
 *   `leaseClientId` distinguishes two tabs of the same account; the lease is owner-only, so the
 *   holder column exists for the audit trail and for the `SET NULL` on account deletion rather
 *   than for authorization.
 */
@Index({ columns: ['ownerId', 'updatedAt'] })
@Table('studio_project')
@UpdatedAtTrigger('studio_project_updatedAt')
export class StudioProjectTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  /** The only account allowed to change this project. */
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  ownerId!: string;

  @Column()
  name!: string;

  /** The shared space whose members may review this project. Null means the owner alone. */
  @ForeignKeyColumn(() => AlbumTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  spaceId!: string | null;

  /** The head revision number. 0 until the first save; the graph is null while it is 0. */
  @Column({ type: 'integer', default: 0 })
  currentRevision!: Generated<number>;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  leaseHolderId!: string | null;

  /** The editor instance holding the lease: one browser tab, not one account. */
  @Column({ nullable: true })
  leaseClientId!: string | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  leaseExpiresAt!: Timestamp | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @UpdateIdColumn()
  updateId!: Generated<string>;
}

/**
 * One accepted save.
 *
 * Rows are immutable: nothing updates them and nothing deletes them short of deleting the project.
 * Restoring an old revision inserts a new one whose `restoredFromRevision` names the source, so
 * history is always a straight line and a restore can itself be undone by restoring again.
 *
 * `envelope` is the whole stored document, `{ schemaVersion, engine, engineRevision, graph }`,
 * kept opaque so unknown graph fields survive a round trip. `digest` is the key-sorted SHA-256 of
 * it, and `requestKey` is the client's idempotency key: a retry that arrives after its response
 * was lost finds this row by key, compares digests and is answered with the same result instead of
 * being applied twice. The pair `(projectId, requestKey)` is unique for that reason.
 */
@Unique({ columns: ['projectId', 'revision'] })
@Unique({ columns: ['projectId', 'requestKey'] })
@Table('studio_project_revision')
export class StudioProjectRevisionTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  @ForeignKeyColumn(() => StudioProjectTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  projectId!: string;

  /** Position in the project's history, starting at 1. */
  @Column({ type: 'integer' })
  revision!: number;

  /** Who saved it. Kept after account deletion as null rather than deleting the history. */
  @ForeignKeyColumn(() => UserTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  authorId!: string | null;

  /** The complete stored envelope. Never read inside by the server; measured and digested only. */
  @Column({ type: 'jsonb' })
  envelope!: Record<string, unknown>;

  /** Key-sorted SHA-256 of `envelope`, hex. Equal digests are the same document. */
  @Column()
  digest!: string;

  @Column({ type: 'integer' })
  graphBytes!: number;

  /** What the save said it contained: command ids and counts, for the history list. */
  @Column({ type: 'jsonb' })
  summary!: Record<string, unknown>;

  /** The client's idempotency key for the save that produced this row. */
  @Column({ nullable: true })
  requestKey!: string | null;

  /** Set when this revision is a restore of an earlier one. */
  @Column({ type: 'integer', nullable: true })
  restoredFromRevision!: number | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}

/**
 * A review comment pinned to an instant on the timeline.
 *
 * Comments live beside the document, not inside the graph, so a reviewer without the write lease
 * can leave one and a comment never changes the digest of the revision it was made against. The
 * instant is stored as an exact rational number of seconds (FL-93): `timeNum / timeDen`, reduced,
 * so an NTSC frame boundary stays the boundary the editor and the encoder agree on.
 */
@Index({ columns: ['projectId', 'createdAt'] })
@Unique({ columns: ['projectId', 'requestKey'] })
@Table('studio_project_comment')
@UpdatedAtTrigger('studio_project_comment_updatedAt')
export class StudioProjectCommentTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  @ForeignKeyColumn(() => StudioProjectTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  projectId!: string;

  /** A deleted account takes its comments with it. */
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  authorId!: string;

  /** The revision the reviewer was looking at. */
  @Column({ type: 'integer' })
  revision!: number;

  @Column({ type: 'bigint' })
  timeNum!: Int8;

  @Column({ type: 'bigint' })
  timeDen!: Int8;

  @Column({ type: 'text' })
  text!: string;

  @Column({ type: 'timestamp with time zone', nullable: true })
  resolvedAt!: Timestamp | null;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  resolvedById!: string | null;

  /** The client's idempotency key for the create that produced this row. */
  @Column({ nullable: true })
  requestKey!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}
