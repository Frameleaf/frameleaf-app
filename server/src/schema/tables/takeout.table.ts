import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  Index,
  PrimaryColumn,
  Table,
  Unique,
  UpdateDateColumn,
} from '@immich/sql-tools';
import type { Generated, Int8, Timestamp } from '@immich/sql-tools';
import type {
  TakeoutFileKind,
  TakeoutItemState,
  TakeoutMetadata,
  TakeoutPairState,
  TakeoutPhase,
  TakeoutResultKind,
  TakeoutSidecarCandidate,
  TakeoutSourceKind,
} from 'src/utils/takeout.js';
import { PrimaryGeneratedUuidV7Column } from 'src/decorators.js';
import { AlbumTable } from 'src/schema/tables/album.table.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { MediaOperationTable } from 'src/schema/tables/media-operation.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * A Google Photos import (FL-65, `IMP-001`). Mirrors migration 2100000000460-AddTakeoutImport.
 *
 * The row is the wizard: its sources, where it has got to (`phase`) and the choices the owner made
 * for the import (`options`). The work itself — scanning staged sources and importing reviewed
 * items — runs as durable `media_operation` jobs of kind `takeout_import`, so it is paused, cancelled,
 * retried and watched from Activity like every other background job and carries on after the browser
 * closes. `runOperationId` is the job that currently holds the import; a second job for the same
 * import refuses to start while it is running.
 *
 * `updatedAt` is written by the queries that change the row; there is no trigger.
 */
@Index({ columns: ['ownerId', 'createdAt'] })
@Table('takeout_import')
export class TakeoutImportTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  /** The only account that may see or act on this import. */
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  ownerId!: string;

  @Column()
  name!: string;

  /** `sources`, `scanning`, `review`, `importing` or `completed`. */
  @Column({ default: 'sources' })
  phase!: Generated<TakeoutPhase>;

  /** The owner's import choices (`TakeoutOptions`). Read by every run, so a retry uses the current ones. */
  @Column({ type: 'jsonb' })
  options!: Record<string, unknown>;

  @ForeignKeyColumn(() => MediaOperationTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  runOperationId!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}

/**
 * One source of an import: an uploaded ZIP archive staged on the server, or a server directory an
 * administrator selected under a permitted root. `path` is a server path and is never sent to a
 * client; archives are staged under an opaque generated name.
 */
@Table('takeout_source')
export class TakeoutSourceTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  @ForeignKeyColumn(() => TakeoutImportTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  importId!: string;

  /** The archive's file name as the owner selected it, or the directory's name. Display only. */
  @Column()
  name!: string;

  @Column()
  kind!: TakeoutSourceKind;

  @Column()
  path!: string;

  /** Declared archive size in bytes; zero for a directory. */
  @Column({ type: 'bigint', default: 0 })
  size!: Generated<Int8>;

  /** Bytes durably staged so far. An upload resumes at this offset. */
  @Column({ type: 'bigint', default: 0 })
  received!: Generated<Int8>;

  /**
   * Entries the scan refused rather than staged: an unsafe or traversing name, a link or encryption.
   * Their names are never used as paths; the count is reported so nothing is dropped silently.
   */
  @Column({ type: 'integer', default: 0 })
  rejected!: Generated<number>;

  /** Every entry has been staged and recorded; a resumed scan skips this source. */
  @Column({ type: 'boolean', default: false })
  scanned!: Generated<boolean>;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}

/**
 * One file found in a source: a photo, a video or a JSON sidecar. The id is derived from the source
 * and the entry name, so scanning the same entry again finds the row it already wrote instead of
 * staging a second copy.
 */
@Index({ columns: ['importId', 'folder'] })
@Unique({ columns: ['sourceId', 'entryName'] })
@Table('takeout_file')
export class TakeoutFileTable {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @ForeignKeyColumn(() => TakeoutImportTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  importId!: string;

  @ForeignKeyColumn(() => TakeoutSourceTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  sourceId!: string;

  /** The entry name exactly as the archive or directory walk gave it. Never used as a path. */
  @Column()
  entryName!: string;

  /** The path below the Google Photos folder, for display and album grouping. */
  @Column()
  relativePath!: string;

  /** The album or year folder the file sits in; empty at the export root. */
  @Column()
  folder!: string;

  @Column()
  name!: string;

  @Column()
  kind!: TakeoutFileKind;

  /** Where the staged copy lives on the server. Never sent to a client. */
  @Column()
  path!: string;

  @Column({ type: 'bigint' })
  size!: Int8;

  /** SHA-256 of the staged bytes. */
  @Column({ type: 'bytea' })
  checksum!: Buffer;

  /** SHA-1 of the staged bytes, which older libraries identify originals by. */
  @Column({ type: 'bytea' })
  legacyChecksum!: Buffer;

  @Column({ type: 'timestamp with time zone' })
  modifiedAt!: Timestamp;

  /** A sidecar's parsed metadata; null for media and for a sidecar that could not be read. */
  @Column({ type: 'jsonb', nullable: true })
  metadata!: TakeoutMetadata | null;
}

/**
 * A photo or video to import, and what happened to it. The id is its `takeout_file` row.
 *
 * `locked` is set when any metadata the item could take says the photo was in Google's Locked
 * Folder. Such an item is imported into Locked and is never named to a session that has not
 * unlocked it.
 */
@Index({ columns: ['importId', 'state'] })
@Table('takeout_item')
export class TakeoutItemTable {
  @ForeignKeyColumn(() => TakeoutFileTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true })
  id!: string;

  @Column({ type: 'uuid' })
  importId!: string;

  @Column({ default: 'ready' })
  state!: Generated<TakeoutItemState>;

  /** The metadata the import applies: the chosen sidecar's, or only the file's own title. */
  @Column({ type: 'jsonb' })
  metadata!: TakeoutMetadata;

  @Column({ type: 'uuid', nullable: true })
  sidecarId!: string | null;

  @Column({ type: 'jsonb' })
  candidates!: TakeoutSidecarCandidate[];

  /** Album folders the item belongs to. */
  @Column({ type: 'jsonb' })
  albums!: string[];

  @Column({ type: 'jsonb' })
  warnings!: string[];

  @Column({ type: 'boolean', default: false })
  locked!: Generated<boolean>;

  /** The library asset the item became or matched. */
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  assetId!: string | null;

  /** `created` when this import created the asset, `matched` when it was already in the library. */
  @Column({ nullable: true })
  resultKind!: TakeoutResultKind | null;

  /**
   * The library path a run copied this item to before creating its asset. A later run that finds an
   * asset with the item's checksum counts it as this import's own creation only when the asset is at
   * this path; otherwise the photo was already in the library and is only matched.
   */
  @Column({ nullable: true })
  createPath!: string | null;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}

/** A photo and a video that may be the two parts of one Live Photo, and the owner's decision. */
@Index({ columns: ['importId', 'state'] })
@Unique({ columns: ['photoItemId', 'videoItemId'] })
@Table('takeout_pair')
export class TakeoutPairTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  @Column({ type: 'uuid' })
  importId!: string;

  @ForeignKeyColumn(() => TakeoutItemTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  photoItemId!: string;

  @ForeignKeyColumn(() => TakeoutItemTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  videoItemId!: string;

  @Column({ default: 'suggested' })
  state!: Generated<TakeoutPairState>;

  @Column()
  reason!: string;

  @Column({ type: 'text', nullable: true })
  error!: string | null;
}

/**
 * The album an export folder became, per owner, so a second import of the same export adds to the
 * albums the first one made instead of making them again.
 */
@Unique({ columns: ['ownerId', 'folder'] })
@Table('takeout_album')
export class TakeoutAlbumTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  ownerId!: string;

  @Column()
  folder!: string;

  @ForeignKeyColumn(() => AlbumTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  albumId!: string;
}
