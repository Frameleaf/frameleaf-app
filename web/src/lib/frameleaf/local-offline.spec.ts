import { afterEach, describe, expect, it, vi } from 'vitest';
import { localOfflineSignOutPath, offlineSessionExit } from '$lib/frameleaf/local-offline';

describe('local Desktop offline sign-out', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('replaces Photos sign-out with an exact credential-free native intent', () => {
    vi.stubGlobal('__FRAMELEAF_DESKTOP_LOCAL_OFFLINE_ALBUMS__', true);
    expect(offlineSessionExit('/auth/logout')).toBe(localOfflineSignOutPath);
    expect(offlineSessionExit('/auth/logout?continue=%2Fphotos')).toBe(localOfflineSignOutPath);
  });

  it('preserves ordinary browser and Locked view navigation', () => {
    expect(offlineSessionExit('/auth/logout')).toBe('/auth/logout');
    vi.stubGlobal('__FRAMELEAF_DESKTOP_LOCAL_OFFLINE_ALBUMS__', true);
    expect(offlineSessionExit('/auth/pin-prompt')).toBe('/auth/pin-prompt');
    expect(offlineSessionExit('/auth/logout-extra')).toBe('/auth/logout-extra');
  });
});
