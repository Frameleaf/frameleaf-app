import {
  AssetTypeEnum,
  ColorTolerance,
  LibraryAssetItemKind,
  LibraryBookmarkItemKind,
  LibraryScope,
  LibraryViewScope,
  type BookmarkResponseDto,
  type LibraryItemSearchResponseDto,
} from '@frameleaf/sdk';
import { fireEvent, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { emptyDiscoveryQuery } from '$lib/components/discovery/query';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { renderWithTooltips } from '$tests/helpers';
import { assetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import en from '../../../../../i18n/en.json';
import LibraryItemsView from './LibraryItemsView.svelte';

const socket = vi.hoisted(() => ({ listeners: new Map<string, () => void>() }));
vi.mock('$lib/stores/websocket', () => ({
  websocketEvents: {
    on: (name: string, callback: () => void) => {
      socket.listeners.set(name, callback);
      return () => socket.listeners.delete(name);
    },
  },
}));
vi.mock('$lib/components/frameleaf/ResultsAssetViewer.svelte', async () => ({
  default: (await import('@test-data/frameleaf/EmptyStub.svelte')).default,
}));
const user = userAdminFactory.build({ isAdmin: false });
const bookmark: BookmarkResponseDto = {
  id: 'book',
  ownerId: user.id,
  title: 'Packaging reference',
  url: 'https://example.com',
  note: 'Owner note',
  rating: null,
  previewAssetId: null,
  libraryScope: LibraryScope.Design,
  isArchived: false,
  isLocked: false,
  deletedAt: null,
  createdAt: '',
  updatedAt: '',
  updateId: '',
};
const response: LibraryItemSearchResponseDto = {
  count: 1,
  countCapped: false,
  items: [{ kind: LibraryBookmarkItemKind.Bookmark, bookmark }],
  nextCursor: null,
};
const query = { ...emptyDiscoveryQuery(), filter: { libraryScope: LibraryViewScope.Design } };
const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')!;
beforeEach(() => {
  vi.clearAllMocks();
  socket.listeners.clear();
  localStorage.clear();
  sessionStorage.clear();
  addMessages('dev', en);
  authManager.setUser(user);
  authManager.setPreferences(preferencesFactory.build());
  sdkMock.searchLibraryItems.mockResolvedValue(response);
  sdkMock.getBookmark.mockResolvedValue(bookmark);
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1000 });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        queueMicrotask(() => this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver));
      }
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  authManager.reset();
  vi.unstubAllGlobals();
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', width);
});

it('opens designer assets and notes for an ordinary account without a Pro entitlement', async () => {
  renderWithTooltips(LibraryItemsView, { title: 'Pro', query, onQueryChange: vi.fn() });
  const card = await screen.findByRole('button', { name: 'Open saved link Packaging reference' });
  await fireEvent.click(card);
  expect(await screen.findByRole('textbox', { name: 'Notes' })).toHaveValue('Owner note');
  expect(sdkMock.searchLibraryItems).toHaveBeenCalledWith(
    expect.objectContaining({
      libraryItemSearchDto: expect.objectContaining({
        filter: expect.objectContaining({ libraryScope: LibraryViewScope.Design }),
      }),
    }),
    expect.anything(),
  );
});

it('opens the saved link a deep link names, even before the grid reaches it', async () => {
  sdkMock.searchLibraryItems.mockResolvedValue({ count: 0, countCapped: false, items: [], nextCursor: null });
  renderWithTooltips(LibraryItemsView, { title: 'Boards', query, onQueryChange: vi.fn(), bookmark: 'book' });
  expect(await screen.findByRole('textbox', { name: 'Notes' })).toHaveValue('Owner note');
  expect(sdkMock.getBookmark).toHaveBeenCalledWith({ id: 'book' }, expect.anything());
});

it('keeps the loaded grid in place when a tile receives pointer or keyboard focus', async () => {
  renderWithTooltips(LibraryItemsView, { title: 'Pro', query, onQueryChange: vi.fn() });
  const card = await screen.findByRole('button', { name: 'Open saved link Packaging reference' });
  await fireEvent.focus(card);
  expect(sdkMock.searchLibraryItems).toHaveBeenCalledOnce();
  expect(card.isConnected).toBe(true);
});

it('does not adopt late private records after logout', async () => {
  let finish!: (response: LibraryItemSearchResponseDto) => void;
  sdkMock.searchLibraryItems.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  renderWithTooltips(LibraryItemsView, { title: 'Pro', query, onQueryChange: vi.fn() });
  await waitFor(() => expect(sdkMock.searchLibraryItems).toHaveBeenCalledOnce());
  authManager.reset();
  eventManager.emit('AuthLogout');
  finish(response);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Open saved link Packaging reference' })).toBeNull());
  expect(screen.queryByText('Owner note')).toBeNull();
});

it('refreshes the same mixed result set when an upload becomes ready', async () => {
  renderWithTooltips(LibraryItemsView, { title: 'Pro', query, onQueryChange: vi.fn() });
  await screen.findByRole('button', { name: 'Open saved link Packaging reference' });
  socket.listeners.get('on_upload_success')?.();
  await waitFor(() => expect(sdkMock.searchLibraryItems).toHaveBeenCalledTimes(2));
});

const empty: LibraryItemSearchResponseDto = { count: 0, countCapped: false, items: [], nextCursor: null };
const lastRequest = () => sdkMock.searchLibraryItems.mock.lastCall?.[0].libraryItemSearchDto;

it('sorts by name or rating, and offers closest colour first only while a colour is on', async () => {
  renderWithTooltips(LibraryItemsView, { title: 'Boards', query, onQueryChange: vi.fn() });
  const sort = await screen.findByRole('combobox', { name: 'Sort by' });
  expect(screen.queryByRole('option', { name: 'Closest colour first' })).toBeNull();
  await fireEvent.change(sort, { target: { value: 'name' } });
  await waitFor(() => expect(lastRequest()?.sort).toBe('name'));
  await fireEvent.change(sort, { target: { value: 'rating' } });
  await waitFor(() => expect(lastRequest()?.sort).toBe('rating'));
});

it('finds by colour from the toolbar, names it as a pill and sorts closest first', async () => {
  const onQueryChange = vi.fn();
  renderWithTooltips(LibraryItemsView, { title: 'Boards', query, onQueryChange });
  await fireEvent.click(await screen.findByRole('button', { name: 'Colour' }));
  const picker = screen.getByRole('dialog', { name: 'Find by colour' });
  await fireEvent.click(within(picker).getByRole('button', { name: 'Teal' }));
  await fireEvent.click(within(picker).getByRole('button', { name: 'Show matches' }));
  await waitFor(() =>
    expect(lastRequest()).toMatchObject({
      sort: 'color',
      filter: { color: { hex: '#3f8f8a', tolerance: 'normal', minWeight: 0.05 } },
    }),
  );
  expect(screen.getByRole('button', { name: 'Teal · close' })).toHaveAttribute('aria-expanded', 'false');
  expect(screen.getByRole('option', { name: 'Closest colour first' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save as smart collection' })).toBeInTheDocument();
});

it('leads an empty Boards with the first-run actions', async () => {
  sdkMock.searchLibraryItems.mockResolvedValue(empty);
  const onSaveLink = vi.fn();
  const onGetExtension = vi.fn();
  renderWithTooltips(LibraryItemsView, { title: 'Boards', query, onQueryChange: vi.fn(), onSaveLink, onGetExtension });
  expect(await screen.findByRole('heading', { name: 'Collect what inspires your work' })).toBeInTheDocument();
  await fireEvent.click(screen.getByRole('button', { name: 'Get the browser extension' }));
  expect(onGetExtension).toHaveBeenCalledOnce();
  await fireEvent.click(screen.getByRole('button', { name: 'Save a link' }));
  expect(onSaveLink).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: 'Upload files' })).toBeInTheDocument();
});

it('offers loose matches when nothing is close to the colour', async () => {
  sdkMock.searchLibraryItems.mockResolvedValue(empty);
  const colour = {
    ...query,
    filter: { ...query.filter, color: { hex: '#3f8f8a', tolerance: ColorTolerance.Tight, minWeight: 0.25 } },
  };
  renderWithTooltips(LibraryItemsView, { title: 'Boards', query: colour, onQueryChange: vi.fn() });
  expect(await screen.findByRole('heading', { name: 'Nothing close to that colour' })).toBeInTheDocument();
  await fireEvent.click(screen.getByRole('button', { name: 'Show loose matches' }));
  await waitFor(() =>
    expect(lastRequest()?.filter?.color).toEqual({ hex: '#3f8f8a', tolerance: 'broad', minWeight: 0.05 }),
  );
});

it('says everything is filed when Unfiled is empty', async () => {
  sdkMock.searchLibraryItems.mockResolvedValue(empty);
  const unfiled = { ...query, filter: { ...query.filter, hasAlbums: { eq: false } } };
  renderWithTooltips(LibraryItemsView, { title: 'Boards', query: unfiled, onQueryChange: vi.fn() });
  expect(await screen.findByRole('heading', { name: 'Everything is filed' })).toBeInTheDocument();
});

it('opens the save-link flow when an address is pasted', async () => {
  const onSaveLink = vi.fn();
  renderWithTooltips(LibraryItemsView, { title: 'Boards', query, onQueryChange: vi.fn(), onSaveLink });
  await screen.findByRole('button', { name: 'Open saved link Packaging reference' });
  const paste = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(paste, 'clipboardData', {
    value: { files: [], getData: () => ' https://example.com/board ' },
  });
  document.body.dispatchEvent(paste);
  expect(onSaveLink).toHaveBeenCalledWith('https://example.com/board');
});

it('rates and trashes a selected link from the Boards selection bar', async () => {
  sdkMock.updateBookmark.mockResolvedValue(bookmark);
  sdkMock.trashBookmark.mockResolvedValue(undefined as never);
  renderWithTooltips(LibraryItemsView, { title: 'Boards', query, onQueryChange: vi.fn() });
  await fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Packaging reference' }));
  const bar = await screen.findByRole('toolbar', { name: '1 item selected' });
  expect(within(bar).getByRole('button', { name: 'Add to collection' })).toBeEnabled();
  expect(within(bar).getByRole('button', { name: 'Download' })).toBeDisabled();
  await fireEvent.click(within(bar).getByRole('button', { name: 'Rate' }));
  await fireEvent.click(await screen.findByRole('menuitem', { name: 'Rejected' }));
  await waitFor(() =>
    expect(sdkMock.updateBookmark).toHaveBeenCalledWith({ id: 'book', bookmarkUpdateDto: { rating: -1 } }),
  );
  await fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Packaging reference' }));
  await fireEvent.click(
    within(await screen.findByRole('toolbar', { name: '1 item selected' })).getByRole('button', {
      name: 'Move to trash',
    }),
  );
  await waitFor(() => expect(sdkMock.trashBookmark).toHaveBeenCalledWith({ id: 'book' }));
});

it('opens the Download dialog from the Boards selection bar and adds the library file with the links', async () => {
  // an image, so its checkbox reads "Image taken on…" (the factory picks a random type)
  const file = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image });
  sdkMock.searchLibraryItems.mockResolvedValue({
    count: 2,
    countCapped: false,
    items: [
      { kind: LibraryAssetItemKind.Asset, asset: file },
      { kind: LibraryBookmarkItemKind.Bookmark, bookmark },
    ],
    nextCursor: null,
  });
  sdkMock.getDownloadInfo.mockResolvedValue({ totalSize: 10, archives: [{ size: 10, assetIds: [file.id] }] });
  sdkMock.downloadArchive.mockResolvedValue(new Blob(['zip']));
  renderWithTooltips(LibraryItemsView, { title: 'Boards', query, onQueryChange: vi.fn() });
  await fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Packaging reference' }));
  await fireEvent.click(await screen.findByRole('checkbox', { name: /^Select Image taken on/ }));
  const bar = await screen.findByRole('toolbar', { name: '2 items selected' });
  await fireEvent.click(within(bar).getByRole('button', { name: 'Download' }));

  expect(await screen.findByRole('heading', { name: 'Download 2 items' })).toBeInTheDocument();
  expect(screen.getByRole('switch', { name: /Include a library file/ })).toBeChecked();
  await fireEvent.click(screen.getByRole('button', { name: 'Download .zip' }));

  await waitFor(() =>
    expect(sdkMock.downloadArchive).toHaveBeenCalledWith(
      {
        downloadArchiveDto: expect.objectContaining({
          assetIds: [file.id],
          edited: false,
          includeLibraryMetadata: true,
          includeSources: true,
          bookmarkIds: ['book'],
        }),
      },
      expect.anything(),
    ),
  );
});
