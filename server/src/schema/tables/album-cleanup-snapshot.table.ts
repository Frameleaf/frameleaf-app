import { Column, ForeignKeyColumn, PrimaryColumn, Table } from '@frameleaf/sql-tools';
import type { Timestamp } from '@frameleaf/sql-tools';
import { UserTable } from 'src/schema/tables/user.table.js';

/** Which session a snapshot was computed for. A session without the PIN reads only `Ordinary`. */
export enum AlbumCleanupVariant {
  Ordinary = 'ordinary',
  Elevated = 'elevated',
}

/**
 * FL-1300: what the Magic Albums cleanup scan found in a person's top-level albums. One row per person per viewer
 * variant, because a session without the PIN must never receive anything computed from Locked items.
 */
@Table('album_cleanup_snapshot')
export class AlbumCleanupSnapshotTable {
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true, index: false })
  userId!: string;

  @PrimaryColumn({ type: 'text' })
  variant!: AlbumCleanupVariant;

  @Column({ type: 'jsonb' })
  facts!: unknown;

  @Column({ type: 'integer' })
  suggestionCount!: number;

  @Column({ type: 'timestamp with time zone' })
  computedAt!: Timestamp;
}
