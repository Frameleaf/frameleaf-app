import { Column, CreateDateColumn, ForeignKeyColumn, Table, Unique } from '@immich/sql-tools';
import type { Generated, Timestamp } from '@immich/sql-tools';
import { PrimaryGeneratedUuidV7Column } from 'src/decorators.js';
import { AlbumTable } from 'src/schema/tables/album.table.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { PersonGroupTable } from 'src/schema/tables/person-group.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * A person one member has linked into a shared space (FL-55), and the identity
 * the space knows them by.
 *
 * **A link, not a merge, and never a disclosure of somebody's own people.** A
 * `person` row belongs to one account: its name, its birth date, its hidden
 * flag and its thumbnail are that account's private naming of their own faces.
 * Linking must not hand any of that to the other members of a space, so this
 * row carries the space's *own* identity for the person and nothing borrowed:
 *
 * - `name` is the name the space sees. It is written by the member who made the
 *   link and it never reads back into their own `person` row, which is what
 *   "independently named identity" means — renaming in the space does not
 *   rename in the library, and renaming in the library does not rename here.
 * - `coverAssetId` is an asset that is already in the space, so showing it
 *   grants nothing: every member could already see it. The person's own
 *   thumbnail is never served to anybody else.
 *
 * The private half — which faces this actually is — stays in `personOwnerId` +
 * `personGroupId` and is only ever used server side, to count how many of the
 * space's assets show that person. Unlinking deletes this row: the person, its
 * name, its faces and every asset are untouched, and so is the space.
 *
 * `personOwnerId`/`personGroupId` are two single-column foreign keys rather than
 * one composite key to `person`, because the schema tooling models foreign keys
 * a column at a time. Deleting the `person` row while its owner and its group
 * survive therefore leaves this row behind; every read inner-joins `person`, so
 * such a link simply stops appearing, and unlinking still works.
 */
@Unique({ columns: ['albumId', 'personOwnerId', 'personGroupId'] })
@Table({ name: 'shared_space_person' })
export class SharedSpacePersonTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  /** The shared space. Always an album row with `kind = 'space'`. */
  @ForeignKeyColumn(() => AlbumTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  albumId!: string;

  /** Whose person this is. Always the member who made the link. */
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  personOwnerId!: string;

  /** Which of their people. Never exposed by the API. */
  @ForeignKeyColumn(() => PersonGroupTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  personGroupId!: string;

  /** The name the space uses. Independent of the owner's own name for them. */
  @Column({ default: '' })
  name!: Generated<string>;

  /** An asset already in the space, used as the face on the tile. Never the person's thumbnail. */
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  coverAssetId!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
