import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  Index,
  PrimaryGeneratedColumn,
  Table,
  UpdateDateColumn,
} from '@immich/sql-tools';
import type { Generated, Timestamp } from '@immich/sql-tools';
import { MemoryExportFormat, MemoryExportStatus } from 'src/enum.js';
import { MemoryTable } from 'src/schema/tables/memory.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * A private highlight export of one memory (FL-62).
 *
 * This is the durable half of the export job: the queued job carries only the row id, so a
 * worker restart, a cancel or a page reload all read the same authoritative state. The row
 * is owner-scoped by construction — every read path filters on `ownerId`, and the row is
 * removed with its owner or its memory — so an export is never visible to another user
 * even when the memory's assets are later shared.
 */
@Index({ columns: ['ownerId', 'createdAt'] })
@Index({ columns: ['status'] })
@Table('memory_export')
export class MemoryExportTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  ownerId!: string;

  @ForeignKeyColumn(() => MemoryTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  memoryId!: string;

  @Column({ default: MemoryExportFormat.Archive })
  format!: Generated<MemoryExportFormat>;

  @Column({ default: MemoryExportStatus.Pending })
  status!: Generated<MemoryExportStatus>;

  /** the memory's title when the export was requested, so a renamed or deleted memory still reads sensibly */
  @Column()
  title!: string;

  /**
   * The asset ids the export was requested for, captured at request time. The job never
   * re-reads the memory's current membership, so adding or removing assets afterwards
   * cannot change what an in-flight export produces.
   */
  @Column({ type: 'jsonb' })
  assetIds!: string[];

  @Column({ type: 'integer', default: 0 })
  assetCount!: Generated<number>;

  @Column({ type: 'integer', default: 0 })
  processedAssets!: Generated<number>;

  /** absolute path of the finished archive, only set while the run is `ready` */
  @Column({ type: 'text', nullable: true })
  path!: string | null;

  @Column({ type: 'bigint', nullable: true })
  sizeInBytes!: number | null;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  /** set by the owner's cancel request; the worker observes it and finishes the run as cancelled */
  @Column({ type: 'timestamp with time zone', nullable: true })
  cancelRequestedAt!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  startedAt!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  finishedAt!: Timestamp | null;

  /** the archive is deleted after this instant, whether or not it was downloaded */
  @Column({ type: 'timestamp with time zone', nullable: true })
  expiresAt!: Timestamp | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}
