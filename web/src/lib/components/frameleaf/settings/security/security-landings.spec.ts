import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { addMessages } from 'svelte-i18n';
import en from '../../../../../../../i18n/en.json';
import WhoCanSignInLanding from './WhoCanSignInLanding.svelte';
import YourSignInLanding from './YourSignInLanding.svelte';
import { idleDevices, signInMethodsState } from './sign-in';

const sdk = vi.hoisted(() => ({
  searchUsersAdmin: vi.fn(),
  getAuthStatus: vi.fn(),
  getSessions: vi.fn(),
  getApiKeys: vi.fn(),
  getLockedEncryption: vi.fn(),
  getFrameleafAccountLink: vi.fn(),
  getOAuthAppGrants: vi.fn(),
  getMyActivity: vi.fn(),
}));
const cloud = vi.hoisted(() => ({ status: null as unknown }));
const nav = vi.hoisted(() => ({ goto: vi.fn() }));
vi.mock('$app/navigation', () => ({ goto: nav.goto }));
const user = vi.hoisted(() => ({ isAdmin: true, email: 'taylor@example.test', name: 'Taylor' }));
vi.mock('@frameleaf/sdk', async (original) => ({ ...(await original<typeof import('@frameleaf/sdk')>()), ...sdk }));
vi.mock('$lib/managers/cloud-manager.svelte', () => ({
  cloudManager: {
    listen: () => () => {},
    get status() {
      return cloud.status;
    },
    license: null,
  },
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { user } }));
vi.mock('$lib/frameleaf/system-config-draft.svelte', () => ({
  getSystemConfigDraft: () => ({ baseline: { passwordLogin: { enabled: true }, oauth: { enabled: false } } }),
}));

const ICON = 'M0 0h1v1H0z';
const sections = [
  { key: 'password', title: 'How you sign in', subtitle: 'Your email, password and linked accounts', icon: ICON },
  { key: 'authorized-devices', title: 'Signed-in devices', subtitle: 'Where you are signed in', icon: ICON },
  { key: 'connected-apps', title: 'Connected apps', subtitle: 'AI assistants and other apps', icon: ICON },
  { key: 'account-activity', title: 'Account activity', subtitle: 'Your sign-ins and changes', icon: ICON },
  { key: 'api-keys', title: 'API keys', subtitle: 'For apps', icon: ICON },
  { key: 'user-pin-code-settings', title: 'Locked PIN', subtitle: 'Opens Locked photos', icon: ICON },
  { key: 'suppressed-content', title: 'Always Locked', subtitle: 'People, pets and tags', icon: ICON },
  { key: 'locked-encryption', title: 'Locked encryption', subtitle: 'Encrypts the files', icon: ICON },
];
const now = Date.now();
const session = (id: string, daysAgo: number, current = false) => ({
  id,
  current,
  createdAt: new Date(now - 90 * 86_400_000).toISOString(),
  updatedAt: new Date(now - daysAgo * 86_400_000).toISOString(),
  deviceOS: 'macOS',
  deviceType: 'Chrome',
  isPendingSyncReset: false,
  appVersion: null,
});

describe('Who can sign in (FL-367)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    sdk.searchUsersAdmin.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  });

  it('says people can sign in at home only while the server is not linked', async () => {
    cloud.status = { state: 'unlinked', configured: true, signInLinkedAccounts: 0 };
    render(WhoCanSignInLanding);
    expect(await screen.findByRole('heading', { name: 'People can sign in at home only' })).toBeInTheDocument();
    expect(screen.getByText('Password')).toBeInTheDocument();
  });

  it('names how many people can only sign in at home once linked', async () => {
    cloud.status = { state: 'linked', configured: true, signInLinkedAccounts: 2 };
    render(WhoCanSignInLanding);
    expect(await screen.findByRole('heading', { name: 'One person can only sign in at home' })).toBeInTheDocument();
    expect(screen.getByText('Everyone can · 2 of 3 people have linked')).toBeInTheDocument();
  });
});

describe('Your sign-in & privacy (FL-367)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    sdk.getAuthStatus.mockResolvedValue({ password: true, pinCode: true, isElevated: false });
    sdk.getApiKeys.mockResolvedValue([]);
    sdk.getFrameleafAccountLink.mockResolvedValue({ available: true, linked: false });
    sdk.getOAuthAppGrants.mockResolvedValue([]);
    sdk.getMyActivity.mockResolvedValue({ events: [], hasMore: false });
  });

  it('says the account is protected', async () => {
    sdk.getSessions.mockResolvedValue([session('a', 0, true)]);
    render(YourSignInLanding, { sections });
    expect(await screen.findByRole('heading', { name: 'Your account is protected' })).toBeInTheDocument();
    // "How you sign in" says the ways in (Personal.jsx), here a password and no Frameleaf account yet.
    expect(await screen.findByText('Password only')).toBeInTheDocument();
    expect(screen.getByText('Who can sign in')).toBeInTheDocument();
  });

  it('lists Locked encryption with its state (FL-721)', async () => {
    sdk.getSessions.mockResolvedValue([session('a', 0, true)]);
    sdk.getLockedEncryption.mockResolvedValue({ enabled: false, status: null, mode: null, keyLoaded: false });
    render(YourSignInLanding, { sections });
    expect(await screen.findByText('Off · Optional, only you can turn it on')).toBeInTheDocument();
    expect(screen.getByText('Locked encryption')).toBeInTheDocument();
  });

  it('lists connected apps with how many can use the library (FL-860)', async () => {
    sdk.getSessions.mockResolvedValue([session('a', 0, true)]);
    sdk.getOAuthAppGrants.mockResolvedValue([{ id: 'g', lastUsedAt: new Date(now).toISOString() }]);
    render(YourSignInLanding, { sections });
    expect(screen.getByText('Connected apps')).toBeInTheDocument();
    expect(await screen.findByText('1 app')).toBeInTheDocument();
  });

  it('links Account activity with when you last signed in, or that sign-ins did not work (FL-824)', async () => {
    const event = (action: string, minutesAgo: number) => ({
      id: `${action}-${minutesAgo}`,
      source: 'account',
      userId: 'u1',
      action,
      detail: 'password',
      createdAt: new Date(now - minutesAgo * 60_000).toISOString(),
    });
    sdk.getSessions.mockResolvedValue([session('a', 0, true)]);
    const view = render(YourSignInLanding, { sections });
    expect(screen.getByText('Account activity')).toBeInTheDocument();
    expect(await screen.findByText('Nothing yet')).toBeInTheDocument();
    expect(sdk.getMyActivity).toHaveBeenCalledWith({ take: 50 });
    view.unmount();

    sdk.getMyActivity.mockResolvedValue({ events: [event('signed-in', 0)], hasMore: false });
    const signedIn = render(YourSignInLanding, { sections });
    expect(await screen.findByText(/^Last sign-in today, /)).toBeInTheDocument();
    signedIn.unmount();

    sdk.getMyActivity.mockResolvedValue({
      events: [event('signed-in', 0), event('sign-in-failed', 5), event('sign-in-failed', 6)],
      hasMore: false,
    });
    render(YourSignInLanding, { sections });
    expect(await screen.findByText('2 sign-ins didn’t work in the last day')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open: Account activity' }));
    expect(nav.goto).toHaveBeenCalledWith('/user-settings?area=privacy&section=account-activity');
  });

  it('raises a device not used for a while', async () => {
    sdk.getSessions.mockResolvedValue([session('a', 0, true), session('b', 45)]);
    render(YourSignInLanding, { sections });
    expect(
      await screen.findByRole('heading', { name: 'A device you haven’t used for a while is still signed in' }),
    ).toBeInTheDocument();
  });
});

describe('sign-in rules', () => {
  it('names the ways in that are on', () => {
    expect(signInMethodsState({ password: true, provider: false, frameleaf: true })).toBe('password_frameleaf');
    expect(signInMethodsState({ password: false, provider: false, frameleaf: false })).toBe('none');
  });

  it('finds devices not used for 30 days, never this one', () => {
    const sessions = [session('a', 60, true), session('b', 31), session('c', 3)] as never[];
    expect(idleDevices(sessions, now).map((item: { id: string }) => item.id)).toEqual(['b']);
  });
});
