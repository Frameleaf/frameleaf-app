import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { addMessages } from 'svelte-i18n';
import { SvelteURL } from 'svelte/reactivity';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
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
    expect(screen.queryByRole('button', { name: /Missing files/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Mobile apps/ })).toBeInTheDocument();
    expect(state.load).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /Duplicate review/ }));
    expect(state.goto).toHaveBeenCalledWith('/user-settings?area=utilities&section=duplicates', expect.any(Object));
  });
  it('opens on what needs a look, with those tools first and the rare ones under Advanced (FL-519)', async () => {
    state.user = { id: 'me', isAdmin: true };
    sdkMock.getUtilitiesSummary.mockResolvedValue({
      duplicateGroups: 12,
      withoutPlace: 214,
      missingFiles: 3,
      damagedFiles: 0,
      unusedFiles: 86,
      unusedBytes: 410_000_000,
    });
    render(UtilitiesArea);

    expect(await screen.findByRole('heading', { name: '2 tools have something for you' })).toBeInTheDocument();
    const first = screen.getByRole('heading', { name: 'Needs a look' }).nextElementSibling as HTMLElement;
    expect(first).toHaveTextContent('Duplicate review');
    expect(first).toHaveTextContent('12 groups to look at');
    expect(first).toHaveTextContent('3 files missing');
    expect(screen.getByRole('button', { name: /Fix locations/ })).toHaveTextContent('214 photos have no place');
    expect(screen.getByText('Advanced: Android direct updates').closest('details')).not.toHaveAttribute('open');
  });

  it('says nothing needs a look when every tool is calm (FL-519)', async () => {
    sdkMock.getUtilitiesSummary.mockResolvedValue({
      duplicateGroups: 0,
      withoutPlace: 0,
      missingFiles: null,
      damagedFiles: null,
      unusedFiles: null,
      unusedBytes: null,
    });
    render(UtilitiesArea);

    expect(await screen.findByRole('heading', { name: 'Nothing needs a look' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Needs a look' })).toBeNull();
  });

  it('shows each tool’s icon in the directory (UT-12)', () => {
    render(UtilitiesArea);
    for (const name of [/Duplicate review/, /Large files/, /Mobile apps/]) {
      expect(screen.getByRole('button', { name }).querySelector('svg')).not.toBeNull();
      // The icon comes first, before the title, then the chevron.
      expect(screen.getByRole('button', { name }).querySelectorAll('svg')).toHaveLength(2);
    }
  });
  it('keeps an admin on the single utilities host', async () => {
    state.user.isAdmin = true;
    render(UtilitiesArea);
    await userEvent.click(screen.getByRole('button', { name: /Missing files/ }));
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
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('This tool could not be loaded'));
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
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
