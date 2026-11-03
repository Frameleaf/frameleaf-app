import { render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '../../../../../../../i18n/en.json';
import ImportLanding from './ImportLanding.svelte';

const sdk = vi.hoisted(() => ({
  listTakeoutImports: vi.fn(),
  listICloudConnections: vi.fn(),
  getAllLibraries: vi.fn(),
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { user: { isAdmin: true } } }));
vi.mock('@frameleaf/sdk', async (original) => ({ ...(await original<typeof import('@frameleaf/sdk')>()), ...sdk }));

describe('Import & export (FL-365)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    sdk.listTakeoutImports.mockResolvedValue([]);
    sdk.listICloudConnections.mockResolvedValue({ enabled: true, connections: [] });
    sdk.getAllLibraries.mockResolvedValue([{ id: 'l1', deletedAt: null }]);
  });

  it('opens on the imports, lists every way in, and points backups to Backup', async () => {
    render(ImportLanding);
    expect(await screen.findByRole('heading', { name: 'Nothing has been imported yet' })).toBeInTheDocument();
    for (const name of ['Google Photos', 'iCloud Photos', 'A folder on this server', 'Your phone', 'Export a copy']) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    expect(await screen.findByText(/1 folder connected/)).toBeInTheDocument();
    expect(screen.getByText('Looking for backups?')).toBeInTheDocument();
  });

  it('says when an import is running', async () => {
    sdk.listTakeoutImports.mockResolvedValue([
      { id: 't1', state: 'importing', processed: 1248, total: 3560, updatedAt: '2026-10-20T00:00:00.000Z' },
    ]);
    render(ImportLanding);
    expect(await screen.findByRole('heading', { name: /1,248 of 3,560 photos added/ })).toBeInTheDocument();
  });
});
