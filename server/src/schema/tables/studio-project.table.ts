import { Column, CreateDateColumn, ForeignKeyColumn, Index, Table, Unique, UpdateDateColumn } from '@immich/sql-tools';
import type { Generated, Timestamp } from '@immich/sql-tools';
import type { Int8Writable } from 'src/schema/int8-writable.js';
import { PrimaryGeneratedUuidV7Column, UpdateIdColumn, UpdatedAtTrigger } from 'src/decorators.js';
import { AlbumTable } from 'src/schema/tables/album.table.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
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
 * - **The lifecycle (FL-91, `STU-204`).** `archivedAt` puts a project away without touching its
 *   history; `deletedAt` moves it to the trash and `purgeAfter` says when the sweep may delete the
 *   row for good, so a trashed project is restorable until then and never a moment longer than the
 *   configured retention. Neither state touches any library original: a project only ever
 *   references media, so deleting it, even permanently, deletes references and nothing else.
 *   `thumbnailAssetId`, `duplicatedFromId` and `importedFromDigest` are lineage for the project
 *   library, all nullable and all `SET NULL` on the other side's deletion.
 */
@Index({ columns: ['ownerId', 'updatedAt'] })
@Index({ columns: ['purgeAfter'] })
@Unique({ columns: ['importOperationId'] })
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

  /** In the trash since. Null for a live project; restoring clears it. */
  @Column({ type: 'timestamp with time zone', nullable: true })
  deletedAt!: Timestamp | null;

  /** When the retention sweep may delete a trashed project for good. Null while it is not trashed. */
  @Column({ type: 'timestamp with time zone', nullable: true })
  purgeAfter!: Timestamp | null;

  /** Put away by the owner. Read-only until unarchived; hidden from the active list. */
  @Column({ type: 'timestamp with time zone', nullable: true })
  archivedAt!: Timestamp | null;

  /** The last time an editor instance took the lease, for the project library's recents. */
  @Column({ type: 'timestamp with time zone', nullable: true })
  lastOpenedAt!: Timestamp | null;

  /** A library asset the owner chose as the project's poster. Never copied; a reference only. */
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  thumbnailAssetId!: string | null;

  /** The project this one was duplicated from, while that project still exists. */
  @ForeignKeyColumn(() => StudioProjectTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  duplicatedFromId!: string | null;

  /** SHA-256, hex, of the portable bundle file this project was imported from. */
  @Column({ nullable: true })
  importedFromDigest!: string | null;

  /** The import job that created this project; unique, so a retried import finds it again. */
  @Column({ type: 'uuid', nullable: true })
  importOperationId!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @UpdateIdColumn()
  updateId!: Generated<string>;
}

/**
 * A portable bundle file an account uploaded for import (FL-91, `STU-204`).
 *
 * The upload is registered before anything is read out of it, so the import job works from a
 * file the server already measured and digested rather than from a request body. `manifest` is
 * the validated summary the interface shows before the import starts (name, sources, what will
 * relink); the file itself stays where the upload put it until `expiresAt`, or until the sweep
 * finds it consumed, so a second import with a corrected mapping does not need a second upload.
 * Retention is bounded by design: nothing here outlives its expiry.
 */
@Index({ columns: ['ownerId', 'expiresAt'] })
@Table('studio_bundle_upload')
export class StudioBundleUploadTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  ownerId!: string;

  /** Server-side path of the uploaded file. Never returned to a client. */
  @Column()
  path!: string;

  @Column({ type: 'bigint' })
  sizeBytes!: Int8Writable;

  /** SHA-256, hex, of the whole file as uploaded. */
  @Column()
  digest!: string;

  @Column()
  originalFileName!: string;

  /** The validated manifest summary. */
  @Column({ type: 'jsonb' })
  manifest!: Record<string, unknown>;

  @Column({ type: 'timestamp with time zone' })
  expiresAt!: Timestamp;

  /** Set by the first import that read it; the file is kept until expiry for a re-import. */
  @Column({ type: 'timestamp with time zone', nullable: true })
  consumedAt!: Timestamp | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
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
  timeNum!: Int8Writable;

  @Column({ type: 'bigint' })
  timeDen!: Int8Writable;

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

  @UpdateIdColumn()
  updateId!: Generated<string>;
}
