import { getServerStatistics, searchUsersAdmin, type UserAdminResponseDto } from '@frameleaf/sdk';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { addMessages } from 'svelte-i18n';
import { requestServerInfo } from '$lib/utils/auth';
import en from '../../../../../../i18n/en.json';
import UsersSection from './UsersSection.svelte';

const state = vi.hoisted(() => ({
  url: new URL('http://localhost/user-settings?area=users&section=accounts'),
  goto: vi.fn(),
}));
vi.mock('$app/state', () => ({
  page: {
    get url() {
      return state.url;
    },
  },
}));
vi.mock('$app/navigation', () => ({ goto: state.goto }));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { supporter: false, configFile: false } },
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: { authenticated: true, user: { id: 'b1' } },
}));
vi.mock('$lib/utils/auth', () => ({ requestServerInfo: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@frameleaf/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@frameleaf/sdk')>()),
  searchUsersAdmin: vi.fn(),
  getServerStatistics: vi.fn(),
}));
vi.mock('./UserDetail.svelte', async () => ({
  default: (await import('../../../../test-data/components/MockText.svelte')).default,
}));

const id = '0b9f7a3e-5c1d-4e8a-9f2b-1a2b3c4d5e6f';
const person = (overrides: Partial<UserAdminResponseDto>) =>
  ({
    id,
    name: 'Jamie',
    email: 'jamie@example.test',
    isAdmin: false,
    status: 'active',
    deletedAt: null,
    createdAt: '2026-02-02T12:00:00.000Z',
    quotaSizeInBytes: null,
    quotaUsageInBytes: 45_000_000,
    uploadsPaused: false,
    license: null,
    avatarColor: 'blue',
    profileImagePath: '',
    ...overrides,
  }) as UserAdminResponseDto;

describe('Users manager (FL-71, AccountsLibraries.jsx)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    vi.mocked(searchUsersAdmin).mockResolvedValue([] as UserAdminResponseDto[]);
    vi.mocked(getServerStatistics).mockResolvedValue({ photos: 0, videos: 0, usage: 0, usageByUser: [] } as never);
    state.goto.mockReset().mockResolvedValue(undefined);
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("opens on the prototype's answer, then everyone as one list with Add a person on it (FL-516)", async () => {
    state.url = new URL('http://localhost/user-settings?area=users&section=accounts');
    vi.mocked(searchUsersAdmin).mockResolvedValue([
      person({}),
      person({ id: 'b1', name: 'Taylor', email: 'taylor@example.test', isAdmin: true }),
    ]);
    render(UsersSection);

    expect(screen.getByText('Your server')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Users' })).toBeInTheDocument();
    expect(screen.getByText('Everyone with an account, and how much space each has.')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '2 people have an account on this server' })).toBeInTheDocument();
    expect(
      screen.getByText('One administrator and one member. Everyone has room to add more photos.'),
    ).toBeInTheDocument();
    expect(screen.getByText('jamie@example.test · Member')).toBeInTheDocument();
    expect(screen.getByText('taylor@example.test · Administrator')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Open Jamie' }));
    expect(state.goto).toHaveBeenLastCalledWith(`/user-settings?area=users&section=accounts&user=${id}`);
    await userEvent.click(screen.getByRole('button', { name: 'Add a person' }));
    expect(state.goto).toHaveBeenLastCalledWith('/user-settings?area=users&section=accounts&new=1');
  });

  it('says when each person was last active, from the server statistics', async () => {
    state.url = new URL('http://localhost/user-settings?area=users&section=accounts');
    vi.mocked(searchUsersAdmin).mockResolvedValue([person({})]);
    vi.mocked(getServerStatistics).mockResolvedValue({
      photos: 0,
      videos: 0,
      usage: 0,
      usageByUser: [{ userId: id, lastActiveAt: new Date().toISOString() }],
    } as never);
    render(UsersSection);

    expect(await screen.findByText(/^Joined .+ · last active today$/)).toBeInTheDocument();
  });

  it('says who is almost out of space, with the way to give them more', async () => {
    state.url = new URL('http://localhost/user-settings?area=users&section=accounts');
    vi.mocked(searchUsersAdmin).mockResolvedValue([
      person({ quotaSizeInBytes: 200_000_000_000, quotaUsageInBytes: 192_000_000_000 }),
      person({ id: 'b1', name: 'Taylor', email: 'taylor@example.test', isAdmin: true }),
    ]);
    render(UsersSection);

    expect(await screen.findByRole('heading', { name: 'Jamie has almost run out of space' })).toBeInTheDocument();
    expect(screen.getByText('Almost full')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Give Jamie more space' }));
    expect(state.goto).toHaveBeenLastCalledWith(`/user-settings?area=users&section=accounts&user=${id}`);
  });

  it('opens one person in place of the list and scrolls it into view', async () => {
    state.url = new URL(`http://localhost/user-settings?area=users&section=accounts&user=${id}`);
    render(UsersSection);

    await waitFor(() => expect(searchUsersAdmin).toHaveBeenCalled());
    expect(screen.queryByRole('heading', { level: 1, name: 'Users' })).toBeNull();
    await waitFor(() =>
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' }),
    );
  });

  it('reads the accounts without waiting for the disk check', async () => {
    state.url = new URL('http://localhost/user-settings?area=users&section=accounts');
    vi.mocked(requestServerInfo).mockReturnValueOnce(new Promise(() => {}));
    vi.mocked(searchUsersAdmin).mockResolvedValue([person({})]);
    render(UsersSection);
    await waitFor(() => expect(searchUsersAdmin).toHaveBeenCalledWith({ withDeleted: true }));
    // The list renders while the disk check is still pending; alone on the server, the answer says so.
    expect(await screen.findByRole('heading', { name: 'You’re the only person on this server' })).toBeInTheDocument();
  });
});
