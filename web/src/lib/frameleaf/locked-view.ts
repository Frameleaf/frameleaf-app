import { AssetLockReason, AssetVisibility } from '@immich/sdk';
import type { Translations } from 'svelte-i18n';

/**
 * The Locked view (FL-34): every item its owner locked, whatever locked it, in one place.
 *
 * Locked is one lock record per item. It keeps the item's albums and organisation and hides it from
 * every view except this one, which only opens after the PIN. The filter narrows by why the item is
 * locked; All is the default, so items moved over from the old Locked folder show straight away.
 */

/** `all`, or one of the lock reasons. */
export type LockedFilter = 'all' | AssetLockReason;

export const LOCKED_FILTERS: readonly LockedFilter[] = [
  'all',
  AssetLockReason.ImmichLockedFolder,
  AssetLockReason.Marked,
  AssetLockReason.Detected,
];

export const DEFAULT_LOCKED_FILTER: LockedFilter = 'all';

const FILTER_LABEL_KEYS: Record<LockedFilter, Translations> = {
  all: 'frameleaf_lock_filter_all',
  [AssetLockReason.ImmichLockedFolder]: 'frameleaf_lock_filter_folder',
  [AssetLockReason.Marked]: 'frameleaf_lock_filter_marked',
  [AssetLockReason.Detected]: 'frameleaf_lock_filter_detected',
};

/** The i18n key of a filter's label. */
export const lockedFilterLabelKey = (filter: LockedFilter): Translations => FILTER_LABEL_KEYS[filter];

/** Reads a filter from a URL value; anything unknown is All. */
export const parseLockedFilter = (value: string | null | undefined): LockedFilter =>
  LOCKED_FILTERS.find((filter) => filter === value) ?? DEFAULT_LOCKED_FILTER;

/** The timeline options for the Locked view with `filter` applied. */
export const lockedTimelineOptions = (filter: LockedFilter) =>
  filter === 'all'
    ? { visibility: AssetVisibility.Locked }
    : { visibility: AssetVisibility.Locked, lockReason: filter };

/**
 * The label of a locked tile's badge, as the prototype draws it: `Locked` for an item that came from
 * the old Locked folder (or whose reason the read did not carry), `Sensitive` for a mark or a detection.
 */
export const lockBadgeLabelKey = (reason: AssetLockReason | null | undefined): Translations =>
  reason === AssetLockReason.Marked || reason === AssetLockReason.Detected
    ? 'frameleaf_library_badge_sensitive'
    : 'frameleaf_library_badge_locked';
