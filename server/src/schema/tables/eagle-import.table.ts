import {
  Check,
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  Index,
  Table,
  Unique,
  UpdateDateColumn,
} from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { PrimaryGeneratedUuidV7Column } from 'src/decorators.js';
import { AlbumTable } from 'src/schema/tables/album.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/** `running` until it ends; `stopping` once Stop was pressed and the item in hand is finishing. */
export type EagleImportStatus = 'running' | 'stopping' | 'stopped' | 'finished';

/** One of the latest items brought over, for the progress list. */
export interface EagleImportRecent {
  id: string;
  name: string;
  duplicate: boolean;
  collections: string[];
}

/**
 * FL-653: an Eagle library in a folder the server can open, imported by the server so it carries on
 * with the tab closed. It is the server's version of the browser's resumable record: the
 * collections and tags already made, and (in `eagle_import_item`) every item brought over, so a
 * stopped or interrupted import carries on without sending anything twice. `libraryPath` is a
 * server path and is never sent to a client. The Eagle library itself is only read.
 */
@Table('eagle_import')
@Index({ columns: ['ownerId', 'createdAt'] })
/** One running import of a library per account, so two clicks or two tabs never import it twice. */
@Index({
  name: 'eagle_import_active_library_uq',
  columns: ['ownerId', 'libraryPath'],
  unique: true,
  where: `("status" IN ('running', 'stopping'))`,
})
@Check({
  name: 'eagle_import_status_check',
  expression: `"status" IN ('running', 'stopping', 'stopped', 'finished')`,
})
export class EagleImportTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  /** The only account that may see or act on this import. */
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  ownerId!: string;

  /** Which permitted import folder it is in, as `FRAMELEAF_IMPORT_ROOTS` listed it. */
  @Column()
  rootId!: string;

  /** The library folder below that root, as it was chosen. */
  @Column()
  relativePath!: string;

  /** The resolved library folder. Never sent to a client. */
  @Column()
  libraryPath!: string;

  @Column()
  libraryName!: string;

  /** Which library this is; an import carries on only into the same one. */
  @Column()
  fingerprint!: string;

  /** Where the import goes (`{ mode: 'top' }` or `{ mode: 'inside', inside }`). */
  @Column({ type: 'jsonb' })
  target!: Record<string, unknown>;

  /** Your top-level collection names when it started, for "Name (Eagle)" at the top level. */
  @Column({ type: 'jsonb', default: '[]' })
  existingTop!: Generated<string[]>;

  @Column({ default: 'running' })
  status!: Generated<EagleImportStatus>;

  /** Items that come over, as counted when the import last read the library. */
  @Column({ type: 'integer', default: 0 })
  total!: Generated<number>;

  /** The collection the import went into, when it went inside one. */
  @ForeignKeyColumn(() => AlbumTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  rootAlbumId!: string | null;

  /** Eagle folder id → collection id. */
  @Column({ type: 'jsonb', default: '{}' })
  albums!: Generated<Record<string, string>>;

  /** Tag name → tag id. */
  @Column({ type: 'jsonb', default: '{}' })
  tagIds!: Generated<Record<string, string>>;

  /** Eagle ids of items that could not be brought over this time. Carrying on tries them again. */
  @Column({ type: 'jsonb', default: '[]' })
  failed!: Generated<string[]>;

  @Column({ type: 'jsonb', default: '[]' })
  recent!: Generated<EagleImportRecent[]>;

  /** Why the import could not carry on, in plain words, when it could not. */
  @Column({ type: 'text', nullable: true })
  error!: string | null;

  /** The worker running it now, until its lease runs out. */
  @Column({ nullable: true })
  leaseOwner!: string | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  leaseExpiresAt!: Timestamp | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}

/** FL-653: one item an Eagle import on the server brought over, and the item it became. */
@Table('eagle_import_item')
@Unique({ columns: ['importId', 'itemId'] })
export class EagleImportItemTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  @ForeignKeyColumn(() => EagleImportTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  importId!: string;

  /** Eagle's id for the item. */
  @Column()
  itemId!: string;

  @Column({ type: 'uuid' })
  assetId!: string;

  /** The file was already in the library, so it was not stored twice. */
  @Column({ type: 'boolean' })
  duplicate!: boolean;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
