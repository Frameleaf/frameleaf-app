import { goto } from '$app/navigation';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { forgetOtherAccountsEagleImports } from '$lib/frameleaf/eagle/eagle-import-record';
import { clearPrivateBrowserState } from '$lib/frameleaf/private-browser-state';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn().mockResolvedValue(undefined) }));
vi.mock('$lib/frameleaf/eagle/eagle-import-record', () => ({
  forgetOtherAccountsEagleImports: vi.fn().mockResolvedValue(undefined),
}));

class FakeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly data: unknown = {},
  ) {
    super(`HTTP ${status}`);
  }
}

/** FL-1771: a sign-out the server could not complete is not shown as done. */
describe('authManager.logout', () => {
  const user = { id: 'user-1', name: 'Ada', email: 'ada@example.test' };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(goto).mockResolvedValue(undefined);
    sdkMock.isHttpError.mockImplementation((error: unknown) => error instanceof FakeHttpError);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    authManager.reset();
    authManager.setUser(user as never);
  });

  it('signs out and goes to the sign-in page when the server ends the session', async () => {
    sdkMock.logout.mockResolvedValue({ successful: true, redirectUri: '/auth/login' } as never);
    const emit = vi.spyOn(eventManager, 'emit');

    await expect(authManager.logout()).resolves.toBe(true);

    expect(authManager.authenticated).toBe(false);
    expect(emit).toHaveBeenCalledWith('AuthLogout');
    expect(goto).toHaveBeenCalledWith('/auth/login');
  });

  it.each([
    ['an expired session', new FakeHttpError(401)],
    ['a session remote access refuses', new FakeHttpError(403, { code: 'frameleaf_sign_in_required' })],
  ])('signs out here after %s', async (_name, error) => {
    sdkMock.logout.mockRejectedValue(error);

    await expect(authManager.logout()).resolves.toBe(true);

    expect(authManager.authenticated).toBe(false);
    expect(sdkMock.logout).toHaveBeenCalledTimes(1);
  });

  it('retries once, then stays signed in when the session could not be ended', async () => {
    sdkMock.logout.mockRejectedValue(new TypeError('Failed to fetch'));
    const emit = vi.spyOn(eventManager, 'emit');

    await expect(authManager.logout()).resolves.toBe(false);

    expect(sdkMock.logout).toHaveBeenCalledTimes(2);
    expect(authManager.authenticated).toBe(true);
    expect(emit).not.toHaveBeenCalledWith('AuthLogout');
    expect(goto).not.toHaveBeenCalled();
  });

  it('signs out when the retry succeeds', async () => {
    sdkMock.logout
      .mockRejectedValueOnce(new FakeHttpError(502))
      .mockResolvedValueOnce({ successful: true, redirectUri: '/auth/login' } as never);

    await expect(authManager.logout()).resolves.toBe(true);

    expect(authManager.authenticated).toBe(false);
  });
});

/** FL-1771: another account's Eagle import records are deleted once an account signs in. */
describe('authManager.refresh Eagle import records', () => {
  it("forgets other accounts' records for the account that signed in", async () => {
    vi.resetAllMocks();
    authManager.reset();
    const user = { id: 'user-2', name: 'Bo', email: 'bo@example.test', license: { activatedAt: 'x' } };
    sdkMock.getMyUser.mockResolvedValue(user as never);
    sdkMock.getMyPreferences.mockResolvedValue({
      privacy: { suppression: { personIds: [], tagIds: [], petIds: [] } },
    } as never);
    vi.mocked(forgetOtherAccountsEagleImports).mockResolvedValue(undefined);

    await authManager.refresh();

    expect(forgetOtherAccountsEagleImports).toHaveBeenCalledWith('user-2');
  });

  it.each([
    [{ supporter: false }, false],
    [{ supporter: true }, true],
    [undefined, true],
  ])('takes the supporter badge from the server answer %o (FL-1771)', async (features, purchased) => {
    vi.resetAllMocks();
    authManager.reset();
    sdkMock.getMyUser.mockResolvedValue({ id: 'user-3', name: 'Cy', email: 'cy@example.test' } as never);
    sdkMock.getMyPreferences.mockResolvedValue({
      privacy: { suppression: { personIds: [], tagIds: [], petIds: [] } },
    } as never);
    if (features) {
      sdkMock.getServerFeatures.mockResolvedValue(features as never);
    } else {
      sdkMock.getServerFeatures.mockRejectedValue(new Error('offline'));
    }
    await authManager.refresh();
    // the same account read again, with the supporter key now as the server says
    authManager.isPurchased = true;

    await authManager.refresh();

    expect(authManager.isPurchased).toBe(purchased);
  });
});

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
