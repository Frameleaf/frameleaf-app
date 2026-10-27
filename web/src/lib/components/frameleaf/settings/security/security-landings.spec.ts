import { render, screen } from '@testing-library/svelte';
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
}));
const cloud = vi.hoisted(() => ({ status: null as unknown }));
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
  { key: 'password', title: 'Password', subtitle: 'Your email and password', icon: ICON },
  { key: 'authorized-devices', title: 'Signed-in devices', subtitle: 'Where you are signed in', icon: ICON },
  { key: 'api-keys', title: 'API keys', subtitle: 'For apps', icon: ICON },
  { key: 'user-pin-code-settings', title: 'Locked PIN', subtitle: 'Opens Locked photos', icon: ICON },
  { key: 'suppressed-content', title: 'Always Locked', subtitle: 'People, pets and tags', icon: ICON },
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
  });

  it('says the account is protected', async () => {
    sdk.getSessions.mockResolvedValue([session('a', 0, true)]);
    render(YourSignInLanding, { sections });
    expect(await screen.findByRole('heading', { name: 'Your account is protected' })).toBeInTheDocument();
    expect(await screen.findByText('taylor@example.test · password set')).toBeInTheDocument();
    expect(screen.getByText('Who can sign in')).toBeInTheDocument();
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
