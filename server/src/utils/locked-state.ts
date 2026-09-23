import { Expression, Kysely, sql } from 'kysely';
import { AssetLockReason, AssetVisibility } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { anyUuid } from 'src/utils/database.js';
import { isNotLocked, isLockedRow, lockedAssetIdExists } from 'src/utils/locked.js';

/**
 * The one place FL-53 reads and writes the Locked state of an asset.
 *
 * Locked is the fork lock record (`asset_lock`, FL-34, `src/utils/locked.ts`): metadata, never a
 * stored visibility. Every Locked check and every lock or unlock write behind the cover fallbacks, the
 * stack cascade and profile pictures goes through the functions below, and they read and write that
 * record. In a request `visibility: locked` still means "lock it" (`isLockingVisibility`).
 */

/** Whether a write that asks for `visibility` puts the asset into the Locked state. */
export const isLockingVisibility = (visibility: AssetVisibility): visibility is AssetVisibility.Locked =>
  visibility === AssetVisibility.Locked;

/**
 * Whether an asset row read into memory is Locked. The row must carry the lock (`isLocked`) or the
 * effective visibility, see `isLockedRow`.
 */
export const isLockedAsset = (asset: { visibility?: AssetVisibility | string | null; isLocked?: boolean | null }) =>
  isLockedRow(asset);

/** SQL: the asset `assetId` names is Locked. False for a null or unknown id. */
export const isLockedAssetId = (assetId: Expression<unknown>) => lockedAssetIdExists(assetId);

/** SQL: the asset row `alias` (in scope in the query) is not Locked. */
export const isUnlockedAsset = (alias = 'asset') => isNotLocked(alias);

/** The ids among `assetIds` whose asset is Locked now. */
export const getLockedAssetIds = async (db: Kysely<DB>, assetIds: string[]): Promise<string[]> => {
  if (assetIds.length === 0) {
    return [];
  }

  const rows = await db
    .selectFrom('asset_lock')
    .select('asset_lock.assetId')
    .where('asset_lock.assetId', '=', anyUuid(assetIds))
    .execute();
  return rows.map(({ assetId }) => assetId);
};

/**
 * Locks `assetIds` without any cascade: writes their lock records (`reason`, by default the owner's own
 * lock) and touches the assets so clients that sync learn of it. Used by the stack cascade, which
 * releases the covers itself. Returns the ids it locked; ids already Locked keep their lock and reason.
 */
export const lockAssets = async (
  db: Kysely<DB>,
  assetIds: string[],
  reason: AssetLockReason = AssetLockReason.Marked,
): Promise<string[]> => {
  if (assetIds.length === 0) {
    return [];
  }

  const { rows } = await sql<{ assetId: string }>`
    insert into asset_lock ("assetId", "reason")
    select target.id, ${reason}
    from unnest(${`{${assetIds}}`}::uuid[]) as target(id)
    on conflict ("assetId") do nothing
    returning "assetId"
  `.execute(db);
  const locked = rows.map(({ assetId }) => assetId);
  if (locked.length > 0) {
    await db.updateTable('asset').set({ updatedAt: new Date() }).where('id', '=', anyUuid(locked)).execute();
  }
  return locked;
};

/**
 * Unlocks `assetIds` without any cascade: removes their lock records and touches the assets. The stored
 * visibility is left as it is, so an asset goes back exactly where it was; `_visibility` is kept for the
 * callers written against the upstream Locked folder. Returns the ids it unlocked.
 */
export const unlockAssets = async (
  db: Kysely<DB>,
  assetIds: string[],
  _visibility?: Exclude<AssetVisibility, AssetVisibility.Locked>,
): Promise<string[]> => {
  if (assetIds.length === 0) {
    return [];
  }

  const rows = await db
    .deleteFrom('asset_lock')
    .where('asset_lock.assetId', '=', anyUuid(assetIds))
    .returning('asset_lock.assetId')
    .execute();
  const unlocked = rows.map(({ assetId }) => assetId);
  if (unlocked.length > 0) {
    await db.updateTable('asset').set({ updatedAt: new Date() }).where('id', '=', anyUuid(unlocked)).execute();
  }
  return unlocked;
};
