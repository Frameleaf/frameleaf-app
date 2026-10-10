import type { ApiHttpError } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { ownPreferencesPending } from '$lib/components/frameleaf/settings/own-preferences-pending.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import en from '../../../../../i18n/en.json';
import NotificationsSettings from './NotificationsSettings.svelte';

const navigation = vi.hoisted(() => ({ beforeNavigate: vi.fn(), goto: vi.fn() }));
vi.mock('$app/navigation', () => navigation);

vi.mock('$app/state', () => ({
  page: { params: {}, route: { id: '/(user)/user-settings' }, url: new URL('http://localhost/user-settings') },
}));

vi.mock('@frameleaf/ui', () => ({ toastManager: { primary: vi.fn(), danger: vi.fn() } }));

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

  it('holds unsaved changes in the shared sticky bar and marks the page as pending (finding 70)', async () => {
    render(NotificationsSettings);
    const bar = () => screen.queryByRole('region', { name: en.frameleaf_account_prefs_own_bar_label });

    // Nothing to save: no bar, no buttons, no pending mark.
    expect(bar()).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.save })).not.toBeInTheDocument();
    expect(ownPreferencesPending.dirty).toBe(false);

    await fireEvent.click(toggle(en.frameleaf_own_prefs_email));
    expect(bar()).toHaveTextContent(en.frameleaf_account_prefs_own_unsaved);
    expect(ownPreferencesPending.dirty).toBe(true);

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_account_prefs_cancel }));
    await waitFor(() => expect(bar()).not.toBeInTheDocument());
    expect(ownPreferencesPending.dirty).toBe(false);
    expect(toggle(en.frameleaf_own_prefs_email).getAttribute('aria-checked')).toBe('true');
  });

  it('holds a move to another settings page while a change is unsaved (design review finding 70)', async () => {
    render(NotificationsSettings);
    const guard = navigation.beforeNavigate.mock.calls.at(-1)![0] as (navigation: unknown) => void;
    const from = { url: new URL('http://localhost/user-settings?area=notifications') };
    const to = { url: new URL('http://localhost/user-settings?area=storage') };

    // Nothing to lose: the navigation goes through.
    const clean = vi.fn();
    guard({ cancel: clean, from, to, type: 'goto' });
    expect(clean).not.toHaveBeenCalled();

    await fireEvent.click(toggle(en.frameleaf_own_prefs_email));

    // A change of anything but the page (a scope, a dialog parameter) keeps the form, so it is not held.
    const samePage = vi.fn();
    guard({
      cancel: samePage,
      from,
      to: { url: new URL('http://localhost/user-settings?area=notifications&scope=all') },
      type: 'goto',
    });
    expect(samePage).not.toHaveBeenCalled();

    const cancel = vi.fn();
    guard({ cancel, from, to, type: 'goto' });
    expect(cancel).toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent(en.frameleaf_account_prefs_own_leave_notice);

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_account_prefs_discard_continue }));
    await waitFor(() => expect(navigation.goto).toHaveBeenCalledWith(to.url));
    expect(toggle(en.frameleaf_own_prefs_email).getAttribute('aria-checked')).toBe('true');
  });
});
