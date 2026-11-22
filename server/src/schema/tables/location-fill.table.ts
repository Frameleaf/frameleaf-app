import { Column, CreateDateColumn, ForeignKeyColumn, Index, Table } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import type { FillMethod } from 'src/utils/location-fill.js';
import { PrimaryGeneratedUuidV7Column } from 'src/decorators.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/** Where a run is. A plain string in the API. */
export type LocationFillStatus = 'proposing' | 'ready' | 'applying' | 'applied' | 'undoing' | 'undone' | 'failed';

/**
 * FL-964: one pass over a person's photos without a location, proposing a place for each from their location
 * history. Nothing changes until its owner applies proposals; what was applied can be undone as a whole.
 * Mirrors migration 1794900000000-LocationFill.
 */
@Index({ columns: ['ownerId', 'createdAt'] })
@Table('location_fill_run')
export class LocationFillRunTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  ownerId!: string;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @Column({ type: 'text', default: 'proposing' })
  status!: Generated<LocationFillStatus>;

  /** How far in time a history place may be from the photo: 5, 15 or 60 minutes. */
  @Column({ type: 'integer' })
  maxGapMinutes!: number;

  /** Only photos taken from here on (local date and time), when asked. */
  @Column({ type: 'timestamp with time zone', nullable: true })
  takenAfter!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  takenBefore!: Timestamp | null;

  /** Photos without a location that were looked at. */
  @Column({ type: 'integer', default: 0 })
  candidateCount!: Generated<number>;

  @Column({ type: 'integer', default: 0 })
  proposalCount!: Generated<number>;

  /** Photos that hold a location from this run now. */
  @Column({ type: 'integer', default: 0 })
  appliedCount!: Generated<number>;

  @Column({ type: 'timestamp with time zone', nullable: true })
  appliedAt!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  undoneAt!: Timestamp | null;

  /** Why the run stopped, in words for its owner. */
  @Column({ type: 'text', nullable: true })
  error!: string | null;
}

/**
 * FL-964: the place proposed for one photo, and what became of it. A photo is only ever proposed a place while it
 * has none, so what undo puts back is always "no location": there is no earlier value to keep.
 */
@Table('location_fill_proposal')
export class LocationFillProposalTable {
  @ForeignKeyColumn(() => LocationFillRunTable, {
    primary: true,
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    index: false,
  })
  runId!: string;

  @ForeignKeyColumn(() => AssetTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  assetId!: string;

  @Column({ type: 'double precision' })
  latitude!: number;

  @Column({ type: 'double precision' })
  longitude!: number;

  /** `nearest`: the history place closest in time; `interpolated`: between the places before and after. */
  @Column({ type: 'text' })
  method!: FillMethod;

  /** Seconds between the photo and the nearest history place used. */
  @Column({ type: 'integer' })
  gapSeconds!: number;

  /** Its owner asked for this one to be applied. */
  @Column({ type: 'timestamp with time zone', nullable: true })
  requestedAt!: Timestamp | null;

  /** The photo was given this place. */
  @Column({ type: 'timestamp with time zone', nullable: true })
  appliedAt!: Timestamp | null;

  /** The place was taken away again by undo. Null on an applied photo whose location was changed since: undo left it. */
  @Column({ type: 'timestamp with time zone', nullable: true })
  undoneAt!: Timestamp | null;
}
