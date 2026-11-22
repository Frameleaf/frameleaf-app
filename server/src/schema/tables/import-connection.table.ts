import { Column, CreateDateColumn, ForeignKeyColumn, Table, Unique, UpdateDateColumn } from '@frameleaf/sql-tools';
import type { Generated, Int8, Timestamp } from '@frameleaf/sql-tools';
import { PrimaryGeneratedUuidV7Column } from 'src/decorators.js';
import { TakeoutImportTable } from 'src/schema/tables/takeout.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * A remote place one account imports photos from (FL-920): a WebDAV server, a Dropbox. Mirrors
 * migration 1794875920000-ImportConnection.
 *
 * Each scan of a connection is a `takeout_import` row that names it (`takeout_import.connectionId`),
 * so a run is scanned, reviewed, imported, paused and cancelled by the Google Photos import's own
 * machinery. `updatedAt` is written by the queries that change the row; there is no trigger.
 */
@Table('import_connection')
export class ImportConnectionTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  /** The only account that may see or use this connection. */
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  ownerId!: string;

  /** Which kind of source reads it (`webdav`, `dropbox`). Text: a new kind needs no schema change. */
  @Column({ type: 'text' })
  provider!: string;

  @Column({ type: 'text' })
  displayName!: string;

  /** The source's credentials, sealed with this server's own key and bound to this row. Never sent anywhere. */
  @Column({ type: 'bytea' })
  sealedCredentials!: Buffer;

  /** The folders the owner chose, as the source names them. */
  @Column({ type: 'jsonb', default: '[]' })
  roots!: Generated<string[]>;

  /** Look for new photos once a day and import them. */
  @Column({ type: 'boolean', default: false })
  dailyCheck!: Generated<boolean>;

  /** Where the last finished scan got to, as the source wants it remembered. */
  @Column({ type: 'jsonb', nullable: true })
  cursor!: Record<string, unknown> | null;

  /** When the latest scan was started, by the owner or by the daily check. */
  @Column({ type: 'timestamp with time zone', nullable: true })
  lastScanAt!: Timestamp | null;

  /** `active`, or `sign_in_required` once the source refused the credentials. */
  @Column({ type: 'text', default: 'active' })
  status!: Generated<string>;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}

/**
 * One file a connection has seen at its source, and the run that offers or imported it. A scan adds
 * a row for a file it has not seen and offers a row again when the file changed; nothing ever removes
 * a row because the file is gone from the source.
 */
@Unique({ columns: ['connectionId', 'remoteId'] })
@Table('import_connection_item')
export class ImportConnectionItemTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  @ForeignKeyColumn(() => ImportConnectionTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  connectionId!: string;

  /** The source's own id for the file. */
  @Column({ type: 'text' })
  remoteId!: string;

  /** Where the file is at the source, for review; its last segment is the file name. */
  @Column({ type: 'text' })
  path!: string;

  @Column({ type: 'bigint' })
  size!: Int8;

  @Column({ type: 'timestamp with time zone' })
  modifiedAt!: Timestamp;

  /** The source's own change marker, when it has one. */
  @Column({ type: 'text', nullable: true })
  contentHash!: string | null;

  @Column({ type: 'text', nullable: true })
  albumHint!: string | null;

  @Column({ type: 'text', nullable: true })
  caption!: string | null;

  @Column({ type: 'boolean', default: false })
  favourite!: Generated<boolean>;

  /** The run that offers this file, or imported it. */
  @ForeignKeyColumn(() => TakeoutImportTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  importId!: string | null;

  /** The run's `takeout_file` and `takeout_item` once the file has been downloaded. A plain id. */
  @Column({ type: 'uuid', nullable: true })
  fileId!: string | null;

  /** Why the download failed, until it is tried again. */
  @Column({ type: 'text', nullable: true })
  error!: string | null;
}
