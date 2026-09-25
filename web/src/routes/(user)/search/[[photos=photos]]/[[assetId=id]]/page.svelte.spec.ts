import { Mode, askSearch, searchAssets, searchSmart, type SearchResponseDto } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { discoveryUrl, emptyDiscoveryQuery } from '$lib/components/discovery/query';
import { Route } from '$lib/route';
import { handleError } from '$lib/utils/handle-error';
import { assetFactory } from '@test-data/factories/asset-factory';
import SearchPage from './+page.svelte';

const flags = $state({ search: true, smartSearch: false });
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
vi.mock('@immich/sdk', async (original) => ({
  ...(await original<object>()),
  searchAssets: vi.fn(),
  searchSmart: vi.fn(),
  askSearch: vi.fn(),
}));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: {
    get value() {
      return flags;
    },
  },
}));
vi.mock('$lib/components/frameleaf/ResultsView.svelte', async () => ({
  default: (await import('@test-data/frameleaf/SearchResults.svelte')).default,
}));
vi.mock('$lib/components/frameleaf/ResultsAssetViewer.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/frameleaf/VideoMomentResults.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/frameleaf/SearchEntry.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/shared-components/ControlAppBar.svelte', () => ({ default: () => {} }));
vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));
const result = (ids: string[], nextCursor: string | null = null) =>
  ({
    albums: { items: [], count: 0, total: 0, facets: [] },
    assets: {
      items: ids.map((id) => assetFactory.build({ id })),
      count: ids.length,
      total: ids.length,
      facets: [],
      nextPage: null,
      nextCursor,
    },
  }) as SearchResponseDto;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const setQuery = (terms: Parameters<typeof Route.search>[0]) => {
  state.url = new URL(Route.search(terms), 'http://localhost');
};
beforeEach(() => {
  vi.clearAllMocks();
  flags.smartSearch = false;
  state.url = new URL('http://localhost/search');
  vi.mocked(searchAssets).mockResolvedValue(result([]));
});

it('discards old metadata results/cursors after browser-history query replacement', async () => {
  const old = deferred<SearchResponseDto>();
  const current = deferred<SearchResponseDto>();
  vi.mocked(searchAssets).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  setQuery({ city: 'old' });
  render(SearchPage);
  await waitFor(() => expect(searchAssets).toHaveBeenCalledOnce());
  const signal = vi.mocked(searchAssets).mock.calls[0][1]?.signal;
  flushSync(() => setQuery({ city: 'new' }));
  await waitFor(() => expect(searchAssets).toHaveBeenCalledTimes(2));
  expect(signal?.aborted).toBe(true);
  old.resolve(result(['old'], 'obsolete'));
  await old.promise;
  expect(screen.queryByTestId('search-result')).toBeNull();
  current.resolve(result(['new']));
  await screen.findByText('new', { selector: '[data-testid="search-result"]' });
  expect(screen.getAllByTestId('search-result')).toHaveLength(1);
});

it('preserves structured cursor paging and the mounted result draft across an asset URL change', async () => {
  const pending = deferred<SearchResponseDto>();
  vi.mocked(searchAssets)
    .mockResolvedValueOnce(result(['first'], 'page-two'))
    .mockReturnValueOnce(pending.promise);
  const query = emptyDiscoveryQuery();
  query.filter = { city: { eq: 'Banff' } };
  state.url = new URL(discoveryUrl(query), 'http://localhost');
  const view = render(SearchPage);
  await screen.findByText('first', { selector: '[data-testid="search-result"]' });
  const draft = screen.getByRole('textbox', { name: 'Result draft' });
  await fireEvent.input(draft, { target: { value: 'unsaved' } });
  flushSync(() => {
    const next = new URL(state.url);
    next.pathname = '/search/photos/first';
    state.url = next;
  });
  expect(screen.getByRole('textbox', { name: 'Result draft' })).toBe(draft);
  expect((draft as HTMLInputElement).value).toBe('unsaved');
  expect(searchAssets).toHaveBeenCalledOnce();
  await fireEvent.click(screen.getByRole('button', { name: 'Load more results' }));
  expect(searchAssets).toHaveBeenLastCalledWith(
    {
      metadataSearchDto: expect.objectContaining({
        filter: { city: { eq: 'Banff' }, trashedAt: { eq: null }, visibility: { eq: 'timeline' } },
        cursor: 'page-two',
      }),
    },
    { signal: expect.any(AbortSignal) },
  );
  expect(vi.mocked(searchAssets).mock.calls[1][0].metadataSearchDto).not.toHaveProperty('page');
  const signal = vi.mocked(searchAssets).mock.calls[1][1]?.signal;
  view.unmount();
  expect(signal?.aborted).toBe(true);
  pending.resolve(result(['late']));
  await pending.promise;
});

it('shares ownership when metadata is replaced by Ask and ignores the old error', async () => {
  const old = deferred<SearchResponseDto>();
  vi.mocked(searchAssets).mockReturnValueOnce(old.promise);
  flags.smartSearch = true;
  setQuery({ city: 'old' });
  render(SearchPage);
  await waitFor(() => expect(searchAssets).toHaveBeenCalledOnce());
  vi.mocked(askSearch).mockResolvedValue({
    query: 'new',
    plan: { filters: {}, mode: Mode.Metadata, normalizedQuery: 'new' },
    explanation: 'new explanation',
    warnings: [],
    results: result(['ask-result']),
  });
  flushSync(() => {
    state.url = new URL('http://localhost/search?ask=new');
  });
  await screen.findByText('ask-result');
  old.reject(new Error('obsolete'));
  await waitFor(() => expect(screen.getAllByTestId('search-result')).toHaveLength(1));
  expect(handleError).not.toHaveBeenCalled();
});

it('replaces a text request when its endpoint capability changes, without resetting unrelated metadata', async () => {
  const old = deferred<SearchResponseDto>();
  vi.mocked(searchAssets).mockReturnValueOnce(old.promise);
  setQuery({ query: 'tree' });
  render(SearchPage);
  await waitFor(() => expect(searchAssets).toHaveBeenCalledOnce());
  vi.mocked(searchSmart).mockResolvedValue(result(['smart']));
  flushSync(() => {
    flags.smartSearch = true;
  });
  await screen.findByText('smart');
  old.resolve(result(['old']));
  await old.promise;
  expect(screen.getAllByTestId('search-result')).toHaveLength(1);
  flushSync(() => setQuery({ city: 'Banff' }));
  await screen.findByText('no_results');
  const count = vi.mocked(searchAssets).mock.calls.length;
  flushSync(() => {
    flags.smartSearch = false;
  });
  expect(searchAssets).toHaveBeenCalledTimes(count);
});

it('draws the palette-style chips on the results page and removes one condition at a time (SD-12)', async () => {
  const query = emptyDiscoveryQuery();
  query.text = 'IMG';
  query.filter = { city: { eq: 'Banff' }, isFavorite: { eq: true } };
  state.url = new URL(discoveryUrl(query), 'http://localhost');
  render(SearchPage);
  await waitFor(() => expect(document.querySelector('#search-chips')).not.toBeNull());
  const chips = document.querySelector('#search-chips')!;
  expect(chips).toHaveClass('frameleaf');
  expect(chips.querySelectorAll('.search-chip')).toHaveLength(3);
  const remove = [...chips.querySelectorAll(':scope .search-chip button')];
  expect(remove).toHaveLength(3);
  // Filter chips come first, in field order (city, isFavorite), then the text
  await fireEvent.click(remove[0]);
  const url = new URL(navigation.goto.mock.calls.at(-1)![0] as string, 'http://localhost');
  const next = JSON.parse(url.searchParams.get('dq')!);
  expect(next.filter).toEqual({ isFavorite: { eq: true } });
  expect(next.text).toBe('IMG');
});
