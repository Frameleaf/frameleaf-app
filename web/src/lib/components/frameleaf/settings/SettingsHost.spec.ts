import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { addMessages } from 'svelte-i18n';
import { SvelteURL } from 'svelte/reactivity';
import en from '../../../../../../i18n/en.json';
import SettingsLibraryGroup from '../../../../test-data/frameleaf/SettingsLibraryGroup.svelte';
import SettingsHost from './SettingsHost.svelte';

const state = vi.hoisted(() => ({
  url: new URL('http://localhost/admin/system-settings?area=libraries'),
  goto: vi.fn(),
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
  authManager: { user: { id: 'me', isAdmin: true }, params: {} },
}));
vi.mock('$lib/frameleaf/system-config-draft.svelte', () => ({ getSystemConfigDraft: () => undefined }));
vi.mock('$lib/components/frameleaf/analytics/AnalyticsArea.svelte', async () => ({
  default: (await import('../../../../test-data/components/MockText.svelte')).default,
}));

describe('Command Center area navigation', () => {
  beforeAll(() => addMessages('dev', en));
  it('keeps the requested area after delayed navigation destroys the Libraries groups and follows history', async () => {
    state.url = new SvelteURL('http://localhost/admin/system-settings?area=libraries&isOpen=library-watch');
    let complete!: () => void;
    state.goto.mockReset().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    render(SettingsHost, {
      sections: [
        {
          key: 'external-library',
          title: 'External libraries',
          subtitle: '',
          icon: '',
          component: SettingsLibraryGroup,
        },
      ],
    });
    const libraries = screen.getByRole('button', { name: 'Libraries' });
    const analytics = screen.getByRole('button', { name: 'Library analytics' });
    expect(libraries).toHaveAttribute('aria-current', 'page');
    await userEvent.click(analytics);
    expect(state.goto).toHaveBeenCalledOnce();
    expect(state.goto).toHaveBeenCalledWith(
      '/admin/system-settings?area=analytics&isOpen=library-watch',
      expect.any(Object),
    );
    expect(libraries).toHaveAttribute('aria-current', 'page');
    state.url.searchParams.set('area', 'analytics');
    complete();
    await waitFor(() => expect(analytics).toHaveAttribute('aria-current', 'page'));
    expect(state.goto).toHaveBeenCalledOnce();
    state.url.searchParams.set('area', 'libraries');
    await waitFor(() => expect(libraries).toHaveAttribute('aria-current', 'page'));
    expect(screen.getByRole('button', { name: 'Watch library' })).toHaveAttribute('aria-expanded', 'true');
    expect(state.goto).toHaveBeenCalledOnce();
  });
  it('lists the library areas in the prototype order and opens utilities on their single host', async () => {
    state.url = new SvelteURL('http://localhost/admin/system-settings?area=storage');
    state.goto.mockReset().mockResolvedValue(undefined);
    render(SettingsHost, { sections: [] });
    const nav = screen.getByRole('navigation', { name: 'Settings navigation' });
    const names = [...nav.querySelectorAll('button.area')].map((button) => button.textContent?.trim());
    expect(names.slice(names.indexOf('Library care'), names.indexOf('Utilities') + 1)).toEqual([
      'Library care',
      'Libraries',
      'Utilities',
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'Utilities' }));
    expect(state.goto).toHaveBeenCalledWith('/user-settings?area=utilities', expect.any(Object));
  });
});
