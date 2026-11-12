import { Column, CreateDateColumn, ForeignKeyColumn, Index, Table } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import type { DateFindingCause } from 'src/utils/date-doctor.js';
import { PrimaryGeneratedUuidV7Column } from 'src/decorators.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * FL-930: one Apply of the Date & Time Doctor, which its owner can undo for 30 days. Older batches are removed
 * nightly. Mirrors migration 1794440000000-DateFix.
 */
@Index({ columns: ['userId', 'createdAt'] })
@Table('date_fix_batch')
export class DateFixBatchTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  userId!: string;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @Column({ type: 'timestamp with time zone', nullable: true })
  undoneAt!: Timestamp | null;

  @Column({ type: 'integer' })
  count!: number;

  /** What was asked: the proposals' cause when they all had one, or the zone and shift chosen by hand. */
  @Column({ type: 'text', nullable: true })
  cause!: DateFindingCause | null;

  @Column({ type: 'integer', nullable: true })
  shiftMinutes!: number | null;

  @Column({ type: 'text', nullable: true })
  timeZone!: string | null;
}

/**
 * FL-930: a photo's date and zone before and after a batch. A photo fixed again keeps the values from before its
 * first fix, so undoing the later batch puts back what the photo had before the Doctor touched it.
 */
@Table('date_fix_item')
export class DateFixItemTable {
  @ForeignKeyColumn(() => DateFixBatchTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  batchId!: string;

  @ForeignKeyColumn(() => AssetTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  assetId!: string;

  /** The EXIF capture date; null when the photo had none. */
  @Column({ type: 'timestamp with time zone', nullable: true })
  previousDate!: Timestamp | null;

  @Column({ type: 'text', nullable: true })
  previousZone!: string | null;

  /** The photo's own `fileCreatedAt` and `localDateTime`, which undo puts back as they were. */
  @Column({ type: 'timestamp with time zone' })
  previousTakenAt!: Timestamp;

  @Column({ type: 'timestamp with time zone' })
  previousLocalDateTime!: Timestamp;

  /** Whether the date or zone was locked before; if not, undo lets go of the lock once the sidecar is rewritten. */
  @Column({ type: 'boolean' })
  previousLocked!: boolean;

  @Column({ type: 'timestamp with time zone' })
  newDate!: Timestamp;

  @Column({ type: 'text', nullable: true })
  newZone!: string | null;

  @Column({ type: 'timestamp with time zone' })
  newLocalDateTime!: Timestamp;
}
