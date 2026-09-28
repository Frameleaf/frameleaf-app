import { ForeignKeyColumn, Table } from '@immich/sql-tools';
import { ActivityTable } from 'src/schema/tables/activity.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * A member named in a shared space comment (FL-55).
 *
 * A mention is stored by user id, never by display name: the comment text
 * carries an `@{<user id>}` token the server parsed and checked against the
 * space's current members when the comment was written, so renaming an account
 * does not break a mention and typing somebody's name does not create one.
 * Deleting the comment deletes its mentions with it.
 */
@Table({ name: 'shared_space_mention' })
export class SharedSpaceMentionTable {
  @ForeignKeyColumn(() => ActivityTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false, primary: true })
  activityId!: string;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false, primary: true })
  userId!: string;
}
