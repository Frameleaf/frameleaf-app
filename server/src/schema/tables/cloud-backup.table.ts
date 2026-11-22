import { Column, CreateDateColumn, PrimaryGeneratedColumn, Table } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import type { Int8Writable } from 'src/schema/int8-writable.js';

/**
 * One backup (FL-160, FL-1676). `key` is the backup's name in storage, a snapshot of the backup engine's
 * repository (`r/v1/<vault id>/s/<sequence>-<id>`). It is chosen when the run starts, so a run resumed after a
 * restart finishes the same backup.
 */
@Table('cloud_backup_manifest')
export class CloudBackupManifestTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @Column({ type: 'text' })
  bucket!: string;

  @Column({ type: 'text' })
  key!: string;

  /** Where the backup holds its database dump. */
  @Column({ type: 'text', nullable: true })
  databaseKey!: string | null;

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
