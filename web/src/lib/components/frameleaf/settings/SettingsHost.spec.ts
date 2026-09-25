import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { addMessages } from 'svelte-i18n';
import { SvelteURL } from 'svelte/reactivity';
import type { SettingsHostSection } from '$lib/frameleaf/settings-areas';
import en from '../../../../../../i18n/en.json';
import MockText from '../../../../test-data/components/MockText.svelte';
import SettingsLibraryGroup from '../../../../test-data/frameleaf/SettingsLibraryGroup.svelte';
import SettingsHost from './SettingsHost.svelte';

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
vi.mock('$lib/components/frameleaf/settings/UtilitiesArea.svelte', async () => ({
  default: (await import('../../../../test-data/components/MockText.svelte')).default,
}));
vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
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

const serverSection = (key: string, title: string): SettingsHostSection => ({
  key,
  title,
  subtitle: `${title} help`,
  icon: '',
  admin: true,
  component: key === 'external-library' ? SettingsLibraryGroup : MockText,
});
const accountSection = (key: string, title: string): SettingsHostSection => ({
  key,
  title,
  subtitle: `${title} help`,
  icon: '',
});

const sections = [
  serverSection('storage-template', 'Storage template'),
  serverSection('trash', 'Trash settings'),
  serverSection('backup', 'Database backups'),
  serverSection('integrity-checks', 'Integrity checks'),
  serverSection('external-library', 'External libraries'),
  serverSection('notifications', 'Email delivery'),
  serverSection('queues', 'Job manager'),
  serverSection('accounts', 'People with server access'),
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

describe('the Command Center (FL-71)', () => {
  beforeAll(() => addMessages('dev', en));

  it('is one full-screen shell with Back to library, collapse, the Viewing scope and the grouped areas', async () => {
    open('/user-settings?area=storage');
    render(SettingsHost, { sections });
    expect(screen.getByRole('link', { name: 'Back to library' })).toHaveAttribute('href', '/photos');
    expect(screen.getByRole('button', { name: 'Collapse settings navigation' })).toBeInTheDocument();
    expect(await screen.findByRole('combobox', { name: 'Account or library scope' })).toBeInTheDocument();
    expect(screen.getByText('Administrator')).toBeInTheDocument();
    const names = areaNames();
    // The template's catalogue order, grouped: Your library keeps care, libraries, utilities (N1).
    expect(names.slice(names.indexOf('Library care'), names.indexOf('Utilities') + 1)).toEqual([
      'Library care',
      'Libraries',
      'Utilities',
    ]);
    expect(names.at(-2)).toBe('Your preferences');
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
    expect(tile('Import & protection')).toBe('#30b0c7');
    expect(tile('Library care')).toBe('#30d158');
    expect(tile('Notifications')).toBe('#ff453a');
    for (const button of screen
      .getByRole('navigation', { name: 'Settings navigation' })
      .querySelectorAll('button.area')) {
      expect(button.querySelector(':scope .tile svg')).not.toBeNull();
    }
  });

  it('shows an area as a section directory and one section at a time with its breadcrumb', async () => {
    open('/user-settings?area=storage');
    const { container } = render(SettingsHost, { sections });
    expect(screen.getByRole('heading', { level: 1, name: 'Storage & originals' })).toBeInTheDocument();
    expect(container.querySelector('.cc-section')).toBeNull();
    await userEvent.click(
      within(container.querySelector<HTMLElement>('.cc-directory')!).getByRole('button', { name: /Trash settings/ }),
    );
    expect(state.goto).toHaveBeenCalledWith('/user-settings?area=storage&section=trash', expect.any(Object));

    state.url.searchParams.set('section', 'trash');
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Trash settings' })).toBeInTheDocument());
    expect(container.querySelector('#setting-trash')).not.toBeNull();
    expect(container.querySelector('#setting-storage-template')).toBeNull();
    const pages = screen.getByLabelText('Storage & originals pages');
    expect(within(pages).getByRole('button', { name: 'Trash settings' })).toHaveAttribute('aria-current', 'page');
    // The breadcrumb returns to the directory.
    const breadcrumb = screen.getByRole('heading', { level: 1 }).parentElement!;
    await userEvent.click(within(breadcrumb).getByRole('button', { name: 'Storage & originals' }));
    expect(state.goto).toHaveBeenLastCalledWith('/user-settings?area=storage', expect.any(Object));
  });

  it('draws an area directory as grouped lists without repeated icons (FL-71, FL-10)', () => {
    open('/user-settings?area=storage');
    const { container } = render(SettingsHost, { sections });
    const directory = container.querySelector<HTMLElement>('.cc-directory')!;
    expect(
      within(directory)
        .getAllByRole('heading', { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(['Storage', 'Trash']);
    // Only the chevron: no area icon repeated on every row.
    for (const row of within(directory).getAllByRole('button')) {
      expect(row.querySelectorAll('svg')).toHaveLength(1);
    }
    // Every row is a server setting, like the area, so none carries a scope tag.
    expect(directory.querySelector('.cc-directory-scope')).toBeNull();
  });

  it('tags only the rows whose scope differs from the rest of the area', () => {
    open('/user-settings?area=notifications');
    const { container } = render(SettingsHost, { sections });
    const directory = container.querySelector<HTMLElement>('.cc-directory')!;
    const tags = [...directory.querySelectorAll('.cc-directory-scope')].map((tag) => tag.textContent);
    expect(tags).toEqual(['Just you']);
    expect(within(directory).getByRole('button', { name: /Your email notifications/ })).toHaveTextContent('Just you');
    expect(within(directory).getByRole('button', { name: /Email delivery/ })).not.toHaveTextContent('Just you');
  });

  it("lists Library care's repair tools after its sections", async () => {
    open('/user-settings?area=care');
    const { container } = render(SettingsHost, { sections });
    const directory = container.querySelector<HTMLElement>('.cc-directory')!;
    expect(within(directory).getByRole('heading', { level: 2, name: 'Tools' })).toBeInTheDocument();
    await userEvent.click(within(directory).getByRole('button', { name: /Missing media/ }));
    expect(state.goto).toHaveBeenCalledWith('/user-settings?area=utilities&section=missing-media', expect.any(Object));
  });

  it('lists all four repair tools for an administrator, in the Utilities order', () => {
    open('/user-settings?area=care');
    const { container } = render(SettingsHost, { sections });
    const tools = within(container.querySelector<HTMLElement>('.cc-directory')!)
      .getByRole('heading', { level: 2, name: 'Tools' })
      .closest('section')!;
    expect([...tools.querySelectorAll(':scope button strong')].map((title) => title.textContent)).toEqual([
      'Duplicate review',
      'Live Photo pairing',
      'Missing media',
      'Damaged media',
    ]);
  });

  it('lists only the repair tools an account without administration may run', () => {
    open('/user-settings?area=care', false);
    const { container } = render(SettingsHost, {
      sections: [...sections.filter((section) => !section.admin), accountSection('repair', 'Repair queues')],
    });
    const tools = within(container.querySelector<HTMLElement>('.cc-directory')!)
      .getByRole('heading', { level: 2, name: 'Tools' })
      .closest('section')!;
    expect([...tools.querySelectorAll(':scope button strong')].map((title) => title.textContent)).toEqual([
      'Duplicate review',
      'Live Photo pairing',
    ]);
  });

  it('does not repeat a page name that matches its area in the overline', () => {
    open('/user-settings?area=trash');
    render(SettingsHost, { sections });
    const heading = screen.getByRole('heading', { level: 1, name: 'Trash' }).parentElement!;
    expect(within(heading).queryByRole('button', { name: 'Trash' })).toBeNull();
    expect(heading.querySelector('.cc-overline')).toHaveTextContent('Your library');
  });

  it('gives administration tools the page width without a card around their own grouped containers', () => {
    open('/user-settings?area=processing&section=render-workers');
    const { container } = render(SettingsHost, {
      sections: [...sections, serverSection('render-workers', 'Render workers')],
    });
    expect(container.querySelector('#setting-render-workers')).toHaveClass('cc-manager');
  });

  it('keeps an ordinary settings page as one grouped list', () => {
    open('/user-settings?area=storage&section=trash');
    const { container } = render(SettingsHost, { sections });
    expect(container.querySelector('#setting-trash')).not.toHaveClass('cc-manager');
  });

  it("links Storage → Trash & retention to the account's own trash", async () => {
    open('/user-settings?area=storage&section=trash');
    render(SettingsHost, { sections });
    await userEvent.click(screen.getByRole('button', { name: 'Open your trash' }));
    expect(state.goto).toHaveBeenCalledWith('/user-settings?area=trash&section=contents', expect.any(Object));
  });

  it('names the server as its administrator set it, and falls back to its address (CC-4, CommandCenter.jsx:657)', () => {
    open('/user-settings?area=storage');
    serverConfig.value.serverName = 'Home archive';
    const { unmount } = render(SettingsHost, { sections });
    expect(document.querySelector('.cc-context')).toHaveTextContent('Home archive');
    unmount();

    serverConfig.value.serverName = '  ';
    render(SettingsHost, { sections });
    expect(document.querySelector('.cc-context')).toHaveTextContent('localhost');
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
      await screen.findByText(
        'Job and utility queues are filtered by account. This view includes all libraries owned by Ada.',
      ),
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
      'Import & protection',
      'People & sharing',
      'Utilities',
      'Trash',
      'Access & security',
      'Notifications',
      'Your preferences',
      'Change history',
    ]);
    // A server area falls back to the first area the account may open.
    expect(screen.getByRole('button', { name: 'Import & protection' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('button', { name: /Database backups/ })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Account or library scope' })).toBeNull();
    expect(screen.getByText('Ada’s library')).toBeInTheDocument();
  });

  it('shows an account without administration its own preference history (FL-71 CC-10)', async () => {
    open('/user-settings?area=history', false);
    render(SettingsHost, { sections: sections.filter((section) => !section.admin) });

    expect(await screen.findByText('1 preference changed')).toBeInTheDocument();
    expect(screen.getByText('Ada · iOS · Mobile')).toBeInTheDocument();
  });

  it('searches areas, sections and utility tools, and clears an empty search', async () => {
    open('/user-settings?area=storage');
    render(SettingsHost, { sections });
    const search = screen.getByRole('searchbox', { name: 'Search all settings' });
    await userEvent.type(search, 'email');
    const result = await screen.findByRole('button', { name: /Email delivery/ });
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

  it('keeps the Libraries manager and its settings together without a directory', () => {
    open('/user-settings?area=libraries&isOpen=library-watch');
    render(SettingsHost, { sections });
    expect(screen.getByRole('button', { name: 'Watch library' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
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
    expect(names).not.toContain('Compute & jobs');
  });
});
