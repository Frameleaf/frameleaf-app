import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '../../../../../../../i18n/en.json';
import ImportLanding from './ImportLanding.svelte';

const sdk = vi.hoisted(() => ({
  listTakeoutImports: vi.fn(),
  listICloudConnections: vi.fn(),
  getAllLibraries: vi.fn(),
  listBackupDevices: vi.fn(),
}));
const goto = vi.hoisted(() => vi.fn());
vi.mock('$app/navigation', () => ({ goto }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { user: { isAdmin: true } } }));
vi.mock('@frameleaf/sdk', async (original) => ({ ...(await original<typeof import('@frameleaf/sdk')>()), ...sdk }));

describe('Import (FL-365, FL-1808)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    sdk.listTakeoutImports.mockResolvedValue([]);
    sdk.listICloudConnections.mockResolvedValue({ enabled: true, connections: [] });
    sdk.getAllLibraries.mockResolvedValue([{ id: 'l1', deletedAt: null }]);
    sdk.listBackupDevices.mockResolvedValue({ devices: [{}, {}, {}], nextOffset: null });
  });

  it('opens on the imports, lists every way in, and points backups to Backup', async () => {
    render(ImportLanding);
    expect(await screen.findByRole('heading', { name: 'Nothing has been imported yet' })).toBeInTheDocument();
    for (const name of ['Google Photos', 'iCloud Photos', 'A folder on this server', 'Your phone', 'Export a copy']) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    expect(await screen.findByText(/1 folder connected/)).toBeInTheDocument();
    expect(await screen.findByText('3 phones are backing up.')).toBeInTheDocument();
    expect(screen.getByText('Looking for backups?')).toBeInTheDocument();
  });

  it('lists your phone first, then Google, iCloud, a folder and Eagle, and opens the Eagle import here (FL-1808)', async () => {
    const { eagleImportUi } = await import('$lib/frameleaf/eagle/eagle-import-status.svelte');
    render(ImportLanding);
    const ways = await screen.findByRole('region', { name: 'Bring photos in from…' });
    expect([...ways.querySelectorAll('li strong')].map((row) => row.textContent)).toEqual([
      'Your phone',
      'Google Photos',
      'iCloud Photos',
      'A folder on this server',
      'Eagle library',
    ]);
    await fireEvent.click(screen.getByRole('button', { name: /Eagle library/ }));
    // As the prototype: Boards opens with the Eagle import dialog.
    await vi.waitFor(() => expect(eagleImportUi.open).toBe(true));
    expect(goto).toHaveBeenCalledWith('/pro');
  });

  it('says when an import is running', async () => {
    sdk.listTakeoutImports.mockResolvedValue([
      { id: 't1', state: 'importing', processed: 1248, total: 3560, updatedAt: '2026-10-20T00:00:00.000Z' },
    ]);
    render(ImportLanding);
    expect(await screen.findByRole('heading', { name: /1,248 of 3,560 photos added/ })).toBeInTheDocument();
  });
});
