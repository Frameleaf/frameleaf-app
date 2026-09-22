import {
  searchAssets,
  searchSmart,
  askSearch,
  AssetOrder,
  SearchOrderField,
  Mode2,
  type AskSearchResponseDto,
  deleteAssets,
  restoreAssets,
  getPerson,
  type PersonResponseDto,
  type SearchResponseDto,
} from '@immich/sdk';
import { toastManager } from '@immich/ui';
import { render, screen, waitFor, fireEvent } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { flushSync } from 'svelte';
import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { searchManager } from '$lib/managers/search-manager.svelte';
import { Route } from '$lib/route';
import { assetFactory, timelineAssetFactory } from '@test-data/factories/asset-factory';
import SearchPage from './+page.svelte';

const flags = $state({ trash: true, search: true, smartSearch: false });
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
  deleteAssets: vi.fn(),
  restoreAssets: vi.fn(),
  getPerson: vi.fn(),
}));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: {
    get value() {
      return flags;
    },
  },
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: { authenticated: true, user: { id: 'owner' }, preferences: { tags: { enabled: false } } },
}));
vi.mock('$lib/components/shared-components/search-bar/SearchBar.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/shared-components/gallery-viewer/GalleryViewer.svelte', async () => {
  const { default: Component } = await import('./SearchGallery.test.svelte');
  return { default: Component };
});
vi.mock('$lib/components/shared-components/ControlAppBar.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/timeline/AssetSelectControlBar.svelte', async () => {
  const { default: Field } = await import('@test-data/components/MockField.svelte');
  return { default: Field };
});
vi.mock('$lib/components/shared-components/context-menu/ButtonContextMenu.svelte', async () => {
  const { default: Field } = await import('@test-data/components/MockField.svelte');
  return { default: Field };
});
vi.mock('@immich/ui', async (original) => {
  const { default: IconButton } = await import('@test-data/components/MockIconButton.svelte');
  return {
    ...(await original<object>()),
    IconButton,
    ActionButton: () => {},
    CommandPaletteDefaultProvider: () => {},
    toastManager: { primary: vi.fn() },
  };
});
vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));

const empty = { assets: { items: [], nextPage: null }, albums: { items: [] } } as unknown as SearchResponseDto;
const setQuery = (terms: Parameters<typeof Route.search>[0]) => {
  state.url = new URL(Route.search(terms), 'http://localhost');
};

beforeEach(() => {
  vi.clearAllMocks();
  navigation.goto.mockReset();
  authManager.user.id = 'owner';
  flags.smartSearch = false;
  vi.mocked(searchAssets).mockResolvedValue(empty);
  searchManager.reset();
  assetMultiSelectManager.clear();
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

it('reloads the current filtered query after deleting and undoing selected assets', async () => {
  const asset = timelineAssetFactory.build({ id: 'asset', ownerId: 'owner' });
  setQuery({ city: 'Banff', originalFileName: 'holiday' });
  assetMultiSelectManager.selectAsset(asset);
  const view = render(SearchPage);
  await waitFor(() => expect(searchAssets).toHaveBeenCalledOnce());
  await fireEvent.click(screen.getByRole('menuitem', { name: 'delete' }));
  expect(deleteAssets).toHaveBeenCalledWith({ assetBulkDeleteDto: { ids: ['asset'], force: false } });
  const toast = vi.mocked(toastManager.primary).mock.calls[0][0];
  if (!toast || typeof toast === 'string' || typeof toast.button === 'function') {
    throw new Error('Expected an undo toast');
  }
  const undo = toast.button?.onclick;
  expect(undo).toBeTypeOf('function');
  await undo?.();
  await waitFor(() => expect(searchAssets).toHaveBeenCalledTimes(2));
  expect(restoreAssets).toHaveBeenCalledWith({ bulkIdsDto: { ids: ['asset'] } });
  expect(searchAssets).toHaveBeenLastCalledWith(
    {
      metadataSearchDto: {
        city: 'Banff',
        originalFileName: 'holiday',
        visibility: 'timeline',
        page: 1,
        withExif: true,
      },
    },
    expect.anything(),
  );
  expect(searchManager.filter.query).toBe('holiday');
  expect(searchManager.filter.location.city).toBe('Banff');
  view.unmount();
});

it.each([
  ['lock', () => eventManager.emit('SessionLocked')],
  ['PIN reset', () => eventManager.emit('UserPinCodeReset')],
  ['access restriction', () => eventManager.emit('SessionAccessChanged', { isElevated: false })],
] as const)('revalidates the query and discards late person-chip evidence on %s', async (_name, restrict) => {
  let resolvePerson!: (person: PersonResponseDto) => void;
  vi.mocked(getPerson)
    .mockReturnValueOnce(
      new Promise((done) => {
        resolvePerson = done;
      }),
    )
    .mockRejectedValue(new Error('person no longer accessible'));
  setQuery({ personIds: ['private-person'], city: 'Banff' });
  const view = render(SearchPage);
  await waitFor(() => expect(getPerson).toHaveBeenCalledOnce());
  flushSync(restrict);
  await waitFor(() => expect(searchAssets).toHaveBeenCalledTimes(2));
  expect(searchManager.filter.location.city).toBe('Banff');
  resolvePerson({ id: 'private-person', name: 'Private old person' } as PersonResponseDto);
  await waitFor(() => expect(getPerson).toHaveBeenCalledTimes(2));
  expect(screen.queryByText('Private old person')).toBeNull();
  expect(screen.getAllByRole('button', { name: 'remove_filter' })).toHaveLength(2);
  view.unmount();
});

it.each([
  ['logout', () => eventManager.emit('AuthLogout')],
  ['session deletion', () => eventManager.emit('SessionDelete')],
  [
    'account change',
    () => {
      authManager.user.id = 'other-owner';
      eventManager.emit('AuthUserLoaded', authManager.user);
    },
  ],
] as const)('hides old-account query evidence and blocks reloads after %s', async (_name, revoke) => {
  setQuery({ city: 'Private city' });
  const view = render(SearchPage);
  await waitFor(() => expect(searchAssets).toHaveBeenCalledOnce());
  expect(screen.getByText('Private city')).toBeInTheDocument();
  flushSync(revoke);
  expect(screen.queryByText('Private city')).toBeNull();
  flushSync(() => setQuery({ city: 'Another old query' }));
  expect(searchAssets).toHaveBeenCalledOnce();
  expect(searchManager.filter.location.city).toBeUndefined();
  view.unmount();
});

it('keeps the mounted gallery draft when access expands', async () => {
  setQuery({ city: 'Banff' });
  vi.mocked(searchAssets).mockResolvedValue({
    ...empty,
    assets: { items: [{ id: 'asset' }], nextPage: null },
  } as unknown as SearchResponseDto);
  const view = render(SearchPage);
  const input = await screen.findByRole('textbox', { name: 'Pending editor draft' });
  await fireEvent.input(input, { target: { value: 'unfinished crop note' } });
  vi.mocked(searchAssets).mockReturnValue(new Promise(() => {}));
  flushSync(() => eventManager.emit('SessionAccessChanged', { isElevated: true }));
  expect(screen.getByRole('textbox', { name: 'Pending editor draft' })).toBe(input);
  expect(input).toHaveValue('unfinished crop note');
  expect(searchAssets).toHaveBeenCalledOnce();
  view.unmount();
});

it('replaces a pending smart query when the live capability selects metadata and rejects its late page', async () => {
  flags.smartSearch = true;
  let resolveSmart!: (value: SearchResponseDto) => void;
  vi.mocked(searchSmart).mockReturnValueOnce(
    new Promise((resolve) => {
      resolveSmart = resolve;
    }),
  );
  setQuery({ query: 'river', city: 'Banff' });
  const view = render(SearchPage);
  await waitFor(() => expect(searchSmart).toHaveBeenCalledOnce());
  const signal = vi.mocked(searchSmart).mock.calls[0][1]?.signal;
  flushSync(() => {
    flags.smartSearch = false;
  });
  await waitFor(() => expect(searchAssets).toHaveBeenCalledOnce());
  expect(signal?.aborted).toBe(true);
  resolveSmart({
    ...empty,
    assets: { ...empty.assets, items: [assetFactory.build({ id: 'obsolete' })], nextPage: '9' },
  });
  await screen.findByText('no_results');
  expect(screen.queryByRole('status', { name: 'Loaded search assets' })).toBeNull();
  view.unmount();
});

it('keeps scoped filters and loaded pages while opening media and preserves the mounted draft and selection', async () => {
  const [first, second] = assetFactory.buildList(2, { ownerId: 'owner' });
  const terms = {
    originalPath: '/library/travel',
    albumIds: ['album'],
    tagIds: null,
    city: 'Banff',
    order: AssetOrder.Asc,
    size: 1,
  };
  setQuery(terms);
  vi.mocked(searchAssets)
    .mockResolvedValueOnce({ ...empty, assets: { ...empty.assets, items: [first], nextPage: '2' } })
    .mockResolvedValueOnce({ ...empty, assets: { ...empty.assets, items: [second], nextPage: null } });
  const view = render(SearchPage);
  const input = await screen.findByRole('textbox', { name: 'Pending editor draft' });
  await fireEvent.input(input, { target: { value: 'pending edit' } });
  await fireEvent.click(screen.getByRole('button', { name: 'Load next search page' }));
  await waitFor(() =>
    expect(screen.getByRole('status', { name: 'Loaded search assets' })).toHaveTextContent(`${first.id},${second.id}`),
  );
  expect(searchAssets).toHaveBeenLastCalledWith(
    { metadataSearchDto: { ...terms, visibility: 'timeline', page: 2, withExif: true } },
    expect.anything(),
  );
  assetMultiSelectManager.selectAsset(timelineAssetFactory.build({ id: first.id, ownerId: 'owner' }));
  const viewerUrl = new URL(state.url);
  viewerUrl.pathname = `/search/photos/${first.id}`;
  flushSync(() => {
    state.url = viewerUrl;
  });
  expect(searchAssets).toHaveBeenCalledTimes(2);
  expect(assetMultiSelectManager.assets.map(({ id }) => id)).toEqual([first.id]);
  expect(screen.getByRole('textbox', { name: 'Pending editor draft' })).toBe(input);
  expect(input).toHaveValue('pending edit');
  view.unmount();
});

it('submits Ask through the form URL and returns to structured filters without accepting a late Ask response', async () => {
  flags.smartSearch = true;
  state.url = new URL('http://localhost/search');
  let resolveAsk!: (value: AskSearchResponseDto) => void;
  vi.mocked(askSearch).mockReturnValueOnce(
    new Promise((resolve) => {
      resolveAsk = resolve;
    }),
  );
  navigation.goto.mockImplementation((url) => {
    state.url = new URL(url, 'http://localhost');
    return Promise.resolve();
  });
  const view = render(SearchPage);
  const input = await screen.findByRole('searchbox', { name: 'search_your_photos' });
  await userEvent.type(input, '  river in Banff  {Enter}');
  await waitFor(() => expect(askSearch).toHaveBeenCalledOnce());
  expect(state.url.searchParams.get('ask')).toBe('river in Banff');
  const signal = vi.mocked(askSearch).mock.calls[0][1]?.signal;
  flushSync(() => setQuery({ city: 'Banff' }));
  await waitFor(() => expect(searchAssets).toHaveBeenCalledOnce());
  expect(signal?.aborted).toBe(true);
  resolveAsk({
    query: 'river in Banff',
    explanation: 'obsolete Ask explanation',
    plan: { filters: {}, mode: Mode2.Smart, normalizedQuery: 'river in Banff' },
    warnings: [],
    results: empty,
  });
  await screen.findByText('no_results');
  expect(screen.queryByText('obsolete Ask explanation')).toBeNull();
  view.unmount();
});

it('does not retire a metadata gallery when unrelated smart capability changes', async () => {
  setQuery({ city: 'Banff' });
  vi.mocked(searchAssets).mockResolvedValue({
    ...empty,
    assets: { ...empty.assets, items: [assetFactory.build()], nextPage: null },
  });
  const view = render(SearchPage);
  const input = await screen.findByRole('textbox', { name: 'Pending editor draft' });
  await fireEvent.input(input, { target: { value: 'keep this draft' } });
  flushSync(() => {
    flags.smartSearch = true;
  });
  expect(searchAssets).toHaveBeenCalledOnce();
  expect(screen.getByRole('textbox', { name: 'Pending editor draft' })).toBe(input);
  expect(input).toHaveValue('keep this draft');
  view.unmount();
});

it('pages a deep-linked structured filter tree using the server cursor without injecting incompatible flat fields', async () => {
  const [first, second] = assetFactory.buildList(2);
  const terms = {
    filter: { albumIds: { any: ['album'] }, or: [{ city: { eq: 'Banff' } }, { rating: { gte: 4 } }] },
    orderBy: { field: SearchOrderField.FileCreatedAt, direction: AssetOrder.Asc },
    size: 1,
  };
  setQuery(terms);
  vi.mocked(searchAssets)
    .mockResolvedValueOnce({
      ...empty,
      assets: { ...empty.assets, items: [first], nextPage: null, nextCursor: 'opaque-next' },
    })
    .mockResolvedValueOnce({
      ...empty,
      assets: { ...empty.assets, items: [second], nextPage: null, nextCursor: null },
    });
  const view = render(SearchPage);
  await screen.findByRole('button', { name: 'Load next search page' });
  expect(searchAssets).toHaveBeenNthCalledWith(
    1,
    { metadataSearchDto: { ...terms, withExif: true } },
    expect.anything(),
  );
  await fireEvent.click(screen.getByRole('button', { name: 'Load next search page' }));
  await waitFor(() => expect(searchAssets).toHaveBeenCalledTimes(2));
  expect(searchAssets).toHaveBeenLastCalledWith(
    { metadataSearchDto: { ...terms, cursor: 'opaque-next', withExif: true } },
    expect.anything(),
  );
  await waitFor(() =>
    expect(screen.getByRole('status', { name: 'Loaded search assets' })).toHaveTextContent(`${first.id},${second.id}`),
  );
  await fireEvent.click(screen.getByRole('button', { name: 'Load next search page' }));
  expect(searchAssets).toHaveBeenCalledTimes(2);
  view.unmount();
});
