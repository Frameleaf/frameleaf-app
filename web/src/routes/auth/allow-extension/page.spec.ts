import {
  authorizeBrowserExtensionSignIn,
  BrowserExtensionClient,
  CodeChallengeMethod,
  startBrowserExtensionSignIn,
} from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authManager } from '$lib/managers/auth-manager.svelte';
import en from '../../../../../i18n/en.json';
import Page from './+page.svelte';

vi.mock('@frameleaf/sdk', async (original) => ({
  ...(await original<object>()),
  startBrowserExtensionSignIn: vi.fn(),
  authorizeBrowserExtensionSignIn: vi.fn(),
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

const REDIRECT = 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/';
const request = {
  redirectUri: REDIRECT,
  codeChallenge: 'a'.repeat(43),
  codeChallengeMethod: CodeChallengeMethod.S256,
  state: 'state-0123456789abcdef',
  client: BrowserExtensionClient.Chrome,
};
const replace = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
  vi.stubGlobal('location', {
    ...location,
    host: 'photos.taylor.home',
    replace,
    pathname: '/auth/allow-extension',
    search: '?x',
  });
  vi.mocked(startBrowserExtensionSignIn).mockResolvedValue({
    accessName: 'Save to Frameleaf · Chrome',
    alreadyAllowed: false,
  });
});

describe('Allow Save to Frameleaf (FL-655)', () => {
  it('shows the account, what it can and can’t do, and where it is listed', async () => {
    render(Page, { data: { request, meta: { title: '' } } as never });

    expect(await screen.findByRole('heading', { name: en.frameleaf_extension_allow_title })).toBeInTheDocument();
    expect(screen.getByText('Taylor')).toBeInTheDocument();
    expect(screen.getByText('taylor@example.test · photos.taylor.home')).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_extension_allow_can_save)).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_extension_allow_cant_photos)).toBeInTheDocument();
    expect(screen.getByText(/listed as “Save to Frameleaf · Chrome”/)).toBeInTheDocument();
    expect(startBrowserExtensionSignIn).toHaveBeenCalledWith({ browserExtensionSignInStartDto: request });
  });

  it('Allow goes back to the extension with the code', async () => {
    vi.mocked(authorizeBrowserExtensionSignIn).mockResolvedValue({ redirectUrl: `${REDIRECT}?code=c&state=s` });
    render(Page, { data: { request, meta: { title: '' } } as never });

    await fireEvent.click(await screen.findByRole('button', { name: en.frameleaf_extension_allow_allow }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith(`${REDIRECT}?code=c&state=s`));
    expect(authorizeBrowserExtensionSignIn).toHaveBeenCalledWith({
      browserExtensionSignInAuthorizeDto: { ...request, allow: true },
    });
    expect(screen.getByText(en.frameleaf_extension_allow_allowed_title)).toBeInTheDocument();
  });

  it('Cancel allows nothing and tells the extension', async () => {
    vi.mocked(authorizeBrowserExtensionSignIn).mockResolvedValue({
      redirectUrl: `${REDIRECT}?error=access_denied&state=s`,
    });
    render(Page, { data: { request, meta: { title: '' } } as never });

    await fireEvent.click(await screen.findByRole('button', { name: en.cancel }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith(`${REDIRECT}?error=access_denied&state=s`));
    expect(authorizeBrowserExtensionSignIn).toHaveBeenCalledWith({
      browserExtensionSignInAuthorizeDto: { ...request, allow: false },
    });
    expect(screen.getByText(en.frameleaf_extension_allow_cancelled_title)).toBeInTheDocument();
  });

  it('is asked once per browser: an extension already allowed goes straight through', async () => {
    vi.mocked(startBrowserExtensionSignIn).mockResolvedValue({ accessName: 'x', alreadyAllowed: true });
    vi.mocked(authorizeBrowserExtensionSignIn).mockResolvedValue({ redirectUrl: `${REDIRECT}?code=c&state=s` });
    render(Page, { data: { request, meta: { title: '' } } as never });

    await waitFor(() => expect(replace).toHaveBeenCalledWith(`${REDIRECT}?code=c&state=s`));
    expect(screen.queryByRole('button', { name: en.frameleaf_extension_allow_allow })).not.toBeInTheDocument();
  });

  it('never sends the window anywhere but the extension', async () => {
    vi.mocked(authorizeBrowserExtensionSignIn).mockResolvedValue({ redirectUrl: 'https://evil.example/?code=c' });
    render(Page, { data: { request, meta: { title: '' } } as never });

    await fireEvent.click(await screen.findByRole('button', { name: en.frameleaf_extension_allow_allow }));

    expect(await screen.findByText(en.frameleaf_extension_allow_invalid_title)).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it('says a request that is not from the extension can’t continue', async () => {
    render(Page, { data: { request: null, meta: { title: '' } } as never });

    expect(await screen.findByText(en.frameleaf_extension_allow_invalid_title)).toBeInTheDocument();
    expect(startBrowserExtensionSignIn).not.toHaveBeenCalled();
  });

  it('Not you? signs out and comes back here after signing in', async () => {
    render(Page, { data: { request, meta: { title: '' } } as never });

    await fireEvent.click(await screen.findByRole('button', { name: en.frameleaf_extension_allow_not_you }));

    expect(authManager.logout).toHaveBeenCalledWith({ continue: '/auth/allow-extension?x' });
  });
});
