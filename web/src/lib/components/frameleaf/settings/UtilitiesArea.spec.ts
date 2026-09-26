import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { addMessages } from 'svelte-i18n';
import { SvelteURL } from 'svelte/reactivity';
import UtilitiesArea from '$lib/components/frameleaf/settings/UtilitiesArea.svelte';
import en from '../../../../../../i18n/en.json';

const state = vi.hoisted(() => ({
  url: new URL('http://localhost/user-settings?area=utilities'),
  user: { id: 'me', isAdmin: false },
  load: vi.fn(),
  goto: vi.fn(),
}));
vi.mock('$app/state', () => ({
  page: {
    get url() {
      return state.url;
    },
  },
}));
vi.mock('$app/navigation', () => ({ goto: state.goto }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: {
    get user() {
      return state.user;
    },
    params: {},
  },
}));
vi.mock('$lib/frameleaf/utilities-load', () => ({ loadUtility: state.load }));

describe('Utilities area', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    state.url = new SvelteURL('http://localhost/user-settings?area=utilities');
    state.user = { id: 'me', isAdmin: false };
    state.load.mockReset().mockReturnValue(new Promise(() => {}));
    state.goto.mockReset();
  });
  it('renders prototype grouped cards without loading a tool', async () => {
    render(UtilitiesArea);
    expect(screen.getByRole('heading', { name: 'Utilities' })).toBeInTheDocument();
    for (const name of ['Organize', 'Repair', 'Import', 'Automate', 'Connect']) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: /Missing media/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Mobile applications/ })).toBeInTheDocument();
    expect(state.load).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /Duplicate review/ }));
    expect(state.goto).toHaveBeenCalledWith('/user-settings?area=utilities&section=duplicates', expect.any(Object));
  });
  it('shows each tool’s icon in the directory (UT-12)', () => {
    render(UtilitiesArea);
    for (const name of [/Duplicate review/, /Large files/, /Mobile applications/]) {
      expect(screen.getByRole('button', { name }).querySelector('svg')).not.toBeNull();
      // The icon comes first, before the title, then the chevron.
      expect(screen.getByRole('button', { name }).querySelectorAll('svg')).toHaveLength(2);
    }
  });
  it('keeps an admin on the single utilities host', async () => {
    state.user.isAdmin = true;
    render(UtilitiesArea);
    await userEvent.click(screen.getByRole('button', { name: /Missing media/ }));
    expect(state.goto).toHaveBeenCalledWith('/user-settings?area=utilities&section=missing-media', expect.any(Object));
  });
  it('rejects a direct non-admin health tool selection without loading it', () => {
    state.url.searchParams.set('section', 'corrupt-media');
    render(UtilitiesArea);
    expect(screen.getByRole('alert')).toHaveTextContent('Administrator access');
    expect(state.load).not.toHaveBeenCalled();
  });
  it('shows the selected tool breadcrumb while loading and an actionable failure', async () => {
    state.url.searchParams.set('section', 'duplicates');
    state.load.mockRejectedValue(new Error('offline'));
    render(UtilitiesArea);
    expect(screen.getByRole('button', { name: 'Utilities' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not load this tool'));
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(state.load).toHaveBeenCalledTimes(2));
  });
  it('does not reload the tool when the photo viewer query changes', async () => {
    state.url.searchParams.set('section', 'duplicates');
    render(UtilitiesArea);
    await waitFor(() => expect(state.load).toHaveBeenCalledTimes(1));
    state.url.searchParams.set('assetId', 'photo');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.load).toHaveBeenCalledTimes(1);
  });
});
