import { render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '../../../../../../i18n/en.json';
import PhonesList from './PhonesList.svelte';

const sdk = vi.hoisted(() => ({ listAllBackupDevices: vi.fn(), searchUsersAdmin: vi.fn() }));
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
});

describe('Phones (FL-540)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    sdk.searchUsersAdmin.mockReset().mockResolvedValue([{ id: 'u1', name: 'Sam' }]);
    sdk.listAllBackupDevices.mockReset();
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
