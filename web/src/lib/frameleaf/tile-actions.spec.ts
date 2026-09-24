import { AssetVisibility } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
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

  it('never shares a Locked item from a tile', () => {
    expect(tileActionAvailability(asset({ visibility: AssetVisibility.Locked }), context).share).toBe(false);
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
