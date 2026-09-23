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
vi.mock('$lib/components/frameleaf/analytics/AnalyticsArea.svelte', async () => ({
  default: (await import('../../../../test-data/components/MockText.svelte')).default,
}));
vi.mock('$lib/components/frameleaf/settings/UtilitiesArea.svelte', async () => ({
  default: (await import('../../../../test-data/components/MockText.svelte')).default,
}));
vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  getAdminConfigHistory: vi.fn().mockResolvedValue({ entries: [] }),
  getAnalyticsScopes: vi.fn().mockResolvedValue({
    scopes: [
      { kind: 'host', value: 'all', label: '', libraryId: null, removed: false, userId: null },
      { kind: 'account', value: 'user:ada', label: 'Ada', libraryId: null, removed: false, userId: 'ada' },
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
  accountSection('account', 'Your profile'),
  accountSection('takeout', 'Google Photos imports'),
  accountSection('email-preferences', 'Your email notifications'),
  accountSection('oauth', 'Sign-in provider'),
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

  it('keeps the Viewing scope when moving between areas', async () => {
    open('/user-settings?area=storage&scope=user%3Aada');
    render(SettingsHost, { sections });
    await userEvent.click(screen.getByRole('button', { name: 'Library analytics' }));
    expect(state.goto).toHaveBeenCalledWith('/user-settings?area=analytics&scope=user%3Aada', expect.any(Object));
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
      'Utilities',
      'Access & security',
      'Notifications',
      'Your preferences',
    ]);
    // A server area falls back to the first area the account may open.
    expect(screen.getByRole('button', { name: 'Import & protection' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('button', { name: /Database backups/ })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Account or library scope' })).toBeNull();
    expect(screen.getByText('Ada’s library')).toBeInTheDocument();
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
});
