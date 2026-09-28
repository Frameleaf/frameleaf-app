import { Column, ForeignKeyColumn, Table } from '@immich/sql-tools';
import type { Timestamp } from '@immich/sql-tools';
import { AlbumTable } from 'src/schema/tables/album.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * One member's last-seen marker for one shared space (FL-55).
 *
 * "New since your last visit" needs a per-member marker, and it must be per
 * member: a space is a place several people come back to at different times,
 * so a single "last changed" timestamp on the space cannot answer the question
 * for anybody. The row exists only once a member has marked the space seen; no
 * row means the member has not marked it yet, and everything in the space is
 * new to them.
 *
 * The marker is written explicitly, not by the act of loading the page. If
 * opening a space silently cleared the badge, a member who glanced at it on a
 * phone would lose the list of what they had not looked at. `POST
 * /shared-spaces/{id}/visit` is that explicit acknowledgement.
 *
 * The marker carries no content. What is new is recomputed from `album_asset`
 * against this timestamp on every read, under the same exclusions as every
 * other read of the space, so the marker can never disclose anything the member
 * could not otherwise see.
 */
@Table({ name: 'shared_space_visit' })
export class SharedSpaceVisitTable {
  @ForeignKeyColumn(() => AlbumTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false, primary: true })
  albumId!: string;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false, primary: true })
  userId!: string;

  /** When this member last said they had seen the space. */
  @Column({ type: 'timestamp with time zone' })
  lastSeenAt!: Timestamp;
}
