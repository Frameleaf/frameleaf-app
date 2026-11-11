import { Column, ForeignKeyColumn, PrimaryColumn, Table } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import type { DateFindingCause } from 'src/utils/date-doctor.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';

/**
 * FL-912: what the Date & Time Doctor found wrong with a photo's date or zone, and what it proposes, one row per
 * photo and cause. A scan replaces its owner's rows; a dismissed row stays, so a dismissed finding is not raised again.
 */
@Table('asset_date_finding')
export class AssetDateFindingTable {
  @ForeignKeyColumn(() => AssetTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  assetId!: string;

  @PrimaryColumn({ type: 'text' })
  cause!: DateFindingCause;

  @Column({ type: 'timestamp with time zone' })
  currentDate!: Timestamp;

  @Column({ type: 'text', nullable: true })
  currentZone!: string | null;

  /** Null when the Doctor can only say the date is wrong (a reset date with nothing to go on). */
  @Column({ type: 'timestamp with time zone', nullable: true })
  proposedDate!: Timestamp | null;

  @Column({ type: 'text', nullable: true })
  proposedZone!: string | null;

  @Column({ type: 'real' })
  confidence!: number;

  /** Camera and local day: a shoot is reviewed, and fixed, together. */
  @Column({ type: 'text' })
  groupKey!: string;

  @Column({ type: 'timestamp with time zone', default: () => 'now()' })
  createdAt!: Generated<Timestamp>;

  @Column({ type: 'timestamp with time zone', nullable: true })
  dismissedAt!: Timestamp | null;
}
