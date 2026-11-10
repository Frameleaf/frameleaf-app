import { render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '../../../../../../i18n/en.json';
import PhonesList from './PhonesList.svelte';

const sdk = vi.hoisted(() => ({
  listAllBackupDevices: vi.fn(),
  searchUsersAdmin: vi.fn(),
  getAuthStatus: vi.fn(),
  getBackupDeviceReceipt: vi.fn(),
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('@frameleaf/sdk', async (original) => ({ ...(await original<typeof import('@frameleaf/sdk')>()), ...sdk }));

const phone = (id: string, displayName: string, quietForDays: number | null, ownerId = 'u1') => ({
  id,
  displayName,
  model: 'iPhone 16',
  platform: 'iOS',
  ownerId,
  quietForDays,
  lastSuccessfulBackupAt: quietForDays === null ? null : new Date(Date.now() - quietForDays * 86_400_000).toISOString(),
  phoneItemCount: null as number | null,
  pendingReasons: [] as { code: string; count: number }[],
  lastCheck: null as null | { completedAt: string; itemsChecked: number; itemsMissing: number },
});

describe('Phones (FL-540)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    sdk.searchUsersAdmin.mockReset().mockResolvedValue([{ id: 'u1', name: 'Sam' }]);
    sdk.listAllBackupDevices.mockReset();
    sdk.getAuthStatus.mockReset().mockResolvedValue({ isElevated: true });
  });

  it('lists every phone, longest quiet first, and says which stopped sending photos', async () => {
    sdk.listAllBackupDevices.mockResolvedValue({
      devices: [phone('a', 'Sam’s iPhone', 0), phone('b', 'Old iPad', 12), phone('c', 'New Pixel', null)],
    });
    render(PhonesList);
    expect(await screen.findByRole('heading', { name: '1 phone stopped sending photos' })).toBeInTheDocument();
    const names = screen.getAllByText(/Sam’s iPhone|Old iPad|New Pixel/).map((node) => node.textContent);
    expect(names).toEqual(['Old iPad', 'Sam’s iPhone', 'New Pixel']);
    expect(screen.getByText('Quiet for 12 days')).toBeInTheDocument();
    expect(screen.getByText('No photos sent yet')).toBeInTheDocument();
    expect(screen.getAllByText(/^Sam · iPhone 16/).length).toBe(3);
  });

  it('adds each phone’s counts and check age, never its waiting reasons (FL-792)', async () => {
    const checked = {
      ...phone('a', 'Sam’s iPhone', 0),
      phoneItemCount: 2430,
      pendingReasons: [{ code: 'wifi', count: 4 }],
      lastCheck: { completedAt: new Date(Date.now() - 3_600_000).toISOString(), itemsChecked: 2430, itemsMissing: 0 },
    };
    sdk.listAllBackupDevices.mockResolvedValue({ devices: [checked, phone('c', 'New Pixel', null)] });
    render(PhonesList);
    expect(
      await screen.findByText('Sam · iPhone 16 · 2,430 on this phone · 2,430 safely on the server · 4 waiting'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Last checked 1 hour ago/)).toBeInTheDocument();
    expect(
      screen.getByText('Sam · iPhone 16 · Phone count not sent yet · Not checked on the server yet'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Wi-Fi/)).toBeNull();
  });

  it('does not call a withheld check “not checked” in a locked session', async () => {
    sdk.getAuthStatus.mockResolvedValue({ isElevated: false });
    sdk.listAllBackupDevices.mockResolvedValue({ devices: [phone('a', 'Sam’s iPhone', 0)] });
    render(PhonesList);
    expect(await screen.findByText(/Unlock to see the server’s check/)).toBeInTheDocument();
    expect(screen.queryByText(/Not checked on the server yet/)).toBeNull();
  });

  it('says no phone backs up yet', async () => {
    sdk.listAllBackupDevices.mockResolvedValue({ devices: [] });
    render(PhonesList);
    expect(await screen.findByRole('heading', { name: 'No phone backs up here yet' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mobile apps' })).toBeInTheDocument();
  });

  it('says the phones could not be read', async () => {
    sdk.listAllBackupDevices.mockRejectedValue(new Error('down'));
    render(PhonesList);
    expect(await screen.findByRole('heading', { name: 'The phones could not be read' })).toBeInTheDocument();
  });
});
