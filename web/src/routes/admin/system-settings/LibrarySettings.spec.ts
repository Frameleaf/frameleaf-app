import { MediaOperationStatus, type AdminConfigDto, type LibraryResponseDto } from '@frameleaf/sdk';
import { render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { DEFAULT_EXCLUSION_PATTERNS } from '$lib/frameleaf/libraries';
import { SystemConfigDraftStore } from '$lib/frameleaf/system-config-draft.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import en from '../../../../../i18n/en.json';
import LibrarySettings from './LibrarySettings.svelte';

const draft = vi.hoisted(() => ({ store: undefined as unknown }));

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { configFile: false } },
}));
vi.mock('$lib/frameleaf/system-config-draft.svelte', async (original) => ({
  ...(await original<object>()),
  requireSystemConfigDraft: () => draft.store,
  getSystemConfigDraft: () => draft.store,
}));

const newStore = () => {
  const config = () =>
    ({
      library: { scan: { enabled: true, cronExpression: '0 0 * * *' }, watch: { enabled: false } },
    }) as unknown as AdminConfigDto;
  return new SystemConfigDraftStore(
    { config: config(), revision: 'r1' },
    { defaults: config(), load: vi.fn(), save: vi.fn() },
  );
};

const library = (name: string, scan: Partial<NonNullable<LibraryResponseDto['scan']>> | null) =>
  ({
    id: `${name}-id`,
    name,
    importPaths: [`/mnt/${name}`],
    exclusionPatterns: [...DEFAULT_EXCLUSION_PATTERNS],
    deletedAt: null,
    scan: scan && {
      status: MediaOperationStatus.Completed,
      added: 3,
      updated: 0,
      offlined: 0,
      startedAt: '2026-10-23T02:00:00.000Z',
      finishedAt: '2026-10-23T02:04:00.000Z',
      ...scan,
    },
  }) as unknown as LibraryResponseDto;

describe('Folder checks (FL-539)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    vi.clearAllMocks();
    draft.store = newStore();
  });

  it('opens on the last check, with what each folder skips and the recent checks', async () => {
    sdkMock.getAllLibraries.mockResolvedValue([library('Family photos', {})]);
    render(LibrarySettings);

    expect(await screen.findByRole('heading', { name: 'Your folders are checked every night' })).toBeInTheDocument();
    expect(screen.getByText(/1 folder, 3 new photos, nothing removed/)).toBeInTheDocument();
    expect(screen.getByText('A check is not a backup')).toBeInTheDocument();
    expect(screen.getByText('Recommended choices on')).toBeInTheDocument();
    expect(screen.getByText('3 new · 0 changed · 0 removed')).toBeInTheDocument();
    expect(screen.getByText(/took 4 minutes/)).toBeInTheDocument();
  });

  it('says which folder the last check skipped', async () => {
    sdkMock.getAllLibraries.mockResolvedValue([library('Trail camera', { status: MediaOperationStatus.Failed })]);
    render(LibrarySettings);

    expect(await screen.findByRole('heading', { name: 'The last check skipped Trail camera' })).toBeInTheDocument();
  });

  it('asks to add a folder when there is none', async () => {
    sdkMock.getAllLibraries.mockResolvedValue([]);
    render(LibrarySettings);

    expect(await screen.findByRole('heading', { name: 'These apply once you add a folder' })).toBeInTheDocument();
  });

  it('offers a retry instead of "add a folder" when the folders fail to load', async () => {
    sdkMock.getAllLibraries
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValue([library('Family photos', {})]);
    render(LibrarySettings);

    await screen.findByRole('alert');
    expect(screen.queryByRole('heading', { name: 'These apply once you add a folder' })).not.toBeInTheDocument();
    screen.getByRole('button', { name: 'Try again' }).click();
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(sdkMock.getAllLibraries).toHaveBeenCalledTimes(2);
  });

  it('follows a folder added in the Libraries manager without a reload', async () => {
    sdkMock.getAllLibraries.mockResolvedValue([]);
    render(LibrarySettings);
    expect(await screen.findByRole('heading', { name: 'These apply once you add a folder' })).toBeInTheDocument();

    sdkMock.getAllLibraries.mockResolvedValue([library('Family photos', {})]);
    eventManager.emit('LibrariesChange');

    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'These apply once you add a folder' })).not.toBeInTheDocument(),
    );
  });
});
