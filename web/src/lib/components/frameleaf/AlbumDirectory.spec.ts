import {
  LibraryScope,
  LibraryViewScope,
  AlbumKind,
  AlbumUserRole,
  SmartAlbumBuiltInKind,
  type AlbumTreeResponseDto,
} from '@frameleaf/sdk';
import { fireEvent, screen, waitFor, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { init, register, t, waitLocale } from 'svelte-i18n';
import { get } from 'svelte/store';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { afterNavigate } from '$app/navigation';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { defaultAlbumDirectoryView } from '$lib/frameleaf/album-directory';
import { workspaceHref } from '$lib/frameleaf/search-context';
import { installFrameleafToasts } from '$lib/frameleaf/toast';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { albumDirectoryView } from '$lib/stores/preferences.store';
import { renderWithTooltips } from '$tests/helpers';
import { albumFactory } from '@test-data/factories/album-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import AlbumDirectory from './AlbumDirectory.svelte';

const me = userAdminFactory.build({ id: 'me', isAdmin: false });
const jamie = userAdminFactory.build({ id: 'jamie', name: 'Jamie' });

const app = vi.hoisted(() => ({
  page: { url: new URL('http://localhost/albums'), state: {} },
  goto: vi.fn(),
  replaceState: vi.fn<(url: string | URL, state: App.PageState) => Promise<void>>(async () => {}),
  routerStarted: true,
}));
vi.mock('$app/state', () => ({ page: app.page }));
vi.mock('$app/navigation', () => ({
  goto: app.goto,
  replaceState: app.replaceState,
  invalidate: vi.fn(),
  afterNavigate: vi.fn(),
  onNavigate: vi.fn(),
}));
vi.mock('$lib/utils/router-started', () => ({ hasRouterStarted: () => app.routerStarted }));

vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: {
    user: { id: 'me', isAdmin: false, name: 'Me', email: 'me@example.com' },
    params: {},
    preferences: { albums: { pinned: [], pinnedCustomOrder: false } },
    // A toast's Undo only acts for the session that showed it (toast.ts); this session never changes.
    captureSession: () => () => true,
  },
}));
vi.mock('$lib/components/assets/thumbnail/ImageThumbnail.svelte', async () => {
  const { default: TestImage } = await import('$lib/../test-data/frameleaf/TestImage.svelte');
  return { default: TestImage };
});

const owned = (overrides: Parameters<typeof albumFactory.build>[0] = {}) =>
  albumFactory.build({ albumUsers: [{ user: me, role: AlbumUserRole.Owner }], ...overrides });

const family = owned({ id: 'family', albumName: 'Family', kind: AlbumKind.Collection, description: 'The three of us' });
// FL-1836: a collection is one tile that opens in place, so the albums most tests act on stand at the top level
// and Family holds an album of its own.
const rockies = owned({ id: 'rockies', albumName: 'Summer in the Rockies', assetCount: 10 });
const winter = owned({ id: 'winter', albumName: 'Winter 2026', assetCount: 0 });
const cabin = owned({ id: 'cabin', albumName: 'Cabin weekend', parentId: 'family', assetCount: 4 });
const trail = albumFactory.build({
  id: 'trail',
  albumName: 'Trail camera',
  isSmart: true,
  assetCount: 7,
  albumUsers: [
    { user: jamie, role: AlbumUserRole.Owner },
    { user: me, role: AlbumUserRole.Viewer },
  ],
});
const space = owned({
  id: 'space',
  albumName: 'Family Space',
  kind: AlbumKind.Space,
  albumUsers: [
    { user: me, role: AlbumUserRole.Owner },
    { user: jamie, role: AlbumUserRole.Editor },
  ],
});

const tree: AlbumTreeResponseDto = {
  collections: [{ collection: family, albums: [cabin], albumCount: 1, assetCount: 4 }],
  albums: [rockies, winter, trail],
  spaces: [space],
};

/** The line under the filters (drag hint, "your albums changed"); outcomes are toasts, also `status`. */
const directoryStatus = () => within(document.querySelector('.status') as HTMLElement).getByRole('status');

describe('AlbumDirectory', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
    // Outcomes are said in the Frameleaf toast, as the root layout installs it.
    installFrameleafToasts();
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.open = false;
    };
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Most tests are about the tiles themselves: with no observer every tile is built straight away.
    vi.stubGlobal('IntersectionObserver', undefined);
    app.page.url = new URL('http://localhost/albums');
    app.routerStarted = true;
    localStorage.clear();
    // The view (filter pill, grid or list) is a persisted store that outlives a single mount.
    // Empty albums show here (the page hides them by default), so every album in the fixture has a tile.
    albumDirectoryView.set({ ...defaultAlbumDirectoryView, hideEmpty: false });
  });

  it('shows the top level grouped by kind, with a collection as one tile that opens in place (FL-1836)', () => {
    renderWithTooltips(AlbumDirectory, { tree, onRefresh: vi.fn() });

    const collections = screen.getByRole('region', { name: 'Collections' });
    const familyTile = within(collections).getByRole('article', { name: 'Family' });
    expect(familyTile).toHaveTextContent('1 album');
    expect(familyTile.querySelector('a[href="/albums?in=family"]')).not.toBeNull();
    // Its album stays inside it: never listed at the top level with the collection's name above it.
    expect(screen.queryByRole('article', { name: 'Cabin weekend' })).toBeNull();

    const albumsSection = screen
      .getAllByRole('region', { name: 'Albums' })
      .find((el) => el.classList.contains('group'));
    expect(within(albumsSection!).getAllByRole('article')).toHaveLength(2);
    expect(screen.getByRole('region', { name: 'Smart albums' })).toHaveTextContent('Trail camera');
    expect(screen.getByRole('region', { name: 'Shared spaces' })).toHaveTextContent('Family Space');
    expect(screen.getByRole('heading', { level: 1, name: 'Albums' })).toBeInTheDocument();
    expect(screen.getByText('4 albums · 1 collection · 1 shared space')).toBeInTheDocument();
  });

  it('opens a collection in place, with a path back to the top and what it holds (FL-1836)', () => {
    app.page.url = new URL('http://localhost/albums?in=family');
    renderWithTooltips(AlbumDirectory, { tree, onRefresh: vi.fn() });

    const path = screen.getByRole('navigation', { name: 'Where you are' });
    expect(within(path).getByRole('link', { name: 'Albums' })).toHaveAttribute('href', '/albums');
    expect(within(path).getByRole('link', { name: 'Family' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { level: 1, name: 'Family' })).toBeInTheDocument();
    expect(screen.getByText(/1 album inside/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View all photos' })).toHaveAttribute('href', '/albums/family');
    expect(screen.getByRole('article', { name: 'Cabin weekend' })).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'Summer in the Rockies' })).toBeNull();
  });

  it('offers the folder-albums notice at the top level, and not inside a collection (FL-1837)', async () => {
    const { authManager } = await import('$lib/managers/auth-manager.svelte');
    const user = authManager.user as { isAdmin: boolean };
    user.isAdmin = true;
    sdkMock.getFolderAlbumSuggestions.mockResolvedValue([]);
    try {
      const top = renderWithTooltips(AlbumDirectory, { tree, onRefresh: vi.fn() });
      expect(sdkMock.getFolderAlbumSuggestions).toHaveBeenCalledTimes(1);
      top.unmount();

      app.page.url = new URL('http://localhost/albums?in=family');
      renderWithTooltips(AlbumDirectory, { tree, onRefresh: vi.fn() });
      expect(sdkMock.getFolderAlbumSuggestions).toHaveBeenCalledTimes(1);
    } finally {
      user.isAdmin = false;
    }
  });

  it('hides empty albums by default and says how many (FL-1836)', () => {
    albumDirectoryView.set({ ...defaultAlbumDirectoryView });
    renderWithTooltips(AlbumDirectory, { tree, onRefresh: vi.fn() });

    expect(screen.queryByRole('article', { name: 'Winter 2026' })).toBeNull();
    expect(screen.getByRole('article', { name: 'Summer in the Rockies' })).toBeInTheDocument();
    expect(screen.getByText(/1 empty hidden/)).toBeInTheDocument();
  });

  it('groups by year when asked, and orders the level from the Order button (FL-1836)', async () => {
    const dated = {
      collections: [],
      albums: [
        owned({ id: 'a', albumName: 'Old', assetCount: 1, endDate: '2019-05-01T00:00:00.000Z' }),
        owned({ id: 'b', albumName: 'New', assetCount: 1, endDate: '2026-11-01T00:00:00.000Z' }),
      ],
      spaces: [],
    };
    renderWithTooltips(AlbumDirectory, { tree: dated, onRefresh: vi.fn() });
    await fireEvent.click(screen.getByRole('button', { name: 'Group albums' }));
    await fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Year' }));
    const headings = () => screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
    expect(headings()).toEqual(['2026', '2019']);
    await fireEvent.click(screen.getByRole('button', { name: 'Order: Newest first' }));
    expect(headings()).toEqual(['2019', '2026']);
  });

  // FL-1411 (M12): on a phone sort is a 48px button at the start edge; a menu hung from its end opens off screen.
  it('opens the sort menu from the start edge on a phone, and from the end edge on a wide screen', async () => {
    const width = (phone: boolean) => (query: string) => ({
      matches: phone && query.includes('max-width: 700px'),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });
    const sortMenu = async () => {
      const { unmount } = renderWithTooltips(AlbumDirectory, { tree, onRefresh: vi.fn() });
      await fireEvent.click(screen.getByRole('button', { name: 'Sort albums' }));
      const end = (await screen.findByRole('menu', { name: 'Sort albums' })).classList.contains('end');
      unmount();
      return end;
    };
    try {
      vi.mocked(matchMedia).mockImplementation(width(true) as never);
      expect(await sortMenu()).toBe(false);
      vi.mocked(matchMedia).mockImplementation(width(false) as never);
      expect(await sortMenu()).toBe(true);
    } finally {
      vi.mocked(matchMedia).mockImplementation(width(false) as never);
    }
  });

  it('offers the filter pills, and the Smart pill keeps only smart albums', async () => {
    renderWithTooltips(AlbumDirectory, { tree, onRefresh: vi.fn() });

    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent?.trim());
    expect(tabs).toEqual(['All', 'My albums', 'Shared', 'Smart']);

    await fireEvent.click(screen.getByRole('tab', { name: 'Smart' }));

    expect(screen.queryByRole('region', { name: 'Family' })).toBeNull();
    expect(screen.getByRole('article', { name: 'Trail camera' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Shared spaces' })).toBeNull();
  });

  it('searches every level, says where each result lives, and keeps the list view (FL-1836)', async () => {
    renderWithTooltips(AlbumDirectory, { tree, onRefresh: vi.fn() });

    await fireEvent.click(screen.getByRole('button', { name: 'List view' }));
    expect(screen.getByRole('button', { name: 'List view' })).toHaveAttribute('aria-pressed', 'true');
    expect(document.querySelector('[role="list"]')).not.toBeNull();

    await fireEvent.input(screen.getByRole('searchbox', { name: 'Search albums' }), { target: { value: 'cabin' } });
    const found = screen.getByRole('article', { name: 'Cabin weekend' });
    expect(found).toHaveTextContent('in Family');
    expect(screen.queryByRole('article', { name: 'Summer in the Rockies' })).toBeNull();
    expect(screen.getByText(/1 result across every level/)).toBeInTheDocument();
  });

  it('shows the one empty-page pattern, and nothing to arrange, when there is nothing (FL-1412)', () => {
    renderWithTooltips(AlbumDirectory, { tree: { collections: [], albums: [], spaces: [] }, onRefresh: vi.fn() });
    const empty = screen.getByTestId('frameleaf-empty-state');
    expect(within(empty).getByRole('heading', { level: 2, name: 'No albums yet' })).toBeInTheDocument();
    expect(empty).toHaveTextContent('An album gathers photos you choose. The photos stay in your library.');
    expect(within(empty).getAllByRole('button')).toHaveLength(1);
    expect(within(empty).getByRole('button', { name: 'New album' })).toBeInTheDocument();
    // Nothing to search, sort, lay out, select or filter. The New menu stays: it makes every kind of album.
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('group', { name: 'View' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Select' })).toBeNull();
    expect(screen.getByRole('button', { name: 'New' })).toBeInTheDocument();
  });

  it('shows the plain empty page, not a filtered one, when nothing is left under a filter kept from before', () => {
    albumDirectoryView.set({ ...defaultAlbumDirectoryView, filter: 'smart' });
    renderWithTooltips(AlbumDirectory, { tree: { collections: [], albums: [], spaces: [] }, onRefresh: vi.fn() });
    expect(screen.getByRole('heading', { level: 2, name: 'No albums yet' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'No smart albums yet' })).toBeNull();
  });

  it('keeps its controls when a search or a filter is what leaves nothing (FL-1412)', async () => {
    renderWithTooltips(AlbumDirectory, { tree, onRefresh: vi.fn() });
    await fireEvent.input(screen.getByRole('searchbox'), { target: { value: 'zzzz' } });
    expect(await screen.findByRole('heading', { level: 2, name: 'No albums match' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox')).toBeInTheDocument();
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(within(screen.getByTestId('frameleaf-empty-state')).queryByRole('button')).toBeNull();
  });

  it('puts an album dropped on a plain album inside it, and a smart album takes none', async () => {
    sdkMock.moveAlbumToCollection.mockResolvedValue({ ...rockies, parentId: 'winter' });
    renderWithTooltips(AlbumDirectory, { tree, onRefresh: vi.fn() });
    const dataTransfer = {
      types: ['application/x-immich-album-id'],
      getData: () => 'rockies',
      setData: vi.fn(),
      effectAllowed: 'move',
      dropEffect: 'none',
    };
    await fireEvent.dragStart(screen.getByRole('article', { name: 'Summer in the Rockies' }), { dataTransfer });
    const smart = screen.getByRole('article', { name: 'Trail camera' });
    await fireEvent.dragOver(smart, { dataTransfer });
    expect(smart).not.toHaveClass('drop-into');
    const target = screen.getByRole('article', { name: 'Winter 2026' });
    await fireEvent.dragOver(target, { dataTransfer });
    expect(target).toHaveClass('drop-into');
    await fireEvent.drop(target, { dataTransfer });
    await waitFor(() =>
      expect(sdkMock.moveAlbumToCollection).toHaveBeenCalledWith({
        id: 'rockies',
        moveAlbumDto: { collectionId: 'winter', expectedParentId: null },
      }),
    );
    // Undo puts it back where it came from: the top level.
    await fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(sdkMock.moveAlbumToCollection).toHaveBeenLastCalledWith({
        id: 'rockies',
        moveAlbumDto: { collectionId: null, expectedParentId: 'winter' },
      }),
    );
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull());
  });

  it('takes an album out of its collection through the server and refreshes', async () => {
    const onRefresh = vi.fn();
    sdkMock.moveAlbumToCollection.mockResolvedValue({ ...cabin, parentId: null });
    app.page.url = new URL('http://localhost/albums?in=family');
    renderWithTooltips(AlbumDirectory, { tree, onRefresh });

    const rootDrop = document.querySelector('.root-drop') as HTMLElement;
    const dataTransfer = {
      types: ['application/x-immich-album-id'],
      getData: () => 'cabin',
      setData: vi.fn(),
      effectAllowed: 'move',
      dropEffect: 'none',
    };
    const tile = screen.getByRole('article', { name: 'Cabin weekend' });
    await fireEvent.dragStart(tile, { dataTransfer });
    await fireEvent.dragOver(rootDrop, { dataTransfer });
    await fireEvent.drop(rootDrop, { dataTransfer });

    await waitFor(() =>
      expect(sdkMock.moveAlbumToCollection).toHaveBeenCalledWith({
        id: 'cabin',
        // Where this page last saw it, so a move from an outdated directory is refused (FL-52).
        moveAlbumDto: { collectionId: null, expectedParentId: 'family' },
      }),
    );
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
    // Said in a toast at the foot of the page, not in the line under the filters.
    expect(await screen.findByText(/“Cabin weekend” is now on its own/)).toBeInTheDocument();
    expect(directoryStatus()).toHaveTextContent('');

    // Undo moves it back to the collection it came from.
    await fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(sdkMock.moveAlbumToCollection).toHaveBeenLastCalledWith({
        id: 'cabin',
        moveAlbumDto: { collectionId: 'family', expectedParentId: null },
      }),
    );
  });

  it('moves a dragged album to the top level when it lands on "Albums" in the path (FL-1836)', async () => {
    sdkMock.moveAlbumToCollection.mockResolvedValue({ ...cabin, parentId: null });
    app.page.url = new URL('http://localhost/albums?in=family');
    renderWithTooltips(AlbumDirectory, { tree, onRefresh: vi.fn() });
    const dataTransfer = {
      types: ['application/x-immich-album-id'],
      getData: () => 'cabin',
      setData: vi.fn(),
      effectAllowed: 'move',
      dropEffect: 'none',
    };
    await fireEvent.dragStart(screen.getByRole('article', { name: 'Cabin weekend' }), { dataTransfer });
    const top = within(screen.getByRole('navigation', { name: 'Where you are' })).getByRole('link', { name: 'Albums' });
    await fireEvent.dragOver(top, { dataTransfer });
    await fireEvent.drop(top, { dataTransfer });
    await waitFor(() =>
      expect(sdkMock.moveAlbumToCollection).toHaveBeenCalledWith({
        id: 'cabin',
        moveAlbumDto: { collectionId: null, expectedParentId: 'family' },
      }),
    );
  });

  it('keeps shared spaces top level, opening on their own page, with a link to waiting invitations', () => {
    renderWithTooltips(AlbumDirectory, { tree, spaceInvitations: 2, onRefresh: vi.fn() });

    const spaces = screen.getByRole('region', { name: 'Shared spaces' });
    const tile = spaces.querySelector('article[aria-label="Family Space"]') as HTMLElement;
    expect(tile).toHaveAttribute('draggable', 'false');
    expect(tile.querySelector('a[href="/albums/space"]')).not.toBeNull();
    expect(
      screen.getByRole('region', { name: 'Collections' }).querySelector('article[aria-label="Family Space"]'),
    ).toBeNull();
    expect(screen.getByRole('link', { name: '2 invitations waiting' })).toHaveAttribute('href', '/sharing');
  });

  it('opens the create dialog the rail asked for, once, and drops the request from the address', async () => {
    app.page.url = new URL('http://localhost/albums?create=space');
    renderWithTooltips(AlbumDirectory, { tree, onRefresh: vi.fn() });

    expect(await screen.findByRole('dialog', { name: 'New shared space' })).toBeInTheDocument();
    expect(app.replaceState).toHaveBeenCalledOnce();
    const [url] = app.replaceState.mock.calls[0];
    expect(url).toBeInstanceOf(URL);
    expect(new URL(url).search).toBe('');
  });

  it('waits for the router before touching the address on a direct load', async () => {
    app.page.url = new URL('http://localhost/albums?create=album');
    app.routerStarted = false;
    renderWithTooltips(AlbumDirectory, { tree, onRefresh: vi.fn() });
    await tick();

    expect(app.replaceState).not.toHaveBeenCalled();
    const [[callback]] = vi.mocked(afterNavigate).mock.calls as unknown as [[() => void]];
    callback();

    expect(await screen.findByRole('dialog', { name: 'New album' })).toBeInTheDocument();
    expect(app.replaceState).toHaveBeenCalledOnce();
  });

  it('creates a Pro album in Design through the ordinary album flow', async () => {
    app.page.url = new URL(
      workspaceHref('/albums?create=album', LibraryViewScope.Design, 'http://localhost'),
      'http://localhost',
    );
    sdkMock.createAlbum.mockResolvedValue(
      albumFactory.build({ id: 'packaging', kind: AlbumKind.Album, libraryScope: LibraryScope.Design }),
    );
    renderWithTooltips(AlbumDirectory, { tree, onRefresh: vi.fn() });
    const dialog = await screen.findByRole('dialog', { name: 'New album' });
    await fireEvent.input(within(dialog).getByRole('textbox', { name: 'Name' }), { target: { value: 'Packaging' } });
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(sdkMock.createAlbum).toHaveBeenCalledWith({
        createAlbumDto: expect.objectContaining({ albumName: 'Packaging', libraryScope: LibraryScope.Design }),
      }),
    );
    // The new album opens instead of leaving you on the list.
    await waitFor(() => expect(app.goto).toHaveBeenCalledWith(expect.stringContaining('packaging')));
  });

  it('opens no create dialog on a plain visit to All albums', () => {
    renderWithTooltips(AlbumDirectory, { tree, onRefresh: vi.fn() });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(app.replaceState).not.toHaveBeenCalled();
  });

  it('opens an album’s menu at the pointer on a right-click, and a collection’s on its tile', async () => {
    renderWithTooltips(AlbumDirectory, { tree, onRefresh: vi.fn() });

    const tile = document.querySelector('article[aria-label="Summer in the Rockies"]') as HTMLElement;
    await fireEvent.contextMenu(tile, { clientX: 120, clientY: 80 });
    const menu = await screen.findByRole('menu', { name: 'Actions for Summer in the Rockies' });
    // It floats on the page (outside the frosted cards) at the pointer.
    expect(menu.parentElement).toBe(document.body);
    expect(menu.style.left).toBe('120px');
    expect(within(menu).getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Pin to sidebar' })).toBeInTheDocument();
    expect(screen.queryByRole('menu', { name: 'Actions for Family' })).toBeNull();

    await fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Actions for Summer in the Rockies' })).toBeNull());

    await fireEvent.contextMenu(screen.getByRole('article', { name: 'Family' }), { clientX: 40, clientY: 40 });
    expect(await screen.findByRole('menu', { name: 'Actions for Family' })).toBeInTheDocument();
  });

  describe('Move to… in a large library', () => {
    it('lists only the ten most recently changed albums until the person types, then searches them all', async () => {
      const many = Array.from({ length: 15 }, (_, index) =>
        owned({
          id: `old-${index}`,
          albumName: `Trip ${String(index).padStart(2, '0')}`,
          updatedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
        }),
      );
      renderWithTooltips(AlbumDirectory, { tree: { collections: [], albums: many, spaces: [] }, onRefresh: vi.fn() });
      // A section shows two rows of tiles first (FL-1836).
      await fireEvent.click(screen.getByRole('button', { name: /^Show \d+ more/ }));

      await fireEvent.click(screen.getByRole('button', { name: 'Actions for Trip 14' }));
      const menu = within(await screen.findByRole('menu', { name: 'Actions for Trip 14' }));
      await fireEvent.click(menu.getByRole('menuitem', { name: 'Move to…' }));
      const dialog = within(await screen.findByRole('dialog', { name: /Move “Trip 14”/ }));

      // Top level, then the newest ten: Trip 14 down to Trip 05.
      expect(dialog.getAllByRole('radio')).toHaveLength(11);
      expect(dialog.queryByRole('radio', { name: /Trip 04/ })).toBeNull();

      await fireEvent.input(dialog.getByRole('searchbox', { name: 'Find a collection' }), {
        target: { value: 'trip 04' },
      });
      expect(dialog.getByRole('radio', { name: /Trip 04/ })).toBeEnabled();
    });
  });

  it('selects only the albums on screen with Select all, never those past "Show more" (FL-1836)', async () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      owned({ id: `many-${index}`, albumName: `Many ${index}`, assetCount: 1 }),
    );
    renderWithTooltips(AlbumDirectory, { tree: { collections: [], albums: many, spaces: [] }, onRefresh: vi.fn() });
    await fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    const bar = within(screen.getByRole('toolbar', { name: 'Actions for the chosen albums' }));
    await fireEvent.click(bar.getByRole('button', { name: 'Select all' }));
    expect(bar.getByRole('status')).toHaveTextContent('12 selected');
  });

  it('offers no arranging while empty albums are hidden from the group (FL-1836)', async () => {
    albumDirectoryView.set({ ...defaultAlbumDirectoryView, sort: 'custom', group: 'none', hideEmpty: true });
    renderWithTooltips(AlbumDirectory, { tree, onRefresh: vi.fn() });
    await fireEvent.click(screen.getByRole('button', { name: 'Actions for Summer in the Rockies' }));
    const menu = within(await screen.findByRole('menu', { name: 'Actions for Summer in the Rockies' }));
    expect(menu.queryByRole('menuitem', { name: 'Move earlier' })).toBeNull();
    expect(menu.queryByRole('menuitem', { name: 'Move later' })).toBeNull();
  });

  describe('choosing several albums', () => {
    const choose = async (...names: string[]) => {
      await fireEvent.click(screen.getByRole('button', { name: 'Select' }));
      for (const name of names) {
        await fireEvent.click(screen.getByRole('checkbox', { name: `Select “${name}”` }));
      }
      const bar = within(screen.getByRole('toolbar', { name: 'Actions for the chosen albums' }));
      expect(bar.getByRole('status')).toHaveTextContent(`${names.length} selected`);
      return bar;
    };

    it('moves every chosen album into the collection picked once', async () => {
      const onRefresh = vi.fn();
      const trips = owned({ id: 'trips', albumName: 'Trips', kind: AlbumKind.Collection });
      sdkMock.moveAlbumToCollection.mockResolvedValue(rockies);
      renderWithTooltips(AlbumDirectory, {
        tree: {
          ...tree,
          collections: [...tree.collections, { collection: trips, albums: [], albumCount: 0, assetCount: 0 }],
        },
        onRefresh,
      });

      const bar = await choose('Summer in the Rockies', 'Winter 2026');
      await fireEvent.click(bar.getByRole('button', { name: /Move to…/ }));
      const dialog = within(await screen.findByRole('dialog', { name: 'Move 2 albums' }));
      await fireEvent.input(dialog.getByRole('searchbox', { name: 'Find a collection' }), {
        target: { value: 'trips' },
      });
      await fireEvent.click(dialog.getByRole('radio', { name: /Trips/ }));
      await fireEvent.submit(dialog.getByRole('button', { name: 'Move here' }).closest('form')!);

      await waitFor(() => expect(sdkMock.moveAlbumToCollection).toHaveBeenCalledTimes(2));
      expect(sdkMock.moveAlbumToCollection).toHaveBeenCalledWith({
        id: 'winter',
        moveAlbumDto: { collectionId: 'trips', expectedParentId: null },
      });
      // One refresh for the lot, not one per album.
      await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    });

    it('merges the chosen albums into one of them, leaving that one out of the merge', async () => {
      sdkMock.mergeAlbumsInto.mockResolvedValue({ runId: 'run-many', winnerId: 'winter' });
      renderWithTooltips(AlbumDirectory, { tree, onRefresh: vi.fn() });

      const bar = await choose('Summer in the Rockies', 'Winter 2026');
      await fireEvent.click(bar.getByRole('button', { name: /Merge into…/ }));
      const dialog = within(await screen.findByRole('dialog', { name: 'Merge 2 albums into…' }));
      await fireEvent.click(dialog.getByRole('radio', { name: /Winter 2026/ }));
      await fireEvent.submit(dialog.getByRole('button', { name: 'Merge 1 album' }).closest('form')!);

      await waitFor(() =>
        expect(sdkMock.mergeAlbumsInto).toHaveBeenCalledWith({
          id: 'winter',
          albumMergeIntoDto: { otherIds: ['rockies'] },
        }),
      );
    });

    it('opens one menu for all the chosen albums on a right-click on one of them', async () => {
      sdkMock.mergeAlbumsInto.mockResolvedValue({ runId: 'run-many', winnerId: 'rockies' });
      renderWithTooltips(AlbumDirectory, { tree, onRefresh: vi.fn() });
      await choose('Summer in the Rockies', 'Winter 2026');

      const tile = document.querySelector('article[aria-label="Winter 2026"]') as HTMLElement;
      await fireEvent.contextMenu(tile, { clientX: 60, clientY: 90 });
      const menu = within(await screen.findByRole('menu', { name: 'Actions for the chosen albums' }));
      expect(screen.queryByRole('menu', { name: 'Actions for Winter 2026' })).toBeNull();
      await fireEvent.click(menu.getByRole('menuitem', { name: /Merge into…/ }));

      expect(await screen.findByRole('dialog', { name: 'Merge 2 albums into…' })).toBeInTheDocument();
    });

    it('keeps an album’s own menu on a right-click on an album that is not chosen', async () => {
      renderWithTooltips(AlbumDirectory, { tree, onRefresh: vi.fn() });
      await choose('Summer in the Rockies', 'Winter 2026');

      const tile = document.querySelector('article[aria-label="Trail camera"]') as HTMLElement;
      await fireEvent.contextMenu(tile, { clientX: 60, clientY: 90 });

      expect(await screen.findByRole('menu', { name: 'Actions for Trail camera' })).toBeInTheDocument();
      expect(screen.queryByRole('menu', { name: 'Actions for the chosen albums' })).toBeNull();
    });

    it('starts choosing with a Ctrl- or Cmd-click on a tile, without opening the album', async () => {
      renderWithTooltips(AlbumDirectory, { tree, onRefresh: vi.fn() });

      const cover = within(screen.getByRole('article', { name: 'Summer in the Rockies' })).getAllByRole('link')[0];
      const opened = fireEvent.click(cover, { metaKey: true });
      expect(await opened).toBe(false);
      await fireEvent.click(screen.getByRole('article', { name: 'Winter 2026' }), { ctrlKey: true });

      const bar = within(screen.getByRole('toolbar', { name: 'Actions for the chosen albums' }));
      expect(bar.getByRole('status')).toHaveTextContent('2 selected');
      expect(screen.getByRole('checkbox', { name: 'Select “Summer in the Rockies”' })).toBeChecked();

      await fireEvent.click(screen.getByRole('checkbox', { name: 'Select “Winter 2026”' }), { metaKey: true });
      expect(bar.getByRole('status')).toHaveTextContent('1 selected');
    });

    it('offers no merge or lock while a smart album someone else owns is chosen', async () => {
      renderWithTooltips(AlbumDirectory, { tree, onRefresh: vi.fn() });

      const bar = await choose('Summer in the Rockies', 'Trail camera');
      expect(bar.getByRole('button', { name: /Merge into…/ })).toBeDisabled();
      expect(bar.getByRole('button', { name: /Move to…/ })).toBeDisabled();
      expect(bar.getByRole('button', { name: /Lock album…/ })).toBeDisabled();
    });
  });

  describe('Merge with…', () => {
    const openMenu = async (name: string) => {
      await fireEvent.click(screen.getByRole('button', { name: `Actions for ${name}` }));
      return within(await screen.findByRole('menu', { name: `Actions for ${name}` }));
    };
    const preview = { winnerId: 'rockies', total: 12, inBoth: 0, winnerShared: false, loserShared: false };
    // Toasts outlive the test that raised them, so earlier merges may still be on screen.
    const latestUndo = async () => (await screen.findAllByRole('button', { name: 'Undo' })).at(-1)!;
    const chooseWinter = async () => {
      const dialog = await screen.findByRole('dialog', { name: 'Merge “Summer in the Rockies” with' });
      await fireEvent.click(within(dialog).getByRole('button', { name: /Winter 2026/ }));
    };

    const merge = async (onRefresh = vi.fn()) => {
      sdkMock.getAlbumMergePreview.mockResolvedValue(preview);
      sdkMock.mergeAlbum.mockResolvedValue({ runId: 'run-1', winnerId: 'rockies' });
      renderWithTooltips(AlbumDirectory, { tree, onRefresh });
      const menu = await openMenu('Summer in the Rockies');
      await fireEvent.click(menu.getByRole('menuitem', { name: 'Merge with…' }));
      await chooseWinter();
      await fireEvent.click(await screen.findByRole('button', { name: 'Merge albums' }));
      await waitFor(() =>
        expect(sdkMock.mergeAlbum).toHaveBeenCalledWith({ id: 'rockies', albumMergeDto: { otherId: 'winter' } }),
      );
      return onRefresh;
    };

    it('sits right after Move to… on an album the person owns', async () => {
      renderWithTooltips(AlbumDirectory, { tree, onRefresh: vi.fn() });

      const labels = (await openMenu('Summer in the Rockies'))
        .getAllByRole('menuitem')
        .map((item) => item.textContent?.trim());

      expect(labels[labels.indexOf('Move to…') + 1]).toBe('Merge with…');
    });

    it.each([
      ['a collection', 'Family'],
      ['a shared space', 'Family Space'],
      ['someone else’s smart album', 'Trail camera'],
    ])('is not offered on %s', async (_kind, name) => {
      renderWithTooltips(AlbumDirectory, { tree, onRefresh: vi.fn() });

      expect((await openMenu(name)).queryByRole('menuitem', { name: 'Merge with…' })).toBeNull();
    });

    it('says which album stayed and refreshes', async () => {
      const onRefresh = await merge();

      expect(await screen.findByText('Merged “Winter 2026” into “Summer in the Rockies”')).toBeInTheDocument();
      expect(onRefresh).toHaveBeenCalled();
    });

    it('takes the merge back from the message', async () => {
      sdkMock.undoLatestAlbumChangeRun.mockResolvedValue({ reversed: 4, skipped: [] });
      await merge();

      await fireEvent.click(await latestUndo());

      await waitFor(() => expect(sdkMock.undoLatestAlbumChangeRun).toHaveBeenCalled());
      expect(sdkMock.undoLatestAlbumChangeRun.mock.calls[0][0]).toEqual({
        albumChangeUndoDto: { runId: expect.any(String) },
      });
      expect(await screen.findByText('Merge undone')).toBeInTheDocument();
    });

    it('says to undo the newer change first when this merge is no longer the latest', async () => {
      sdkMock.isHttpError.mockReturnValue(true);
      sdkMock.undoLatestAlbumChangeRun.mockRejectedValue(Object.assign(new Error('conflict'), { status: 409 }));
      await merge();

      await fireEvent.click(await latestUndo());

      expect(await screen.findByText('Undo your newer change first, then this one.')).toBeInTheDocument();
    });

    it('says what Undo kept because it was changed after the merge', async () => {
      sdkMock.undoLatestAlbumChangeRun.mockResolvedValue({ reversed: 4, skipped: ['Beach', 'Lake'] });
      await merge();

      await fireEvent.click(await latestUndo());

      expect(await screen.findByText('Merge undone. Your later changes to Beach, Lake were kept.')).toBeInTheDocument();
    });

    it('leaves the page of an album that was merged away', async () => {
      app.page.url = new URL('http://localhost/albums/winter');
      await merge();

      await waitFor(() => expect(app.goto).toHaveBeenCalledWith(expect.stringContaining('rockies')));
    });

    it('tells the person when the merge fails, and refreshes nothing', async () => {
      sdkMock.getAlbumMergePreview.mockResolvedValue(preview);
      sdkMock.mergeAlbum.mockRejectedValue(new Error('refused'));
      const onRefresh = vi.fn();
      renderWithTooltips(AlbumDirectory, { tree, onRefresh });
      const menu = await openMenu('Summer in the Rockies');
      await fireEvent.click(menu.getByRole('menuitem', { name: 'Merge with…' }));
      await chooseWinter();
      await fireEvent.click(await screen.findByRole('button', { name: 'Merge albums' }));

      await waitFor(() => expect(sdkMock.mergeAlbum).toHaveBeenCalled());
      expect(onRefresh).not.toHaveBeenCalled();
    });
  });

  it('deletes an owned album through the Frameleaf confirmation, keeping its items', async () => {
    const onRefresh = vi.fn();
    sdkMock.deleteAlbum.mockResolvedValue(undefined as never);
    renderWithTooltips(AlbumDirectory, { tree, onRefresh });

    await fireEvent.click(screen.getByRole('button', { name: 'Actions for Summer in the Rockies' }));
    const menu = within(await screen.findByRole('menu', { name: 'Actions for Summer in the Rockies' }));
    // Owner-only; the key renders literally until the copy lands in en.json.
    expect(menu.getByRole('menuitem', { name: /^(Create link|frameleaf_albums_create_link)$/ })).toBeInTheDocument();
    await fireEvent.click(menu.getByRole('menuitem', { name: 'Delete' }));

    const dialog = await screen.findByRole('dialog', { name: 'Delete “Summer in the Rockies”?' });
    expect(dialog).toHaveTextContent('Its 10 items stay in your library.');
    await fireEvent.click(screen.getByRole('button', { name: 'Delete album' }));

    await waitFor(() => expect(sdkMock.deleteAlbum).toHaveBeenCalledWith({ id: 'rockies' }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
  });

  it('says once, with the count, that a deleted collection keeps its albums (LIB-04)', async () => {
    renderWithTooltips(AlbumDirectory, { tree, onRefresh: vi.fn() });

    await fireEvent.click(screen.getByRole('button', { name: 'Actions for Family' }));
    const menu = within(await screen.findByRole('menu', { name: 'Actions for Family' }));
    await fireEvent.click(menu.getByRole('menuitem', { name: 'Delete' }));

    const dialog = await screen.findByRole('dialog', { name: 'Delete “Family”?' });
    expect(dialog).toHaveTextContent(
      'The collection is removed. Its children move to its parent, or to the top level. Its 1 child album stays in your library.',
    );
    expect(dialog.textContent?.match(/stays? in your library/g)).toHaveLength(1);

    const format = get(t);
    expect(format('frameleaf_album_delete_collection_keep', { values: { count: 1 } })).toBe(
      'Its 1 child album stays in your library.',
    );
  });

  it('leaves a shared album through the Frameleaf confirmation as “me”', async () => {
    const onRefresh = vi.fn();
    sdkMock.removeUserFromAlbum.mockResolvedValue(undefined as never);
    renderWithTooltips(AlbumDirectory, { tree, onRefresh });

    await fireEvent.click(screen.getByRole('button', { name: 'Actions for Trail camera' }));
    const menu = within(await screen.findByRole('menu', { name: 'Actions for Trail camera' }));
    expect(menu.queryByRole('menuitem', { name: /^(Create link|frameleaf_albums_create_link)$/ })).toBeNull();
    await fireEvent.click(menu.getByRole('menuitem', { name: 'Leave' }));

    await screen.findByRole('dialog', { name: 'Leave “Trail camera”?' });
    await fireEvent.click(screen.getByRole('button', { name: 'Leave album' }));

    await waitFor(() => expect(sdkMock.removeUserFromAlbum).toHaveBeenCalledWith({ id: 'trail', userId: 'me' }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
  });

  it('edits an album in the Frameleaf edit dialog, not the legacy modal (AL-2)', async () => {
    sdkMock.getAlbumIconCatalogue.mockResolvedValue({ version: '7.4.47', names: [], suggested: [] });
    sdkMock.updateAlbumInfo.mockResolvedValue({ ...rockies, albumName: 'Rockies' });
    renderWithTooltips(AlbumDirectory, { tree, onRefresh: vi.fn() });

    await fireEvent.click(screen.getByRole('button', { name: 'Actions for Summer in the Rockies' }));
    const menu = within(await screen.findByRole('menu', { name: 'Actions for Summer in the Rockies' }));
    await fireEvent.click(menu.getByRole('menuitem', { name: 'Edit' }));

    const dialog = within(await screen.findByRole('dialog', { name: 'Edit album' }));
    const name = dialog.getByRole('textbox', { name: 'Name' });
    expect(name).toHaveValue('Summer in the Rockies');
    await fireEvent.input(name, { target: { value: 'Rockies' } });
    await fireEvent.click(dialog.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(sdkMock.updateAlbumInfo).toHaveBeenCalledWith({
        id: 'rockies',
        updateAlbumDto: expect.objectContaining({ albumName: 'Rockies' }),
      }),
    );
    // The collection did not change, so nothing is moved.
    expect(sdkMock.moveAlbumToCollection).not.toHaveBeenCalled();
  });

  it('locks an album from its menu only after asking (FL-1296)', async () => {
    sdkMock.updateAlbumInfo.mockResolvedValue({ ...rockies, isLocked: true });
    const onRefresh = vi.fn();
    renderWithTooltips(AlbumDirectory, { tree, onRefresh });

    await fireEvent.click(screen.getByRole('button', { name: 'Actions for Summer in the Rockies' }));
    const menu = within(await screen.findByRole('menu', { name: 'Actions for Summer in the Rockies' }));
    await fireEvent.click(menu.getByRole('menuitem', { name: 'Lock album…' }));

    const dialog = within(await screen.findByRole('dialog', { name: 'Lock “Summer in the Rockies”?' }));
    expect(sdkMock.updateAlbumInfo).not.toHaveBeenCalled();
    await fireEvent.click(dialog.getByRole('button', { name: 'Lock album' }));

    await waitFor(() =>
      expect(sdkMock.updateAlbumInfo).toHaveBeenCalledWith({ id: 'rockies', updateAlbumDto: { isLocked: true } }),
    );
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
  });

  it('unlocks a locked album from its menu without asking (FL-1296)', async () => {
    sdkMock.updateAlbumInfo.mockResolvedValue({ ...rockies, isLocked: false });
    const locked = { ...rockies, isLocked: true };
    const lockedTree = { ...tree, albums: tree.albums.map((album) => (album.id === rockies.id ? locked : album)) };
    renderWithTooltips(AlbumDirectory, { tree: lockedTree, onRefresh: vi.fn() });

    await fireEvent.click(screen.getByRole('button', { name: 'Actions for Summer in the Rockies' }));
    const menu = within(await screen.findByRole('menu', { name: 'Actions for Summer in the Rockies' }));
    expect(menu.queryByRole('menuitem', { name: 'Lock album…' })).toBeNull();
    await fireEvent.click(menu.getByRole('menuitem', { name: 'Unlock album' }));

    await waitFor(() =>
      expect(sdkMock.updateAlbumInfo).toHaveBeenCalledWith({ id: 'rockies', updateAlbumDto: { isLocked: false } }),
    );
  });

  it('offers Lock only to the owner, and only on albums (FL-1296)', async () => {
    renderWithTooltips(AlbumDirectory, { tree, onRefresh: vi.fn() });

    await fireEvent.click(screen.getByRole('button', { name: 'Actions for Trail camera' }));
    const shared = within(await screen.findByRole('menu', { name: 'Actions for Trail camera' }));
    expect(shared.queryByRole('menuitem', { name: 'Lock album…' })).toBeNull();
    await fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    await fireEvent.click(screen.getByRole('button', { name: 'Actions for Family' }));
    const collection = within(await screen.findByRole('menu', { name: 'Actions for Family' }));
    expect(collection.queryByRole('menuitem', { name: 'Lock album…' })).toBeNull();
  });

  it('re-evaluates a built-in smart album scoped to its own kind (AL-6)', async () => {
    const { authManager } = await import('$lib/managers/auth-manager.svelte');
    const { modalManager } = await import('@frameleaf/ui');
    const show = vi.spyOn(modalManager, 'show').mockResolvedValue(undefined as never);
    (authManager.user as { isAdmin: boolean }).isAdmin = true;
    try {
      const food = owned({ id: 'food', albumName: 'Food', isSmart: true, smartKind: SmartAlbumBuiltInKind.Food });
      renderWithTooltips(AlbumDirectory, { tree: { ...tree, albums: [food] }, onRefresh: vi.fn() });

      await fireEvent.click(screen.getByRole('button', { name: 'Actions for Food' }));
      const menu = within(await screen.findByRole('menu', { name: 'Actions for Food' }));
      await fireEvent.click(menu.getByRole('menuitem', { name: 'Re-evaluate' }));

      await waitFor(() => expect(show).toHaveBeenCalledWith(expect.anything(), { kind: 'food', kindLabel: 'Food' }));
    } finally {
      (authManager.user as { isAdmin: boolean }).isAdmin = false;
      show.mockRestore();
    }
  });

  it('shares an album in the Frameleaf share dialog with a searchable invite list (AL-3, AL-15)', async () => {
    sdkMock.searchUsers.mockResolvedValue([jamie]);
    renderWithTooltips(AlbumDirectory, { tree, onRefresh: vi.fn() });

    await fireEvent.click(screen.getByRole('button', { name: 'Actions for Summer in the Rockies' }));
    const menu = within(await screen.findByRole('menu', { name: 'Actions for Summer in the Rockies' }));
    await fireEvent.click(menu.getByRole('menuitem', { name: 'Share' }));

    const dialog = within(await screen.findByRole('dialog', { name: 'Share album' }));
    const people = await dialog.findByRole('listbox', { name: 'People to invite' });
    expect(within(people).getByRole('option', { name: /Jamie/ })).toBeInTheDocument();
    expect(dialog.queryByRole('combobox', { name: /search/i })).toBeNull();
  });

  describe('custom order (FL-52)', () => {
    // FL-1836: arranging works on the whole level, so it is offered with Group by None.
    const useCustomOrder = () =>
      albumDirectoryView.set({ ...defaultAlbumDirectoryView, sort: 'custom', group: 'none', hideEmpty: false });

    it('offers “Custom order” in the Frameleaf sort menu and shows the server’s own order', async () => {
      const reordered: AlbumTreeResponseDto = { ...tree, albums: [winter, rockies, trail] };
      renderWithTooltips(AlbumDirectory, { tree: reordered, onRefresh: vi.fn() });

      await fireEvent.click(screen.getByRole('button', { name: 'Sort albums' }));
      const menu = within(await screen.findByRole('menu', { name: 'Sort albums' }));
      expect(menu.getByRole('menuitemcheckbox', { name: 'Date of photos' })).toHaveAttribute('aria-checked', 'true');
      await fireEvent.click(menu.getByRole('menuitemcheckbox', { name: 'Custom order' }));

      const section = screen.getAllByRole('region', { name: 'Albums' }).find((el) => el.classList.contains('group'));
      const names = [...section!.querySelectorAll('article')].map((tile) => tile.getAttribute('aria-label'));
      expect(names).toEqual(['Winter 2026', 'Summer in the Rockies']);
    });

    it('moves an album earlier from its menu (the keyboard alternative) and saves the whole group', async () => {
      useCustomOrder();
      const onRefresh = vi.fn();
      sdkMock.setAlbumOrder.mockResolvedValue(undefined as never);
      renderWithTooltips(AlbumDirectory, { tree, onRefresh });

      await fireEvent.click(screen.getByRole('button', { name: 'Actions for Winter 2026' }));
      const menu = within(await screen.findByRole('menu', { name: 'Actions for Winter 2026' }));
      await fireEvent.click(menu.getByRole('menuitem', { name: 'Move earlier' }));

      await waitFor(() =>
        expect(sdkMock.setAlbumOrder).toHaveBeenCalledWith({
          albumOrderDto: { parentId: null, albumIds: ['family', 'winter', 'rockies', 'trail'], hierarchy: true },
        }),
      );
      await waitFor(() => expect(onRefresh).toHaveBeenCalled());
      const announcement = await screen.findByText(/“Winter 2026” is now 2 of 4/);
      expect(announcement.closest('[role="status"]')).toHaveAttribute('data-testid', 'frameleaf-toast');
      // the moved tile is marked so the eye finds it
      await waitFor(() => expect(screen.getByRole('article', { name: 'Winter 2026' })).toHaveClass('moved'));
    });

    it('arranges collections at the top level too', async () => {
      useCustomOrder();
      const trips = owned({ id: 'trips', albumName: 'Trips', kind: AlbumKind.Collection });
      sdkMock.setAlbumOrder.mockResolvedValue(undefined as never);
      renderWithTooltips(AlbumDirectory, {
        tree: {
          ...tree,
          collections: [...tree.collections, { collection: trips, albums: [], albumCount: 0, assetCount: 0 }],
        },
        onRefresh: vi.fn(),
      });

      await fireEvent.click(screen.getByRole('button', { name: 'Actions for Trips' }));
      const menu = within(await screen.findByRole('menu', { name: 'Actions for Trips' }));
      await fireEvent.click(menu.getByRole('menuitem', { name: 'Move earlier' }));

      await waitFor(() =>
        expect(sdkMock.setAlbumOrder).toHaveBeenCalledWith({
          albumOrderDto: {
            parentId: null,
            albumIds: ['trips', 'family', 'rockies', 'winter', 'trail'],
            hierarchy: true,
          },
        }),
      );
    });

    it('drops a dragged album on another in its group to put it just before', async () => {
      useCustomOrder();
      sdkMock.setAlbumOrder.mockResolvedValue(undefined as never);
      renderWithTooltips(AlbumDirectory, { tree, onRefresh: vi.fn() });
      const dataTransfer = {
        types: ['application/x-immich-album-id'],
        getData: () => 'winter',
        setData: vi.fn(),
        effectAllowed: 'move',
        dropEffect: 'none',
      };
      const dragged = screen.getByRole('article', { name: 'Winter 2026' });
      const target = screen.getByRole('article', { name: 'Summer in the Rockies' });

      await fireEvent.dragStart(dragged, { dataTransfer });
      await fireEvent.dragOver(target, { dataTransfer });
      expect(target).toHaveClass('drop-before');
      await fireEvent.drop(target, { dataTransfer });

      await waitFor(() =>
        expect(sdkMock.setAlbumOrder).toHaveBeenCalledWith({
          albumOrderDto: { parentId: null, albumIds: ['family', 'winter', 'rockies', 'trail'], hierarchy: true },
        }),
      );
      // Arranging never moves the album anywhere.
      expect(sdkMock.moveAlbumToCollection).not.toHaveBeenCalled();
    });

    it('lets anyone arrange their own view, including albums shared with them', () => {
      useCustomOrder();
      renderWithTooltips(AlbumDirectory, { tree, onRefresh: vi.fn() });
      expect(screen.getByRole('article', { name: 'Trail camera' })).toHaveAttribute('draggable', 'true');
    });

    it('offers no arranging while a filter or a search hides part of a group', async () => {
      useCustomOrder();
      renderWithTooltips(AlbumDirectory, { tree, onRefresh: vi.fn() });
      await fireEvent.input(screen.getByRole('searchbox', { name: 'Search albums' }), { target: { value: 'winter' } });

      await fireEvent.click(screen.getByRole('button', { name: 'Actions for Winter 2026' }));
      const menu = within(await screen.findByRole('menu', { name: 'Actions for Winter 2026' }));
      expect(menu.queryByRole('menuitem', { name: 'Move earlier' })).toBeNull();
    });

    it('reloads and says so when the server refuses an order from a stale tree', async () => {
      useCustomOrder();
      const onRefresh = vi.fn();
      sdkMock.setAlbumOrder.mockRejectedValue(Object.assign(new Error('Conflict'), { status: 409 }));
      renderWithTooltips(AlbumDirectory, { tree, onRefresh });

      await fireEvent.click(screen.getByRole('button', { name: 'Actions for Winter 2026' }));
      const menu = within(await screen.findByRole('menu', { name: 'Actions for Winter 2026' }));
      await fireEvent.click(menu.getByRole('menuitem', { name: 'Move earlier' }));

      await waitFor(() => expect(onRefresh).toHaveBeenCalled());
      expect(directoryStatus()).toHaveTextContent('Your albums changed since this page loaded');
    });

    it('reloads and says so when a move is refused because the album was moved since (stale moved node)', async () => {
      const onRefresh = vi.fn();
      sdkMock.moveAlbumToCollection.mockRejectedValue(Object.assign(new Error('Conflict'), { status: 409 }));
      app.page.url = new URL('http://localhost/albums?in=family');
      renderWithTooltips(AlbumDirectory, { tree, onRefresh });

      await fireEvent.click(screen.getByRole('button', { name: 'Actions for Cabin weekend' }));
      const menu = within(await screen.findByRole('menu', { name: 'Actions for Cabin weekend' }));
      await fireEvent.click(menu.getByRole('menuitem', { name: 'Move to…' }));
      const dialog = within(await screen.findByRole('dialog', { name: /Move “Cabin weekend”/ }));
      await fireEvent.click(dialog.getByRole('radio', { name: /Top level/ }));
      await fireEvent.click(dialog.getByRole('button', { name: 'Move here' }));

      await waitFor(() => expect(onRefresh).toHaveBeenCalled());
      expect(directoryStatus()).toHaveTextContent('Your albums changed since this page loaded');
    });
  });

  it('reparents with the keyboard through Move to…, without dragging', async () => {
    const onRefresh = vi.fn();
    const trips = owned({ id: 'trips', albumName: 'Trips', kind: AlbumKind.Collection });
    sdkMock.moveAlbumToCollection.mockResolvedValue({ ...rockies, parentId: 'trips' });
    renderWithTooltips(AlbumDirectory, {
      tree: {
        ...tree,
        collections: [...tree.collections, { collection: trips, albums: [], albumCount: 0, assetCount: 0 }],
      },
      onRefresh,
    });

    const trigger = screen.getByRole('button', { name: 'Actions for Summer in the Rockies' });
    trigger.focus();
    await fireEvent.click(trigger);
    const menu = within(await screen.findByRole('menu', { name: 'Actions for Summer in the Rockies' }));
    await fireEvent.click(menu.getByRole('menuitem', { name: 'Move to…' }));

    const dialog = within(await screen.findByRole('dialog', { name: /Move “Summer in the Rockies”/ }));
    const destination = dialog.getByRole('radio', { name: /Trips/ });
    destination.focus();
    await fireEvent.click(destination);
    await fireEvent.submit(dialog.getByRole('button', { name: 'Move here' }).closest('form')!);

    await waitFor(() =>
      expect(sdkMock.moveAlbumToCollection).toHaveBeenCalledWith({
        id: 'rockies',
        moveAlbumDto: { collectionId: 'trips', expectedParentId: null },
      }),
    );
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
    expect(await screen.findByText(/Summer in the Rockies.*Trips/)).toBeInTheDocument();
  });

  it('keeps a collection and everything inside it listed but refused when moving it, saying why', async () => {
    renderWithTooltips(AlbumDirectory, { tree, onRefresh: vi.fn() });

    await fireEvent.click(screen.getByRole('button', { name: 'Actions for Family' }));
    const menu = within(await screen.findByRole('menu', { name: 'Actions for Family' }));
    await fireEvent.click(menu.getByRole('menuitem', { name: 'Move to…' }));
    const dialog = within(await screen.findByRole('dialog', { name: /Move “Family”/ }));

    const self = dialog.getByRole('radio', { name: /^Family This is the one/ });
    expect(self).toBeDisabled();
    expect(self).toHaveAccessibleDescription('This is the one you’re moving');
    const inside = dialog.getByRole('radio', { name: /Cabin weekend/ });
    expect(inside).toBeDisabled();
    expect(inside).toHaveAccessibleDescription('It’s inside the one you’re moving');

    await fireEvent.input(dialog.getByRole('searchbox', { name: 'Find a collection' }), {
      target: { value: 'cabin' },
    });
    expect(dialog.getByText('Family')).toBeInTheDocument();
    expect(dialog.queryByRole('radio', { name: /Top level/ })).toBeNull();
  });

  it('never offers Move to… or a drag to an editor of someone else’s album (FL-83 AL-9)', async () => {
    const shared = albumFactory.build({
      id: 'shared-edit',
      albumName: 'Jamie’s trip',
      albumUsers: [
        { user: jamie, role: AlbumUserRole.Owner },
        { user: me, role: AlbumUserRole.Editor },
      ],
    });
    renderWithTooltips(AlbumDirectory, { tree: { ...tree, albums: [trail, shared] }, onRefresh: vi.fn() });

    expect(screen.getByRole('article', { name: 'Jamie’s trip' })).toHaveAttribute('draggable', 'false');
    await fireEvent.click(screen.getByRole('button', { name: 'Actions for Jamie’s trip' }));
    const menu = within(await screen.findByRole('menu', { name: 'Actions for Jamie’s trip' }));
    // The editor still edits the album; only its place is the owner's.
    expect(menu.getByRole('menuitem', { name: 'Edit' })).toBeInTheDocument();
    expect(menu.queryByRole('menuitem', { name: 'Move to…' })).toBeNull();
  });

  it('never lets a viewer drag someone else’s album', () => {
    renderWithTooltips(AlbumDirectory, { tree, onRefresh: vi.fn() });
    expect(screen.getByRole('article', { name: 'Trail camera' })).toHaveAttribute('draggable', 'false');
    expect(screen.getByRole('article', { name: 'Summer in the Rockies' })).toHaveAttribute('draggable', 'true');
  });

  describe('thousands of albums (FL-1297)', () => {
    type Callback = (entries: Partial<IntersectionObserverEntry>[]) => void;
    let notify: Callback;
    const observers: { options?: IntersectionObserverInit }[] = [];

    const useObserver = () => {
      observers.length = 0;
      vi.stubGlobal(
        'IntersectionObserver',
        vi.fn(function (callback: Callback, options?: IntersectionObserverInit) {
          notify = callback;
          observers.push({ options });
          return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
        }),
      );
    };
    const cell = (id: string) =>
      [...document.querySelectorAll<HTMLElement>('[data-album-id]')].find(
        (element) => element.dataset.albumId === id && !element.classList.contains('shelf-tint'),
      )!;
    const placeholderIn = (id: string) => cell(id).querySelector('[data-testid="album-placeholder"]');
    const nearView = async (id: string, isIntersecting = true) => {
      notify([{ target: cell(id), isIntersecting }]);
      await tick();
    };
    const flatTree = (...albums: ReturnType<typeof owned>[]): AlbumTreeResponseDto => ({
      collections: [],
      albums,
      spaces: [],
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    it('keeps a waiting album reachable by name and moves focus onto its tile when reached', async () => {
      useObserver();
      const far = owned({ id: 'far', albumName: 'Far' });
      renderWithTooltips(AlbumDirectory, { tree: flatTree(far), onRefresh: vi.fn() });

      screen.getByRole('link', { name: 'Far' }).focus();

      await waitFor(() => expect(placeholderIn('far')).toBeNull());
      expect(cell('far').contains(document.activeElement)).toBe(true);
    });

    it.each(['grid', 'list'] as const)('builds a %s tile and its menu only once it nears the view', async (mode) => {
      useObserver();
      albumDirectoryView.set({ ...defaultAlbumDirectoryView, view: mode, hideEmpty: false });
      const near = owned({ id: 'near', albumName: 'Near' });
      const far = owned({ id: 'far', albumName: 'Far' });
      renderWithTooltips(AlbumDirectory, { tree: flatTree(near, far), onRefresh: vi.fn() });

      expect(observers).toHaveLength(1);
      expect(screen.queryByRole('article')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Actions for Near' })).toBeNull();
      expect(placeholderIn('near')).not.toBeNull();

      await nearView('near');

      expect(screen.getByRole('article', { name: 'Near' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Actions for Near' })).toBeInTheDocument();
      expect(screen.queryByRole('article', { name: 'Far' })).toBeNull();
      expect(placeholderIn('far')).not.toBeNull();
    });

    it('keeps a tile built after it has scrolled away', async () => {
      useObserver();
      const album = owned({ id: 'kept', albumName: 'Kept' });
      renderWithTooltips(AlbumDirectory, { tree: flatTree(album), onRefresh: vi.fn() });

      await nearView('kept');
      await nearView('kept', false);

      expect(screen.getByRole('article', { name: 'Kept' })).toBeInTheDocument();
    });

    it('still lists every album by its cell while tiles are waiting', async () => {
      useObserver();
      const albums = Array.from({ length: 50 }, (_, index) => owned({ id: `album-${index}` }));
      renderWithTooltips(AlbumDirectory, { tree: flatTree(...albums), onRefresh: vi.fn() });
      // Two rows first, then the rest of the section on request (FL-1836).
      await fireEvent.click(screen.getByRole('button', { name: /^Show 38 more/ }));

      expect(document.querySelectorAll('[data-testid="album-placeholder"]')).toHaveLength(50);
    });

    /** `renderWithTooltips` mounts a wrapper, so a new tree goes through the wrapper's own props. */
    const wrapped = (next: AlbumTreeResponseDto, onRefresh: () => void) =>
      ({ component: AlbumDirectory, componentProps: { tree: next, onRefresh } }) as never;

    const pendingAlbum = owned({ id: 'pending', albumName: 'Pending', assetCount: 0, statsPending: true });
    const counted = owned({ id: 'counted', albumName: 'Counted', assetCount: 3 });

    it('asks again every 3 seconds while an album is waiting for its numbers', async () => {
      vi.useFakeTimers();
      const onRefresh = vi.fn();
      const { rerender } = renderWithTooltips(AlbumDirectory, { tree: flatTree(pendingAlbum), onRefresh });
      await tick();

      await vi.advanceTimersByTimeAsync(2999);
      expect(onRefresh).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(onRefresh).toHaveBeenCalledTimes(1);

      await rerender(wrapped(flatTree(pendingAlbum), onRefresh));
      await vi.advanceTimersByTimeAsync(3000);
      expect(onRefresh).toHaveBeenCalledTimes(2);
    });

    /** FL-1802 */
    it('asks for the waiting albums’ numbers alone, and reads the tree only once they arrive', async () => {
      vi.useFakeTimers();
      const onRefresh = vi.fn();
      sdkMock.getAlbumStats.mockResolvedValue({ albums: [{ id: 'pending', assetCount: 0, statsPending: true }] });
      renderWithTooltips(AlbumDirectory, { tree: flatTree(pendingAlbum, counted), onRefresh });
      await tick();

      await vi.advanceTimersByTimeAsync(9000);
      expect(sdkMock.getAlbumStats).toHaveBeenCalledTimes(3);
      expect(sdkMock.getAlbumStats).toHaveBeenLastCalledWith({ albumStatsDto: { albumIds: ['pending'] } });
      expect(onRefresh).not.toHaveBeenCalled();

      sdkMock.getAlbumStats.mockResolvedValue({ albums: [{ id: 'pending', assetCount: 12 }] });
      await vi.advanceTimersByTimeAsync(3000);
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('reads the tree when a waiting album is no longer in the answer', async () => {
      vi.useFakeTimers();
      const onRefresh = vi.fn();
      sdkMock.getAlbumStats.mockResolvedValue({ albums: [] });
      renderWithTooltips(AlbumDirectory, { tree: flatTree(pendingAlbum), onRefresh });
      await tick();
      await vi.advanceTimersByTimeAsync(3000);
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('answers a burst of album changes with one read', async () => {
      vi.useFakeTimers();
      const onRefresh = vi.fn();
      renderWithTooltips(AlbumDirectory, { tree: flatTree(counted), onRefresh });
      await tick();
      for (let change = 0; change < 12; change++) {
        eventManager.emit('AlbumUpdate', counted);
      }
      eventManager.emit('AlbumDelete', counted);
      expect(onRefresh).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(250);
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('stops asking once the numbers have arrived', async () => {
      vi.useFakeTimers();
      const onRefresh = vi.fn();
      const { rerender } = renderWithTooltips(AlbumDirectory, { tree: flatTree(pendingAlbum), onRefresh });
      await tick();
      await vi.advanceTimersByTimeAsync(3000);
      expect(onRefresh).toHaveBeenCalledTimes(1);

      await rerender(wrapped(flatTree(counted), onRefresh));
      await vi.advanceTimersByTimeAsync(30_000);

      expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('gives up after 20 tries', async () => {
      vi.useFakeTimers();
      const onRefresh = vi.fn();
      const { rerender } = renderWithTooltips(AlbumDirectory, { tree: flatTree(pendingAlbum), onRefresh });
      await tick();

      for (let attempt = 0; attempt < 25; attempt++) {
        await vi.advanceTimersByTimeAsync(3000);
        await rerender(wrapped(flatTree(pendingAlbum), onRefresh));
      }

      expect(onRefresh).toHaveBeenCalledTimes(20);
    });

    it('asks again for an album that starts waiting after it gave up', async () => {
      vi.useFakeTimers();
      const onRefresh = vi.fn();
      const { rerender } = renderWithTooltips(AlbumDirectory, { tree: flatTree(pendingAlbum), onRefresh });
      await tick();
      for (let attempt = 0; attempt < 25; attempt++) {
        await vi.advanceTimersByTimeAsync(3000);
        await rerender(wrapped(flatTree(pendingAlbum), onRefresh));
      }
      expect(onRefresh).toHaveBeenCalledTimes(20);

      const another = owned({ id: 'another', albumName: 'Another', assetCount: 0, statsPending: true });
      await rerender(wrapped(flatTree(pendingAlbum, another), onRefresh));
      await vi.advanceTimersByTimeAsync(3000);

      expect(onRefresh).toHaveBeenCalledTimes(21);
    });

    it('gives an album the full wait when it starts waiting again', async () => {
      vi.useFakeTimers();
      const onRefresh = vi.fn();
      const another = owned({ id: 'another', albumName: 'Another', assetCount: 0, statsPending: true });
      const { rerender } = renderWithTooltips(AlbumDirectory, { tree: flatTree(pendingAlbum, another), onRefresh });
      await tick();
      // Still listed with its numbers, so no tile leaves the page and starts a leave animation.
      const arrived = { ...another, statsPending: false };
      await rerender(wrapped(flatTree(pendingAlbum, arrived), onRefresh));
      for (let attempt = 0; attempt < 25; attempt++) {
        await vi.advanceTimersByTimeAsync(3000);
        await rerender(wrapped(flatTree(pendingAlbum, arrived), onRefresh));
      }
      expect(onRefresh).toHaveBeenCalledTimes(20);

      await rerender(wrapped(flatTree(pendingAlbum, another), onRefresh));
      await vi.advanceTimersByTimeAsync(3000);

      expect(onRefresh).toHaveBeenCalledTimes(21);
    });

    it('never asks when nothing is waiting', async () => {
      vi.useFakeTimers();
      const onRefresh = vi.fn();
      renderWithTooltips(AlbumDirectory, { tree: flatTree(counted), onRefresh });
      await tick();

      await vi.advanceTimersByTimeAsync(30_000);

      expect(onRefresh).not.toHaveBeenCalled();
    });

    it('stops asking when the page is left', async () => {
      vi.useFakeTimers();
      const onRefresh = vi.fn();
      const { unmount } = renderWithTooltips(AlbumDirectory, { tree: flatTree(pendingAlbum), onRefresh });
      await tick();

      unmount();
      await vi.advanceTimersByTimeAsync(30_000);

      expect(onRefresh).not.toHaveBeenCalled();
    });

    it('still offers Download for an album whose count has not arrived', async () => {
      renderWithTooltips(AlbumDirectory, { tree: flatTree(pendingAlbum), onRefresh: vi.fn() });

      await fireEvent.click(screen.getByRole('button', { name: 'Actions for Pending' }));
      const menu = within(await screen.findByRole('menu', { name: 'Actions for Pending' }));

      expect(menu.getByRole('menuitem', { name: 'Download' })).toBeEnabled();
    });

    it('leaves out a collection’s total until every album in it has been counted', () => {
      const shelfAlbum = owned({ id: 'inside', parentId: 'family', assetCount: 0, statsPending: true });
      renderWithTooltips(AlbumDirectory, {
        tree: {
          collections: [{ collection: family, albums: [shelfAlbum], albumCount: 1, assetCount: 0 }],
          albums: [],
          spaces: [],
        },
        onRefresh: vi.fn(),
      });

      const tile = screen.getByRole('article', { name: 'Family' });
      expect(tile).toHaveTextContent('1 album');
      expect(tile).not.toHaveTextContent('Empty');
    });
  });
});
