import { updateMyPreferences } from '@frameleaf/sdk';
import { saveNotificationLanguage } from '$lib/frameleaf/notification-language';
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
});
