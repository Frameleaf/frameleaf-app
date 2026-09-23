import { CreateDateColumn, ForeignKeyColumn, Table } from '@immich/sql-tools';
import type { Generated, Timestamp } from '@immich/sql-tools';
import { ActivityTable } from 'src/schema/tables/activity.table.js';
import { AlbumTable } from 'src/schema/tables/album.table.js';

/**
 * Which comment a shared space reply answers (FL-55, threaded replies).
 *
 * A reply is an ordinary `activity` comment; this row is the only thing that
 * makes it a reply. Keeping the thread in a fork table, rather than adding a
 * parent column to the upstream `activity` table, means an upstream merge never
 * touches it. A comment with no row here is a top-level comment, which is what
 * every comment written before this table existed, and every comment written
 * through the upstream activity endpoints, stays.
 *
 * Threads are one level deep: `parentActivityId` is always a top-level
 * comment. Replying to a reply is stored against that reply's own parent, so
 * it stays in the same thread; the service resolves that before it writes.
 *
 * Deleting the reply deletes this row (cascade on `activityId`). Deleting the
 * parent removes its replies too: the service deletes the reply `activity` rows
 * together with the parent in one statement, and the cascade on
 * `parentActivityId` is the backstop that leaves no row pointing at a comment
 * that is gone. `albumId` is the shared space, so the rows leave with it.
 */
@Table({ name: 'shared_space_comment_thread' })
export class SharedSpaceCommentThreadTable {
  /** The reply. One row per reply, so a comment answers at most one parent. */
  @ForeignKeyColumn(() => ActivityTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false, primary: true })
  activityId!: string;

  /** The top-level comment the reply answers. Never itself a reply. */
  @ForeignKeyColumn(() => ActivityTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  parentActivityId!: string;

  /** The shared space. Always an album row with `kind = 'space'`. */
  @ForeignKeyColumn(() => AlbumTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  albumId!: string;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
