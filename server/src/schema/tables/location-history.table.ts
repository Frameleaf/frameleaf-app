import { Column, CreateDateColumn, ForeignKeyColumn, Index, Table } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { PrimaryGeneratedUuidV7Column } from 'src/decorators.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * FL-925: one location history file a person imported. Its places are theirs alone: no partner, administrator or
 * shared link reads them. `importedAt` is set when the file has been read to its end; `error` when it could not be.
 * Mirrors migration 1794911000000-LocationHistory.
 */
@Index({ columns: ['ownerId', 'createdAt'] })
@Table('location_history_source')
export class LocationHistorySourceTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  ownerId!: string;

  /** What the file turned out to be (`gpx`, `google-timeline`, …); null until its first place is read. */
  @Column({ type: 'text', nullable: true })
  kind!: string | null;

  @Column({ type: 'text' })
  fileName!: string;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @Column({ type: 'timestamp with time zone', nullable: true })
  importedAt!: Timestamp | null;

  @Column({ type: 'integer', default: 0 })
  pointCount!: Generated<number>;

  @Column({ type: 'timestamp with time zone', nullable: true })
  firstAt!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  lastAt!: Timestamp | null;

  /** Why the file could not be read, in words for its owner. */
  @Column({ type: 'text', nullable: true })
  error!: string | null;
}

/** FL-925: where a person was at a moment, from one of their imported files. Removed with its file or its owner. */
@Index({ columns: ['ownerId', 'recordedAt'] })
@Table('location_point')
export class LocationPointTable {
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  ownerId!: string;

  @ForeignKeyColumn(() => LocationHistorySourceTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  sourceId!: string;

  @Column({ type: 'timestamp with time zone' })
  recordedAt!: Timestamp;

  @Column({ type: 'double precision' })
  latitude!: number;

  @Column({ type: 'double precision' })
  longitude!: number;

  @Column({ type: 'real', nullable: true })
  accuracyM!: number | null;
}
