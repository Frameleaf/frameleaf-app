import { Kysely, sql } from 'kysely';
import { AssetVisibility } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { releaseLockedCoverReferences } from 'src/utils/cover-references.js';
import { anyUuid } from 'src/utils/database.js';
import {
  isLockedAssetId,
  isLockingVisibility,
  isUnlockedAsset,
  lockAssets,
  unlockAssets,
} from 'src/utils/locked-state.js';

/**
 * A stack is Locked as a whole (owner decision 3, September 22, 2026, FL-53).
 *
 * A stack is one moment shown as one tile: a burst, a RAW with its JPEG, an original with its edits.
 * When any photo of a stack becomes Locked, every photo of that stack becomes Locked with it, and
 * when a photo of a stack leaves the Locked state, the whole stack leaves with it. Both happen in the
 * transaction of the change that moved the first photo, through the same choke point
 * (`AssetRepository.update`/`updateAll`, and the iCloud reconciler that locks Apple Hidden photos), so
 * a stack is never seen half Locked. Every photo that becomes Locked this way releases its covers.
 *
 * These are written as "when assets become Locked / leave the Locked state" steps rather than as
 * visibility updates: the change itself is the caller's, and the only lock and unlock writes are the
 * ones in `locked-state.ts`.
 */

/** The ids of the other photos of the stacks `assetIds` belong to. */
const otherStackMembers = (db: Kysely<DB>, assetIds: string[]) =>
  db
    .selectFrom('asset as member')
    .select('member.id')
    .where('member.stackId', 'in', (eb) =>
      eb
        .selectFrom('asset as moved')
        .select('moved.stackId')
        .where('moved.id', '=', anyUuid(assetIds))
        .where('moved.stackId', 'is not', null),
    )
    .where('member.id', '!=', sql<string>`all(${`{${assetIds}}`}::uuid[])`);

/**
 * Call right after `assetIds` became Locked, in the same transaction. Locks the rest of their stacks
 * and releases every cover, featured photo and face thumbnail any of them was. Returns the ids of the
 * other stack photos it locked.
 */
export const onAssetsLocked = async (db: Kysely<DB>, assetIds: string[]): Promise<string[]> => {
  if (assetIds.length === 0) {
    return [];
  }

  const rows = await otherStackMembers(db, assetIds).where(isUnlockedAsset('member')).execute();
  const moved = await lockAssets(db, rows.map(({ id }) => id));
  await releaseLockedCoverReferences(db, [...assetIds, ...moved]);
  return moved;
};

/**
 * Call right after `assetIds` left the Locked state for `visibility`, in the same transaction. Moves
 * the rest of their stacks out with them, to the same visibility. Returns the ids it moved.
 */
export const onAssetsUnlocked = async (
  db: Kysely<DB>,
  assetIds: string[],
  visibility: Exclude<AssetVisibility, AssetVisibility.Locked>,
): Promise<string[]> => {
  if (assetIds.length === 0) {
    return [];
  }

  const rows = await otherStackMembers(db, assetIds).where(isLockedAssetId(sql.ref('member.id'))).execute();
  return unlockAssets(db, rows.map(({ id }) => id), visibility);
};

/**
 * Call right after `assetIds` were written with `visibility`, in the same transaction; `wereLocked`
 * are those of them that were Locked before the write. Runs `onAssetsLocked` when the write locked
 * them, and `onAssetsUnlocked` for the ones it took out of the Locked state.
 */
export const onLockedStateChanged = async (
  db: Kysely<DB>,
  visibility: AssetVisibility,
  assetIds: string[],
  wereLocked: string[],
): Promise<void> => {
  if (isLockingVisibility(visibility)) {
    await onAssetsLocked(db, assetIds);
    return;
  }

  await onAssetsUnlocked(db, wereLocked, visibility);
};

/**
 * Call right after photos joined the stacks `stackIds` (a new stack, a merge), in the same
 * transaction. A stack that now holds a Locked photo is Locked as a whole, so its other photos become
 * Locked and release their covers. Returns the ids it locked.
 */
export const onStacksJoined = async (db: Kysely<DB>, stackIds: string[]): Promise<string[]> => {
  if (stackIds.length === 0) {
    return [];
  }

  const rows = await db
    .selectFrom('asset as member')
    .select('member.id')
    .where('member.stackId', '=', anyUuid(stackIds))
    .where(isUnlockedAsset('member'))
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('asset as locked_member')
          .select(sql.lit(1).as('locked'))
          .whereRef('locked_member.stackId', '=', 'member.stackId')
          .where(isLockedAssetId(sql.ref('locked_member.id'))),
      ),
    )
    .execute();
  const moved = await lockAssets(db, rows.map(({ id }) => id));
  await releaseLockedCoverReferences(db, moved);
  return moved;
};
