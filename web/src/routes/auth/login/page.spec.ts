import {
  createFrameleafHandoff,
  finishFrameleafSignIn,
  isHttpError,
  login,
  redeemFrameleafHandoff,
  startFrameleafSignIn,
} from '@frameleaf/sdk';
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
vi.mock('@frameleaf/sdk', () => ({
  login: vi.fn(),
  isHttpError: vi.fn(() => false),
  startFrameleafSignIn: vi.fn(),
  finishFrameleafSignIn: vi.fn(),
  createFrameleafHandoff: vi.fn(),
  redeemFrameleafHandoff: vi.fn(),
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
  eventManager: { emit: vi.fn(), on: vi.fn() },
}));

const frameleafOff = {
  signInAvailable: false,
  signInRequired: false,
  via: null as string | null,
  relayHost: null as string | null,
  localUrl: null as string | null,
  sameNetwork: false,
  signInOrigin: null as string | null,
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
  it('greets with the hero heading, the brand rule and the logo arriving once (BRAND.md)', () => {
    const { container } = render(Page, { data: data(false) } as never);
    const heading = screen.getByRole('heading', { level: 1, name: 'Welcome back' });
    expect(heading.closest('.auth-heading')).toHaveClass('hero');
    expect(container.querySelector(':scope .auth-heading .fl-brand-line')).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector(':scope .auth-brand .fl-logo-arrive')).not.toBeNull();
    // the lockup stands on the page by itself: no plate behind it
    expect(container.querySelector('.auth-brand-plate')).toBeNull();
  });

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

  it.each([
    ['/albums?from=share#top', '/auth/onboarding?continue=%2Falbums%3Ffrom%3Dshare%23top'],
    ['/photos', '/auth/onboarding'],
  ])('carries the page asked for (%s) through first-time setup (FL-146, FL-30)', async (continueUrl, expected) => {
    vi.mocked(login).mockResolvedValue({ isAdmin: false, isOnboarded: false, shouldChangePassword: false } as never);
    render(Page, { data: { ...data(false), continueUrl: new URL(continueUrl, location.origin) } } as never);
    await fireEvent.input(screen.getByLabelText('Email'), { target: { value: 'user@example.test' } });
    await fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'password' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(goto).toHaveBeenCalledWith(expected));
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

describe('OAuth callback refusals (FL-80)', () => {
  const refusal = 'The identity provider did not approve the sign-in. Try again.';

  it('shows the refusal, stays signed out and forgets where the sign-in was going', async () => {
    setOAuthContinue('/albums?from=share');
    vi.mocked(oauth.isCallback).mockReturnValue(true);
    vi.mocked(isHttpError).mockReturnValue(true);
    vi.mocked(oauth.login).mockRejectedValue({ status: 400, data: { message: refusal } });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    render(Page, { data: data(true) } as never);
    expect(await screen.findByRole('alert')).toHaveTextContent(refusal);
    expect(goto).not.toHaveBeenCalled();
    expect(eventManager.emit).not.toHaveBeenCalled();
    expect(String(getOAuthContinue('/photos'))).toBe(new URL('/photos', location.origin).href);

    // retry: the provider button is back and starts a fresh sign-in
    vi.mocked(oauth.authorize).mockResolvedValue(true);
    await fireEvent.click(await screen.findByRole('button', { name: 'Continue with provider' }));
    expect(oauth.authorize).toHaveBeenCalledOnce();
  });

  it('never continues to another site after a callback, whatever was stored', async () => {
    setOAuthContinue('https://outside.example.test/steal');
    vi.mocked(oauth.isCallback).mockReturnValue(true);
    vi.mocked(oauth.login).mockResolvedValue({ ...forced, shouldChangePassword: false } as never);

    render(Page, { data: data(true) } as never);
    await waitFor(() => expect(goto).toHaveBeenCalledOnce());
    const target = String(vi.mocked(goto).mock.calls[0][0]);
    expect(new URL(target, location.origin).origin).toBe(location.origin);
    expect(target).not.toContain('outside.example.test');
  });
});

describe('Sign in with Frameleaf (FL-158)', () => {
  const relay = () => {
    const pageData = data(true);
    pageData.publicConfig.frameleaf = {
      signInAvailable: true,
      signInRequired: true,
      via: 'relay',
      relayHost: 'r.label.frameleaf.net',
      localUrl: 'http://192.168.1.10:2283',
      sameNetwork: false,
      signInOrigin: null,
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
    expect(screen.getByText('r.label.frameleaf.net')).toBeInTheDocument();
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

describe('Sign in with Frameleaf from a home address (FL-167)', () => {
  const LAN = 'https://192-168-1-10.u225vlzhsdlhwh4l.frameleaf.net:2443';
  const RELAY = 'https://r.u225vlzhsdlhwh4l.frameleaf.net';
  const at = (href: string, assign = vi.fn()) => {
    const url = new URL(href);
    vi.stubGlobal('location', {
      ...location,
      assign,
      href,
      origin: url.origin,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
    });
    return assign;
  };
  const home = () => {
    const pageData = data(false);
    pageData.publicConfig.frameleafCloud.signIn = { buttonText: 'Sign in with Frameleaf', showOnLocalLogin: true };
    pageData.publicConfig.frameleaf = { ...frameleafOff, signInAvailable: true, via: 'lan', signInOrigin: RELAY };
    return pageData;
  };
  const remote = () => {
    const pageData = data(false);
    pageData.publicConfig.frameleaf = { ...frameleafOff, signInAvailable: true, signInRequired: true, via: 'relay' };
    return pageData;
  };

  it('signs in on the public address and comes back to the home address with a tagged session', async () => {
    // 1. on the home address: off to the public address, with where to come back to
    let assign = at(`${LAN}/auth/login`);
    render(Page, { data: home() } as never);
    await fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Frameleaf' }));
    const bounced = new URL(assign.mock.calls[0][0] as string);
    const nonce = bounced.searchParams.get('frameleafNonce')!;
    expect(bounced.origin + bounced.pathname).toBe(`${RELAY}/auth/login`);
    expect(bounced.searchParams.get('frameleafReturn')).toBe(LAN);
    expect(bounced.searchParams.get('frameleafRemember')).toBe('1');
    expect(nonce).toMatch(/^[\w-]{16,64}$/);
    expect(startFrameleafSignIn).not.toHaveBeenCalled();
    vi.unstubAllGlobals();

    // 2. on the public address: straight on to Frameleaf, remembering the home address
    assign = at(
      `${RELAY}/auth/login?frameleafReturn=${encodeURIComponent(LAN)}&frameleafNonce=${nonce}&frameleafRemember=1`,
    );
    vi.mocked(startFrameleafSignIn).mockResolvedValue({ url: 'https://id.frameleaf.cloud/auth?state=bounce' });
    render(Page, { data: remote() } as never);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://id.frameleaf.cloud/auth?state=bounce'));
    vi.unstubAllGlobals();

    // 3. back from Frameleaf on the public address: the session is handed to the home address
    assign = at(`${RELAY}/auth/login?code=abc&state=bounce`);
    vi.mocked(oauth.isCallback).mockReturnValue(true);
    vi.mocked(finishFrameleafSignIn).mockResolvedValue({ ...forced, shouldChangePassword: false } as never);
    vi.mocked(createFrameleafHandoff).mockResolvedValue({
      code: 'one-time',
      expiresAt: new Date().toISOString(),
      url: `${LAN}/auth/login#frameleafHandoff=one-time`,
    });
    render(Page, { data: remote() } as never);
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(`${LAN}/auth/login#frameleafHandoff=one-time&frameleafNonce=${nonce}`),
    );
    expect(createFrameleafHandoff).toHaveBeenCalledWith({ frameleafHandoffCreateDto: { returnTo: LAN } });
    expect(goto).not.toHaveBeenCalled();
    vi.unstubAllGlobals();

    // 4. on the home address: the code signs in here, once
    vi.mocked(oauth.isCallback).mockReturnValue(false);
    at(`${LAN}/auth/login#frameleafHandoff=one-time&frameleafNonce=${nonce}`);
    vi.mocked(redeemFrameleafHandoff).mockResolvedValue({ ...forced, shouldChangePassword: false } as never);
    render(Page, { data: home() } as never);
    await waitFor(() =>
      expect(redeemFrameleafHandoff).toHaveBeenCalledWith({
        frameleafHandoffRedeemDto: { code: 'one-time', rememberMe: true },
      }),
    );
    await waitFor(() => expect(goto).toHaveBeenCalled());
    vi.unstubAllGlobals();
  });

  it('never redeems a code this tab did not ask for (login CSRF)', async () => {
    sessionStorage.clear();
    at(`${LAN}/auth/login#frameleafHandoff=attackers-code&frameleafNonce=${'a'.repeat(32)}`);
    render(Page, { data: home() } as never);
    await screen.findByRole('button', { name: 'Sign in with Frameleaf' });
    expect(redeemFrameleafHandoff).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('never bounces to a return address that is not https', async () => {
    const assign = at(`${RELAY}/auth/login?frameleafReturn=${encodeURIComponent('javascript:alert(1)')}`);
    render(Page, { data: remote() } as never);
    await screen.findByRole('button', { name: 'Sign in with Frameleaf' });
    expect(startFrameleafSignIn).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('stays signed in on the public address when the home address is refused', async () => {
    at(`${RELAY}/auth/login?code=abc&state=refused`);
    localStorage.setItem(
      'frameleaf.auth.frameleafRequest.refused',
      JSON.stringify({
        purpose: 'sign-in',
        expiresAt: Date.now() + 60_000,
        returnTo: 'https://evil.example.com',
        nonce: 'n'.repeat(32),
      }),
    );
    vi.mocked(oauth.isCallback).mockReturnValue(true);
    vi.mocked(finishFrameleafSignIn).mockResolvedValue({ ...forced, shouldChangePassword: false } as never);
    vi.mocked(createFrameleafHandoff).mockRejectedValue(
      new Error('This address is not one of this server’s home addresses'),
    );
    render(Page, { data: remote() } as never);
    await waitFor(() => expect(goto).toHaveBeenCalled());
    vi.unstubAllGlobals();
  });
});
