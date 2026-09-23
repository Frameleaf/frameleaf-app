import { Expression, Kysely, sql } from 'kysely';
import { AssetVisibility } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { anyUuid } from 'src/utils/database.js';

/**
 * The one place FL-53 reads and writes the Locked state of an asset.
 *
 * Today an asset is Locked when it is in the Locked folder (`asset.visibility = 'locked'`), exactly as
 * in Immich, so a migrated library keeps working unchanged. FL-34 replaces that with a fork lock
 * record (`server/src/utils/locked.ts`); every Locked check and every lock or unlock write behind the
 * cover fallbacks, the stack cascade and profile pictures goes through the functions below, so that
 * change repoints them here and nowhere else.
 */

/** Whether a write that sets `visibility` puts the asset into the Locked state. */
export const isLockingVisibility = (visibility: AssetVisibility): visibility is AssetVisibility.Locked =>
  visibility === AssetVisibility.Locked;

/** Whether an asset row read into memory is Locked. */
export const isLockedAsset = (asset: { visibility: AssetVisibility }) => isLockingVisibility(asset.visibility);

/** SQL: the asset `assetId` names is Locked. False for a null or unknown id. */
export const isLockedAssetId = (assetId: Expression<unknown>) => sql<boolean>`exists (
    select 1
    from asset as locked_asset
    where locked_asset.id = ${assetId}
      and locked_asset.visibility = ${sql.lit(AssetVisibility.Locked)}
  )`;

/** SQL: the asset row `alias` (in scope in the query) is not Locked. */
export const isUnlockedAsset = (alias = 'asset') =>
  sql<boolean>`${sql.ref(`${alias}.visibility`)} != ${sql.lit(AssetVisibility.Locked)}`;

/** The ids among `assetIds` whose asset is Locked now. */
export const getLockedAssetIds = async (db: Kysely<DB>, assetIds: string[]): Promise<string[]> => {
  if (assetIds.length === 0) {
    return [];
  }

  const rows = await db
    .selectFrom('asset')
    .select('asset.id')
    .where('asset.id', '=', anyUuid(assetIds))
    .where(isLockedAssetId(sql.ref('asset.id')))
    .execute();
  return rows.map(({ id }) => id);
};

/**
 * Locks `assetIds` the way a move into the Locked folder does. The only lock write FL-53 adds, used by
 * the stack cascade to move the rest of a stack along with the asset that was locked. Returns the ids
 * it locked; ids already Locked are left alone.
 */
export const lockAssets = async (db: Kysely<DB>, assetIds: string[]): Promise<string[]> => {
  if (assetIds.length === 0) {
    return [];
  }

  const rows = await db
    .updateTable('asset')
    .set({ visibility: AssetVisibility.Locked })
    .where('asset.id', '=', anyUuid(assetIds))
    .where(isUnlockedAsset())
    .returning('asset.id')
    .execute();
  return rows.map(({ id }) => id);
};

/**
 * Unlocks `assetIds` to `visibility`, the way a move out of the Locked folder does. The only unlock
 * write FL-53 adds, used by the stack cascade. Returns the ids it unlocked; ids not Locked are left
 * alone.
 */
export const unlockAssets = async (
  db: Kysely<DB>,
  assetIds: string[],
  visibility: Exclude<AssetVisibility, AssetVisibility.Locked>,
): Promise<string[]> => {
  if (assetIds.length === 0) {
    return [];
  }

  const rows = await db
    .updateTable('asset')
    .set({ visibility })
    .where('asset.id', '=', anyUuid(assetIds))
    .where(isLockedAssetId(sql.ref('asset.id')))
    .returning('asset.id')
    .execute();
  return rows.map(({ id }) => id);
};
