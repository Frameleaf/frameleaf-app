import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { clearPrivateBrowserState } from '$lib/frameleaf/private-browser-state';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';

/** FL-146 (FL-77): an administrator's change to this account's preferences reaches open sessions live. */
describe('authManager.refreshPreferences', () => {
  const user = { id: 'user-1', name: 'Ada', email: 'ada@example.test' };
  const preferences = (memories: boolean) =>
    ({ memories: { enabled: memories }, privacy: { suppression: { personIds: [], tagIds: [], petIds: [] } } }) as never;

  beforeEach(() => {
    vi.resetAllMocks();
    authManager.reset();
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

  it.each(['reset', 'switch', 'relogin', 'private-clear'] as const)(
    'discards a preferences read after %s',
    async (change) => {
      let finish!: (value: never) => void;
      sdkMock.getMyPreferences.mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      const emit = vi.spyOn(eventManager, 'emit');
      const pending = authManager.refreshPreferences();
      if (change === 'private-clear') {
        clearPrivateBrowserState();
      } else {
        authManager.reset();
        if (change !== 'reset') {
          authManager.setUser({ ...user, id: change === 'switch' ? 'user-2' : user.id } as never);
          authManager.setPreferences(preferences(true));
        }
      }
      finish(preferences(false));
      await pending;
      if (change === 'reset') {
        expect(() => authManager.preferences).toThrow('AuthManager.preferences is undefined');
      } else {
        expect(authManager.preferences.memories.enabled).toBe(true);
      }
      expect(emit).not.toHaveBeenCalledWith('UserPreferencesRemoteUpdate');
    },
  );

  it('does not restore a reset account from a late user/preferences read', async () => {
    let finish!: (value: never) => void;
    sdkMock.getMyUser.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    sdkMock.getMyPreferences.mockResolvedValue(preferences(false));
    sdkMock.getServerFeatures.mockResolvedValue({ supporter: true } as never);
    const emit = vi.spyOn(eventManager, 'emit');
    const pending = authManager.refresh();
    authManager.reset();
    finish(user as never);
    await pending;
    expect(authManager.authenticated).toBe(false);
    expect(sdkMock.getServerFeatures).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith('AuthUserLoaded', expect.anything());
  });

  it('discards a late supporter response and user-loaded event after reset', async () => {
    let finish!: (value: never) => void;
    let requested!: () => void;
    const started = new Promise<void>((resolve) => {
      requested = resolve;
    });
    sdkMock.getMyUser.mockResolvedValue(user as never);
    sdkMock.getMyPreferences.mockResolvedValue(preferences(false));
    sdkMock.getServerFeatures.mockImplementationOnce(() => {
      requested();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const emit = vi.spyOn(eventManager, 'emit');
    authManager.isPurchased = false;
    const pending = authManager.refresh();
    await started;
    authManager.reset();
    finish({ supporter: true } as never);
    await pending;
    expect(authManager.isPurchased).toBe(false);
    expect(emit).not.toHaveBeenCalledWith('AuthUserLoaded', expect.anything());
  });
});
