import { Column, ForeignKeyColumn, Table } from '@immich/sql-tools';
import type { Generated, Timestamp } from '@immich/sql-tools';
import { AssetLockReason, AssetVisibility } from 'src/enum.js';
import { asset_visibility_enum } from 'src/schema/enums.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * The one Locked state (FL-34). Mirrors migration 2100000000320-AddAssetLock.
 *
 * A row means the asset is locked: hidden from every read except its owner's elevated (PIN-unlocked)
 * session, and listed in that owner's Locked view. A lock is metadata, never a relocation: the asset
 * keeps its albums, favourites, tags, faces and stack, and its stored `visibility` is left alone (the
 * upstream `locked` visibility is no longer written). `src/utils/locked.ts` holds the predicate every
 * read uses.
 */
@Table('asset_lock')
export class AssetLockTable {
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true })
  assetId!: string;

  /** `AssetLockReason`. */
  @Column()
  reason!: AssetLockReason;

  @Column({ type: 'timestamp with time zone', default: () => 'now()' })
  lockedAt!: Generated<Timestamp>;

  /** The account that locked it; null for detections and for the upgrade from the old Locked folder. */
  @ForeignKeyColumn(() => UserTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  lockedBy!: string | null;

  /**
   * The stored visibility the lock replaced, when creating it changed the asset's visibility: `locked`
   * for an asset moved out of the old Locked folder by the upgrade. Null otherwise.
   */
  @Column({ enum: asset_visibility_enum, nullable: true })
  previousVisibility!: AssetVisibility | null;
}
