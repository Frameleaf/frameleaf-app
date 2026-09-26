import { Column, CreateDateColumn, PrimaryColumn, PrimaryGeneratedColumn, Table } from '@immich/sql-tools';
import type { Generated, Timestamp } from '@immich/sql-tools';
import type { Int8Writable } from 'src/schema/int8-writable.js';

/**
 * Cloud backup (FL-160). Mirrors migration 2100000000670-AddCloudBackupTables.
 *
 * `cloud_backup_object` is this server's index of the unique files already in a claimed bucket, one row
 * per SHA-256: an object `o/<sha256>` is uploaded once and every later run skips it. `bucket` is the
 * claimed bucket's address (`<endpoint>/<bucket>`), so a new bucket starts from an empty index; the
 * first run in a bucket fills the index from the bucket listing before it uploads anything.
 */
@Table('cloud_backup_object')
export class CloudBackupObjectTable {
  @PrimaryColumn({ type: 'text' })
  bucket!: string;

  /** Lowercase hex SHA-256 of the plaintext file; the object key is `o/<sha256>`. */
  @PrimaryColumn({ type: 'text' })
  sha256!: string;

  @Column({ type: 'bigint' })
  size!: Int8Writable;

  /** The ETag the provider answered for the upload (or listed), for the record. */
  @Column({ type: 'text', nullable: true })
  etag!: string | null;

  @Column({ type: 'timestamp with time zone', default: () => 'now()' })
  uploadedAt!: Generated<Timestamp>;

  /** The last run that referenced this object, or the listing that found it. */
  @Column({ type: 'timestamp with time zone', default: () => 'now()' })
  lastSeenAt!: Generated<Timestamp>;
}

/**
 * One backup run's manifest (FL-160): `m/<ISO>.json.gz` in the bucket once the run completes. The key
 * is chosen when the run starts, so a run resumed after a restart finishes the same manifest.
 */
@Table('cloud_backup_manifest')
export class CloudBackupManifestTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @Column({ type: 'text' })
  bucket!: string;

  @Column({ type: 'text' })
  key!: string;

  /** The `media_operation` of kind `cloud_backup` writing this manifest. */
  @Column({ type: 'uuid', nullable: true })
  operationId!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @Column({ type: 'timestamp with time zone', nullable: true })
  finishedAt!: Timestamp | null;

  @Column({ type: 'integer', default: 0 })
  assetCount!: Generated<number>;

  @Column({ type: 'integer', default: 0 })
  fileCount!: Generated<number>;

  @Column({ type: 'bigint', default: 0 })
  bytes!: Generated<Int8Writable>;

  /** `running`, `complete`, `cancelled` or `failed`. */
  @Column({ type: 'text', default: 'running' })
  status!: Generated<string>;
}

/**
 * The files a running manifest has recorded so far (FL-160), so a run resumed after a restart keeps
 * what it already did. `fileKey` names the file within the manifest (`<assetId>:original`,
 * `<assetId>:sidecar`, `profile:<userId>`, …); writing one twice replaces it. The rows are deleted once
 * the manifest is in the bucket, or when its run ends without one.
 */
@Table('cloud_backup_manifest_entry')
export class CloudBackupManifestEntryTable {
  @PrimaryColumn({ type: 'uuid' })
  manifestId!: string;

  @PrimaryColumn({ type: 'text' })
  fileKey!: string;

  @Column({ type: 'uuid', nullable: true })
  assetId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  ownerId!: string | null;

  /** `original`, `sidecar`, `fullsize`, `preview`, `thumbnail`, `encoded_video` or `profile`. */
  @Column({ type: 'text' })
  role!: string;

  @Column({ type: 'text' })
  path!: string;

  @Column({ type: 'text' })
  sha256!: string;

  @Column({ type: 'bigint' })
  size!: Int8Writable;

  @Column({ type: 'timestamp with time zone', nullable: true })
  mtime!: Timestamp | null;
}
