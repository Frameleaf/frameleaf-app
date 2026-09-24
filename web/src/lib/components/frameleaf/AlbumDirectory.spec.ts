import { AlbumKind, AlbumUserRole, type AlbumTreeResponseDto } from '@immich/sdk';
import { fireEvent, screen, waitFor, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { afterNavigate } from '$app/navigation';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { defaultAlbumDirectoryView } from '$lib/frameleaf/album-directory';
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
  replaceState: vi.fn(),
  routerStarted: true,
}));
vi.mock('$app/state', () => ({ page: app.page }));
vi.mock('$app/navigation', () => ({
  goto: app.goto,
  replaceState: app.replaceState,
  invalidate: vi.fn(),
  afterNavigate: vi.fn(),
}));
vi.mock('$lib/utils/router-started', () => ({ hasRouterStarted: () => app.routerStarted }));

vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: { user: { id: 'me', isAdmin: false, name: 'Me', email: 'me@example.com' }, params: {} },
}));
vi.mock('$lib/components/assets/thumbnail/ImageThumbnail.svelte', async () => {
  const { default: TestImage } = await import('$lib/../test-data/frameleaf/TestImage.svelte');
  return { default: TestImage };
});

const owned = (overrides: Parameters<typeof albumFactory.build>[0] = {}) =>
  albumFactory.build({ albumUsers: [{ user: me, role: AlbumUserRole.Owner }], ...overrides });

const family = owned({ id: 'family', albumName: 'Family', kind: AlbumKind.Collection, description: 'The three of us' });
const rockies = owned({ id: 'rockies', albumName: 'Summer in the Rockies', parentId: 'family', assetCount: 10 });
const winter = owned({ id: 'winter', albumName: 'Winter 2026', parentId: 'family', assetCount: 0 });
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
  collections: [{ collection: family, albums: [rockies, winter], albumCount: 2, assetCount: 10 }],
  albums: [trail],
  spaces: [space],
};

describe('AlbumDirectory', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.open = false;
    };
  });

  beforeEach(() => {
    vi.clearAllMocks();
    app.page.url = new URL('http://localhost/albums');
    app.routerStarted = true;
    localStorage.clear();
    // The view (filter pill, grid or list) is a persisted store that outlives a single mount.
    albumDirectoryView.set({ ...defaultAlbumDirectoryView });
  });

  it('renders one shelf per collection with its albums, then other albums, then shared spaces', () => {
    renderWithTooltips(AlbumDirectory, { tree, onRefresh: vi.fn() });

    const shelf = screen.getByRole('region', { name: 'Family' });
    expect(shelf).toHaveTextContent('2 albums');
    expect(shelf).toHaveTextContent('10 items');
    expect(shelf).toHaveTextContent('The three of us');
    expect(shelf.querySelector('article[aria-label="Summer in the Rockies"]')).not.toBeNull();
    expect(shelf.querySelector('article[aria-label="Winter 2026"]')).not.toBeNull();

    expect(screen.getByRole('region', { name: 'Other albums' })).toHaveTextContent('Trail camera');
    expect(screen.getByRole('region', { name: 'Shared spaces' })).toHaveTextContent('Family Space');
    expect(screen.getByRole('heading', { level: 1, name: 'Albums' })).toBeInTheDocument();
    expect(screen.getByText('3 albums · 1 collection · 2 shared')).toBeInTheDocument();
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

  it('searches by name and keeps the list view on shelves', async () => {
    renderWithTooltips(AlbumDirectory, { tree, onRefresh: vi.fn() });

    await fireEvent.click(screen.getByRole('button', { name: 'List view' }));
    expect(screen.getByRole('button', { name: 'List view' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('region', { name: 'Family' }).querySelector('[role="list"]')).not.toBeNull();

    await fireEvent.input(screen.getByRole('searchbox', { name: 'Search albums' }), { target: { value: 'winter' } });
    const shelf = screen.getByRole('region', { name: 'Family' });
    expect(shelf.querySelector('article[aria-label="Winter 2026"]')).not.toBeNull();
    expect(shelf.querySelector('article[aria-label="Summer in the Rockies"]')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Other albums' })).toBeNull();
  });

  it('shows the empty state with a create action when there is nothing', () => {
    renderWithTooltips(AlbumDirectory, { tree: { collections: [], albums: [], spaces: [] }, onRefresh: vi.fn() });
    expect(screen.getByRole('heading', { level: 2, name: 'No albums yet' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create album' })).toBeInTheDocument();
  });

  it('moves an album into a collection through the server and refreshes', async () => {
    const onRefresh = vi.fn();
    const moved = { ...rockies, parentId: null };
    sdkMock.moveAlbumToCollection.mockResolvedValue(moved);
    renderWithTooltips(AlbumDirectory, { tree, onRefresh });

    const rootDrop = document.querySelector('.root-drop') as HTMLElement;
    const dataTransfer = {
      types: ['application/x-immich-album-id'],
      getData: () => 'rockies',
      setData: vi.fn(),
      effectAllowed: 'move',
      dropEffect: 'none',
    };
    const tile = screen.getByRole('article', { name: 'Summer in the Rockies' });
    await fireEvent.dragStart(tile, { dataTransfer });
    await fireEvent.dragOver(rootDrop, { dataTransfer });
    await fireEvent.drop(rootDrop, { dataTransfer });

    await waitFor(() =>
      expect(sdkMock.moveAlbumToCollection).toHaveBeenCalledWith({
        id: 'rockies',
        // Where this page last saw it, so a move from an outdated directory is refused (FL-52).
        moveAlbumDto: { collectionId: null, expectedParentId: 'family' },
      }),
    );
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
    expect(screen.getByRole('status')).toHaveTextContent('“Summer in the Rockies” is now on its own');
  });

  it('keeps shared spaces top level, opening on their own page, with a way to Sharing and its invitations', () => {
    renderWithTooltips(AlbumDirectory, { tree, spaceInvitations: 2, onRefresh: vi.fn() });

    const shelf = screen.getByRole('region', { name: 'Shared spaces' });
    const tile = shelf.querySelector('article[aria-label="Family Space"]') as HTMLElement;
    expect(tile).toHaveAttribute('draggable', 'false');
    expect(tile.querySelector('a[href="/sharing/space"]')).not.toBeNull();
    expect(
      screen.getByRole('region', { name: 'Family' }).querySelector('article[aria-label="Family Space"]'),
    ).toBeNull();

    expect(screen.getByRole('link', { name: '2 invitations waiting' })).toHaveAttribute('href', '/sharing');
    expect(screen.getByRole('link', { name: 'Open Sharing' })).toHaveAttribute('href', '/sharing');
  });

  it('offers to make the first shared space when there are albums but no spaces', () => {
    renderWithTooltips(AlbumDirectory, { tree: { ...tree, spaces: [] }, onRefresh: vi.fn() });

    const shelf = screen.getByRole('region', { name: 'Shared spaces' });
    expect(shelf).toHaveTextContent('No shared spaces yet');
    expect(screen.getByRole('button', { name: 'New shared space' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /invitations? waiting/ })).toBeNull();
  });

  it('opens the create dialog the rail asked for, once, and drops the request from the address', async () => {
    app.page.url = new URL('http://localhost/albums?create=space');
    renderWithTooltips(AlbumDirectory, { tree, onRefresh: vi.fn() });

    expect(await screen.findByRole('dialog', { name: 'New shared space' })).toBeInTheDocument();
    expect(app.replaceState).toHaveBeenCalledOnce();
    const [url] = app.replaceState.mock.calls[0] as [URL];
    expect(url.search).toBe('');
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

  it('opens no create dialog on a plain visit to All albums', () => {
    renderWithTooltips(AlbumDirectory, { tree, onRefresh: vi.fn() });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(app.replaceState).not.toHaveBeenCalled();
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

  it('shares an album in the Frameleaf share dialog with a searchable invite list (AL-3, AL-15)', async () => {
    sdkMock.searchUsers.mockResolvedValue([jamie]);
    renderWithTooltips(AlbumDirectory, { tree, onRefresh: vi.fn() });

    await fireEvent.click(screen.getByRole('button', { name: 'Actions for Summer in the Rockies' }));
    const menu = within(await screen.findByRole('menu', { name: 'Actions for Summer in the Rockies' }));
    await fireEvent.click(menu.getByRole('menuitem', { name: 'Share' }));

    const dialog = within(await screen.findByRole('dialog', { name: 'Share this album' }));
    const people = await dialog.findByRole('listbox', { name: 'People to invite' });
    expect(within(people).getByRole('option', { name: /Jamie/ })).toBeInTheDocument();
    expect(dialog.queryByRole('combobox', { name: /search/i })).toBeNull();
  });

  describe('custom order (FL-52)', () => {
    const useCustomOrder = () => albumDirectoryView.set({ ...defaultAlbumDirectoryView, sort: 'custom' });

    it('offers “Custom order” in the Frameleaf sort menu and shows the server’s own order', async () => {
      const reordered: AlbumTreeResponseDto = {
        ...tree,
        collections: [{ ...tree.collections[0], albums: [winter, rockies] }],
      };
      renderWithTooltips(AlbumDirectory, { tree: reordered, onRefresh: vi.fn() });

      await fireEvent.click(screen.getByRole('button', { name: 'Sort albums' }));
      const menu = within(await screen.findByRole('menu', { name: 'Sort albums' }));
      expect(menu.getByRole('menuitemcheckbox', { name: 'Last modified' })).toHaveAttribute('aria-checked', 'true');
      await fireEvent.click(menu.getByRole('menuitemcheckbox', { name: 'Custom order' }));

      const shelf = screen.getByRole('region', { name: 'Family' });
      const names = [...shelf.querySelectorAll('article')].map((tile) => tile.getAttribute('aria-label'));
      expect(names).toEqual(['Winter 2026', 'Summer in the Rockies']);
    });

    it('moves an album earlier from its menu (the keyboard alternative) and saves the whole group', async () => {
      useCustomOrder();
      const onRefresh = vi.fn();
      sdkMock.setAlbumOrder.mockResolvedValue(undefined as never);
      renderWithTooltips(AlbumDirectory, { tree, onRefresh });

      await fireEvent.click(screen.getByRole('button', { name: 'Actions for Winter 2026' }));
      const menu = within(await screen.findByRole('menu', { name: 'Actions for Winter 2026' }));
      // Winter is last in its collection, so it can only go earlier.
      expect(menu.queryByRole('menuitem', { name: 'Move later' })).toBeNull();
      await fireEvent.click(menu.getByRole('menuitem', { name: 'Move earlier' }));

      await waitFor(() =>
        expect(sdkMock.setAlbumOrder).toHaveBeenCalledWith({
          albumOrderDto: { parentId: 'family', albumIds: ['winter', 'rockies'] },
        }),
      );
      await waitFor(() => expect(onRefresh).toHaveBeenCalled());
      expect(screen.getByRole('status')).toHaveTextContent('“Winter 2026” is now 1 of 2');
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
          albumOrderDto: { parentId: null, albumIds: ['trips', 'family'] },
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
          albumOrderDto: { parentId: 'family', albumIds: ['winter', 'rockies'] },
        }),
      );
      // Arranging inside the collection never moves the album anywhere.
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
      expect(screen.getByRole('status')).toHaveTextContent('Your albums changed since this page loaded');
    });

    it('reloads and says so when a move is refused because the album was moved since (stale moved node)', async () => {
      const onRefresh = vi.fn();
      sdkMock.moveAlbumToCollection.mockRejectedValue(Object.assign(new Error('Conflict'), { status: 409 }));
      renderWithTooltips(AlbumDirectory, { tree, onRefresh });

      await fireEvent.click(screen.getByRole('button', { name: 'Actions for Summer in the Rockies' }));
      const menu = within(await screen.findByRole('menu', { name: 'Actions for Summer in the Rockies' }));
      await fireEvent.click(menu.getByRole('menuitem', { name: 'Move to…' }));
      const dialog = within(await screen.findByRole('dialog', { name: /Move “Summer in the Rockies”/ }));
      await fireEvent.click(dialog.getByRole('radio', { name: /On its own/ }));
      await fireEvent.click(dialog.getByRole('button', { name: 'Move' }));

      await waitFor(() => expect(onRefresh).toHaveBeenCalled());
      expect(screen.getByRole('status')).toHaveTextContent('Your albums changed since this page loaded');
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
    await fireEvent.submit(dialog.getByRole('button', { name: 'Move' }).closest('form')!);

    await waitFor(() =>
      expect(sdkMock.moveAlbumToCollection).toHaveBeenCalledWith({
        id: 'rockies',
        moveAlbumDto: { collectionId: 'trips', expectedParentId: 'family' },
      }),
    );
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
    expect(screen.getByRole('status')).toHaveTextContent('Trips');
  });

  it('never lets a viewer drag someone else’s album', () => {
    renderWithTooltips(AlbumDirectory, { tree, onRefresh: vi.fn() });
    expect(screen.getByRole('article', { name: 'Trail camera' })).toHaveAttribute('draggable', 'false');
    expect(screen.getByRole('article', { name: 'Summer in the Rockies' })).toHaveAttribute('draggable', 'true');
  });
});
