import { Expression } from 'kysely';
import { AssetVisibility } from 'src/enum.js';
import { isLockedRow, isNotLocked, lockedAssetIdExists } from 'src/utils/locked.js';

/**
 * The Locked checks FL-53 reads behind the cover fallbacks and profile pictures.
 *
 * Locked is the fork lock record (`asset_lock`, FL-34, `src/utils/locked.ts`): metadata, never a
 * stored visibility. Lock and unlock writes are `AssetRepository.lock` / `unlock` (whole stacks and
 * live photos) and the stack cascade in `locked-stacks.ts`.
 */

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
