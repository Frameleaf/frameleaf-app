import { Column, CreateDateColumn, ForeignKeyColumn, Table } from '@immich/sql-tools';
import type { Generated, Timestamp } from '@immich/sql-tools';
import { AlbumUserRole } from 'src/enum.js';
import { album_user_role_enum } from 'src/schema/enums.js';
import { AlbumTable } from 'src/schema/tables/album.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * A pending invitation to a shared space (FL-55).
 *
 * A shared space is an album row with `kind = 'space'`, so its members are
 * `album_user` rows and its roles are the album roles. The one thing a space
 * adds is that a recipient sees what the space exposes *before* joining it: the
 * invitation therefore lives here and NOT in `album_user`, so an invited person
 * holds no membership until they accept. That keeps every existing access
 * check, listing, sync feed and activity rule exactly as it is — a pending
 * recipient is simply not a member, and no asset, thumbnail or count is
 * reachable through this row.
 *
 * Accepting deletes the invitation and inserts the `album_user` row with the
 * role the owner offered. Declining deletes the invitation and nothing else.
 */
@Table({ name: 'shared_space_invite' })
export class SharedSpaceInviteTable {
  @ForeignKeyColumn(() => AlbumTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false, primary: true })
  albumId!: string;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false, primary: true })
  userId!: string;

  /** The role the recipient gets on accept. `owner` is never offered. */
  @Column({ enum: album_user_role_enum, default: AlbumUserRole.Editor })
  role!: Generated<AlbumUserRole>;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: true })
  invitedById!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
