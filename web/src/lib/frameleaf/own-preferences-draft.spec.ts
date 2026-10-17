import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { createOwnPreferencesDraft } from '$lib/frameleaf/own-preferences-draft';
import { clearPrivateBrowserState } from '$lib/frameleaf/private-browser-state';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { preferencesFactory } from '@test-data/factories/preferences-factory';

describe('own preferences draft ownership', () => {
  const preferences = (enabled: boolean) =>
    preferencesFactory.build({ memories: { enabled }, revision: enabled ? 'r1' : 'r2' });

  beforeEach(() => {
    vi.resetAllMocks();
    authManager.reset();
    authManager.setUser({ id: 'owner' } as never);
    authManager.setPreferences(preferences(true));
  });

  it('shares a current save while preserving the revision contract', async () => {
    const draft = createOwnPreferencesDraft(['memories.enabled']);
    draft.set('memories.enabled', false);
    sdkMock.updateMyPreferences.mockResolvedValue(preferences(false));
    await expect(draft.save()).resolves.toEqual(preferences(false));
    expect(sdkMock.updateMyPreferences).toHaveBeenCalledWith({
      userPreferencesUpdateDto: { memories: { enabled: false }, expectedRevision: 'r1' },
    });
    expect(authManager.preferences.memories.enabled).toBe(false);
  });

  it('refuses reads and writes from a draft after private-state invalidation', async () => {
    const draft = createOwnPreferencesDraft(['memories.enabled']);
    draft.set('memories.enabled', false);
    clearPrivateBrowserState();
    await expect(draft.save()).resolves.toBeUndefined();
    await expect(draft.loadLatest()).resolves.toBe(false);
    expect(sdkMock.updateMyPreferences).not.toHaveBeenCalled();
    expect(sdkMock.getMyPreferences).not.toHaveBeenCalled();
  });

  it.each(['save', 'load'] as const)('discards an in-flight %s after a same-account relogin', async (operation) => {
    const draft = createOwnPreferencesDraft(['memories.enabled']);
    draft.set('memories.enabled', false);
    let finish!: (value: ReturnType<typeof preferences>) => void;
    const response = new Promise<ReturnType<typeof preferences>>((resolve) => {
      finish = resolve;
    });
    sdkMock.updateMyPreferences.mockReturnValueOnce(response);
    sdkMock.getMyPreferences.mockReturnValueOnce(response);
    const pending = operation === 'save' ? draft.save() : draft.loadLatest();
    authManager.reset();
    authManager.setUser({ id: 'owner' } as never);
    authManager.setPreferences(preferences(true));
    finish(preferences(false));
    await pending;
    expect(authManager.preferences.memories.enabled).toBe(true);
    expect(draft.revision).toBe('r1');
  });
});
