import { Kysely, sql } from 'kysely';
import { AssetVisibility } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { releaseLockedCoverReferences } from 'src/utils/cover-references.js';
import { anyUuid } from 'src/utils/database.js';
import { isLockedAssetId, isLockingVisibility, unlockAssets } from 'src/utils/locked-state.js';

/**
 * A stack is Locked as a whole (owner decision 3, September 22, 2026, FL-53), and so is a live photo
 * (FL-34): the video part of every photo a cascade locks is locked with it, and every lock a cascade
 * writes carries the reason of the lock it follows, so the Locked view files it with its stack.
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

/**
 * The ids of the other photos of the stacks `assetIds` belong to. Exported so a caller can, after one
 * of these cascades commits, find who else to tell about it — `AssetRepository.getStackSiblingIds`
 * uses it to give every stack sibling of a Locked or unlocked asset the same real-time update the
 * asset itself gets (FL-53), so an open web client reflects a whole-stack move at once.
 */
export const otherStackMembers = (db: Kysely<DB>, assetIds: string[]) =>
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
 * Touches the assets a cascade just locked, so every device syncs the change.
 */
const touch = async (db: Kysely<DB>, assetIds: string[]) => {
  if (assetIds.length > 0) {
    await db.updateTable('asset').set({ updatedAt: new Date() }).where('id', '=', anyUuid(assetIds)).execute();
  }
};

/**
 * Locks the video part of every locked live photo among `assetIds` with its photo's reason (FL-34):
 * a live photo locks as a whole. Returns the ids it locked.
 */
const lockLivePhotoParts = async (db: Kysely<DB>, assetIds: string[]): Promise<string[]> => {
  const { rows } = await sql<{ assetId: string }>`
    insert into asset_lock ("assetId", "reason", "lockedBy")
    select still."livePhotoVideoId", asset_lock."reason", asset_lock."lockedBy"
    from asset as still
    inner join asset_lock on asset_lock."assetId" = still.id
    where still.id = ${anyUuid(assetIds)}
      and still."livePhotoVideoId" is not null
    on conflict ("assetId") do nothing
    returning "assetId"
  `.execute(db);
  return rows.map(({ assetId }) => assetId);
};

/**
 * Locks every photo of `stackIds` that holds a locked photo, and the video part of each of their live
 * photos (FL-34). Each takes the reason and author of the stack's own lock: the primary photo's when
 * it is locked, otherwise the earliest. Returns the ids it locked, touched but with covers untouched.
 */
const lockRestOfStacks = async (db: Kysely<DB>, stackIds: string[]): Promise<string[]> => {
  const { rows } = await sql<{ assetId: string }>`
    with source as (
      select distinct on (asset."stackId") asset."stackId", asset_lock."reason", asset_lock."lockedBy"
      from asset_lock
      inner join asset on asset.id = asset_lock."assetId"
      inner join stack on stack.id = asset."stackId"
      where asset."stackId" = ${anyUuid(stackIds)}
      order by asset."stackId", (asset.id = stack."primaryAssetId") desc, asset_lock."lockedAt"
    ),
    target as (
      select member.id, source."reason", source."lockedBy"
      from asset as member
      inner join source on source."stackId" = member."stackId"
      union
      select member."livePhotoVideoId" as id, source."reason", source."lockedBy"
      from asset as member
      inner join source on source."stackId" = member."stackId"
      where member."livePhotoVideoId" is not null
    )
    insert into asset_lock ("assetId", "reason", "lockedBy")
    select target.id, target."reason", target."lockedBy"
    from target
    on conflict ("assetId") do nothing
    returning "assetId"
  `.execute(db);
  const locked = rows.map(({ assetId }) => assetId);
  await touch(db, locked);
  return locked;
};

/**
 * Call right after `assetIds` became Locked, in the same transaction. Locks the video parts of their
 * live photos and the rest of their stacks (with their video parts), each with the reason of the lock
 * it follows, and releases every cover, featured photo and face thumbnail any of them was. Returns the
 * ids of everything else it locked.
 */
export const onAssetsLocked = async (db: Kysely<DB>, assetIds: string[]): Promise<string[]> => {
  if (assetIds.length === 0) {
    return [];
  }

  const parts = await lockLivePhotoParts(db, assetIds);
  await touch(db, parts);
  const stacks = await db
    .selectFrom('asset')
    .select('asset.stackId')
    .distinct()
    .where('asset.id', '=', anyUuid(assetIds))
    .where('asset.stackId', 'is not', null)
    .execute();
  const stackIds = stacks.map(({ stackId }) => stackId!);
  const members = stackIds.length > 0 ? await lockRestOfStacks(db, stackIds) : [];
  const moved = [...parts, ...members];
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

  // with the video part of every live photo in the stack, and the reason of the stack's own lock
  const moved = await lockRestOfStacks(db, stackIds);
  await releaseLockedCoverReferences(db, moved);
  return moved;
};
