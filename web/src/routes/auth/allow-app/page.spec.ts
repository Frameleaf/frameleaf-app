import { authorizeOAuthApp, startOAuthAppAuthorization } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authManager } from '$lib/managers/auth-manager.svelte';
import en from '../../../../../i18n/en.json';
import Page from './+page.svelte';

vi.mock('@frameleaf/sdk', async (original) => ({
  ...(await original<object>()),
  startOAuthAppAuthorization: vi.fn(),
  authorizeOAuthApp: vi.fn(),
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: {
    authenticated: true,
    user: {
      id: 'user-1',
      name: 'Taylor',
      email: 'taylor@example.test',
      profileImagePath: '',
      avatarColor: 'green',
      profileChangedAt: '2026-10-01T00:00:00.000Z',
    },
    logout: vi.fn(),
  },
}));

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const request = {
  responseType: 'code',
  clientId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  redirectUri: REDIRECT,
  scope: 'library:read people:read',
  state: 'state-1',
  codeChallenge: 'a'.repeat(43),
  codeChallengeMethod: 'S256',
};
const claude = {
  client: {
    id: request.clientId,
    name: 'Claude',
    verified: true,
    maker: 'Anthropic',
    knownApp: 'claude',
    returnTo: 'claude.ai',
  },
  scopes: ['library:read', 'people:read'],
};
const replace = vi.fn();

const render_ = (value: typeof request | null = request) =>
  render(Page, { data: { request: value, meta: { title: '' } } as never });

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
  vi.stubGlobal('location', {
    ...location,
    host: 'photos.taylor.home',
    replace,
    pathname: '/auth/allow-app',
    search: '?client_id=x',
  });
  vi.mocked(startOAuthAppAuthorization).mockResolvedValue(claude);
});

describe('Allow an app (FL-860)', () => {
  it('shows a verified app, your account, what it can do and that Locked is never possible', async () => {
    render_();

    expect(
      await screen.findByRole('heading', { name: en.frameleaf_apps_allow_title.replace('{name}', 'Claude') }),
    ).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_apps_allow_verified_title)).toBeInTheDocument();
    expect(screen.getByText('taylor@example.test · photos.taylor.home')).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_apps_access_library_read)).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_apps_access_people_read)).toBeInTheDocument();
    expect(screen.queryByText(en.frameleaf_apps_access_library_download)).not.toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_apps_cant_locked)).toBeInTheDocument();
    expect(screen.getByRole('list', { name: en.frameleaf_apps_allow_can_title })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.frameleaf_apps_allow_allow })).toHaveClass('primary');
    expect(startOAuthAppAuthorization).toHaveBeenCalledWith({ oAuthAppAuthorizeStartDto: request });
  });

  it('gives an app Frameleaf hasn’t checked a warning and no highlighted Allow', async () => {
    vi.mocked(startOAuthAppAuthorization).mockResolvedValue({
      ...claude,
      client: {
        ...claude.client,
        name: 'Photo Helper',
        verified: false,
        maker: null,
        knownApp: null,
        returnTo: 'x.example',
      },
    });
    render_();

    expect(await screen.findByText(en.frameleaf_apps_allow_unverified_title)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.frameleaf_apps_allow_allow })).not.toHaveClass('primary');
  });

  it('Allow goes back to the app with the code', async () => {
    vi.mocked(authorizeOAuthApp).mockResolvedValue({ redirectUrl: `${REDIRECT}?code=c&state=state-1` });
    render_();

    await fireEvent.click(await screen.findByRole('button', { name: en.frameleaf_apps_allow_allow }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith(`${REDIRECT}?code=c&state=state-1`));
    expect(authorizeOAuthApp).toHaveBeenCalledWith({ oAuthAppAuthorizeDto: { ...request, allow: true } });
    expect(screen.getByText(en.frameleaf_apps_allow_allowed_title.replace('{name}', 'Claude'))).toBeInTheDocument();
  });

  it('Deny allows nothing and tells the app', async () => {
    vi.mocked(authorizeOAuthApp).mockResolvedValue({ redirectUrl: `${REDIRECT}?error=access_denied` });
    render_();

    await fireEvent.click(await screen.findByRole('button', { name: en.frameleaf_apps_allow_deny }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith(`${REDIRECT}?error=access_denied`));
    expect(authorizeOAuthApp).toHaveBeenCalledWith({ oAuthAppAuthorizeDto: { ...request, allow: false } });
    expect(screen.getByText(en.frameleaf_apps_allow_denied_title)).toBeInTheDocument();
  });

  it('never sends the browser anywhere but the app that asked', async () => {
    vi.mocked(authorizeOAuthApp).mockResolvedValue({ redirectUrl: 'https://evil.example/?code=c' });
    render_();

    await fireEvent.click(await screen.findByRole('button', { name: en.frameleaf_apps_allow_allow }));

    expect(await screen.findByText(en.frameleaf_apps_allow_invalid_title)).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it('refuses a request the server refused, or one it can’t put into words', async () => {
    vi.mocked(startOAuthAppAuthorization).mockRejectedValueOnce(new Error('400'));
    const { unmount } = render_();
    expect(await screen.findByText(en.frameleaf_apps_allow_invalid_title)).toBeInTheDocument();
    unmount();

    vi.mocked(startOAuthAppAuthorization).mockResolvedValueOnce({ ...claude, scopes: ['library:read', 'new:thing'] });
    render_();
    expect(await screen.findByText(en.frameleaf_apps_allow_invalid_title)).toBeInTheDocument();
  });

  it('says a request that did not come through the server can’t continue', async () => {
    render_(null);

    expect(await screen.findByText(en.frameleaf_apps_allow_invalid_title)).toBeInTheDocument();
    expect(startOAuthAppAuthorization).not.toHaveBeenCalled();
  });

  it('runs out of time after ten minutes', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    render_();
    const allow = await screen.findByRole('button', { name: en.frameleaf_apps_allow_allow });
    clock.mockReturnValue(now + 11 * 60 * 1000);

    await fireEvent.click(allow);

    expect(await screen.findByText(en.frameleaf_apps_allow_expired_title)).toBeInTheDocument();
    expect(authorizeOAuthApp).not.toHaveBeenCalled();
    clock.mockRestore();
  });

  it('Switch account signs out and comes back to this request after signing in', async () => {
    render_();

    await fireEvent.click(await screen.findByRole('button', { name: en.frameleaf_apps_allow_switch_account }));

    expect(authManager.logout).toHaveBeenCalledWith({ continue: '/auth/allow-app?client_id=x' });
  });
});
