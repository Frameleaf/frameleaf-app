import {
  AdminAuditAction,
  type AssetStatsResponseDto,
  type LibraryResponseDto,
  type LibraryStatsResponseDto,
  type ServerConfigDto,
  type UserAdminHistoryEventResponseDto,
} from '@immich/sdk';
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
  getUserHistoryAdmin: vi.fn(),
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
  deletedAt: null,
  scan: null,
  assetCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  refreshedAt: null,
  ...overrides,
});

const preferences = preferencesFactory.build({ revision: 'revision-1' });

const renderTabs = (
  libraries: LibraryResponseDto[] = [],
  libraryStatistics: Record<string, LibraryStatsResponseDto> = {},
) =>
  render(AccountDetailTabs, {
    user,
    preferences,
    statistics,
    sessions: [],
    libraries,
    libraryStatistics,
    preferencesEditable: true,
    savePreferences: vi.fn(),
    loadPreferences: vi.fn(),
  });

const tab = (name: string) => screen.getByRole('button', { name });

const event = (overrides: Partial<UserAdminHistoryEventResponseDto>): UserAdminHistoryEventResponseDto => ({
  id: 'event-1',
  action: AdminAuditAction.AccountCreated,
  subject: user.name,
  detail: null,
  libraryId: null,
  actorId: 'admin-id',
  actorName: 'Ada',
  createdAt: '2026-09-23T12:00:00.000Z',
  ...overrides,
});

beforeEach(async () => {
  vi.clearAllMocks();
  addMessages('dev', en);
  const { getUserHistoryAdmin } = await import('@immich/sdk');
  vi.mocked(getUserHistoryAdmin).mockResolvedValue({ events: [], hasMore: false });
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

  describe('Libraries', () => {
    it("lists the account's managed uploads first, with the template's wording", async () => {
      renderTabs();

      await fireEvent.click(tab(en.frameleaf_account_detail_tab_libraries));

      expect(screen.getByText('Grace Hopper’s uploads')).toBeInTheDocument();
      expect(screen.getByText(/Managed uploads · active/)).toBeInTheDocument();
      expect(screen.getByText(en.frameleaf_account_detail_uploads_note)).toBeInTheDocument();
      // everything the account owns when it has no external library
      expect(screen.getByText('124 items')).toBeInTheDocument();
    });

    it("lists only the account's own external libraries, never another account's", async () => {
      renderTabs([
        library({ id: 'lib-1', name: 'Trip photos', ownerId: user.id }),
        library({ id: 'lib-2', name: "Someone else's library", ownerId: 'other-id' }),
      ]);

      await fireEvent.click(tab(en.frameleaf_account_detail_tab_libraries));

      expect(screen.getByText('Trip photos')).toBeInTheDocument();
      expect(screen.getByText(/External folders · active/)).toBeInTheDocument();
      expect(screen.queryByText("Someone else's library")).toBeNull();
    });

    it("counts uploads as the account's items less its external libraries' items", async () => {
      renderTabs([library({ id: 'lib-1', name: 'Trip photos' })], {
        'lib-1': { photos: 40, videos: 2, total: 42, usage: 0, usagePhysical: 0 },
      });

      await fireEvent.click(tab(en.frameleaf_account_detail_tab_libraries));

      expect(screen.getByText('42 items')).toBeInTheDocument();
      expect(screen.getByText('82 items')).toBeInTheDocument();
    });

    it("sends the uploads row's storage action to the account's storage allowance", async () => {
      renderTabs();

      await fireEvent.click(tab(en.frameleaf_account_detail_tab_libraries));
      await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_account_detail_uploads_storage }));

      expect(screen.getByText(en.frameleaf_account_detail_quota_footnote)).toBeInTheDocument();
    });
  });

  it('shows the four snapshot stats, physical originals included (CC-29)', () => {
    render(AccountDetailTabs, {
      user,
      preferences,
      statistics,
      sessions: [],
      libraries: [],
      physicalBytes: 1024,
      preferencesEditable: true,
      savePreferences: vi.fn(),
      loadPreferences: vi.fn(),
    });

    expect(screen.getByText(en.frameleaf_account_detail_originals_logical)).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_account_detail_originals_physical)).toBeInTheDocument();
    expect(screen.getByText('1 KiB')).toBeInTheDocument();
  });

  it("Overview's quick actions jump straight to Features and Security", async () => {
    renderTabs();

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_account_detail_security_settings }));

    expect(screen.getByText(en.frameleaf_users_devices_none)).toBeInTheDocument();
  });

  describe('Activity', () => {
    it("lists the account's administrator history in the template's wording, newest first", async () => {
      const { getUserHistoryAdmin } = await import('@immich/sdk');
      vi.mocked(getUserHistoryAdmin).mockResolvedValue({
        events: [
          event({ id: 'e3', action: AdminAuditAction.SessionRevoked, detail: 'iOS · iPhone' }),
          event({ id: 'e2', action: AdminAuditAction.PasswordReset, detail: 'change-required' }),
          event({ id: 'e1', action: AdminAuditAction.LibraryScanQueued, subject: 'Trip photos', libraryId: 'lib-1' }),
        ],
        hasMore: false,
      });
      renderTabs();

      expect(getUserHistoryAdmin).not.toHaveBeenCalled();
      await fireEvent.click(tab(en.frameleaf_account_detail_tab_activity));

      const items = await screen.findAllByRole('listitem');
      expect(items.map((item) => item.querySelector('strong')?.textContent)).toEqual([
        'Device signed out: iOS · iPhone',
        en.frameleaf_account_history_password_reset_change_required,
        en.frameleaf_account_history_library_scan_queued,
      ]);
      expect(items[2].querySelector('span')?.textContent).toMatch(/^\s*Trip photos · /);
      // The audit actor is named when the server recorded one.
      expect(items[0].querySelector('span')?.textContent).toContain('by Ada');
      expect(getUserHistoryAdmin).toHaveBeenCalledWith({ id: user.id, before: undefined, take: 50 });
    });

    it('fetches the history again each time the tab opens', async () => {
      const { getUserHistoryAdmin } = await import('@immich/sdk');
      renderTabs();

      await fireEvent.click(tab(en.frameleaf_account_detail_tab_activity));
      await fireEvent.click(tab(en.frameleaf_account_detail_tab_overview));
      await fireEvent.click(tab(en.frameleaf_account_detail_tab_activity));

      await waitFor(() => expect(getUserHistoryAdmin).toHaveBeenCalledTimes(2));
    });

    it("shows the template's empty state for an account with no history", async () => {
      renderTabs();

      await fireEvent.click(tab(en.frameleaf_account_detail_tab_activity));

      expect(await screen.findByText(en.frameleaf_account_history_empty)).toBeInTheDocument();
    });

    it('loads older events after the last one shown', async () => {
      const { getUserHistoryAdmin } = await import('@immich/sdk');
      vi.mocked(getUserHistoryAdmin)
        .mockResolvedValueOnce({ events: [event({ id: 'e2', action: AdminAuditAction.PinReset })], hasMore: true })
        .mockResolvedValueOnce({
          events: [event({ id: 'e1', action: AdminAuditAction.AccountCreated })],
          hasMore: false,
        });
      renderTabs();

      await fireEvent.click(tab(en.frameleaf_account_detail_tab_activity));
      await fireEvent.click(await screen.findByRole('button', { name: en.frameleaf_account_history_show_more }));

      await screen.findByText(en.frameleaf_account_history_account_created);
      expect(getUserHistoryAdmin).toHaveBeenLastCalledWith({ id: user.id, before: 'e2', take: 50 });
      expect(screen.getAllByRole('listitem')).toHaveLength(2);
      expect(screen.queryByRole('button', { name: en.frameleaf_account_history_show_more })).toBeNull();
    });

    it('says when the history cannot be loaded and offers a retry', async () => {
      const { getUserHistoryAdmin } = await import('@immich/sdk');
      vi.mocked(getUserHistoryAdmin).mockRejectedValueOnce(new Error('offline'));
      renderTabs();

      await fireEvent.click(tab(en.frameleaf_account_detail_tab_activity));
      expect(await screen.findByRole('alert')).toHaveTextContent(en.frameleaf_account_history_error);

      await fireEvent.click(screen.getByRole('button', { name: en.retry }));

      expect(await screen.findByText(en.frameleaf_account_history_empty)).toBeInTheDocument();
    });
  });
});
