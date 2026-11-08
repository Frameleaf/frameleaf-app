import { Column, ForeignKeyColumn, PrimaryColumn, Table } from '@frameleaf/sql-tools';
import type { Timestamp } from '@frameleaf/sql-tools';
import { AlbumTable } from 'src/schema/tables/album.table.js';

/**
 * FL-1297: an album's item count and dates, stored so that listing albums never aggregates. A count
 * depends on who is reading, so each row belongs to one viewer variant: `viewerKey` is a hash of the
 * whole set of read options (`albumViewerKey`). A session without its PIN has a different key from an
 * unlocked one and can never read a number that includes Locked items.
 */
@Table({ name: 'album_summary' })
export class AlbumSummaryTable {
  @ForeignKeyColumn(() => AlbumTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false, primary: true })
  albumId!: string;

  @PrimaryColumn({ type: 'text' })
  viewerKey!: string;

  @Column({ type: 'integer' })
  assetCount!: number;

  @Column({ type: 'date', nullable: true })
  startDate!: Timestamp | null;

  @Column({ type: 'date', nullable: true })
  endDate!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  lastModifiedAssetTimestamp!: Timestamp | null;

  /** When the numbers were read, taken before the read so a change made during it is noticed later. */
  @Column({ type: 'timestamp with time zone' })
  computedAt!: Timestamp;
}
