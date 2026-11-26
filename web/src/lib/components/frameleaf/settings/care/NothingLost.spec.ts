import { getLedger, getLedgerAdminSummary, getLedgerSummary, searchUsers, searchUsersAdmin } from '@frameleaf/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { goto } from '$app/navigation';
import NothingLost from '$lib/components/frameleaf/settings/care/NothingLost.svelte';
import { sessionAccess } from '$lib/frameleaf/session-access.svelte';
import en from '../../../../../../../i18n/en.json';

/**
 * Library care › Nothing lost (FL-940): the answer, the five totals, who removed what, and by month.
 * Administrators also see the household and one person's totals, never a file name.
 */
const user = vi.hoisted(() => ({ id: 'taylor', isAdmin: true }));

vi.mock('@frameleaf/sdk', async (original) => ({
  ...(await original<object>()),
  getLedger: vi.fn(),
  getLedgerSummary: vi.fn(),
  getLedgerAdminSummary: vi.fn(),
  searchUsers: vi.fn(),
  searchUsersAdmin: vi.fn(),
  getUtilitiesSummary: vi.fn().mockResolvedValue({ unusedFiles: 0, unusedBytes: 0 }),
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: { user, authenticated: true, captureSession: () => () => true },
}));
vi.mock('$lib/components/frameleaf/LockedUnlockDialog.svelte', async () => ({
  default: (await import('$lib/components/frameleaf/Skeleton.svelte')).default,
}));

const states = (overrides: Record<string, number> = {}) => ({
  kept: 24_410,
  merged: 270,
  trashed: 96,
  removed: 192,
  missing: 0,
  ...overrides,
});
const total = (counts: Record<string, number>) => Object.values(counts).reduce((sum, value) => sum + value, 0);
const months = (missing = 0) =>
  ['2026-11', '2026-10', '2026-09', '2026-08', '2026-07', '2026-06', '2026-05'].map((month, index) => {
    const gone = index === 3 ? missing : 0;
    const counts = { kept: 200 - gone, merged: 4, trashed: 5, removed: 2, missing: gone };
    return { month, total: total(counts), states: counts };
  });
const summary = (overrides: Record<string, number> = {}) => {
  const counts = states(overrides);
  return { total: total(counts), states: counts, months: months(counts.missing) };
};
const item = (overrides: Record<string, unknown> = {}) => ({
  assetId: 'a1',
  checksum: 'c',
  originalFileName: 'IMG_4410.HEIC',
  addedAt: '2026-11-02T18:20:00.000Z',
  addedVia: 'upload',
  state: 'removed',
  stateAt: '2026-11-13T20:42:00.000Z',
  stateBy: 'taylor',
  reason: 'deleted',
  ...overrides,
});
const people = [
  { id: 'taylor', name: 'Taylor', email: 't@example.test' },
  { id: 'morgan', name: 'Morgan', email: 'm@example.test' },
];
const hero = () => within(screen.getByRole('region', { name: en.frameleaf_ledger_title }));

describe('Nothing lost (FL-940)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    vi.clearAllMocks();
    user.isAdmin = true;
    sessionAccess.isElevated = false;
    vi.mocked(searchUsersAdmin).mockResolvedValue(people as never);
    vi.mocked(searchUsers).mockResolvedValue(people as never);
    vi.mocked(getLedgerSummary).mockResolvedValue(summary() as never);
    vi.mocked(getLedger).mockImplementation(({ state, cursor }) =>
      Promise.resolve({
        items: cursor
          ? [item({ assetId: 'a20', originalFileName: 'IMG_0020.HEIC' })]
          : state === 'removed'
            ? [
                item(),
                item({ assetId: 'a4', originalFileName: 'VID_2207.MOV', stateBy: null, reason: 'trash-expired' }),
                item({ assetId: 'a9', originalFileName: 'Beach day.jpg', stateBy: 'morgan', addedVia: 'partner-copy' }),
                item({ assetId: 'a12', originalFileName: 'Scan.png', stateBy: 'gone', reason: 'library-removed' }),
              ]
            : [],
        nextCursor: state === 'removed' && !cursor ? 'next' : null,
      } as never),
    );
  });

  it('says everything is accounted for, with the five totals, who removed what and the months', async () => {
    render(NothingLost);

    expect(
      await hero().findByRole('heading', { name: 'All 24,968 photos and videos you added are accounted for' }),
    ).toBeInTheDocument();
    expect(
      hero().getByText(/24,680 are in your library, 96 in the Trash,? and 192 were removed\./),
    ).toBeInTheDocument();
    for (const label of ['In your library', 'Stored once', 'In the Trash', 'Removed', 'Can’t be accounted for']) {
      expect(hero().getByText(label)).toBeInTheDocument();
    }
    expect(hero().queryByRole('button')).not.toBeInTheDocument();

    expect(await screen.findByText('IMG_4410.HEIC')).toBeInTheDocument();
    expect(screen.getByText(/^You deleted it/)).toBeInTheDocument();
    expect(screen.getByText(/^Left the Trash when its time there ran out/)).toBeInTheDocument();
    expect(screen.getByText(/^Morgan deleted it/)).toBeInTheDocument();
    expect(screen.getByText(/^Removed from the library by Someone/)).toBeInTheDocument();
    expect(screen.getByText(/^Saved from a partner’s photos/)).toBeInTheDocument();
    expect(getLedger).toHaveBeenCalledWith({ state: 'removed', size: 50, cursor: undefined });

    // By month: six months first, then the rest.
    expect(screen.getByRole('rowheader', { name: 'November 2026' })).toBeInTheDocument();
    expect(screen.queryByRole('rowheader', { name: 'May 2026' })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_ledger_months_more }));
    expect(screen.getByRole('rowheader', { name: 'May 2026' })).toBeInTheDocument();
    expect(screen.getByText('That’s every month since you started, in May 2026.')).toBeInTheDocument();
  });

  it('gets more of the list, and another chip reads its own', async () => {
    render(NothingLost);
    await fireEvent.click(await screen.findByRole('button', { name: en.frameleaf_ledger_show_more }));
    expect(await screen.findByText('IMG_0020.HEIC')).toBeInTheDocument();
    expect(getLedger).toHaveBeenLastCalledWith({ state: 'removed', size: 50, cursor: 'next' });
    expect(screen.getByText('IMG_4410.HEIC')).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_ledger_all_shown)).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: /^In the Trash/ }));
    expect(await screen.findByText(en.frameleaf_ledger_none_trashed)).toBeInTheDocument();
    expect(getLedger).toHaveBeenLastCalledWith({ state: 'trashed', size: 50, cursor: undefined });
  });

  it('turns into a warning only when something is missing, lists it, and opens File checks', async () => {
    vi.mocked(getLedgerSummary).mockResolvedValue(summary({ kept: 24_407, missing: 3 }) as never);
    vi.mocked(getLedger).mockImplementation(({ state }) =>
      Promise.resolve({
        items:
          state === 'missing'
            ? [item({ assetId: 'm1', originalFileName: 'IMG_1902.HEIC', state: 'missing', stateBy: null })]
            : [],
        nextCursor: null,
      } as never),
    );
    render(NothingLost);

    expect(
      await hero().findByRole('heading', { name: '3 photos and videos can’t be accounted for' }),
    ).toBeInTheDocument();
    expect(hero().getByText(/The other 24,965 are all accounted for\./)).toBeInTheDocument();
    expect(await screen.findByText('IMG_1902.HEIC')).toBeInTheDocument();
    expect(screen.getByText(/^Missing since/)).toBeInTheDocument();

    await fireEvent.click(hero().getByRole('button', { name: en.frameleaf_ledger_open_file_checks }));
    expect(goto).toHaveBeenCalledWith(expect.stringContaining('integrity-checks'));
  });

  it('sends a member to their own missing files, with no Whose picker', async () => {
    user.isAdmin = false;
    vi.mocked(getLedgerSummary).mockResolvedValue(summary({ kept: 24_409, missing: 1 }) as never);
    render(NothingLost);

    expect(await hero().findByRole('heading', { name: '1 photo or video can’t be accounted for' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: en.frameleaf_ledger_whose_label })).not.toBeInTheDocument();
    expect(searchUsers).toHaveBeenCalled();
    expect(searchUsersAdmin).not.toHaveBeenCalled();
    await fireEvent.click(hero().getByRole('button', { name: en.frameleaf_ledger_see_missing_files }));
    expect(goto).toHaveBeenCalledWith(expect.stringMatching(/files/));
    expect(getLedgerAdminSummary).not.toHaveBeenCalled();
  });

  it('says so when nothing was added yet, and when it could not be read', async () => {
    vi.mocked(getLedgerSummary).mockResolvedValueOnce({ ...summary(), total: 0, months: [] } as never);
    const first = render(NothingLost);
    expect(await hero().findByRole('heading', { name: en.frameleaf_ledger_hero_empty_you })).toBeInTheDocument();
    expect(screen.queryByText(en.frameleaf_ledger_happened_title)).not.toBeInTheDocument();
    first.unmount();

    vi.mocked(getLedgerSummary).mockRejectedValueOnce(new Error('offline'));
    render(NothingLost);
    expect(await hero().findByRole('heading', { name: en.frameleaf_ledger_hero_error })).toBeInTheDocument();
    await fireEvent.click(hero().getByRole('button', { name: en.frameleaf_ledger_try_again }));
    expect(
      await hero().findByRole('heading', { name: 'All 24,968 photos and videos you added are accounted for' }),
    ).toBeInTheDocument();
  });

  it('says Locked photos are listed only while Locked is open', async () => {
    const first = render(NothingLost);
    expect(await screen.findByText(en.frameleaf_ledger_locked_line)).toBeInTheDocument();
    first.unmount();

    sessionAccess.isElevated = true;
    render(NothingLost);
    await screen.findByText('IMG_4410.HEIC');
    expect(screen.queryByText(en.frameleaf_ledger_locked_line)).not.toBeInTheDocument();
  });

  it('shows an administrator the household by person, then one person’s totals, and never a file', async () => {
    vi.mocked(getLedgerAdminSummary).mockImplementation(
      ({ userId }: { userId?: string } = {}) =>
        Promise.resolve(
          userId
            ? { ...summary({ kept: 15_100, merged: 110, trashed: 22, removed: 61 }), missingByOwner: [], byOwner: [] }
            : {
                ...summary({ kept: 39_507, missing: 3 }),
                missingByOwner: [{ ownerId: 'morgan', count: 3, since: '2026-11-14T03:40:00.000Z' }],
                byOwner: [
                  { ownerId: 'taylor', total: 24_968, states: states() },
                  { ownerId: 'morgan', total: 15_293, states: states({ kept: 15_097, merged: 110, missing: 3 }) },
                ],
              },
        ) as never,
    );
    render(NothingLost);
    await hero().findByRole('heading', { name: /you added are accounted for/ });

    await fireEvent.change(screen.getByRole('combobox', { name: en.frameleaf_ledger_whose_label }), {
      target: { value: 'everyone' },
    });
    expect(
      await hero().findByRole('heading', { name: '3 photos and videos can’t be accounted for' }),
    ).toBeInTheDocument();
    expect(hero().getByText(/They were in Morgan’s library\./)).toBeInTheDocument();
    expect(screen.getByText('3 can’t be accounted for')).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_ledger_person_ok)).toBeInTheDocument();
    expect(screen.queryByText(en.frameleaf_ledger_happened_title)).not.toBeInTheDocument();
    expect(screen.queryByText('IMG_4410.HEIC')).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'Show Morgan’s totals' }));
    expect(
      await hero().findByRole('heading', { name: 'All 15,293 photos and videos Morgan added are accounted for' }),
    ).toBeInTheDocument();
    expect(getLedgerAdminSummary).toHaveBeenLastCalledWith({ userId: 'morgan' });
    expect(screen.getByText('Only Morgan can see which photos these are')).toBeInTheDocument();
    expect(screen.queryByText(en.frameleaf_ledger_happened_title)).not.toBeInTheDocument();
  });
});
