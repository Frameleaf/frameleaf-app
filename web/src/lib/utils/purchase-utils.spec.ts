import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { clearPrivateBrowserState } from '$lib/frameleaf/private-browser-state';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { setSupportBadgeVisibility } from '$lib/utils/purchase-utils';
import { preferencesFactory } from '@test-data/factories/preferences-factory';

describe('support badge preferences', () => {
  const preferences = (showSupportBadge: boolean) => preferencesFactory.build({ purchase: { showSupportBadge } });

  beforeEach(() => {
    vi.resetAllMocks();
    authManager.reset();
    authManager.setUser({ id: 'owner' } as never);
    authManager.setPreferences(preferences(false));
  });

  it('applies the current account response and keeps request failures visible', async () => {
    sdkMock.updateMyPreferences.mockResolvedValueOnce(preferences(true));
    await setSupportBadgeVisibility(true);
    expect(authManager.preferences.purchase.showSupportBadge).toBe(true);
    expect(sdkMock.updateMyPreferences).toHaveBeenCalledWith({
      userPreferencesUpdateDto: { purchase: { showSupportBadge: true } },
    });
    const error = new Error('offline');
    sdkMock.updateMyPreferences.mockRejectedValueOnce(error);
    await expect(setSupportBadgeVisibility(false)).rejects.toBe(error);
  });

  it.each(['switch', 'relogin', 'private-clear'] as const)('discards a badge response after %s', async (change) => {
    let finish!: (value: ReturnType<typeof preferences>) => void;
    sdkMock.updateMyPreferences.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const pending = setSupportBadgeVisibility(true);
    if (change === 'private-clear') {
      clearPrivateBrowserState();
    } else {
      authManager.reset();
      authManager.setUser({ id: change === 'switch' ? 'second' : 'owner' } as never);
      authManager.setPreferences(preferences(false));
    }
    finish(preferences(true));
    await pending;
    expect(authManager.preferences.purchase.showSupportBadge).toBe(false);
  });
});
