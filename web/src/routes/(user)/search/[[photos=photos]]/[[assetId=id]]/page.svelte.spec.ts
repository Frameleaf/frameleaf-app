import { searchAssets, deleteAssets, restoreAssets, type SearchResponseDto } from '@immich/sdk';
import { toastManager } from '@immich/ui';
import { render, screen, waitFor, fireEvent } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
import { searchManager } from '$lib/managers/search-manager.svelte';
import { Route } from '$lib/route';
import { timelineAssetFactory } from '@test-data/factories/asset-factory';
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
vi.mock('@immich/sdk', async (original) => ({
  ...(await original<object>()),
  searchAssets: vi.fn(),
  deleteAssets: vi.fn(),
  restoreAssets: vi.fn(),
}));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({ featureFlagsManager: { value: { trash: true } } }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: { authenticated: true, user: { id: 'owner' }, preferences: { tags: { enabled: false } } },
}));
vi.mock('$lib/components/shared-components/search-bar/SearchBar.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/shared-components/gallery-viewer/GalleryViewer.svelte', () => ({ default: () => {} }));
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
