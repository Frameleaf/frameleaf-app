import { Column, ForeignKeyColumn, Table } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { AlbumChangeRunTable } from 'src/schema/tables/album-change-run.table.js';

/**
 * FL-1300: a cleanup while it is being applied: the operations the person approved and how far the job has got.
 * `nextIndex`, `targets` and `tally` advance in the transaction that made each change, so a restart picks up
 * exactly where the last committed change left off.
 */
@Table('album_cleanup_apply')
export class AlbumCleanupApplyTable {
  @ForeignKeyColumn(() => AlbumChangeRunTable, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    primary: true,
    index: false,
  })
  runId!: string;

  /** The operations in the order they run. */
  @Column({ type: 'jsonb' })
  operations!: unknown;

  @Column({ type: 'integer', default: 0 })
  nextIndex!: Generated<number>;

  /** Which album each reference now means: new collections by their temporary id, merged-away albums by the winner. */
  @Column({ type: 'jsonb', default: '{}' })
  targets!: Generated<Record<string, string>>;

  /** What has been done so far, for the run's summary. */
  @Column({ type: 'jsonb', default: '{}' })
  tally!: Generated<Record<string, number>>;

  /** Whether the session that applied it had the PIN entered, so Locked photos it approved can still be healed. */
  @Column({ type: 'boolean', default: false })
  elevated!: Generated<boolean>;

  @Column({ type: 'timestamp with time zone', default: () => 'now()' })
  progressAt!: Generated<Timestamp>;
}
