import { getServerStatistics, searchUsersAdmin, type UserAdminResponseDto } from '@immich/sdk';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { addMessages } from 'svelte-i18n';
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
vi.mock('$lib/utils/auth', () => ({ requestServerInfo: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  searchUsersAdmin: vi.fn(),
  getServerStatistics: vi.fn(),
}));
vi.mock('$lib/components/frameleaf/AccountTable.svelte', async () => ({
  default: (await import('../../../../test-data/components/MockText.svelte')).default,
}));
vi.mock('./UserDetail.svelte', async () => ({
  default: (await import('../../../../test-data/components/MockText.svelte')).default,
}));

const id = '0b9f7a3e-5c1d-4e8a-9f2b-1a2b3c4d5e6f';

describe('Users manager (FL-71, AccountsLibraries.jsx)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    vi.mocked(searchUsersAdmin).mockResolvedValue([] as UserAdminResponseDto[]);
    vi.mocked(getServerStatistics).mockResolvedValue({ photos: 0, videos: 0, usage: 0, usageByUser: [] } as never);
    state.goto.mockReset().mockResolvedValue(undefined);
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("carries the template's heading with Create account as its primary action", async () => {
    state.url = new URL('http://localhost/user-settings?area=users&section=accounts');
    render(UsersSection);

    expect(screen.getByText('Your server')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Users' })).toBeInTheDocument();
    expect(screen.getByText('Manage profiles, features, preferences, storage and sign-in.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(state.goto).toHaveBeenCalledWith('/user-settings?area=users&section=accounts&new=1');
  });

  it('opens an account below the list, keeps the list and scrolls the detail into view', async () => {
    state.url = new URL(`http://localhost/user-settings?area=users&section=accounts&user=${id}`);
    const { container } = render(UsersSection);

    await waitFor(() => expect(searchUsersAdmin).toHaveBeenCalled());
    expect(screen.getByRole('heading', { level: 1, name: 'Users' })).toBeInTheDocument();
    const detail = container.querySelector('.resource-detail');
    expect(detail).not.toBeNull();
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'start' }));
  });
});
