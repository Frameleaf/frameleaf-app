import { searchAssets, type SearchResponseDto } from '@immich/sdk';
import { render, screen, waitFor, fireEvent } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { searchManager } from '$lib/managers/search-manager.svelte';
import { Route } from '$lib/route';
import SearchPage from './+page.svelte';

const navigation = vi.hoisted(() => ({ goto: vi.fn(), afterNavigate: vi.fn() }));
const state = $state({
  url: new URL('http://localhost/search'),
  route: { id: '/(user)/search/[[photos=photos]]/[[assetId=id]]' },
  params: {},
});
vi.mock('$app/navigation', () => navigation);
vi.mock('$app/state', () => ({
  get page() {
    return state;
  },
}));
vi.mock('@immich/sdk', async (original) => ({ ...(await original<object>()), searchAssets: vi.fn() }));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({ featureFlagsManager: { value: {} } }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: { authenticated: false, preferences: { tags: { enabled: false } } },
}));
vi.mock('$lib/components/shared-components/search-bar/SearchBar.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/shared-components/gallery-viewer/GalleryViewer.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/shared-components/ControlAppBar.svelte', () => ({ default: () => {} }));
vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));

const empty = { assets: { items: [], nextPage: null }, albums: { items: [] } } as unknown as SearchResponseDto;
const setQuery = (terms: Parameters<typeof Route.search>[0]) => {
  state.url = new URL(Route.search(terms), 'http://localhost');
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(searchAssets).mockResolvedValue(empty);
  searchManager.reset();
});

it('restores deep-linked and browser-history filters into both results and the editable search', async () => {
  setQuery({ originalFileName: 'first', city: 'Banff' });
  const view = render(SearchPage);
  await waitFor(() => expect(searchManager.filter.query).toBe('first'));
  expect(searchManager.filter.location.city).toBe('Banff');
  expect(searchAssets).toHaveBeenLastCalledWith(
    { metadataSearchDto: expect.objectContaining({ originalFileName: 'first', city: 'Banff' }) },
    expect.anything(),
  );
  flushSync(() => setQuery({ originalFileName: 'second', city: 'Jasper' }));
  await waitFor(() => expect(searchManager.filter.query).toBe('second'));
  flushSync(() => setQuery({ originalFileName: 'first', city: 'Banff' }));
  await waitFor(() => expect(searchManager.filter.query).toBe('first'));
  expect(searchManager.filter.location.city).toBe('Banff');
  expect(searchAssets).toHaveBeenCalledTimes(3);
  view.unmount();
});

it('keeps zero-result filters visible and removable through the production route', async () => {
  setQuery({ city: 'No matches' });
  const view = render(SearchPage);
  await screen.findByText('no_results');
  await fireEvent.click(screen.getByRole('button', { name: 'remove_filter' }));
  expect(navigation.goto).toHaveBeenCalledWith('/search');
  expect(searchManager.filter.location.city).toBeUndefined();
  view.unmount();
});

it('preserves the current query when opening media and aborts requests when leaving search', async () => {
  let resolve!: (value: SearchResponseDto) => void;
  vi.mocked(searchAssets).mockReturnValueOnce(
    new Promise<SearchResponseDto>((done) => {
      resolve = done;
    }),
  );
  setQuery({ city: 'Banff' });
  const view = render(SearchPage);
  await waitFor(() => expect(searchAssets).toHaveBeenCalledOnce());
  const signal = vi.mocked(searchAssets).mock.calls[0][1]?.signal;
  const viewerUrl = new URL(state.url);
  viewerUrl.pathname = '/search/photos/asset';
  flushSync(() => {
    state.url = viewerUrl;
  });
  expect(signal?.aborted).toBe(false);
  expect(searchAssets).toHaveBeenCalledOnce();
  view.unmount();
  expect(signal?.aborted).toBe(true);
  resolve(empty);
});
