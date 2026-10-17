import { render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { userAdminFactory } from '$lib/../test-data/factories/user-factory';
import AccountTable from '$lib/components/frameleaf/AccountTable.svelte';
import en from '../../../../../i18n/en.json';

/** CC-26: the template's Items and "Storage used / quota" columns (`AccountsLibraries.jsx` 143-196, 948-1000). */
const GiB = 1024 ** 3;

const flags = vi.hoisted(() => ({ value: { supporter: false } }));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: {
    get value() {
      return flags.value;
    },
  },
}));

beforeAll(() => addMessages('dev', en));
beforeEach(() => {
  flags.value = { supporter: false };
});

describe('AccountTable (FL-76 CC-26)', () => {
  it("shows each account's items and its storage against its quota", () => {
    const ada = userAdminFactory.build({
      id: 'ada',
      name: 'Ada',
      quotaSizeInBytes: 10 * GiB,
      quotaUsageInBytes: 4 * GiB,
      deletedAt: null,
    });
    const grace = userAdminFactory.build({
      id: 'grace',
      name: 'Grace',
      quotaSizeInBytes: null,
      quotaUsageInBytes: 2 * GiB,
      deletedAt: null,
    });
    render(AccountTable, {
      users: [ada, grace],
      usage: [
        {
          userId: 'ada',
          userName: 'Ada',
          photos: 1200,
          videos: 34,
          usage: 0,
          usagePhotos: 0,
          usageVideos: 0,
          quotaSizeInBytes: null,
        },
      ],
    });

    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Items' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Storage used / limit' })).toBeInTheDocument();

    const [, first, second] = within(table).getAllByRole('row');
    expect(within(first).getByText('1,234')).toBeInTheDocument();
    expect(within(first).getByText('34 videos')).toBeInTheDocument();
    expect(within(first).getByRole('progressbar', { name: 'Ada quota usage' })).toHaveAttribute(
      'max',
      String(10 * GiB),
    );
    expect(within(first).getByText(/remaining$/)).toBeInTheDocument();

    // No statistics for this account, and no quota: unlimited without a meter.
    expect(within(second).getByLabelText('Not counted yet')).toBeInTheDocument();
    expect(within(second).getByText('/ unlimited')).toBeInTheDocument();
    expect(within(second).queryByRole('progressbar')).toBeNull();
  });

  it('says when an account is over its quota', () => {
    const user = userAdminFactory.build({
      name: 'Linus',
      quotaSizeInBytes: GiB,
      quotaUsageInBytes: 2 * GiB,
      deletedAt: null,
    });
    render(AccountTable, { users: [user] });

    expect(screen.getByText('Over the limit · new uploads wait until there’s more space')).toBeInTheDocument();
  });

  it('supporter option (b): tags people with their own licence, and everyone on a licensed server', () => {
    // the factory's account holds its own Individual licence
    const ada = userAdminFactory.build({ id: 'ada', name: 'Ada', deletedAt: null });
    const grace = userAdminFactory.build({ id: 'grace', name: 'Grace', deletedAt: null, license: null });
    const { unmount } = render(AccountTable, { users: [ada, grace] });

    const [, first, second] = within(screen.getByRole('table')).getAllByRole('row');
    expect(within(first).getByText('Supporter')).toBeInTheDocument();
    expect(within(second).queryByText('Supporter')).toBeNull();
    unmount();

    // a Server licence covers every account
    flags.value = { supporter: true };
    render(AccountTable, { users: [ada, grace] });
    expect(within(screen.getByRole('table')).getAllByText('Supporter')).toHaveLength(2);
  });
});
