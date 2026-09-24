import { login } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { goto } from '$app/navigation';
import {
  consumeLogoutPreference,
  getOAuthContinue,
  preserveOAuthContinueForPasswordChange,
  preservePreferenceForPasswordChange,
  rememberMePreference,
  setOAuthContinue,
  setRememberMePreference,
} from '$lib/frameleaf/auth-session-preference';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { oauth } from '$lib/utils';
import Page from './+page.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('@immich/sdk', () => ({ login: vi.fn(), isHttpError: () => false }));
vi.mock('$lib/utils', () => ({
  oauth: {
    isCallback: vi.fn(),
    isAutoLaunchDisabled: vi.fn(),
    isAutoLaunchEnabled: vi.fn(),
    authorize: vi.fn(),
    login: vi.fn(),
  },
}));
vi.mock('$lib/managers/server-config-manager.svelte', () => ({
  serverConfigManager: { value: { isOnboarded: true } },
}));
vi.mock('$lib/managers/event-manager.svelte', () => ({
  eventManager: { emit: vi.fn() },
}));

const data = (oauthEnabled: boolean) => ({
  continueUrl: '/photos',
  serverUrl: 'https://photos.example.test',
  publicConfig: {
    server: { loginPageMessage: '' },
    passwordLogin: { enabled: true },
    oauth: { enabled: oauthEnabled, autoLaunch: false, buttonText: 'Continue with provider' },
  },
});
const forced = {
  isAdmin: false,
  isOnboarded: true,
  shouldChangePassword: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  vi.mocked(oauth.isCallback).mockReturnValue(false);
  vi.mocked(oauth.isAutoLaunchEnabled).mockReturnValue(false);
  vi.mocked(oauth.isAutoLaunchDisabled).mockReturnValue(false);
});

describe('login mandatory-change routing', () => {
  it('stores the deep-link continuation before auto-launch navigation reloads page data', async () => {
    const pageData = data(true);
    pageData.publicConfig.oauth.autoLaunch = true;
    pageData.continueUrl = '/albums?from=share';
    vi.mocked(goto).mockImplementation(async () => {
      pageData.continueUrl = '/photos';
    });
    vi.mocked(oauth.authorize).mockResolvedValue(true);

    render(Page, { data: pageData } as never);
    await waitFor(() => expect(oauth.authorize).toHaveBeenCalledOnce());
    expect(goto).toHaveBeenCalledWith('/auth/login?continue=%2Falbums%3Ffrom%3Dshare&autoLaunch=0', {
      replaceState: true,
    });
    expect(String(getOAuthContinue('/photos'))).toBe(new URL('/albums?from=share', location.origin).href);
  });

  it('retains the original OAuth destination when auto-launch follows forced-password relogin', async () => {
    setOAuthContinue('/locked?from=oauth');
    preserveOAuthContinueForPasswordChange();
    preservePreferenceForPasswordChange();
    consumeLogoutPreference();
    const pageData = data(true);
    pageData.publicConfig.oauth.autoLaunch = true;
    vi.mocked(goto).mockImplementation(async () => {
      pageData.continueUrl = '/photos';
    });
    vi.mocked(oauth.authorize).mockResolvedValue(true);

    render(Page, { data: pageData } as never);
    await waitFor(() => expect(oauth.authorize).toHaveBeenCalledOnce());
    expect(goto).toHaveBeenCalledWith(
      `/auth/login?continue=${encodeURIComponent(new URL('/locked?from=oauth', location.origin).href)}&autoLaunch=0`,
      {
        replaceState: true,
      },
    );
    expect(String(getOAuthContinue('/photos'))).toBe(new URL('/locked?from=oauth', location.origin).href);
  });

  it('routes a password login to the forced password screen before continuing', async () => {
    vi.mocked(login).mockResolvedValue(forced as never);
    render(Page, { data: data(false) } as never);
    await fireEvent.input(screen.getByLabelText('Email'), { target: { value: 'user@example.test' } });
    await fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'temporary' } });
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Keep me signed in' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(goto).toHaveBeenCalledWith('/auth/change-password'));
    expect(login).toHaveBeenCalledWith({
      loginCredentialDto: { email: 'user@example.test', password: 'temporary', rememberMe: false },
    });
    expect(rememberMePreference()).toBe(false);
    expect(eventManager.emit).not.toHaveBeenCalled();
  });

  it('applies the same mandatory change to an OAuth callback', async () => {
    setRememberMePreference(false);
    vi.mocked(oauth.isCallback).mockReturnValue(true);
    vi.mocked(oauth.login).mockResolvedValue(forced as never);
    render(Page, { data: data(true) } as never);
    await waitFor(() => expect(goto).toHaveBeenCalledWith('/auth/change-password'));
    expect(oauth.login).toHaveBeenCalledWith(expect.anything(), false);
    expect(rememberMePreference()).toBe(false);
    expect(eventManager.emit).not.toHaveBeenCalled();
  });

  it('uses the same choice for OAuth-only sign-in and clears it after a completed callback', async () => {
    const oauthOnly = data(true);
    oauthOnly.publicConfig.passwordLogin.enabled = false;
    vi.mocked(oauth.authorize).mockResolvedValue(true);
    render(Page, { data: oauthOnly } as never);
    await screen.findByRole('button', { name: 'Continue with provider' });
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Keep me signed in' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Continue with provider' }));
    expect(rememberMePreference()).toBe(false);

    // The callback has its own page load after the provider redirects back.
    vi.mocked(oauth.isCallback).mockReturnValue(true);
    vi.mocked(oauth.login).mockResolvedValue({ ...forced, shouldChangePassword: false } as never);
    render(Page, { data: oauthOnly } as never);
    await waitFor(() =>
      expect(goto).toHaveBeenCalledWith(new URL('/photos', location.origin), { invalidateAll: true }),
    );
    expect(oauth.login).toHaveBeenCalledWith(expect.anything(), false);
    expect(rememberMePreference()).toBe(true);
  });

  it('retains a safe OAuth continuation and session choice through forced-password relogin', async () => {
    setOAuthContinue('/locked?from=login');
    setRememberMePreference(false);
    vi.mocked(oauth.isCallback).mockReturnValue(true);
    vi.mocked(oauth.login).mockResolvedValue(forced as never);
    render(Page, { data: data(true) } as never);
    await waitFor(() => expect(goto).toHaveBeenCalledWith('/auth/change-password'));
    preservePreferenceForPasswordChange();
    consumeLogoutPreference();

    vi.mocked(oauth.isCallback).mockReturnValue(false);
    vi.mocked(login).mockResolvedValue({ ...forced, shouldChangePassword: false } as never);
    render(Page, { data: data(false) } as never);
    const fields = screen.getAllByLabelText<HTMLInputElement>('Email');
    const passwords = screen.getAllByLabelText<HTMLInputElement>('Password');
    await fireEvent.input(fields.at(-1)!, { target: { value: 'user@example.test' } });
    await fireEvent.input(passwords.at(-1)!, { target: { value: 'updated-password' } });
    await fireEvent.click(screen.getAllByRole('button', { name: 'Sign in' }).at(-1)!);
    await waitFor(() =>
      expect(goto).toHaveBeenCalledWith(new URL('/locked?from=login', location.origin), { invalidateAll: true }),
    );
    expect(login).toHaveBeenCalledWith({
      loginCredentialDto: { email: 'user@example.test', password: 'updated-password', rememberMe: false },
    });
    expect(rememberMePreference()).toBe(true);
  });
});
