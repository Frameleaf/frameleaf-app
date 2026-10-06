import { AssetLockReason, AssetVisibility } from '@frameleaf/sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  actsAsRegular,
  closeSessionModals,
  isRevealedLock,
  revealsLocks,
  trackSessionModals,
} from '$lib/frameleaf/session-access.svelte';

describe('closeSessionModals', () => {
  it('retries a modal whose close was rejected instead of replaying the rejection', async () => {
    const close = vi.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValueOnce(undefined);
    const manager = {
      open: () => ({ onClose: new Promise(() => {}), close }),
    } as unknown as typeof import('@frameleaf/ui').modalManager;
    trackSessionModals(manager);
    manager.open({} as never);

    await expect(closeSessionModals()).rejects.toThrow('busy');
    await expect(closeSessionModals()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(2);
  });
});

describe('revealed locks (FL-195)', () => {
  const marked = { visibility: AssetVisibility.Locked, lockReason: AssetLockReason.Marked };
  const detected = { visibility: AssetVisibility.Locked, lockReason: AssetLockReason.Detected };
  const legacy = { visibility: AssetVisibility.Locked, lockReason: AssetLockReason.ImmichLockedFolder };

  it('reveals marks and detections in every ordinary view of an unlocked session only', () => {
    for (const options of [
      { visibility: AssetVisibility.Timeline },
      { visibility: AssetVisibility.Archive },
      { albumId: 'album' },
      { albumId: 'album', visibility: AssetVisibility.Timeline },
    ]) {
      expect(revealsLocks(options, true)).toBe(true);
      expect(revealsLocks(options, false)).toBe(false);
    }
    expect(revealsLocks({ visibility: AssetVisibility.Locked }, true)).toBe(false);
  });

  it('treats every revealed lock like any other item, old Locked folder items included', () => {
    expect(actsAsRegular({ visibility: AssetVisibility.Timeline }, false)).toBe(true);
    expect(isRevealedLock(marked, true)).toBe(true);
    expect(isRevealedLock(detected, true)).toBe(true);
    expect(actsAsRegular(marked, true)).toBe(true);
    // a viewer response carries no reason; the server only sends it to the owner's unlocked session
    expect(actsAsRegular({ visibility: AssetVisibility.Locked }, true)).toBe(true);
    expect(isRevealedLock(legacy, true)).toBe(true);
    expect(actsAsRegular(legacy, true)).toBe(true);
    expect(actsAsRegular(legacy, false)).toBe(false);
    expect(actsAsRegular(marked, false)).toBe(false);
  });
});
