import {
  DEFAULT_LOCKED_FILTER,
  LOCKED_FILTERS,
  lockReasonBadge,
  lockedFilterLabelKey,
  lockedTimelineOptions,
  parseLockedFilter,
} from '$lib/frameleaf/locked-view';
import { AssetLockReason, AssetVisibility } from '@immich/sdk';
import { mdiFolderLockOutline, mdiShieldAlertOutline, mdiShieldLockOutline } from '@mdi/js';

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

  it('gives each reason its own badge', () => {
    expect(lockReasonBadge(AssetLockReason.ImmichLockedFolder)).toEqual({
      icon: mdiFolderLockOutline,
      labelKey: 'frameleaf_lock_reason_folder',
    });
    expect(lockReasonBadge(AssetLockReason.Marked)).toEqual({
      icon: mdiShieldLockOutline,
      labelKey: 'frameleaf_lock_reason_marked',
    });
    expect(lockReasonBadge(AssetLockReason.Detected)).toEqual({
      icon: mdiShieldAlertOutline,
      labelKey: 'frameleaf_lock_reason_detected',
    });
    expect(lockReasonBadge(null).labelKey).toBe('frameleaf_library_badge_locked');
  });
});
