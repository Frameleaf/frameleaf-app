import {
  LibraryBookmarkItemKind,
  LibraryScope,
  LibraryViewScope,
  type BookmarkResponseDto,
  type LibraryItemSearchResponseDto,
} from '@frameleaf/sdk';
import { fireEvent, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { emptyDiscoveryQuery } from '$lib/components/discovery/query';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { renderWithTooltips } from '$tests/helpers';
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
  const card = await screen.findByRole('button', { name: 'Packaging reference' });
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

it('keeps the loaded grid in place when a tile receives pointer or keyboard focus', async () => {
  renderWithTooltips(LibraryItemsView, { title: 'Pro', query, onQueryChange: vi.fn() });
  const card = await screen.findByRole('button', { name: 'Packaging reference' });
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
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Packaging reference' })).toBeNull());
  expect(screen.queryByText('Owner note')).toBeNull();
});

it('refreshes the same mixed result set when an upload becomes ready', async () => {
  renderWithTooltips(LibraryItemsView, { title: 'Pro', query, onQueryChange: vi.fn() });
  await screen.findByRole('button', { name: 'Packaging reference' });
  socket.listeners.get('on_upload_success')?.();
  await waitFor(() => expect(sdkMock.searchLibraryItems).toHaveBeenCalledTimes(2));
});
