import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { addMessages } from 'svelte-i18n';
import { SvelteURL } from 'svelte/reactivity';
import type { SettingsHostSection } from '$lib/frameleaf/settings-areas';
import en from '../../../../../../i18n/en.json';
import MockText from '../../../../test-data/components/MockText.svelte';
import SettingsLibraryGroup from '../../../../test-data/frameleaf/SettingsLibraryGroup.svelte';
import SettingsHost from './SettingsHost.svelte';
import { ownPreferencesPending } from './own-preferences-pending.svelte';

const state = vi.hoisted(() => ({
  url: new URL('http://localhost/user-settings'),
  goto: vi.fn(),
  user: { id: 'me', name: 'Ada', isAdmin: true },
}));
vi.mock('$app/state', () => ({
  page: {
    get url() {
      return state.url;
    },
  },
}));
vi.mock('$app/navigation', () => ({ goto: state.goto, beforeNavigate: vi.fn() }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: {
    get user() {
      return state.user;
    },
    params: {},
  },
}));
vi.mock('$lib/frameleaf/system-config-draft.svelte', () => ({ getSystemConfigDraft: () => undefined }));
const serverConfig = vi.hoisted(() => ({ value: { serverName: '' } }));
vi.mock('$lib/managers/server-config-manager.svelte', () => ({ serverConfigManager: serverConfig }));
vi.mock('$lib/components/frameleaf/analytics/AnalyticsArea.svelte', async () => ({
  default: (await import('../../../../test-data/components/MockText.svelte')).default,
}));
vi.mock('$lib/components/frameleaf/settings/CommandCenterOverview.svelte', async () => ({
  default: (await import('../../../../test-data/components/MockText.svelte')).default,
}));
vi.mock('$lib/components/frameleaf/backup/BackupArea.svelte', async () => ({
  default: (await import('../../../../test-data/components/MockBackupArea.svelte')).default,
}));
vi.mock('$lib/components/frameleaf/computers/ComputersLanding.svelte', async () => ({
  default: (await import('../../../../test-data/components/MockComputersLanding.svelte')).default,
}));
vi.mock('$lib/components/frameleaf/settings/UtilitiesArea.svelte', async () => ({
  default: (await import('../../../../test-data/components/MockText.svelte')).default,
}));
// FL-368: the landing pages read live state of their own; the host only has to mount them.
vi.mock('$lib/components/frameleaf/settings/notifications/NotificationsLanding.svelte', async () => ({
  default: (await import('../../../../test-data/components/MockText.svelte')).default,
}));
vi.mock('$lib/components/frameleaf/settings/server-settings/ServerLanding.svelte', async () => ({
  default: (await import('../../../../test-data/components/MockText.svelte')).default,
}));
vi.mock('$lib/components/frameleaf/settings/preferences/PreferencesLanding.svelte', async () => ({
  default: (await import('../../../../test-data/components/MockText.svelte')).default,
}));
// FL-366: so do Library care, Maintenance, Search & intelligence and Editing & playback.
vi.mock('$lib/components/frameleaf/settings/care/LibraryCareLanding.svelte', async () => ({
  default: (await import('../../../../test-data/components/MockText.svelte')).default,
}));
vi.mock('$lib/components/frameleaf/settings/care/MaintenanceLanding.svelte', async () => ({
  default: (await import('../../../../test-data/components/MockText.svelte')).default,
}));
vi.mock('$lib/components/frameleaf/settings/intelligence/SearchLanding.svelte', async () => ({
  default: (await import('../../../../test-data/components/MockText.svelte')).default,
}));
// FL-365: Storage & originals and Import & export open on landing pages of their own.
vi.mock('$lib/components/frameleaf/settings/storage/StorageLanding.svelte', async () => ({
  default: (await import('../../../../test-data/components/MockText.svelte')).default,
}));
vi.mock('$lib/components/frameleaf/settings/imports/ImportLanding.svelte', async () => ({
  default: (await import('../../../../test-data/components/MockText.svelte')).default,
}));
vi.mock('$lib/components/frameleaf/settings/editing/EditingLanding.svelte', async () => ({
  default: (await import('../../../../test-data/components/MockText.svelte')).default,
}));
vi.mock('@frameleaf/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@frameleaf/sdk')>()),
  getAdminConfigHistory: vi.fn().mockResolvedValue({ entries: [] }),
  getMyPreferenceHistory: vi.fn().mockResolvedValue({
    entries: [
      {
        id: 'pref-1',
        createdAt: '2026-09-24T10:00:00.000Z',
        deviceLabel: 'iOS · Mobile',
        changes: [{ path: 'tags.enabled', before: 'false', after: 'true' }],
        omittedChanges: 0,
      },
    ],
  }),
  getAnalyticsScopes: vi.fn().mockResolvedValue({
    scopes: [
      { kind: 'host', value: 'all', label: '', libraryId: null, removed: false, userId: null },
      { kind: 'account', value: 'user:ada', label: 'Ada', libraryId: null, removed: false, userId: 'ada' },
      { kind: 'library', value: 'library:l1', label: 'Archive', libraryId: 'l1', removed: false, userId: 'ada' },
    ],
  }),
}));

const ICON = 'M12 2L2 22h20Z';
const serverSection = (key: string, title: string, keywords?: string[]): SettingsHostSection => ({
  key,
  title,
  subtitle: `${title} help`,
  icon: ICON,
  keywords,
  admin: true,
  component: key === 'external-library' ? SettingsLibraryGroup : MockText,
});
const accountSection = (key: string, title: string): SettingsHostSection => ({
  key,
  title,
  subtitle: `${title} help`,
  icon: ICON,
});

const sections = [
  serverSection('storage-template', 'Storage template'),
  serverSection('trash', 'Trash settings'),
  serverSection('backup', 'Backup schedule'),
  serverSection('backups', 'Backups & restore'),
  serverSection('mode', 'Maintenance mode'),
  serverSection('cloud-backup', 'Cloud backup'),
  serverSection('integrity-checks', 'Integrity checks'),
  serverSection('external-library', 'External libraries'),
  serverSection('notifications', 'Email delivery'),
  serverSection('queues', 'Job manager'),
  serverSection('accounts', 'People with server access'),
  serverSection('cloud-account', 'Account & link'),
  serverSection('cloud-remote', 'Remote access', ['Public server URL']),
  accountSection('account', 'Your profile'),
  accountSection('takeout', 'Google Photos imports'),
  accountSection('email-preferences', 'Your email notifications'),
  accountSection('oauth', 'Sign-in provider'),
  accountSection('contents', 'Trash'),
  accountSection('sharing', 'Partners & recipient groups'),
];

const open = (href: string, isAdmin = true) => {
  state.url = new SvelteURL(`http://localhost${href}`);
  state.user = { id: 'me', name: 'Ada', isAdmin };
  state.goto.mockReset().mockResolvedValue(undefined);
};

const areaNames = () =>
  [...screen.getByRole('navigation', { name: 'Settings navigation' }).querySelectorAll('button.area')].map((button) =>
    button.textContent?.trim(),
  );

/** An area's own button in the navigation (a breadcrumb may carry the same name). */
const areaButton = (name: string) =>
  [
    ...screen.getByRole('navigation', { name: 'Settings navigation' }).querySelectorAll<HTMLElement>('button.area'),
  ].find((button) => button.getAttribute('aria-label') === name)!;

/** The Backup page the area is showing. */
const backupPage = () => screen.getByTestId('backup-area').textContent;

describe('the Command Center (FL-71)', () => {
  beforeAll(() => addMessages('dev', en));

  it('is one full-screen shell with Back to library, collapse and the grouped areas', () => {
    open('/user-settings?area=storage');
    render(SettingsHost, { sections });
    expect(screen.getByRole('link', { name: 'Back to library' })).toHaveAttribute('href', '/photos');
    expect(screen.getByRole('button', { name: 'Collapse settings navigation' })).toBeInTheDocument();
    expect(screen.getByText('Administrator')).toBeInTheDocument();
    const names = areaNames();
    // The template's catalogue order, grouped: Your library keeps care, libraries, utilities (N1).
    expect(names.slice(names.indexOf('Library care'), names.indexOf('Utilities') + 1)).toEqual([
      'Library care',
      'Libraries',
      'Utilities',
    ]);
    expect(names.at(-3)).toBe('Your preferences');
    // FL-367
    expect(names.at(-2)).toBe('Your sign-in & privacy');
    expect(names.at(-1)).toBe('Change history');
    expect(screen.getByRole('button', { name: 'Storage & originals' })).toHaveAttribute('aria-current', 'page');
  });

  it('gives every area a coloured icon tile, like System Settings (FL-76)', () => {
    open('/user-settings?area=storage');
    render(SettingsHost, { sections });
    const tile = (name: string) =>
      screen.getByRole('button', { name }).querySelector<HTMLElement>('.tile')!.style.getPropertyValue('--tile');
    expect(tile('Overview')).toBe('#0a84ff');
    expect(tile('Library analytics')).toBe('#bf5af2');
    // Backup keeps the teal tile; Import & export no longer shares it (design review finding 66).
    expect(tile('Backup')).toBe('#30b0c7');
    expect(tile('Import & export')).toBe('#64d2ff');
    expect(tile('Library care')).toBe('#30d158');
    expect(tile('Notifications')).toBe('#ff453a');
    for (const button of screen
      .getByRole('navigation', { name: 'Settings navigation' })
      .querySelectorAll('button.area')) {
      expect(button.querySelector(':scope .tile svg')).not.toBeNull();
    }
  });

  // FL-365 / FL-367: Storage & originals and Frameleaf Cloud were the last areas drawn as a section
  // directory; every area with several pages now opens on a landing page of its own.
  it('opens a section one at a time, with the way back to its area', async () => {
    open('/user-settings?area=cloud&section=cloud-account');
    const { container } = render(SettingsHost, { sections });
    await waitFor(() => expect(container.querySelector('#setting-cloud-account')).not.toBeNull());
    expect(container.querySelector('#setting-cloud-remote')).toBeNull();
    expect(container.querySelector('.cc-directory')).toBeNull();
  });

  it('opens a plain-words area on its own landing page instead of a directory (FL-368)', () => {
    open('/user-settings?area=notifications');
    const { container } = render(SettingsHost, { sections });
    expect(container.querySelector('.cc-directory')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Notifications' })).toBeInTheDocument();
    // The landing page lists the area's pages, so the navigation does not repeat them.
    expect(screen.queryByLabelText('Notifications pages')).toBeNull();
  });

  it('opens Library care, Search & intelligence, Editing & playback and Maintenance on landing pages (FL-366)', () => {
    for (const [area, title] of [
      ['care', 'Library care'],
      ['intelligence', 'Search & intelligence'],
      ['editing', 'Editing & playback'],
      ['maintenance', 'Maintenance'],
    ]) {
      open(`/user-settings?area=${area}`);
      const { container, unmount } = render(SettingsHost, {
        sections: [
          ...sections,
          serverSection('smart-search', 'Visual search'),
          serverSection('image', 'Image previews'),
        ],
      });
      expect(container.querySelector('.cc-directory')).toBeNull();
      expect(screen.getByRole('heading', { level: 1, name: title })).toBeInTheDocument();
      unmount();
    }
  });

  it('does not repeat a page name that matches its area in the overline', () => {
    open('/user-settings?area=trash');
    render(SettingsHost, { sections });
    const heading = screen.getByRole('heading', { level: 1, name: 'Trash' }).parentElement!;
    expect(within(heading).queryByRole('button', { name: 'Trash' })).toBeNull();
    expect(heading.querySelector('.cc-overline')).toHaveTextContent('Your library');
  });

  it('gives administration tools the page width without a card around their own grouped containers', () => {
    open('/user-settings?area=processing&section=computers');
    const { container } = render(SettingsHost, {
      sections: [...sections, serverSection('computers', 'Computers')],
    });
    expect(container.querySelector('#setting-computers')).toHaveClass('cc-manager');
  });

  describe('Computers & background work (FL-364)', () => {
    const pages = () => [
      ...sections,
      serverSection('computers', 'Computers'),
      serverSection('routing', 'Where work runs'),
      serverSection('hardware', 'Graphics card check'),
    ];

    it('names the area in plain words and opens it on its own page, not a list of links', () => {
      open('/user-settings?area=processing');
      render(SettingsHost, { sections: pages() });

      expect(areaNames()).toContain('Computers & background work');
      expect(areaNames()).not.toContain('Compute & jobs');
      expect(screen.getByRole('heading', { level: 1, name: 'Computers & background work' })).toBeInTheDocument();
      expect(screen.getByText('Which computers do the heavy work, and how it is going.')).toBeInTheDocument();
      expect(screen.getByTestId('computers-landing')).toBeInTheDocument();
      // Its pages are listed on that page, as Backup's are, not under it in the navigation.
      expect(screen.queryByRole('group', { name: /pages/i })).not.toBeInTheDocument();
    });

    it('puts the way back under the heading of one of its pages', () => {
      open('/user-settings?area=processing&section=hardware');
      render(SettingsHost, { sections: pages() });

      const heading = screen.getByRole('heading', { level: 1, name: 'Graphics card check' }).parentElement!;
      expect(heading.querySelector('.cc-overline')).toHaveTextContent('Computers & background work');
      expect(within(heading).queryByRole('button')).toBeNull();
      expect(screen.getByRole('link', { name: 'Computers & background work' })).toHaveAttribute(
        'href',
        '/user-settings?area=processing',
      );
    });

    it.each(['workers', 'render-workers'])('opens Computers for the old address of "%s"', (section) => {
      open(`/user-settings?area=processing&section=${section}`);
      const { container } = render(SettingsHost, { sections: pages() });

      expect(screen.getByRole('heading', { level: 1, name: 'Computers' })).toBeInTheDocument();
      expect(container.querySelector('#setting-computers')).toBeInTheDocument();
    });
  });

  describe('the way back goes to the page a page was opened from (ADMIN-P9)', () => {
    const care = () => [
      ...sections,
      serverSection('duplicates', 'Duplicates'),
      serverSection('integrity', 'File checks'),
    ];

    it("takes one check's list back to File checks on the page it was opened from", () => {
      open('/user-settings?area=maintenance&section=integrity&report=missing_file');
      render(SettingsHost, { sections: care() });

      expect(screen.getByRole('link', { name: 'File checks' })).toHaveAttribute(
        'href',
        '/user-settings?area=maintenance&section=integrity',
      );
      expect(screen.queryByRole('link', { name: 'Maintenance' })).toBeNull();
    });

    it('takes File checks itself back to its area', () => {
      open('/user-settings?area=maintenance&section=integrity');
      render(SettingsHost, { sections: care() });

      expect(screen.getByRole('link', { name: 'Maintenance' })).toHaveAttribute(
        'href',
        '/user-settings?area=maintenance',
      );
    });
  });

  it('opens Storage & originals and Import & export on landing pages, and Deleted items at its old addresses (FL-365)', () => {
    for (const area of ['storage', 'backup']) {
      open(`/user-settings?area=${area}`);
      const { container, unmount } = render(SettingsHost, { sections });
      expect(container.querySelector('.cc-directory')).toBeNull();
      unmount();
    }
    open('/user-settings?area=storage&section=user-settings');
    const { container } = render(SettingsHost, { sections });
    expect(container.querySelector('#setting-trash')).not.toBeNull();
    expect(container.querySelector('#setting-trash')).toHaveClass('cc-manager');
  });

  it('names the server as its administrator set it, and never shows its host and port (CC-4)', () => {
    open('/user-settings?area=storage');
    serverConfig.value.serverName = 'Home archive';
    const { unmount } = render(SettingsHost, { sections });
    expect(document.querySelector('.cc-context')).toHaveTextContent('Home archive');
    unmount();

    serverConfig.value.serverName = '  ';
    render(SettingsHost, { sections });
    expect(document.querySelector('.cc-context')).toHaveTextContent('This server');
    expect(document.querySelector('.cc-context')).not.toHaveTextContent('localhost');
  });

  it('keeps the Viewing scope when moving between areas', async () => {
    open('/user-settings?area=storage&scope=user%3Aada');
    render(SettingsHost, { sections });
    await userEvent.click(screen.getByRole('button', { name: 'Library analytics' }));
    expect(state.goto).toHaveBeenCalledWith('/user-settings?area=analytics&scope=user%3Aada', expect.any(Object));
  });

  it('notes that queues filter by account when a library is the Viewing scope (CommandCenter.jsx:772-779)', async () => {
    open('/user-settings?area=processing&section=queues&scope=library%3Al1');
    render(SettingsHost, { sections });

    expect(
      await screen.findByText('Jobs are filtered by account, so this view includes every library owned by Ada.'),
    ).toBeInTheDocument();
  });

  it('opens a section an older isOpen link names, and a bare key as the account section', async () => {
    open('/user-settings?area=notifications&section=notifications&isOpen=notifications');
    const { unmount } = render(SettingsHost, { sections });
    expect(screen.getByRole('heading', { level: 1, name: 'Email delivery' })).toBeInTheDocument();
    unmount();
    open('/user-settings?isOpen=notifications');
    render(SettingsHost, { sections });
    expect(screen.getByRole('heading', { level: 1, name: 'Your email notifications' })).toBeInTheDocument();
  });

  it('opens the sign-in provider section when the provider returns to the page', () => {
    open('/user-settings?code=abc&state=xyz');
    render(SettingsHost, { sections });
    expect(screen.getByRole('heading', { level: 1, name: 'Sign-in provider' })).toBeInTheDocument();
  });

  it('offers an account without administration only its own areas and sections', () => {
    open('/user-settings?area=storage', false);
    render(SettingsHost, { sections: sections.filter((section) => !section.admin) });
    expect(areaNames()).toEqual([
      'Import & export',
      'People & sharing',
      // Library care always lists the repair tools the account may run.
      'Library care',
      'Utilities',
      'Trash',
      'Notifications',
      'Your preferences',
      'Your sign-in & privacy',
      'Change history',
    ]);
    // A server area falls back to the first area the account may open.
    expect(screen.getByRole('button', { name: 'Import & export' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('button', { name: /Backup schedule/ })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Account or library scope' })).toBeNull();
    expect(screen.getByText('Ada’s library')).toBeInTheDocument();
  });

  it('shows an account without administration its own preference history (FL-71 CC-10)', async () => {
    open('/user-settings?area=history', false);
    render(SettingsHost, { sections: sections.filter((section) => !section.admin) });

    // In the words on the page the change came from, with the page named (FL-368).
    expect(await screen.findByText('Tags turned on')).toBeInTheDocument();
    expect(screen.getByText(/· Ada · iOS · Mobile$/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open this setting' })).toHaveAttribute(
      'href',
      '/user-settings?area=preferences&section=feature',
    );
    expect(screen.getByText('Every change you saved to your own settings: what changed and when.')).toBeInTheDocument();
  });

  it('searches areas, sections and utility tools, and clears an empty search', async () => {
    open('/user-settings?area=storage');
    render(SettingsHost, { sections });
    const search = screen.getByRole('searchbox', { name: 'Search all settings' });
    await userEvent.type(search, 'email');
    // The Notifications area also mentions email delivery in its description; this is the page itself.
    const result = (await screen.findAllByRole('button', { name: /Email delivery/ })).find(
      (button) => button.querySelector('strong')?.textContent === 'Email delivery',
    )!;
    await userEvent.click(result);
    expect(state.goto).toHaveBeenCalledWith(
      '/user-settings?area=notifications&section=notifications',
      expect.any(Object),
    );
    await userEvent.type(search, 'zzzz');
    expect(await screen.findByText('No settings found')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(search).toHaveValue('');
  });

  it('finds a section by a setting it holds: the Public server URL lands in Remote access (FL-168)', async () => {
    open('/user-settings?area=storage');
    render(SettingsHost, { sections });
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search all settings' }), 'public server url');
    await userEvent.click(await screen.findByRole('button', { name: /Remote access/ }));
    expect(state.goto).toHaveBeenCalledWith('/user-settings?area=cloud&section=cloud-remote', expect.any(Object));
  });

  it('keeps the Libraries manager and its settings together without a directory', () => {
    open('/user-settings?area=libraries&isOpen=library-watch');
    render(SettingsHost, { sections });
    expect(screen.getByRole('button', { name: 'Watch library' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });

  describe('the Viewing scope (design review finding 65)', () => {
    it('offers the picker only where the page reads it', async () => {
      open('/user-settings?area=analytics');
      const { unmount } = render(SettingsHost, { sections });
      expect(await screen.findByRole('combobox', { name: 'Account or library scope' })).toBeInTheDocument();
      unmount();

      open('/user-settings?area=processing&section=queues');
      const jobs = render(SettingsHost, { sections });
      expect(await screen.findByRole('combobox', { name: 'Account or library scope' })).toBeInTheDocument();
      jobs.unmount();

      open('/user-settings?area=storage');
      render(SettingsHost, { sections });
      expect(await screen.findByText('Applies to the whole server')).toBeInTheDocument();
      expect(screen.queryByRole('combobox', { name: 'Account or library scope' })).toBeNull();
    });

    it('says a page of the account’s own applies to the account', async () => {
      open('/user-settings?area=preferences&section=account');
      render(SettingsHost, { sections });
      expect(await screen.findByText('Applies to your account')).toBeInTheDocument();
    });

    it('does not claim a queue filter on pages that do not apply one', async () => {
      open('/user-settings?area=utilities&scope=library%3Al1');
      render(SettingsHost, { sections });
      await screen.findByText('Applies to your account');
      expect(screen.queryByText(/Jobs are filtered by account/)).toBeNull();
    });
  });

  it("marks the page on screen while one of the account's own preference forms has changes (finding 70)", async () => {
    open('/user-settings?area=backups');
    const { container } = render(SettingsHost, { sections });
    expect(container.querySelector('.pending')).toBeNull();

    const release = ownPreferencesPending.hold();
    try {
      await waitFor(() => expect(container.querySelector(':scope .area.selected .pending')).not.toBeNull());
      expect(container.querySelectorAll('.pending')).toHaveLength(1);
    } finally {
      release();
    }
    await waitFor(() => expect(container.querySelector('.pending')).toBeNull());
  });

  describe('one Backup area (FL-362, after design review finding 66)', () => {
    const backupHeading = () => screen.getByRole('heading', { level: 1, name: 'Backup' });

    it('opens on the Overview, under the one Backup heading and with no pages in the navigation', () => {
      open('/user-settings?area=backups');
      render(SettingsHost, { sections });
      expect(backupHeading()).toBeInTheDocument();
      expect(backupPage()).toBe('overview');
      const navigation = within(screen.getByRole('navigation', { name: 'Settings navigation' }));
      expect(navigation.queryByLabelText('Backup pages')).toBeNull();
    });

    it.each([
      ['schedule', 'schedule'],
      ['restore', 'restore'],
      ['cloud', 'cloud'],
      ['buddy', 'buddy'],
      ['local', 'local'],
      ['nonsense', 'overview'],
    ])('opens the %s page from its address', (section, shown) => {
      open(`/user-settings?area=backups&section=${section}`);
      render(SettingsHost, { sections });
      expect(backupPage()).toBe(shown);
    });

    it.each([
      ['/user-settings?area=backup&section=backup', 'schedule', 'Import & export'],
      ['/user-settings?area=maintenance&section=backups', 'local', 'Maintenance'],
      ['/user-settings?area=cloud&section=cloud-backup', 'cloud', 'Frameleaf Cloud'],
    ])('shows %s under Backup, at the address it always had', (address, shown, formerArea) => {
      open(address);
      render(SettingsHost, { sections });
      expect(areaButton('Backup')).toHaveAttribute('aria-current', 'page');
      expect(screen.getByRole('button', { name: formerArea })).not.toHaveAttribute('aria-current');
      // One screen, one heading: the older page's own title is not a breadcrumb any more.
      expect(backupHeading()).toBeInTheDocument();
      expect(backupPage()).toBe(shown);
    });

    it.each([
      ['status', 'overview'],
      ['cloud', 'cloud'],
      ['controls', 'buddy'],
      ['restore', 'restore'],
      ['compare', 'overview'],
    ])('opens the page that replaced the "%s" view', (view, shown) => {
      open(`/user-settings?area=backups&backupView=${view}`);
      render(SettingsHost, { sections });
      expect(backupPage()).toBe(shown);
    });

    it('no longer lists a backup page under Import & protection, Maintenance or Frameleaf Cloud', () => {
      for (const area of ['backup', 'maintenance', 'cloud']) {
        open(`/user-settings?area=${area}`);
        const { container, unmount } = render(SettingsHost, { sections });
        // Maintenance opens on its own landing page (FL-366), which links to the one Backup page.
        const page = within(container.querySelector<HTMLElement>('.cc-directory') ?? container);
        expect(page.queryByRole('button', { name: /Backup schedule|Backups & restore|Cloud backup/ })).toBeNull();
        unmount();
      }
    });

    it('finds the schedule from search under Backup', async () => {
      open('/user-settings?area=storage');
      render(SettingsHost, { sections });
      await userEvent.type(screen.getByRole('searchbox', { name: 'Search all settings' }), 'schedule');
      const result = await screen.findByRole('button', { name: /Backup schedule/ });
      expect(result.querySelector('small')).toHaveTextContent('Backup');
      await userEvent.click(result);
      expect(state.goto).toHaveBeenCalledWith('/user-settings?area=backup&section=backup', expect.any(Object));
    });
  });

  it('keeps a repair tool opened from Library care under Library care', () => {
    open('/user-settings?area=utilities&section=duplicates&from=care');
    render(SettingsHost, { sections });
    expect(screen.getByRole('button', { name: 'Library care' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Utilities' })).not.toHaveAttribute('aria-current');
  });

  it('walks search results with the arrow keys and opens the first with Enter', async () => {
    open('/user-settings?area=storage');
    render(SettingsHost, { sections });
    const search = screen.getByRole('searchbox', { name: 'Search all settings' });
    await userEvent.type(search, 'email');
    const [first] = await screen.findAllByRole('button', { name: /Email delivery/ });
    await userEvent.keyboard('{ArrowDown}');
    expect(first.parentElement!.querySelector('button')).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    expect(search).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(state.goto).toHaveBeenCalled();
  });

  it('does not badge Change history with a count of every saved change', () => {
    open('/user-settings?area=storage');
    render(SettingsHost, { sections });
    expect(screen.getByRole('button', { name: 'Change history' }).querySelector('.count')).toBeNull();
  });

  it('opens on the Overview for an administrator, as the rail Settings does in the template', () => {
    open('/user-settings');
    render(SettingsHost, { sections });
    expect(screen.getByRole('button', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
    expect(areaNames()[0]).toBe('Overview');
  });

  it('opens Users and Trash on their one section, leaving the headings to the managers that carry them', () => {
    open('/user-settings?area=users');
    const { unmount } = render(SettingsHost, { sections });
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.getByLabelText('Users pages')).toBeInTheDocument();
    unmount();
    open('/user-settings?area=trash');
    const { container } = render(SettingsHost, { sections });
    expect(container.querySelector('#setting-contents')).not.toBeNull();
    // As in the template, Trash lists no pages under it in the navigation.
    expect(screen.queryByLabelText('Trash pages')).toBeNull();
  });

  it('gives an account without administration its own sharing and Trash but none of the server pages', () => {
    open('/user-settings?area=users', false);
    render(SettingsHost, { sections: sections.filter((section) => !section.admin) });
    const names = areaNames();
    expect(names).toContain('People & sharing');
    expect(names).toContain('Trash');
    expect(names).not.toContain('Users');
    expect(names).not.toContain('Overview');
    expect(names).not.toContain('Computers & background work');
  });
});
