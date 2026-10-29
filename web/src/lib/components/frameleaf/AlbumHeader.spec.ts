import { AlbumUserRole, type AlbumResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { goto } from '$app/navigation';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
import { albumFactory } from '@test-data/factories/album-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import AlbumHeader from './AlbumHeader.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn(() => Promise.resolve()) }));

vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: { user: { id: 'me', isAdmin: false, name: 'Me', email: 'me@example.com' }, params: {} },
}));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { map: false } },
}));

const me = userAdminFactory.build({ id: 'me', name: 'Me' });
const jamie = userAdminFactory.build({ id: 'jamie', name: 'Jamie' });

/** An album of Jamie's (or mine) where "me" holds `role`. */
const albumAs = (role: AlbumUserRole, overrides: Partial<AlbumResponseDto> = {}) =>
  albumFactory.build({
    id: 'album-1',
    albumName: 'Summer',
    assetCount: 3,
    isActivityEnabled: true,
    albumUsers:
      role === AlbumUserRole.Owner
        ? [
            { user: me, role: AlbumUserRole.Owner },
            { user: jamie, role: AlbumUserRole.Editor },
          ]
        : [
            { user: jamie, role: AlbumUserRole.Owner },
            { user: me, role },
          ],
    ...overrides,
  });

const renderHeader = (album: AlbumResponseDto) =>
  render(AlbumHeader, {
    album,
    assetCount: album.assetCount,
    onAlbumChange: vi.fn(),
    onRefresh: vi.fn(),
    onAddPhotos: vi.fn(),
    onToggleActivity: vi.fn(),
  });

const openMore = async () => {
  await fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
  return within(await screen.findByRole('menu', { name: 'More actions' }));
};

/**
 * FL-53: the album detail header under each role. What a role may not do is not offered; the
 * server refuses the same things again. A role that changes while the page is open takes the
 * controls and any open dialog with it.
 */
describe('AlbumHeader', () => {
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
    sdkMock.getAlbumMapMarkers.mockResolvedValue([]);
    sdkMock.searchUsers.mockResolvedValue([]);
    sdkMock.getWorkflowCapabilities.mockResolvedValue({ sourceFilters: false } as never);
  });

  it('opens a workflow draft for this editable album without adding any photos', async () => {
    sdkMock.getWorkflowCapabilities.mockResolvedValue({ sourceFilters: true } as never);
    renderHeader(albumAs(AlbumUserRole.Owner));
    const more = await openMore();
    await fireEvent.click(await more.findByRole('menuitem', { name: 'Automatically add matching photos' }));
    await waitFor(() => expect(goto).toHaveBeenCalled());
    const url = new URL(String(vi.mocked(goto).mock.calls[0][0]), 'https://frameleaf.test');
    expect(url.searchParams.get('workflowAlbum')).toBe('album-1');
    expect(url.searchParams.get('workflowName')).toBe('Summer');
    expect(sdkMock.addAssetsToAlbum).not.toHaveBeenCalled();
    expect(sdkMock.runWorkflow).not.toHaveBeenCalled();
  });

  it('offers the owner every control: add, upload, edit, share, links, activity and delete', async () => {
    renderHeader(albumAs(AlbumUserRole.Owner));

    await fireEvent.click(screen.getByRole('button', { name: 'Add photos' }));
    const add = within(await screen.findByRole('menu', { name: 'Add photos' }));
    expect(add.getByRole('menuitem', { name: /Upload from computer/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Links' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Comments/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit title' })).toBeInTheDocument();

    const more = await openMore();
    expect(more.getByRole('menuitem', { name: 'Edit details' })).toBeInTheDocument();
    expect(more.getByRole('menuitem', { name: /Delete album/ })).toBeInTheDocument();
    expect(more.queryByRole('menuitem', { name: /Leave album/ })).toBeNull();
  });

  it('lets an editor add, upload and edit, but not invite, manage links or delete', async () => {
    renderHeader(albumAs(AlbumUserRole.Editor));

    expect(screen.getByRole('button', { name: 'Add photos' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Members' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Links' })).toBeNull();
    expect(screen.getByRole('button', { name: /^Comments/ })).toBeInTheDocument();

    const more = await openMore();
    expect(more.getByRole('menuitem', { name: 'Edit details' })).toBeInTheDocument();
    expect(more.queryByRole('menuitem', { name: /Delete album/ })).toBeNull();
    expect(more.getByRole('menuitem', { name: /Leave album/ })).toBeInTheDocument();
  });

  it('shows a viewer the album and its activity, with nothing to add, upload, edit or invite', async () => {
    renderHeader(albumAs(AlbumUserRole.Viewer));

    expect(screen.queryByRole('button', { name: 'Add photos' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Links' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit title' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Members' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Comments/ })).toBeInTheDocument();
    expect(screen.getByText(/View only/)).toBeInTheDocument();

    const more = await openMore();
    expect(more.queryByRole('menuitem', { name: 'Edit details' })).toBeNull();
    expect(more.queryByRole('menuitem', { name: 'Options' })).toBeNull();
    expect(more.getByRole('menuitem', { name: /Leave album/ })).toBeInTheDocument();
  });

  it('closes an editor-only dialog and drops the controls when the role is downgraded live', async () => {
    const { rerender } = renderHeader(albumAs(AlbumUserRole.Editor));

    const more = await openMore();
    await fireEvent.click(more.getByRole('menuitem', { name: 'Options' }));
    expect(await screen.findByRole('dialog', { name: /Options/ })).toBeInTheDocument();

    // The owner makes "me" a viewer in another window; the page patches the album it holds.
    await rerender({ album: albumAs(AlbumUserRole.Viewer) });

    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Options/ })).toBeNull());
    expect(screen.queryByRole('button', { name: 'Add photos' })).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Your access changed. You can view this album but not add to it.',
    );
  });

  it('says so when the role is raised live, and offers the controls again', async () => {
    const { rerender } = renderHeader(albumAs(AlbumUserRole.Viewer));

    await rerender({ album: albumAs(AlbumUserRole.Editor) });

    expect(await screen.findByRole('button', { name: 'Add photos' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('You can now add photos and edit this album');
  });

  it('closes an open menu on Escape before the page sees it, even with focus outside (LIB-04)', async () => {
    // The album page's "go back" is an Escape shortcut on document.body (CommandPaletteDefaultProvider).
    const pageEscape = vi.fn();
    const onBody = (event: KeyboardEvent) => event.key === 'Escape' && !event.defaultPrevented && pageEscape();
    document.body.addEventListener('keydown', onBody);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({}))),
    );
    try {
      renderHeader(albumAs(AlbumUserRole.Owner));
      const escapeFromBody = async () => {
        // A click on a blank part of the popover leaves focus on the body, not inside it.
        (document.activeElement as HTMLElement | null)?.blur();
        await fireEvent.keyDown(document.body, { key: 'Escape' });
      };

      await openMore();
      await escapeFromBody();
      await waitFor(() => expect(screen.queryByRole('menu', { name: 'More actions' })).not.toBeInTheDocument());
      expect(pageEscape).not.toHaveBeenCalled();

      // With nothing open, Escape is the page's again.
      await fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(pageEscape).toHaveBeenCalledOnce();
    } finally {
      document.body.removeEventListener('keydown', onBody);
      vi.unstubAllGlobals();
    }
  });

  it('keeps activity reachable when comments are turned off, so likes and history stay visible', () => {
    renderHeader(albumAs(AlbumUserRole.Viewer, { isActivityEnabled: false }));
    expect(screen.getByRole('button', { name: /^Comments/ })).toBeInTheDocument();
  });

  it('offers Make a movie beside Slideshow, opening the sheet for this album (FL-561)', async () => {
    sdkMock.getMlCapabilities.mockResolvedValue({ workloads: [], studio: { generationWorker: true } } as never);
    renderHeader(albumAs(AlbumUserRole.Viewer));
    await fireEvent.click(screen.getByRole('button', { name: 'Make a movie' }));
    expect(await screen.findByRole('dialog', { name: 'Make a movie' })).toBeInTheDocument();
    expect(screen.getByText(/3 items · Frameleaf picks the best moments/)).toBeInTheDocument();
  });

  it('cannot make a movie of an empty album', () => {
    renderHeader(albumAs(AlbumUserRole.Owner, { assetCount: 0 }));
    expect(screen.getByRole('button', { name: 'Make a movie' })).toBeDisabled();
  });

  it('shows no separator above Leave when a viewer has nothing else in the menu', async () => {
    renderHeader(albumAs(AlbumUserRole.Viewer));
    const menu = await openMore();
    expect(menu.queryAllByRole('separator')).toHaveLength(0);
    expect(menu.getByRole('menuitem', { name: 'Leave album' })).toBeInTheDocument();
  });

  describe('on a phone', () => {
    const phoneWidth = (query: string) => ({
      matches: query.includes('max-width: 700px'),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });

    beforeEach(() => {
      vi.mocked(matchMedia).mockImplementation(phoneWidth as never);
    });

    afterEach(() => {
      vi.mocked(matchMedia).mockImplementation(((query: string) => ({
        ...phoneWidth(query),
        matches: false,
      })) as never);
    });

    // Approved template, CollectionHeader.jsx:1410-1510.
    it('keeps Add photos and Share in the row and moves everything else into "…"', async () => {
      renderHeader(albumAs(AlbumUserRole.Owner));

      const toolbar = screen.getByRole('toolbar');
      expect(within(toolbar).getByRole('button', { name: 'Add photos' })).toBeInTheDocument();
      expect(within(toolbar).getByRole('button', { name: 'Share' })).toBeInTheDocument();
      for (const name of ['Links', 'Slideshow', 'Download', /^Comments/]) {
        expect(within(toolbar).queryByRole('button', { name })).toBeNull();
      }

      const menu = await openMore();
      for (const name of ['Links', 'Slideshow', 'Download', 'Comments']) {
        expect(menu.getByRole(name === 'Comments' ? 'menuitemcheckbox' : 'menuitem', { name })).toBeInTheDocument();
      }
      expect(menu.getByRole('menuitem', { name: 'Delete album' })).toBeInTheDocument();
    });

    it('moves Map into the menu when the map is on', async () => {
      featureFlagsManager.value.map = true;
      try {
        renderHeader(albumAs(AlbumUserRole.Owner));
        expect(within(screen.getByRole('toolbar')).queryByRole('button', { name: 'Map' })).toBeNull();
        const menu = await openMore();
        // no located items yet, so it is offered but disabled, as the row button was
        expect(menu.getByRole('menuitem', { name: 'Map' })).toHaveAttribute('aria-disabled', 'true');
      } finally {
        featureFlagsManager.value.map = false;
      }
    });

    it("gives a viewer the album's actions in the menu, without links, and Leave as the danger item", async () => {
      renderHeader(albumAs(AlbumUserRole.Viewer));

      const toolbar = screen.getByRole('toolbar');
      expect(within(toolbar).queryByRole('button', { name: 'Add photos' })).toBeNull();
      expect(within(toolbar).getByRole('button', { name: 'Members' })).toBeInTheDocument();

      const menu = await openMore();
      expect(menu.queryByRole('menuitem', { name: 'Links' })).toBeNull();
      for (const name of ['Slideshow', 'Download']) {
        expect(menu.getByRole('menuitem', { name })).toBeInTheDocument();
      }
      const leave = menu.getByRole('menuitem', { name: 'Leave album' });
      expect(leave.querySelector('.danger-item')).not.toBeNull();
      // the moved actions, then Leave: one separator, never two in a row
      expect(menu.getAllByRole('separator')).toHaveLength(1);
    });

    it('separates the moved actions, the album settings and Delete', async () => {
      renderHeader(albumAs(AlbumUserRole.Owner));
      const menu = await openMore();
      expect(menu.getAllByRole('separator')).toHaveLength(2);
      expect(menu.getByRole('menuitem', { name: 'Delete album' }).querySelector('.danger-item')).not.toBeNull();
    });

    it('opens activity from the menu, with its count', async () => {
      const onToggleActivity = vi.fn();
      render(AlbumHeader, {
        album: albumAs(AlbumUserRole.Owner),
        assetCount: 3,
        likeCount: 2,
        commentCount: 1,
        onAlbumChange: vi.fn(),
        onRefresh: vi.fn(),
        onToggleActivity,
      });

      const menu = await openMore();
      await fireEvent.click(menu.getByRole('menuitemcheckbox', { name: 'Comments (3)' }));
      expect(onToggleActivity).toHaveBeenCalledOnce();
    });
  });

  describe('cover (FL-83 AL-13)', () => {
    it.each([
      [true, 'Cover follows the newest item'],
      [false, 'Cover updated'],
    ])('announces the saved cover (follows newest: %s)', async (coverFollowsNewest, message) => {
      const album = albumAs(AlbumUserRole.Owner);
      sdkMock.searchAssets.mockResolvedValue({
        assets: { items: [], count: 0, total: 0, facets: [], nextPage: null },
      } as never);
      sdkMock.updateAlbumInfo.mockResolvedValue({ ...album, coverFollowsNewest });
      const onAlbumChange = vi.fn();
      render(AlbumHeader, {
        album,
        assetCount: album.assetCount,
        onAlbumChange,
        onRefresh: vi.fn(),
        onAddPhotos: vi.fn(),
        onToggleActivity: vi.fn(),
      });

      const menu = await openMore();
      await fireEvent.click(menu.getByRole('menuitem', { name: 'Select cover' }));
      await fireEvent.click(await screen.findByRole('button', { name: 'Use as cover' }));

      await waitFor(() => expect(onAlbumChange).toHaveBeenCalledWith(expect.objectContaining({ coverFollowsNewest })));
      // said in a toast, not in the line under the toolbar
      expect(await screen.findByText(message)).toBeInTheDocument();
    });
  });
});

it('counts bookmark items without enabling media actions for a bookmark-only album', () => {
  render(AlbumHeader, {
    album: albumAs(AlbumUserRole.Owner, { assetCount: 0 }),
    assetCount: 0,
    itemCount: 2,
    onAlbumChange: vi.fn(),
    onRefresh: vi.fn(),
  });
  expect(screen.getByText('2 items', { exact: true })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Download' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Slideshow' })).toBeDisabled();
});

it("hands Download to a Boards collection's dialog instead of downloading at once (FL-660)", async () => {
  const onDownload = vi.fn();
  render(AlbumHeader, {
    album: albumAs(AlbumUserRole.Owner),
    assetCount: 3,
    onAlbumChange: vi.fn(),
    onRefresh: vi.fn(),
    onDownload,
  });
  await fireEvent.click(screen.getByRole('button', { name: 'Download' }));
  expect(onDownload).toHaveBeenCalledOnce();
  expect(sdkMock.getDownloadInfo).not.toHaveBeenCalled();
});

/** Boards (README points 2, 8 and 22): icon and colour, the collections inside, and what Delete does. */
describe('AlbumHeader in Boards', () => {
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
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({}))),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens "Icon and colour" from the icon tile and the menu, and saves both together', async () => {
    const album = albumAs(AlbumUserRole.Owner, { color: null, icon: null });
    sdkMock.updateAlbumInfo.mockResolvedValue({ ...album, color: 'purple' });
    const onAlbumChange = vi.fn();
    render(AlbumHeader, { album, assetCount: 3, onAlbumChange, onRefresh: vi.fn() });

    await fireEvent.click(screen.getByRole('button', { name: 'Change the icon and colour of Summer' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Icon and colour' }));
    expect(dialog.getByText(/for everyone it’s shared with\. They also show in Albums\./)).toBeInTheDocument();
    expect(dialog.getByRole('button', { name: 'Use the plain folder' })).toBeDisabled();
    await fireEvent.click(dialog.getByRole('radio', { name: 'Purple' }));
    expect(dialog.getByTestId('appearance-preview')).toHaveTextContent('Shown in Purple');
    expect(dialog.getByRole('button', { name: 'Use the plain folder' })).toBeEnabled();
    await fireEvent.click(dialog.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(sdkMock.updateAlbumInfo).toHaveBeenCalledWith({
        id: 'album-1',
        updateAlbumDto: { icon: null, color: 'purple' },
      }),
    );
    expect(onAlbumChange).toHaveBeenCalledWith(expect.objectContaining({ color: 'purple' }));

    const menu = await openMore();
    expect(menu.getByRole('menuitem', { name: 'Icon and colour…' })).toBeInTheDocument();
  });

  it('clears both with "Use the plain folder"', async () => {
    const album = albumAs(AlbumUserRole.Owner, { color: 'teal', icon: 'mdiCameraBurst' });
    sdkMock.updateAlbumInfo.mockResolvedValue({ ...album, color: null, icon: null });
    render(AlbumHeader, { album, assetCount: 3, onAlbumChange: vi.fn(), onRefresh: vi.fn() });

    const menu = await openMore();
    await fireEvent.click(menu.getByRole('menuitem', { name: 'Icon and colour…' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Icon and colour' }));
    expect(dialog.getByRole('radio', { name: 'Teal' })).toBeChecked();
    await fireEvent.click(dialog.getByRole('button', { name: 'Use the plain folder' }));
    expect(dialog.getByRole('radio', { name: 'No colour' })).toBeChecked();
    await fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(sdkMock.updateAlbumInfo).toHaveBeenCalledWith({
        id: 'album-1',
        updateAlbumDto: { icon: null, color: null },
      }),
    );
  });

  it('does not offer icon and colour to a viewer', async () => {
    renderHeader(albumAs(AlbumUserRole.Viewer));
    expect(screen.queryByRole('button', { name: /Change the icon and colour/ })).toBeNull();
    const menu = await openMore();
    expect(menu.queryByRole('menuitem', { name: 'Icon and colour…' })).toBeNull();
  });

  it('shows the collections inside as cards with their own mark and counts', () => {
    const parent = albumAs(AlbumUserRole.Owner, { kind: 'collection' as never });
    const mood = albumFactory.build({
      id: 'mood',
      albumName: 'Moodboard',
      parentId: 'album-1',
      assetCount: 4,
      color: 'teal',
    });
    const deep = albumFactory.build({ id: 'deep', albumName: 'Deep', parentId: 'mood' });
    const deeper = albumFactory.build({ id: 'deeper', albumName: 'Deeper', parentId: 'mood' });
    render(AlbumHeader, {
      album: parent,
      childAlbums: [mood],
      albums: [parent, mood, deep, deeper],
      assetCount: 4,
      onAlbumChange: vi.fn(),
      onRefresh: vi.fn(),
    });
    const card = screen.getByTestId('sub-collection-card');
    expect(card).toHaveAttribute('href', '/albums/mood');
    expect(card).toHaveTextContent('Moodboard');
    expect(card).toHaveTextContent('4 items · 2 inside');
    expect(card.querySelector('[data-color="teal"]')).not.toBeNull();
  });

  it('spells out what Delete does: items stay, albums inside move up, people lose access', async () => {
    const brand = albumFactory.build({ id: 'brand', albumName: 'Brand refresh' });
    const album = albumAs(AlbumUserRole.Owner, {
      kind: 'collection' as never,
      parentId: 'brand',
      hasSharedLink: false,
    });
    const kids = [
      albumFactory.build({ id: 'm', albumName: 'Moodboard', parentId: 'album-1' }),
      albumFactory.build({ id: 't', albumName: 'Type', parentId: 'album-1' }),
    ];
    render(AlbumHeader, {
      album,
      ancestors: [brand],
      childAlbums: kids,
      assetCount: 3,
      itemCount: 3,
      onAlbumChange: vi.fn(),
      onRefresh: vi.fn(),
    });
    const menu = await openMore();
    await fireEvent.click(menu.getByRole('menuitem', { name: 'Delete collection' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Delete “Summer”?' }));
    const lines = dialog.getByTestId('delete-consequences');
    expect(lines).toHaveTextContent('The 3 items in it stay in your library.');
    expect(lines).toHaveTextContent('Moodboard and Type move up into Brand refresh.');
    expect(lines).toHaveTextContent('Jamie loses access to this collection.');
  });

  it('moves the albums inside to the top level when there is no parent', async () => {
    const album = albumAs(AlbumUserRole.Owner, {
      albumUsers: [{ user: me, role: AlbumUserRole.Owner }],
    });
    render(AlbumHeader, {
      album,
      childAlbums: [albumFactory.build({ id: 'm', albumName: 'Moodboard', parentId: 'album-1' })],
      assetCount: 1,
      onAlbumChange: vi.fn(),
      onRefresh: vi.fn(),
    });
    const menu = await openMore();
    await fireEvent.click(menu.getByRole('menuitem', { name: 'Delete album' }));
    const lines = within(await screen.findByRole('dialog')).getByTestId('delete-consequences');
    expect(lines).toHaveTextContent('The 1 item in it stays in your library.');
    expect(lines).toHaveTextContent('Moodboard moves up to the top level.');
    expect(lines).not.toHaveTextContent('access');
  });
});
