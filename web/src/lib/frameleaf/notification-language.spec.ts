import { updateMyPreferences } from '@frameleaf/sdk';
import { adoptNotificationLanguage, saveNotificationLanguage } from '$lib/frameleaf/notification-language';
import { authManager } from '$lib/managers/auth-manager.svelte';

vi.mock('@frameleaf/sdk', () => ({ updateMyPreferences: vi.fn() }));
const session = vi.hoisted(() => ({
  authenticated: true,
  preferences: { notifications: { locale: 'en', devices: [{ sessionId: 'device', locale: 'de' }] } },
  captureSession: vi.fn(),
  setPreferences: vi.fn(),
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: session }));

describe('notification language', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    session.authenticated = true;
    session.preferences.notifications = { locale: 'en', devices: [{ sessionId: 'device', locale: 'de' }] };
    vi.mocked(authManager.captureSession).mockReturnValue(() => true);
    vi.mocked(updateMyPreferences).mockResolvedValue(authManager.preferences);
  });

  it('saves the catalogue locale without replacing device overrides', async () => {
    await saveNotificationLanguage('nb_NO');
    expect(updateMyPreferences).toHaveBeenCalledWith({
      userPreferencesUpdateDto: { notifications: { locale: 'nb-NO' } },
    });
    expect(authManager.setPreferences).toHaveBeenCalledWith(authManager.preferences);
  });

  it('uses the available language file for a regional choice', async () => {
    await saveNotificationLanguage('fr-CA');
    expect(updateMyPreferences).toHaveBeenCalledWith({
      userPreferencesUpdateDto: { notifications: { locale: 'fr' } },
    });
  });

  it('skips unchanged, unavailable and unauthenticated choices', async () => {
    await saveNotificationLanguage('en');
    await saveNotificationLanguage('dev');
    session.authenticated = false;
    await saveNotificationLanguage('fr');
    expect(updateMyPreferences).not.toHaveBeenCalled();
  });

  it('does not update another account after a session change', async () => {
    vi.mocked(authManager.captureSession).mockReturnValue(() => false);
    await expect(saveNotificationLanguage('fr')).rejects.toMatchObject({ name: 'AbortError' });
    expect(authManager.setPreferences).not.toHaveBeenCalled();
  });

  it('propagates a failed save without updating account state', async () => {
    vi.mocked(updateMyPreferences).mockRejectedValue(new Error('offline'));
    await expect(saveNotificationLanguage('fr')).rejects.toThrow('offline');
    expect(authManager.setPreferences).not.toHaveBeenCalled();
  });

  describe('an account that never chose one', () => {
    const unchosen = () => {
      session.preferences.notifications = { devices: [] } as never;
    };

    it('takes the language the app is shown in', async () => {
      unchosen();
      await adoptNotificationLanguage('fr');
      expect(updateMyPreferences).toHaveBeenCalledWith({
        userPreferencesUpdateDto: { notifications: { locale: 'fr' } },
      });
    });

    it('keeps a language the account already has', async () => {
      await adoptNotificationLanguage('fr');
      expect(updateMyPreferences).not.toHaveBeenCalled();
    });

    it('writes nothing for English, a language without a file, or a signed-out app', async () => {
      unchosen();
      await adoptNotificationLanguage('en');
      await adoptNotificationLanguage('dev');
      session.authenticated = false;
      await adoptNotificationLanguage('fr');
      expect(updateMyPreferences).not.toHaveBeenCalled();
    });

    it('lets a choice made while it is saving win, on the server and here', async () => {
      unchosen();
      let answerFirst!: (value: unknown) => void;
      vi.mocked(updateMyPreferences)
        .mockImplementationOnce(() => new Promise((done) => (answerFirst = done)) as never)
        .mockResolvedValueOnce({ notifications: { locale: 'de' } } as never);
      const adopted = adoptNotificationLanguage('fr');
      const chosen = saveNotificationLanguage('de');
      await vi.waitFor(() => expect(updateMyPreferences).toHaveBeenCalledTimes(1));
      await new Promise((done) => setTimeout(done, 0));
      // the choice waits for the save already on its way
      expect(updateMyPreferences).toHaveBeenCalledTimes(1);
      answerFirst({ notifications: { locale: 'fr' } });
      await Promise.all([adopted, chosen]);
      expect(
        vi.mocked(updateMyPreferences).mock.calls.map(([dto]) => dto.userPreferencesUpdateDto.notifications?.locale),
      ).toEqual(['fr', 'de']);
      expect(authManager.setPreferences).toHaveBeenLastCalledWith({ notifications: { locale: 'de' } });
    });

    it('lets a failed save pass quietly, to try again next time', async () => {
      unchosen();
      vi.mocked(updateMyPreferences).mockRejectedValue(new Error('offline'));
      await expect(adoptNotificationLanguage('fr')).resolves.toBeUndefined();
    });
  });
});
