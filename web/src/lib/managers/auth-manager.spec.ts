import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';

/** FL-146 (FL-77): an administrator's change to this account's preferences reaches open sessions live. */
describe('authManager.refreshPreferences', () => {
  const user = { id: 'user-1', name: 'Ada', email: 'ada@example.test' };
  const preferences = (memories: boolean) =>
    ({ memories: { enabled: memories }, privacy: { suppression: { personIds: [], tagIds: [], petIds: [] } } }) as never;

  beforeEach(() => {
    vi.clearAllMocks();
    authManager.setUser(user as never);
    authManager.setPreferences(preferences(true));
  });

  it('reads the preferences again and says so', async () => {
    const emit = vi.spyOn(eventManager, 'emit');
    sdkMock.getMyPreferences.mockResolvedValue(preferences(false));

    await authManager.refreshPreferences();

    expect(authManager.preferences.memories.enabled).toBe(false);
    expect(emit).toHaveBeenCalledWith('UserPreferencesRemoteUpdate');
  });

  it('keeps what the session has when the read fails', async () => {
    sdkMock.getMyPreferences.mockRejectedValue(new Error('offline'));

    await authManager.refreshPreferences();

    expect(authManager.preferences.memories.enabled).toBe(true);
  });
});
