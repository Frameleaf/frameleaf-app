import { finishFrameleafSignIn, login, startFrameleafSignIn } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { goto } from '$app/navigation';
import {
  getOAuthContinue,
  rememberMePreference,
  setOAuthContinue,
  setRememberMePreference,
} from '$lib/frameleaf/auth-session-preference';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { oauth } from '$lib/utils';
import en from '../../../../../i18n/en.json';
import Page from './+page.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('@immich/sdk', () => ({
  login: vi.fn(),
  isHttpError: () => false,
  startFrameleafSignIn: vi.fn(),
  finishFrameleafSignIn: vi.fn(),
}));
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

const frameleafOff = {
  signInAvailable: false,
  signInRequired: false,
  via: null as string | null,
  relayHost: null as string | null,
  localUrl: null as string | null,
  sameNetwork: false,
};
const data = (oauthEnabled: boolean) => ({
  continueUrl: '/photos',
  serverUrl: 'https://photos.example.test',
  publicConfig: {
    server: { loginPageMessage: '' },
    passwordLogin: { enabled: true },
    oauth: { enabled: oauthEnabled, autoLaunch: false, buttonText: 'Continue with provider' },
    frameleafCloud: { signIn: { buttonText: 'Sign in with Frameleaf', showOnLocalLogin: false } },
    frameleaf: { ...frameleafOff },
  },
});
const forced = {
  isAdmin: false,
  isOnboarded: true,
  shouldChangePassword: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
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

  it('keeps upstream OAuth behaviour: a callback is never sent to the forced password change', async () => {
    setOAuthContinue('/locked?from=oauth');
    setRememberMePreference(false);
    vi.mocked(oauth.isCallback).mockReturnValue(true);
    vi.mocked(oauth.login).mockResolvedValue(forced as never);
    render(Page, { data: data(true) } as never);
    await waitFor(() =>
      expect(goto).toHaveBeenCalledWith(new URL('/locked?from=oauth', location.origin), { invalidateAll: true }),
    );
    expect(goto).not.toHaveBeenCalledWith('/auth/change-password');
    expect(oauth.login).toHaveBeenCalledWith(expect.anything(), false);
    expect(eventManager.emit).toHaveBeenCalledWith('AuthLogin', forced);
  });

  it.each(['admin@localhost', 'me@nas'])('lets the server validate a single-label address (%s)', async (email) => {
    vi.mocked(login).mockResolvedValue({ ...forced, shouldChangePassword: false } as never);
    render(Page, { data: data(false) } as never);
    await fireEvent.input(screen.getByLabelText('Email'), { target: { value: ` ${email} ` } });
    await fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() =>
      expect(login).toHaveBeenCalledWith({ loginCredentialDto: { email, password: 'secret', rememberMe: true } }),
    );
    expect(screen.queryByRole('alert')).toBeNull();
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
});

describe('Sign in with Frameleaf (FL-158)', () => {
  const relay = () => {
    const pageData = data(true);
    pageData.publicConfig.frameleaf = {
      signInAvailable: true,
      signInRequired: true,
      via: 'relay',
      relayHost: 'r.label.frameleaf-direct.net',
      localUrl: 'http://192.168.1.10:2283',
      sameNetwork: false,
    };
    return pageData;
  };

  it('is not offered at home unless the administrator turned it on', async () => {
    const pageData = data(true);
    pageData.publicConfig.frameleaf.signInAvailable = true;
    render(Page, { data: pageData } as never);
    await screen.findByRole('button', { name: 'Continue with provider' });
    expect(screen.queryByRole('button', { name: 'Sign in with Frameleaf' })).toBeNull();
  });

  it('is offered at home beside passwords and the own provider when turned on', async () => {
    const pageData = data(true);
    pageData.publicConfig.frameleaf.signInAvailable = true;
    pageData.publicConfig.frameleafCloud.signIn = { buttonText: 'Use Frameleaf', showOnLocalLogin: true };
    render(Page, { data: pageData } as never);
    expect(await screen.findByRole('button', { name: 'Use Frameleaf' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue with provider' })).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByText(/A Frameleaf account is optional here/)).toBeInTheDocument();
  });

  it('offers only Sign in with Frameleaf through remote access', async () => {
    render(Page, { data: relay() } as never);
    expect(await screen.findByRole('button', { name: 'Sign in with Frameleaf' })).toBeInTheDocument();
    expect(screen.getByText(/through Frameleaf remote access/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Keep me signed in' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Continue with provider' })).toBeNull();
    expect(screen.getByText('Remote access')).toBeInTheDocument();
    expect(screen.getByText('r.label.frameleaf-direct.net')).toBeInTheDocument();
    expect(screen.queryByText(/same network/)).toBeNull();
    expect(oauth.authorize).not.toHaveBeenCalled();
  });

  it('offers the local address to a visitor on the same network, or lets them stay', async () => {
    const pageData = relay();
    pageData.publicConfig.frameleaf.sameNetwork = true;
    render(Page, { data: pageData } as never);
    expect(await screen.findByText('You’re on the same network as this server')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue on 192.168.1.10:2283' })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Stay on remote access' }));
    expect(screen.queryByText('You’re on the same network as this server')).toBeNull();
  });

  it('says so when remote access has no Frameleaf sign-in to offer', async () => {
    const pageData = relay();
    pageData.publicConfig.frameleaf.signInAvailable = false;
    render(Page, { data: pageData } as never);
    expect(await screen.findByText(/isn’t available on this server right now/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in with Frameleaf' })).toBeNull();
  });

  it('leaves for Frameleaf and finishes the sign-in when it comes back', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...location, assign, href: 'https://photos.example.test/auth/login' });
    vi.mocked(startFrameleafSignIn).mockResolvedValue({ url: 'https://id.frameleaf.cloud/auth?state=fl-state' });
    render(Page, { data: relay() } as never);
    await fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Frameleaf' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://id.frameleaf.cloud/auth?state=fl-state'));
    expect(startFrameleafSignIn).toHaveBeenCalledWith({
      oAuthConfigDto: { redirectUri: 'https://photos.example.test/auth/login' },
    });
    vi.unstubAllGlobals();

    // back from Frameleaf: the callback carries the state recorded above
    vi.stubGlobal('location', {
      ...location,
      href: 'https://photos.example.test/auth/login?code=abc&state=fl-state',
      search: '?code=abc&state=fl-state',
    });
    vi.mocked(oauth.isCallback).mockReturnValue(true);
    vi.mocked(finishFrameleafSignIn).mockResolvedValue({ ...forced, shouldChangePassword: false } as never);
    render(Page, { data: relay() } as never);
    await waitFor(() =>
      expect(finishFrameleafSignIn).toHaveBeenCalledWith({
        oAuthCallbackDto: { url: 'https://photos.example.test/auth/login?code=abc&state=fl-state', rememberMe: true },
      }),
    );
    expect(oauth.login).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
