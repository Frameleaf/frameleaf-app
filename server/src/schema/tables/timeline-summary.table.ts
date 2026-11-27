import { Column, ForeignKeyColumn, PrimaryColumn, Table } from '@frameleaf/sql-tools';
import type { Timestamp } from '@frameleaf/sql-tools';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * FL-1792: one month of a timeline summary (its pages) as last ranked, kept so a server start does not
 * rank the whole library again. `key` is a hash of the whole request (who asks, every option, the page
 * size and the ranking code), so a session without its PIN never reads an unlocked one's months. Shared
 * links are never stored.
 * A row is only ever used while the month's fingerprint, read fresh on every request, still matches.
 */
@Table({ name: 'timeline_summary' })
export class TimelineSummaryTable {
  @PrimaryColumn({ type: 'text' })
  key!: string;

  /** The month, as the summary names it: `2024-07-01`. */
  @PrimaryColumn({ type: 'text' })
  timeBucket!: string;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  userId!: string;

  @Column({ type: 'text' })
  fingerprint!: string;

  @Column({ type: 'jsonb' })
  pages!: unknown;

  /** When the summary was last ranked or read; each person keeps only their most recently used ones. */
  @Column({ type: 'timestamp with time zone' })
  usedAt!: Timestamp;
}
