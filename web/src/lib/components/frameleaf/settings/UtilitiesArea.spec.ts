import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { addMessages } from 'svelte-i18n';
import { SvelteURL } from 'svelte/reactivity';
import '$lib/__mocks__/sdk.mock';
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
  it('sends the old Tools directory, or a tool that no longer exists, to Library care (FL-1807)', () => {
    render(UtilitiesArea);
    expect(state.goto).toHaveBeenCalledWith('/user-settings?area=care', { replaceState: true });
    expect(state.load).not.toHaveBeenCalled();

    state.goto.mockReset();
    state.url.searchParams.set('section', 'nonsense');
    render(UtilitiesArea);
    expect(state.goto).toHaveBeenCalledWith('/user-settings?area=care', { replaceState: true });
  });
  it('leads a tool back to its one home: Library care, or Import for the ways photos come in', async () => {
    state.url.searchParams.set('section', 'large-files');
    const { unmount } = render(UtilitiesArea);
    await userEvent.click(screen.getByRole('button', { name: 'Library care' }));
    expect(state.goto).toHaveBeenCalledWith('/user-settings?area=care');
    unmount();

    state.url.searchParams.set('section', 'icloud');
    render(UtilitiesArea);
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(state.goto).toHaveBeenCalledWith('/user-settings?area=backup');
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
    expect(screen.getByRole('button', { name: 'Library care' })).toBeInTheDocument();
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
