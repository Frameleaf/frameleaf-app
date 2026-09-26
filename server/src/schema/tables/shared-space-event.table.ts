import { Column, CreateDateColumn, ForeignKeyColumn, Index, Table } from '@immich/sql-tools';
import type { Generated, Timestamp } from '@immich/sql-tools';
import { PrimaryGeneratedUuidV7Column } from 'src/decorators.js';
import { SharedSpaceEventType } from 'src/enum.js';
import { ActivityTable } from 'src/schema/tables/activity.table.js';
import { AlbumTable } from 'src/schema/tables/album.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * One thing that happened in a shared space (FL-55): photos added or removed,
 * an album or a person linked or unlinked, a member joining, leaving, being
 * removed or changing role, a comment, a like.
 *
 * **Written by the change, read by the members.** The service that makes a
 * change writes the row in the same request, whoever the actor is and whatever
 * the media is: recording is a backend duty and never depends on the actor's
 * session being elevated, so a Locked or sensitive photo added to a space is
 * recorded like any other. What members *see* is decided at read time, per
 * viewer, and is stricter: `assetIds` are filtered to the items that viewer can
 * see and that are still in the space before anything leaves the server, and an
 * event left with nothing visible is dropped from that viewer's feed. The
 * stored row therefore carries only ids, never a thumbnail, a name or a path.
 *
 * `activityId` ties a comment or like event to its `activity` row and cascades:
 * a deleted comment leaves the feed with it, so the feed never quotes something
 * its author took back. `subject` is the space's own name for a linked album
 * or person at the time, or the new role, so the sentence still reads after
 * the link is undone. `actorId` and `targetUserId` fall back to null when an
 * account is deleted; the row stays, the sentence loses its name.
 */
@Index({ name: 'shared_space_event_albumId_createdAt_idx', columns: ['albumId', 'createdAt'] })
@Table({ name: 'shared_space_event' })
export class SharedSpaceEventTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  /** The shared space. Always an album row with `kind = 'space'`. */
  @ForeignKeyColumn(() => AlbumTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  albumId!: string;

  /** Who did it. Null once that account is gone. */
  @ForeignKeyColumn(() => UserTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  actorId!: string | null;

  @Column()
  type!: SharedSpaceEventType;

  /** The member an event is about, for member events. Null once that account is gone. */
  @ForeignKeyColumn(() => UserTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  targetUserId!: string | null;

  /** The comment or like this event announces. Deleting the activity deletes the event. */
  @ForeignKeyColumn(() => ActivityTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: true })
  activityId!: string | null;

  /** The items added or removed. Ids only; filtered per viewer before they are sent. */
  @Column({ type: 'uuid', array: true, default: [] })
  assetIds!: Generated<string[]>;

  /** A linked album's or person's name as the space knew it, or the new role. */
  @Column({ nullable: true })
  subject!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
