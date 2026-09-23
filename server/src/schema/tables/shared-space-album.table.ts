import { CreateDateColumn, ForeignKeyColumn, Table } from '@immich/sql-tools';
import type { Generated, Timestamp } from '@immich/sql-tools';
import { AlbumTable } from 'src/schema/tables/album.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * An album a member has linked into a shared space (FL-55).
 *
 * **Membership by reference, not by move.** FL-52 nests an album by moving it:
 * `parentId` plus the closure table, one level, inside a collection. A shared
 * space deliberately does not use that. Moving an album under a space would
 * take somebody else's album out of their own library structure, and FL-55's
 * own acceptance says revocation "does not delete originals or move personal
 * album placement". The design invariant says the same thing from the other
 * side: shared spaces stay top level and albums nest only inside collections.
 *
 * So the link is a reference and nothing else. The album keeps its owner, its
 * place in its owner's tree, its own members and its own access rules. This row
 * records that a member pointed at it from the space, who did so and when.
 *
 * A link grants nothing. It does not share the album, it does not add or remove
 * a single asset, and it never mutates an `album_user` grant. What the space
 * shows for a linked album is computed from the assets that are already in the
 * space and also in that album — that is, from evidence every member could
 * already see. Unlinking deletes this row and touches nothing else.
 */
@Table({ name: 'shared_space_album' })
export class SharedSpaceAlbumTable {
  /** The shared space. Always an album row with `kind = 'space'`. */
  @ForeignKeyColumn(() => AlbumTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false, primary: true })
  albumId!: string;

  /** The linked album. Always `kind = 'album'`: a space never links a space or a collection. */
  @ForeignKeyColumn(() => AlbumTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false, primary: true })
  linkedAlbumId!: string;

  /** The member who made the link. They, and the space owner, may undo it. */
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: true })
  linkedById!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
