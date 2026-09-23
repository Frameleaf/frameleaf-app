import { Expression, sql } from 'kysely';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { AssetLockReason, AssetVisibility } from 'src/enum.js';

/**
 * The one Locked predicate (owner decision, September 22, 2026, FL-34).
 *
 * An asset is locked when it has an `asset_lock` record. Nothing else makes it locked: the upstream
 * `visibility = locked` is never stored (migration 2100000000320-AddAssetLock moved the old Locked
 * folder into lock records), and the sensitive projection (`asset.is_nsfw`) no longer hides anything
 * by itself. A lock is metadata, never a relocation: the asset keeps its stored visibility, albums,
 * favourites, tags, faces and stack.
 *
 * Who sees a locked asset: its owner, in an elevated (PIN-unlocked) session, and backend work (jobs,
 * sweeps, renders), which always may. Nobody else ever: not partners, album or space members, shared
 * links, or the owner's own ordinary sessions. Every read that could return another person's media or
 * run outside an elevated session applies one of the predicates below; a read of "Locked" (the API's
 * `visibility: locked`) is `isLocked`.
 *
 * In requests and responses `AssetVisibility.Locked` still stands for "locked", so older clients keep
 * working: `effectiveVisibility` reports `locked` for a locked asset, a request that sets
 * `visibility: locked` creates a lock, and a request for `visibility: locked` lists the Locked view.
 */

const assetRef = (assetAlias: string, column: string) => sql.ref(`${assetAlias}.${column}`);

/** True when the asset with this id is locked. */
export const lockedAssetIdExists = (assetId: Expression<unknown>) =>
  sql<boolean>`exists (select 1 from asset_lock where asset_lock."assetId" = ${assetId})`;

/** True when the asset under `assetAlias` is locked. */
export const isLocked = (assetAlias = 'asset') => lockedAssetIdExists(assetRef(assetAlias, 'id'));

/** True when the asset under `assetAlias` is not locked. */
export const isNotLocked = (assetAlias = 'asset') => sql<boolean>`not ${isLocked(assetAlias)}`;

/** True when the asset with this id is locked for one of `reasons`. */
export const lockedForReason = (reasons: AssetLockReason[], assetAlias = 'asset') =>
  reasons.length === 0
    ? sql<boolean>`false`
    : sql<boolean>`exists (
        select 1 from asset_lock
        where asset_lock."assetId" = ${assetRef(assetAlias, 'id')}
          and asset_lock.reason in (${sql.join(reasons.map((reason) => sql.lit(reason)))})
      )`;

/**
 * Locked media is its owner's alone, and only in an elevated session: the asset is not locked, or it
 * belongs to `lockedOwnerId`. Pass the viewer as `lockedOwnerId` only when their session is elevated
 * (`getLockedOwnerId`); without it no locked asset matches, whoever owns it.
 */
export const notLockedOrOwnedBy = (lockedOwnerId: string | undefined, assetAlias = 'asset') =>
  lockedOwnerId
    ? sql<boolean>`(${isNotLocked(assetAlias)} or ${assetRef(assetAlias, 'ownerId')} = ${lockedOwnerId}::uuid)`
    : isNotLocked(assetAlias);

/**
 * The locks an ordinary view (the timeline) reveals to the owner's elevated session: their sensitive
 * marks and detections ("Revealed for this session"). Items moved over from the old Locked folder
 * stay in the Locked view only, as the upstream folder kept them out of the timeline.
 */
export const REVEALED_LOCK_REASONS: readonly AssetLockReason[] = [AssetLockReason.Marked, AssetLockReason.Detected];

/**
 * Locked media an ordinary view shows: none, except `revealOwnerId`'s own items locked for a revealed
 * reason. Pass the viewer only when their session is elevated (`getLockedOwnerId`).
 */
export const revealedLockScope = (revealOwnerId: string | undefined, assetAlias = 'asset') => {
  if (!revealOwnerId) {
    return isNotLocked(assetAlias);
  }

  const owned = sql<boolean>`${assetRef(assetAlias, 'ownerId')} = ${revealOwnerId}::uuid`;
  const revealed = lockedForReason([...REVEALED_LOCK_REASONS], assetAlias);
  return sql<boolean>`(${isNotLocked(assetAlias)} or (${owned} and ${revealed}))`;
};

/** Timeline or Archive, and not locked: what an ordinary read shows. */
export const isDefaultVisible = (assetAlias = 'asset') =>
  sql<boolean>`(${assetRef(assetAlias, 'visibility')} in (${sql.lit(AssetVisibility.Archive)}, ${sql.lit(AssetVisibility.Timeline)}) and ${isNotLocked(assetAlias)})`;

/** On the timeline and not locked. */
export const isTimelineVisible = (assetAlias = 'asset') => visibilityIs(AssetVisibility.Timeline, assetAlias);

/**
 * A requested visibility as an API caller means it: `locked` is a locked asset that is not the hidden
 * video part of a live photo (that part locks with its photo but never lists on its own, as before);
 * any other value is that stored visibility on an asset that is not locked, or, with `revealOwnerId`,
 * one of that owner's own revealed locks (`revealedLockScope`).
 */
export const visibilityIs = (visibility: AssetVisibility, assetAlias = 'asset', revealOwnerId?: string) =>
  visibility === AssetVisibility.Locked
    ? sql<boolean>`(${assetRef(assetAlias, 'visibility')} != ${sql.lit(AssetVisibility.Hidden)} and ${isLocked(assetAlias)})`
    : sql<boolean>`(${assetRef(assetAlias, 'visibility')} = ${sql.lit(visibility)} and ${revealedLockScope(revealOwnerId, assetAlias)})`;

/** True when the asset matches any of the requested visibilities (see `visibilityIs`). */
export const visibilityIn = (visibilities: AssetVisibility[], assetAlias = 'asset') =>
  visibilities.length === 0
    ? sql<boolean>`false`
    : sql<boolean>`(${sql.join(
        visibilities.map((visibility) => visibilityIs(visibility, assetAlias)),
        sql` or `,
      )})`;

/**
 * The visibility an API caller sees: `locked` for a locked asset, the stored visibility otherwise. The
 * hidden video part of a live photo stays `hidden`, locked or not.
 */
export const effectiveVisibility = (assetAlias = 'asset') =>
  sql<AssetVisibility>`(case
    when ${assetRef(assetAlias, 'visibility')} = ${sql.lit(AssetVisibility.Hidden)} then ${assetRef(assetAlias, 'visibility')}
    when ${isLocked(assetAlias)} then ${sql.lit(AssetVisibility.Locked)}::asset_visibility_enum
    else ${assetRef(assetAlias, 'visibility')}
  end)`;

/** Why the asset is locked, or null when it is not. */
export const lockReasonOf = (assetAlias = 'asset') =>
  sql<AssetLockReason | null>`(select asset_lock.reason from asset_lock where asset_lock."assetId" = ${assetRef(assetAlias, 'id')})`;

/**
 * The in-memory counterpart for a row a repository returned: locked when it carries `isLocked`
 * (select `isLocked().as('isLocked')`) or an effective visibility of `locked`
 * (select `effectiveVisibility().as('visibility')`).
 */
export const isLockedRow = (asset: { isLocked?: boolean | null; visibility?: AssetVisibility | string | null }) =>
  asset.isLocked === true || asset.visibility === AssetVisibility.Locked;

/**
 * `effectiveVisibility` for a row a repository returned with `isLocked` selected: `locked` for a locked
 * asset (the hidden video part of a live photo stays `hidden`), the stored visibility otherwise.
 */
export const effectiveVisibilityOf = (asset: { visibility: AssetVisibility; isLocked?: boolean | null }) =>
  asset.isLocked && asset.visibility !== AssetVisibility.Hidden ? AssetVisibility.Locked : asset.visibility;

/**
 * The one viewer whose own locked media a read may include: the viewer, in an elevated session.
 * Shared links are never elevated.
 */
export const getLockedOwnerId = (auth: AuthDto): string | undefined => {
  if (auth.sharedLink) {
    return undefined;
  }

  return auth.session?.hasElevatedPermission ? auth.user.id : undefined;
};
