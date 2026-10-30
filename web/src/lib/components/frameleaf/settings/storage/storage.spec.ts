import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { analyticsReportFixture } from '$lib/frameleaf/analytics.fixture';
import { unusedFilesAccess } from '$lib/frameleaf/unused-files.svelte';
import en from '../../../../../../../i18n/en.json';
import DeletedItems from './DeletedItems.svelte';
import FolderLayout from './FolderLayout.svelte';
import MoveOrExport from './MoveOrExport.svelte';
import StorageLanding from './StorageLanding.svelte';
import { growthPerDay, keepChoice, layoutOf, placeSample, roomLeft } from './storage';

const draft = vi.hoisted(() => ({ store: undefined as unknown }));
const auth = vi.hoisted(() => ({
  authenticated: true,
  user: { id: '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9', storageLabel: 'admin' as string | null },
}));
const sdk = vi.hoisted(() => ({
  getStorage: vi.fn(),
  getAnalyticsReport: vi.fn(),
  getTrashEveryone: vi.fn(),
  getTrashSummary: vi.fn(),
  searchUsersAdmin: vi.fn(),
  restoreUserAdmin: vi.fn(),
  getStorageMigrationStatus: vi.fn(),
  runStorageMigrationInBackground: vi.fn(),
  getManagerAccess: vi.fn(),
  getMyUser: vi.fn(),
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: auth }));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { configFile: false } },
}));
vi.mock('$lib/frameleaf/system-config-draft.svelte', async (original) => ({
  ...(await original<typeof import('$lib/frameleaf/system-config-draft.svelte')>()),
  getSystemConfigDraft: () => draft.store,
}));
vi.mock('@frameleaf/sdk', async (original) => ({ ...(await original<typeof import('@frameleaf/sdk')>()), ...sdk }));

const config = () => ({
  storageWarning: { percent: 90 },
  trash: { enabled: true, days: 30 },
  user: { deleteDelay: 7 },
  nightlyTasks: { databaseCleanup: true },
  storageTemplate: { enabled: true, hashVerificationEnabled: true, template: '{{y}}/{{y}}-{{MM}}-{{dd}}/{{filename}}' },
});
type Config = ReturnType<typeof config>;

const everyone = (overrides = {}) => ({
  count: 32,
  bytes: 410e6,
  days: 30,
  removedTonight: 0,
  trashEnabled: true,
  tidyUpOn: true,
  accounts: [{ userId: 'u1', name: 'Morgan', count: 21, bytes: 318e6, oldestDeletedAt: new Date().toISOString() }],
  ...overrides,
});

describe('Storage & originals (FL-365)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    draft.store = { draft: config(), baseline: config() };
    sdk.getMyUser.mockImplementation(() => Promise.resolve({ ...auth.user }));
    sdk.getStorage.mockResolvedValue({
      diskSizeRaw: 4000e9,
      diskUseRaw: 1000e9,
      diskAvailableRaw: 3000e9,
      diskUsagePercentage: 25,
    });
    sdk.getAnalyticsReport.mockResolvedValue(analyticsReportFixture());
    sdk.getTrashEveryone.mockReset().mockResolvedValue(everyone());
    sdk.getTrashSummary.mockResolvedValue({ count: 8, offline: 0, bytes: 1, pendingDeletion: 0 });
    sdk.searchUsersAdmin.mockResolvedValue([]);
    sdk.getStorageMigrationStatus.mockResolvedValue({
      enabled: true,
      template: '',
      isActive: false,
      isPaused: false,
      hasUnfinishedWork: false,
      statistics: { active: 0, completed: 0, failed: 0, delayed: 0, waiting: 0, paused: 0 },
      candidates: 31_920,
    });
    sdk.getManagerAccess.mockResolvedValue({ url: null });
  });

  it('says what identical files save, opening Duplicates, and Unused files for the server owner only (FL-416)', async () => {
    unusedFilesAccess.reset();
    const { unmount } = render(StorageLanding);
    const saved = await screen.findByText(/^Identical files are stored once: .+ saved$/);
    expect(saved.closest('a')).toHaveAttribute('href', expect.stringContaining('section=duplicates'));
    expect(screen.queryByText(/^Unused files:/)).toBeNull();
    unmount();

    unusedFilesAccess.totals = { files: 277, bytes: 4_500_000_000 };
    render(StorageLanding);
    const unused = await screen.findByText('Unused files: 277 files, 4.5 GB');
    expect(unused.closest('a')).toHaveAttribute('href', expect.stringContaining('section=unused-files'));
    unusedFilesAccess.reset();
  });

  it('opens on the room left and keeps the disk warning in the settings draft', async () => {
    render(StorageLanding);
    expect(await screen.findByText(/3 TB is free/)).toBeInTheDocument();
    expect(screen.getByText('Deleted items')).toBeInTheDocument();
    expect(await screen.findByText(/32 photos are waiting/)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: /At 95%/ }));
    expect((draft.store as { draft: Config }).draft.storageWarning.percent).toBe(95);
  });

  it('offers no “delete straight away”, and warns what a shorter time removes tonight', async () => {
    sdk.getTrashEveryone.mockImplementation(({ days }: { days?: number }) =>
      Promise.resolve(everyone(days ? { days, removedTonight: 12 } : {})),
    );
    // a shorter length already chosen on the page, not yet saved
    (draft.store as { draft: Config }).draft.trash.days = 7;
    render(DeletedItems);
    const keep = await screen.findByRole('combobox', { name: 'Keep deleted photos for' });
    expect([...(keep as HTMLSelectElement).options].map((option) => option.value)).not.toContain('0');
    expect(await screen.findByText(/12 photos already in the Trash are older than 7 days/)).toBeInTheDocument();
    expect(sdk.getTrashEveryone).toHaveBeenCalledWith({ days: 7 });
    await fireEvent.change(keep, { target: { value: '60' } });
    expect((draft.store as { draft: Config }).draft.trash.days).toBe(60);
    expect(screen.getByText('Morgan')).toBeInTheDocument();
  });

  it('says the Trash is not being emptied while the overnight tidy-up is off', async () => {
    const store = draft.store as { draft: Config; baseline: Config };
    store.baseline.nightlyTasks.databaseCleanup = false;
    render(DeletedItems);
    expect(await screen.findByRole('heading', { name: 'The Trash is not being emptied' })).toBeInTheDocument();
  });

  it('names the layouts, shows where a photo goes and offers to re-file with the count', async () => {
    render(FolderLayout);
    expect(await screen.findByRole('heading', { name: /New photos are filed by year, then day/ })).toBeInTheDocument();
    // OPS-08: the folder the server really uses, the viewer's storage label, not a person's name
    expect(screen.getAllByText(/Photo library › admin › 2024 › 2024-06-15 › IMG_1234\.jpg/).length).toBeGreaterThan(0);
    await fireEvent.click(screen.getByRole('button', { name: /^By year, then month 2024/ }));
    expect((draft.store as { draft: Config }).draft.storageTemplate.template).toBe('{{y}}/{{MM}}/{{filename}}');
  });

  it('shows the account ID as the folder when there is no storage label', async () => {
    auth.user.storageLabel = null;
    render(FolderLayout);
    expect(
      (await screen.findAllByText(new RegExp(`Photo library › ${auth.user.id} › 2024 › 2024-06-15`))).length,
    ).toBeGreaterThan(0);
    auth.user.storageLabel = 'admin';
  });

  it('reads the storage label again on open, as another administrator may have changed it', async () => {
    sdk.getMyUser.mockResolvedValue({ ...auth.user, storageLabel: 'family' });
    render(FolderLayout);
    expect((await screen.findAllByText(/Photo library › family › 2024 › 2024-06-15/)).length).toBeGreaterThan(0);
  });

  it('sends a move without Frameleaf Manager to a backup restore or the checklist', async () => {
    render(MoveOrExport);
    await fireEvent.click(await screen.findByRole('button', { name: /Move my photos to a bigger drive/ }));
    await waitFor(() => expect(screen.getByText('This server has no Frameleaf Manager')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Restore from a backup' })).toBeInTheDocument();
  });
});

describe('storage rules', () => {
  it('reads a keep time back as a listed choice or custom', () => {
    expect(keepChoice(30, [7, 30])).toBe('30');
    expect(keepChoice(45, [7, 30])).toBe('custom');
  });

  it('works out the room left at the pace photos are added', () => {
    const perDay = growthPerDay([
      { through: '2026-01-31T00:00:00.000Z', physicalBytes: 100e9 },
      { through: '2026-07-31T00:00:00.000Z', physicalBytes: 281e9 },
    ]);
    expect(roomLeft(120e9, perDay)).toEqual({ unit: 'months', count: 4 });
    expect(roomLeft(120e9, null)).toBeNull();
  });

  it('places the sample photo and names unknown placeholders', () => {
    expect(placeSample('{{y}}/{{MMMM}}/{{filename}}').parts).toEqual(['2024', 'June', 'IMG_1234.jpg']);
    expect(placeSample('{{y}}/{{nope}}/{{filename}}').unknown).toEqual(['{{nope}}']);
    expect(layoutOf('{{y}}/{{MM}}/{{filename}}')).toBe('month');
    expect(layoutOf('{{y}}/{{album}}/{{filename}}')).toBe('custom');
  });
});
