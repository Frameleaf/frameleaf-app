import { AssetLockReason, AssetVisibility } from '@immich/sdk';
import {
  DEFAULT_LOCKED_FILTER,
  LOCKED_FILTERS,
  lockBadgeLabelKey,
  lockedFilterLabelKey,
  lockedTimelineOptions,
  parseLockedFilter,
} from '$lib/frameleaf/locked-view';

describe('locked view', () => {
  it('defaults to All, so items from the old Locked folder show straight away', () => {
    expect(DEFAULT_LOCKED_FILTER).toBe('all');
    expect(LOCKED_FILTERS[0]).toBe('all');
    expect(lockedTimelineOptions('all')).toEqual({ visibility: AssetVisibility.Locked });
  });

  it('offers All, the old Locked folder, Marked and Detected, in that order', () => {
    expect(LOCKED_FILTERS).toEqual([
      'all',
      AssetLockReason.ImmichLockedFolder,
      AssetLockReason.Marked,
      AssetLockReason.Detected,
    ]);
    expect(LOCKED_FILTERS.map((filter) => lockedFilterLabelKey(filter))).toEqual([
      'frameleaf_lock_filter_all',
      'frameleaf_lock_filter_folder',
      'frameleaf_lock_filter_marked',
      'frameleaf_lock_filter_detected',
    ]);
  });

  it('narrows the Locked timeline by reason', () => {
    expect(lockedTimelineOptions(AssetLockReason.Detected)).toEqual({
      visibility: AssetVisibility.Locked,
      lockReason: AssetLockReason.Detected,
    });
  });

  it('reads a filter from the URL and falls back to All for anything unknown', () => {
    expect(parseLockedFilter('detected')).toBe(AssetLockReason.Detected);
    expect(parseLockedFilter('immich-locked-folder')).toBe(AssetLockReason.ImmichLockedFolder);
    expect(parseLockedFilter('sensitive')).toBe('all');
    expect(parseLockedFilter(null)).toBe('all');
  });

  it('labels a tile Locked or Sensitive, as the prototype does', () => {
    expect(lockBadgeLabelKey(AssetLockReason.ImmichLockedFolder)).toBe('frameleaf_library_badge_locked');
    expect(lockBadgeLabelKey(AssetLockReason.Marked)).toBe('frameleaf_library_badge_sensitive');
    expect(lockBadgeLabelKey(AssetLockReason.Detected)).toBe('frameleaf_library_badge_sensitive');
    expect(lockBadgeLabelKey(null)).toBe('frameleaf_library_badge_locked');
  });
});
