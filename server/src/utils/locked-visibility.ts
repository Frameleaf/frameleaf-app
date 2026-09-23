import type { AuthDto } from 'src/dtos/auth.dto.js';
import { AssetVisibility } from 'src/enum.js';
import { getLockedOwnerId, isLockedRow } from 'src/utils/locked.js';

export { getLockedOwnerId } from 'src/utils/locked.js';

/**
 * Repository option for album reads: the one owner whose locked media the read may include.
 * Left out, an album read shows Timeline and Archive media that is not locked.
 */
export type LockedVisibilityOptions = {
  lockedOwnerId?: string;
};

/**
 * FL-34: the single in-memory test for "this asset row is Locked", the counterpart of `isLockedAsset`
 * in `src/utils/database.ts`. Locked is the lock record, so the row must come from a read that selects
 * it: `isLocked()` as `isLocked`, or `effectiveVisibility()` as `visibility` (`src/utils/locked.ts`). A
 * row that carries neither reads as not locked.
 */
export const isLockedAssetRow = (asset: {
  visibility?: AssetVisibility | string | null;
  isLocked?: boolean | null;
}): boolean => isLockedRow(asset);

/**
 * Owner decision, September 22, 2026: locked media may be a member of any album and stays locked
 * there. An album read shows a locked item to exactly one viewer — the item's owner, in an elevated
 * (PIN-unlocked) session. Every other read hides it: the owner's ordinary sessions, other album
 * members whatever their own elevation, partners, shared spaces and shared links.
 *
 * A shared link is never elevated, so a shared-link visitor gets no owner here even when the link's
 * creator has an unlocked session open somewhere else. The predicate itself is `src/utils/locked.ts`.
 */
export const getLockedVisibilityOptions = (auth: AuthDto): LockedVisibilityOptions => {
  const lockedOwnerId = getLockedOwnerId(auth);
  return lockedOwnerId ? { lockedOwnerId } : {};
};
