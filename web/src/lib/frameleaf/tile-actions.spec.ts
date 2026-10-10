import { AssetLockReason, AssetVisibility } from '@frameleaf/sdk';
import { describe, expect, it } from 'vitest';
import { sessionAccess } from '$lib/frameleaf/session-access.svelte';
import { tileActionAvailability } from './tile-actions';

describe('tile quick actions (FL-33, T-4)', () => {
  const context = { currentUserId: 'me', canEdit: true, canShare: true, canOpen: true };
  const asset = (overrides = {}) => ({
    ownerId: 'me',
    isTrashed: false,
    visibility: AssetVisibility.Timeline,
    ...overrides,
  });

  it('offers every action on the owner’s own item', () => {
    expect(tileActionAvailability(asset(), context)).toEqual({ favorite: true, edit: true, share: true, more: true });
  });

  it('offers only More on someone else’s item', () => {
    expect(tileActionAvailability(asset({ ownerId: 'partner' }), context)).toEqual({
      favorite: false,
      edit: false,
      share: false,
      more: true,
    });
  });

  it('offers nothing but More on a Locked item on the Locked page, or while the session is locked', () => {
    const locked = { favorite: false, edit: false, share: false, more: true };
    expect(tileActionAvailability(asset({ visibility: AssetVisibility.Locked }), context)).toEqual(locked);
    expect(tileActionAvailability(asset(), { ...context, locked: true })).toEqual(locked);
  });

  it('treats a mark revealed in an unlocked session like any other item, but never shares it (FL-195)', () => {
    sessionAccess.isElevated = true;
    try {
      const revealed = asset({ visibility: AssetVisibility.Locked, lockReason: AssetLockReason.Marked });
      expect(tileActionAvailability(revealed, context)).toEqual({
        favorite: true,
        edit: true,
        share: false,
        more: true,
      });
      expect(tileActionAvailability(revealed, { ...context, locked: true }).favorite).toBe(false);
      const legacy = asset({ visibility: AssetVisibility.Locked, lockReason: AssetLockReason.ImmichLockedFolder });
      // FL-195 follow-up: an item moved from the old Locked folder is revealed too
      expect(tileActionAvailability(legacy, context).favorite).toBe(true);
    } finally {
      sessionAccess.isElevated = false;
    }
  });

  it('changes nothing in the trash, and needs a viewer to edit or open', () => {
    expect(tileActionAvailability(asset({ isTrashed: true }), context).favorite).toBe(false);
    expect(tileActionAvailability(asset(), { ...context, trash: true }).edit).toBe(false);
    expect(tileActionAvailability(asset(), { ...context, canEdit: false, canOpen: false })).toMatchObject({
      edit: false,
      more: false,
    });
  });
});
