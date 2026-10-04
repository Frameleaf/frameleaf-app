import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { addMessages } from 'svelte-i18n';
import en from '../../../../../../i18n/en.json';
import UserDetail from './UserDetail.svelte';

const id = '0b9f7a3e-5c1d-4e8a-9f2b-1a2b3c4d5e6f';
const mocks = vi.hoisted(() => ({ goto: vi.fn(), loadUserDetail: vi.fn() }));

vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/user-settings?area=users') } }));
vi.mock('$app/navigation', () => ({ goto: mocks.goto }));
vi.mock('./loaders', () => ({ loadUserDetail: mocks.loadUserDetail }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { user: { id: 'admin' } } }));
vi.mock('$lib/managers/server-config-manager.svelte', () => ({
  serverConfigManager: { value: { userDeleteDelay: 7 } },
}));
vi.mock('$lib/components/frameleaf/AccountDetailTabs.svelte', async () => ({
  default: (await import('../../../../test-data/components/MockText.svelte')).default,
}));

const detail = (deletedAt: string | null = null) => ({
  user: { id, name: 'Jamie', email: 'jamie@example.test', deletedAt, status: deletedAt ? 'deleted' : 'active' },
  userPreferences: {},
  userStatistics: {},
  userSessions: [],
  libraries: [],
  libraryStatistics: {},
});

describe('account detail header (FL-71, AccountsLibraries.jsx)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    mocks.goto.mockReset().mockResolvedValue(undefined);
  });

  it("carries the template's profile, View analytics, Edit account and Close details", async () => {
    mocks.loadUserDetail.mockResolvedValue(detail());
    render(UserDetail, { id });

    expect(await screen.findByRole('heading', { level: 2, name: 'Jamie' })).toBeInTheDocument();
    expect(screen.getByText('jamie@example.test')).toBeInTheDocument();
    // The account's password, PIN, deletion and restore live in its tabs, not in a second action row.
    expect(screen.queryByRole('button', { name: /Reset password|Delete|Restore/ })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'View analytics' }));
    expect(mocks.goto).toHaveBeenLastCalledWith(`/user-settings?area=analytics&scope=account%3A${id}`);
    await userEvent.click(screen.getByRole('button', { name: 'Edit account' }));
    expect(mocks.goto).toHaveBeenLastCalledWith(`/user-settings?area=users&section=accounts&user=${id}&edit=1`);
    await userEvent.click(screen.getByRole('button', { name: 'Close details' }));
    expect(mocks.goto).toHaveBeenLastCalledWith('/user-settings?area=users&section=accounts');
  });

  it('offers no Edit account for a deleted account', async () => {
    mocks.loadUserDetail.mockResolvedValue(detail('2026-09-20T00:00:00.000Z'));
    render(UserDetail, { id });

    expect(await screen.findByRole('heading', { level: 2, name: 'Jamie' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit account' })).toBeNull();
  });
});
