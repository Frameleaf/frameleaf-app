import { Column, Index, PrimaryColumn, Table } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';

/** Where an original is now. */
export const ASSET_LEDGER_STATES = ['kept', 'trashed', 'removed', 'merged', 'missing'] as const;
export type AssetLedgerState = (typeof ASSET_LEDGER_STATES)[number];

/**
 * FL-921: the nothing-lost ledger, one row for every original the server has accepted. It says where the
 * original is now: kept, in the Trash, removed (by whom and when), sharing an identical file, or missing.
 *
 * `assetId`, `ownerId` and `stateBy` are plain ids, not foreign keys: the row outlives the photo and the
 * account. A row whose photo is gone without a recorded removal becomes `missing` in the nightly pass.
 */
@Table('asset_ledger')
@Index({ name: 'asset_ledger_owner_state_idx', columns: ['ownerId', 'state', 'stateAt', 'assetId'] })
@Index({ name: 'asset_ledger_missing_idx', columns: ['ownerId'], where: `state = 'missing'` })
export class AssetLedgerTable {
  @PrimaryColumn({ type: 'uuid' })
  assetId!: string;

  @Column({ type: 'uuid' })
  ownerId!: string;

  @Column({ type: 'bytea' })
  checksum!: Buffer;

  @Column({ type: 'text' })
  originalFileName!: string;

  @Column({ type: 'timestamp with time zone' })
  addedAt!: Timestamp;

  /** How it arrived: upload, library-scan, partner-copy, studio, recovered, or unknown for rows found later. */
  @Column({ type: 'text' })
  addedVia!: string;

  @Column({ type: 'text', default: 'kept' })
  state!: Generated<AssetLedgerState>;

  @Column({ type: 'timestamp with time zone', default: () => 'now()' })
  stateAt!: Generated<Timestamp>;

  /** Who put it in this state; null when Frameleaf did (a scan, the Trash emptying itself, the nightly pass). */
  @Column({ type: 'uuid', nullable: true })
  stateBy!: string | null;

  /** Why, for a state that has a reason: deleted, trash-expired, account-removed, identical-file, not-found. */
  @Column({ type: 'text', nullable: true })
  reason!: string | null;
}
