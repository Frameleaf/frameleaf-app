import type { ApiHttpError } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import en from '../../../../../i18n/en.json';
import NotificationsSettings from './NotificationsSettings.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

vi.mock('$app/state', () => ({
  page: { params: {}, route: { id: '/(user)/user-settings' }, url: new URL('http://localhost/user-settings') },
}));

vi.mock('@immich/ui', () => ({ toastManager: { primary: vi.fn(), danger: vi.fn() } }));

const loaded = preferencesFactory.build({
  emailNotifications: { enabled: true, albumInvite: true, albumUpdate: true },
  revision: 'revision-1',
});

const toggle = (name: string) => screen.getByRole('switch', { name });
const saveButton = () => screen.getByRole('button', { name: en.save });

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
  authManager.setPreferences(loaded);
  sdkMock.isHttpError.mockImplementation(
    (error: unknown): error is ApiHttpError => typeof error === 'object' && error !== null && 'status' in error,
  );
});

describe('NotificationsSettings (FL-77)', () => {
  it('turns invitations and updates off with email and saves only that change with the loaded revision', async () => {
    const saved = preferencesFactory.build({
      ...loaded,
      emailNotifications: { enabled: false, albumInvite: false, albumUpdate: false },
      revision: 'revision-2',
    });
    sdkMock.updateMyPreferences.mockResolvedValue(saved);
    render(NotificationsSettings);

    await fireEvent.click(toggle(en.frameleaf_own_prefs_email));

    expect(toggle(en.frameleaf_own_prefs_album_invites).getAttribute('aria-checked')).toBe('false');
    expect(toggle(en.frameleaf_own_prefs_album_invites)).toBeDisabled();
    expect(toggle(en.frameleaf_own_prefs_album_updates).getAttribute('aria-checked')).toBe('false');

    await fireEvent.click(saveButton());

    await waitFor(() =>
      expect(sdkMock.updateMyPreferences).toHaveBeenCalledWith({
        userPreferencesUpdateDto: {
          emailNotifications: { enabled: false, albumInvite: false, albumUpdate: false },
          expectedRevision: 'revision-1',
        },
      }),
    );
    await waitFor(() => expect(authManager.preferences.revision).toBe('revision-2'));
  });

  it('keeps the change when the preferences changed elsewhere and loads the latest values on request', async () => {
    const latest = preferencesFactory.build({
      ...loaded,
      emailNotifications: { enabled: true, albumInvite: false, albumUpdate: true },
      revision: 'revision-3',
    });
    sdkMock.updateMyPreferences.mockRejectedValue({ status: 409, data: { message: 'changed' } });
    sdkMock.getMyPreferences.mockResolvedValue(latest);
    render(NotificationsSettings);

    await fireEvent.click(toggle(en.frameleaf_own_prefs_album_updates));
    await fireEvent.click(saveButton());

    await waitFor(() => expect(screen.getByText(en.frameleaf_account_prefs_own_conflict)).toBeInTheDocument());
    expect(toggle(en.frameleaf_own_prefs_album_updates).getAttribute('aria-checked')).toBe('false');

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_account_prefs_load_latest }));

    await waitFor(() => expect(screen.queryByText(en.frameleaf_account_prefs_own_conflict)).not.toBeInTheDocument());
    expect(toggle(en.frameleaf_own_prefs_album_invites).getAttribute('aria-checked')).toBe('false');
    expect(toggle(en.frameleaf_own_prefs_album_updates).getAttribute('aria-checked')).toBe('true');
    expect(authManager.preferences.revision).toBe('revision-3');
  });
});
