import { Kysely, sql } from 'kysely';
import { DB } from 'src/schema/index.js';
import { releaseLockedCoverReferences } from 'src/utils/cover-references.js';
import { anyUuid } from 'src/utils/database.js';
import { lockDerivedResults } from 'src/utils/derivative-locks.js';

/**
 * A stack is Locked as a whole (owner decision 3, September 22, 2026, FL-53), and so is a live photo
 * (FL-34): the video part of every photo a cascade locks is locked with it, and every lock a cascade
 * writes carries the reason of the lock it follows, so the Locked view files it with its stack.
 *
 * A stack is one moment shown as one tile: a burst, a RAW with its JPEG, an original with its edits.
 * `AssetRepository.lock` and `unlock` already cover whole stacks and live photos. What is left here is
 * the step for photos that join a stack that holds a Locked photo (a new stack, a merge, an update that
 * sets `stackId`): they become Locked with it, in the transaction of the change that moved them, so a
 * stack is never seen half Locked. Every photo that becomes Locked this way releases its covers.
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
 * FL-34: takes the row locks of `assetIds` in id order. Every writer that locks or unlocks a group
 * (a stack, a live photo) calls this first in its transaction, before it writes `asset_lock` or the
 * group's `asset` rows, so two of them — a Move to Locked and a sensitive mark of the same stack, say —
 * queue on the first row instead of each holding what the other then waits for.
 */
export const lockAssetRowsInOrder = async (db: Kysely<DB>, assetIds: string[]) => {
  if (assetIds.length > 0) {
    await sql`select asset.id from asset where asset.id = ${anyUuid(assetIds)} order by asset.id for no key update`.execute(
      db,
    );
  }
};

/**
 * Touches the assets a cascade just locked, so every device syncs the change.
 */
const touch = async (db: Kysely<DB>, assetIds: string[]) => {
  if (assetIds.length > 0) {
    await db.updateTable('asset').set({ updatedAt: new Date() }).where('id', '=', anyUuid(assetIds)).execute();
  }
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
 * Call right after photos joined the stacks `stackIds` (a new stack, a merge), in the same
 * transaction. A stack that now holds a Locked photo is Locked as a whole, so its other photos become
 * Locked and release their covers. Returns the ids it locked.
 */
export const onStacksJoined = async (db: Kysely<DB>, stackIds: string[]): Promise<string[]> => {
  if (stackIds.length === 0) {
    return [];
  }

  // the whole stacks' rows first, in id order, like every other lock writer (FL-34)
  const { rows: members } = await sql<{ id: string }>`
    select member.id from asset as member where member."stackId" = ${anyUuid(stackIds)}
    union
    select member."livePhotoVideoId" from asset as member
    where member."stackId" = ${anyUuid(stackIds)} and member."livePhotoVideoId" is not null
  `.execute(db);
  await lockAssetRowsInOrder(
    db,
    members.map(({ id }) => id),
  );
  // with the video part of every live photo in the stack, and the reason of the stack's own lock
  const moved = await lockRestOfStacks(db, stackIds);
  // A photo newly locked with its stack locks what was published from it, too (FL-106).
  moved.push(...(await lockDerivedResults(db, moved)));
  await releaseLockedCoverReferences(db, moved);
  return moved;
};
