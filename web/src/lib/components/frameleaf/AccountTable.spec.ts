import { render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { userAdminFactory } from '$lib/../test-data/factories/user-factory';
import AccountTable from '$lib/components/frameleaf/AccountTable.svelte';
import en from '../../../../../i18n/en.json';

/** CC-26: the template's Items and "Storage used / quota" columns (`AccountsLibraries.jsx` 143-196, 948-1000). */
const GiB = 1024 ** 3;

beforeAll(() => addMessages('dev', en));

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
    expect(within(table).getByRole('columnheader', { name: 'Storage used / quota' })).toBeInTheDocument();

    const [, first, second] = within(table).getAllByRole('row');
    expect(within(first).getByText('1,234')).toBeInTheDocument();
    expect(within(first).getByText('34 videos')).toBeInTheDocument();
    expect(within(first).getByRole('progressbar', { name: 'Ada quota usage' })).toHaveAttribute(
      'max',
      String(10 * GiB),
    );
    expect(within(first).getByText(/remaining$/)).toBeInTheDocument();

    // No statistics for this account, and no quota: unlimited without a meter.
    expect(within(second).getByLabelText('No item count')).toBeInTheDocument();
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

    expect(screen.getByText('Over quota · new uploads need more space')).toBeInTheDocument();
  });
});
