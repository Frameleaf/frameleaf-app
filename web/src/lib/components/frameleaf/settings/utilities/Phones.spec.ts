import type { BackupDeviceDto } from '@frameleaf/sdk';
import { render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import Phones from '$lib/components/frameleaf/settings/utilities/Phones.svelte';
import en from '../../../../../../../i18n/en.json';

const state = vi.hoisted(() => ({
  url: new URL('http://localhost/user-settings?area=utilities&section=phones'),
  user: { id: 'me', isAdmin: false },
}));
vi.mock('$app/state', () => ({
  page: {
    get url() {
      return state.url;
    },
  },
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: {
    get user() {
      return state.user;
    },
  },
}));
vi.mock('$lib/components/frameleaf/LockedUnlockDialog.svelte', () => ({ default: () => {} }));

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
const phone = (overrides: Partial<BackupDeviceDto> = {}) =>
  ({
    id: 'p1',
    ownerId: 'me',
    displayName: 'Taylor’s iPhone',
    model: 'iPhone 16 Pro',
    platform: 'iOS',
    quietForDays: 0,
    lastSuccessfulBackupAt: hoursAgo(1),
    phoneItemCount: 12_348,
    pendingReasons: [
      { code: 'wifi', count: 6 },
      { code: 'icloudOriginals', count: 2 },
    ],
    lastCheck: { id: 'r1', checkedAt: hoursAgo(9), completedAt: hoursAgo(9), itemsChecked: 12_340, itemsMissing: 0 },
    ...overrides,
  }) as BackupDeviceDto;
const check = (overrides: Partial<NonNullable<BackupDeviceDto['lastCheck']>>) => ({
  ...phone().lastCheck!,
  ...overrides,
});

const show = (devices: BackupDeviceDto[], { elevated = true, open }: { elevated?: boolean; open?: string } = {}) => {
  state.url = new URL(`http://localhost/user-settings?area=utilities&section=phones${open ? `&phone=${open}` : ''}`);
  sdkMock.listBackupDevices.mockResolvedValue({ devices, nextOffset: null });
  sdkMock.getAuthStatus.mockResolvedValue({ isElevated: elevated } as never);
  sdkMock.getBackupDeviceReceipt.mockResolvedValue({} as never);
  render(Phones);
};

describe('Tools › Phones (FL-792)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    vi.clearAllMocks();
    state.user = { id: 'me', isAdmin: false };
  });

  it('says items are waiting, never safe, while the phone still has some to send', async () => {
    show([phone()]);
    expect(
      await screen.findByRole('heading', { name: 'Taylor’s iPhone: 8 items are still waiting to go up' }),
    ).toBeInTheDocument();
    expect(screen.getByText('8 waiting')).toBeInTheDocument();
    expect(screen.queryByText('All safe')).toBeNull();
  });

  it('follows every page of everyone’s phones', async () => {
    state.user = { id: 'me', isAdmin: true };
    sdkMock.listAllBackupDevices
      .mockResolvedValueOnce({ devices: [phone()], nextOffset: 200 })
      .mockResolvedValueOnce({ devices: [phone({ id: 'p9', displayName: 'Page two phone' })], nextOffset: null });
    sdkMock.searchUsersAdmin.mockResolvedValue([] as never);
    show([phone()]);
    expect(await screen.findByText('Page two phone')).toBeInTheDocument();
    expect(sdkMock.listAllBackupDevices).toHaveBeenLastCalledWith({ limit: 200, offset: 200 });
  });

  it('says every phone is safe, with the receipt line and when it was checked', async () => {
    show([phone({ pendingReasons: [] })]);
    expect(await screen.findByRole('heading', { name: 'Your phones are safely backed up' })).toBeInTheDocument();
    expect(screen.getByText('12,348 on this phone · 12,340 safely on the server')).toBeInTheDocument();
    expect(screen.getByText('All safe')).toBeInTheDocument();
    expect(screen.getByText(/^Last checked/)).toBeInTheDocument();
    expect(screen.queryByText('Everyone’s phones')).toBeNull();
  });

  it('never claims counts before the first check', async () => {
    show([phone({ lastCheck: null, phoneItemCount: null, pendingReasons: [] })], { open: 'p1' });
    expect(await screen.findByRole('heading', { name: 'Not checked yet' })).toBeInTheDocument();
    const receipt = screen.getByRole('region', { name: 'Backup receipt' });
    expect(within(receipt).getByText('Not sent yet')).toBeInTheDocument();
    expect(within(receipt).getAllByText('Not checked yet').length).toBeGreaterThan(0);
    expect(within(receipt).queryByText(/12,/)).toBeNull();
    expect(screen.getByText('Nothing is waiting. New photos go up as soon as they’re taken.')).toBeInTheDocument();
  });

  it('says how many items are missing without listing them', async () => {
    show([phone({ lastCheck: check({ itemsMissing: 11 }) })], { open: 'p1' });
    expect(
      await screen.findByRole('heading', { name: '11 items from Taylor’s iPhone aren’t on the server' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('11 items the phone has are not on the server yet. Open the app to back them up.'),
    ).toBeInTheDocument();
    expect(screen.getByText('12,329')).toBeInTheDocument();
    expect(screen.getByText('Not on the server')).toBeInTheDocument();
  });

  it('warns when the last check is over a week old', async () => {
    show([phone({ lastCheck: check({ completedAt: hoursAgo(9 * 24 + 2) }) })]);
    expect(await screen.findByText('Not checked for 9 days')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Taylor’s iPhone: Last checked 9 days ago' })).toBeInTheDocument();
  });

  it('shows a code it does not know as plain Waiting, never the code', async () => {
    show([phone({ pendingReasons: [{ code: 'x_new_reason_42', count: 3 }] })], { open: 'p1' });
    expect(await screen.findByText('Waiting', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText('Waiting on the phone. Open the app on it to see why.')).toBeInTheDocument();
    expect(screen.queryByText(/x_new_reason_42/)).toBeNull();
  });

  it('offers the PIN instead of "Not checked yet" when the session is locked', async () => {
    show([phone({ lastCheck: null })], { elevated: false });
    expect(await screen.findByRole('heading', { name: 'Unlock to see the server’s check' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeInTheDocument();
    expect(screen.queryByText('Not checked yet')).toBeNull();
    expect(sdkMock.getBackupDeviceReceipt).not.toHaveBeenCalled();
  });

  it('shows administrators everyone’s phones as counts only', async () => {
    state.user = { id: 'me', isAdmin: true };
    sdkMock.listAllBackupDevices.mockResolvedValue({
      devices: [
        phone(),
        phone({
          id: 'p2',
          ownerId: 'u2',
          displayName: 'Jamie’s Pixel 8',
          phoneItemCount: 8912,
          pendingReasons: [{ code: 'charging', count: 3 }],
          lastCheck: check({ itemsChecked: 8909 }),
        }),
      ],
      nextOffset: null,
    });
    sdkMock.searchUsersAdmin.mockResolvedValue([{ id: 'u2', name: 'Jamie' }] as never);
    show([phone()]);
    const table = await screen.findByRole('table', { name: 'Everyone’s phones' });
    expect(within(table).getByText('Jamie’s Pixel 8')).toBeInTheDocument();
    expect(within(table).getByText('Jamie')).toBeInTheDocument();
    expect(within(table).getByText('8,912')).toBeInTheDocument();
    expect(within(table).getByText('3')).toBeInTheDocument();
    expect(within(table).queryByText('Waiting for charging')).toBeNull();
  });
});
