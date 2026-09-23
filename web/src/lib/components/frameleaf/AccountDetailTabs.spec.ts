import type { AssetStatsResponseDto, CalendarHeatmapResponseDto, LibraryResponseDto, ServerConfigDto } from '@immich/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import AccountDetailTabs from '$lib/components/frameleaf/AccountDetailTabs.svelte';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import en from '../../../../../i18n/en.json';

/**
 * FL-76: the account detail's outer tab bar. These checks cover the orchestration this
 * component owns — which tabs exist and in what order, which one is showing, and that the
 * Libraries and Activity tabs reach the right data — not the internals of the panels it
 * composes, which have their own specs (`AccountPreferencesEditor.spec.ts`,
 * `AccountSecurityPanel.spec.ts`).
 */

vi.mock('$app/navigation', () => ({ beforeNavigate: vi.fn(), goto: vi.fn() }));

vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { user: { id: 'admin-id' } } }));

vi.mock('$lib/managers/server-config-manager.svelte', () => ({
  serverConfigManager: { value: { userDeleteDelay: 7 } as ServerConfigDto },
}));

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  getUserCalendarHeatmapAdmin: vi.fn(),
  deleteUserSessionAdmin: vi.fn(),
}));

vi.mock('@immich/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/ui')>()),
  modalManager: { showDialog: vi.fn(), show: vi.fn() },
  toastManager: { primary: vi.fn(), danger: vi.fn() },
}));

const user = userAdminFactory.build({
  id: 'target-id',
  name: 'Grace Hopper',
  isAdmin: false,
  storageLabel: null,
  quotaSizeInBytes: 10_000_000_000,
  quotaUsageInBytes: 2_000_000_000,
});

const statistics: AssetStatsResponseDto = { images: 120, videos: 4, total: 124 };

const library = (overrides: Partial<LibraryResponseDto>): LibraryResponseDto => ({
  id: 'lib-1',
  name: 'Library',
  ownerId: user.id,
  importPaths: ['/mnt/a'],
  exclusionPatterns: [],
  assetCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  refreshedAt: null,
  ...overrides,
});

const preferences = preferencesFactory.build({ revision: 'revision-1' });

const renderTabs = (libraries: LibraryResponseDto[] = []) =>
  render(AccountDetailTabs, {
    user,
    preferences,
    statistics,
    sessions: [],
    libraries,
    preferencesEditable: true,
    savePreferences: vi.fn(),
    loadPreferences: vi.fn(),
  });

const tab = (name: string) => screen.getByRole('button', { name });

beforeEach(async () => {
  vi.clearAllMocks();
  addMessages('dev', en);
  const { getUserCalendarHeatmapAdmin } = await import('@immich/sdk');
  vi.mocked(getUserCalendarHeatmapAdmin).mockResolvedValue({
    from: '2026-01-01',
    series: [],
  } as CalendarHeatmapResponseDto);
});

describe('AccountDetailTabs (FL-76)', () => {
  it("lays out the tabs in the prototype's order", () => {
    renderTabs();

    const nav = screen.getByRole('navigation', { name: en.frameleaf_account_detail_tabs_nav_label });
    const names = within(nav)
      .getAllByRole('button')
      .map((button) => button.textContent?.trim());

    expect(names).toEqual([
      en.frameleaf_account_detail_tab_overview,
      en.frameleaf_account_prefs_tab_features,
      en.frameleaf_account_prefs_tab_preferences,
      en.frameleaf_account_prefs_tab_notifications,
      en.frameleaf_account_detail_tab_libraries,
      en.frameleaf_account_detail_tab_security,
      en.frameleaf_account_detail_tab_activity,
    ]);
  });

  it('opens Features without a second, duplicate tab nav', async () => {
    renderTabs();

    await fireEvent.click(tab(en.frameleaf_account_prefs_tab_features));

    expect(screen.getByRole('checkbox', { name: en.frameleaf_account_prefs_feature_tags })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: en.frameleaf_account_prefs_tabs_label })).toBeNull();
  });

  it("lists only the account's own libraries, never another account's", async () => {
    renderTabs([
      library({ id: 'lib-1', name: 'Trip photos', ownerId: user.id, assetCount: 42 }),
      library({ id: 'lib-2', name: "Someone else's library", ownerId: 'other-id' }),
    ]);

    await fireEvent.click(tab(en.frameleaf_account_detail_tab_libraries));

    expect(screen.getByText('Trip photos')).toBeInTheDocument();
    expect(screen.queryByText("Someone else's library")).toBeNull();
  });

  it('shows an account with no libraries as empty, not an error', async () => {
    renderTabs([]);

    await fireEvent.click(tab(en.frameleaf_account_detail_tab_libraries));

    expect(screen.getByText(en.frameleaf_account_detail_libraries_empty)).toBeInTheDocument();
  });

  it("Overview's quick actions jump straight to Features and Security", async () => {
    renderTabs();

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_account_detail_security_settings }));

    expect(screen.getByText(en.frameleaf_users_devices_none)).toBeInTheDocument();
  });

  it('fetches the upload calendar once, only when the Activity tab is first shown', async () => {
    const { getUserCalendarHeatmapAdmin } = await import('@immich/sdk');
    renderTabs();

    expect(getUserCalendarHeatmapAdmin).not.toHaveBeenCalled();

    await fireEvent.click(tab(en.frameleaf_account_detail_tab_activity));
    await waitFor(() => expect(getUserCalendarHeatmapAdmin).toHaveBeenCalledTimes(1));
    expect(getUserCalendarHeatmapAdmin).toHaveBeenCalledWith(expect.objectContaining({ id: user.id }));

    await fireEvent.click(tab(en.frameleaf_account_detail_tab_overview));
    await fireEvent.click(tab(en.frameleaf_account_detail_tab_activity));

    expect(getUserCalendarHeatmapAdmin).toHaveBeenCalledTimes(1);
  });
});
