import { AlbumUserRole, type AlbumResponseDto } from '@immich/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
import { albumFactory } from '@test-data/factories/album-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import AlbumHeader from './AlbumHeader.svelte';

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
  });

  it('offers the owner every control: add, upload, edit, share, links, activity and delete', async () => {
    renderHeader(albumAs(AlbumUserRole.Owner));

    await fireEvent.click(screen.getByRole('button', { name: 'Add photos' }));
    const add = within(await screen.findByRole('menu', { name: 'Add photos' }));
    expect(add.getByRole('menuitem', { name: /Upload from computer/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Shared links' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Activity/ })).toBeInTheDocument();
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
    expect(screen.queryByRole('button', { name: 'Shared links' })).toBeNull();
    expect(screen.getByRole('button', { name: /^Activity/ })).toBeInTheDocument();

    const more = await openMore();
    expect(more.getByRole('menuitem', { name: 'Edit details' })).toBeInTheDocument();
    expect(more.queryByRole('menuitem', { name: /Delete album/ })).toBeNull();
    expect(more.getByRole('menuitem', { name: /Leave album/ })).toBeInTheDocument();
  });

  it('shows a viewer the album and its activity, with nothing to add, upload, edit or invite', async () => {
    renderHeader(albumAs(AlbumUserRole.Viewer));

    expect(screen.queryByRole('button', { name: 'Add photos' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Shared links' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit title' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Members' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Activity/ })).toBeInTheDocument();
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
    expect(screen.getByRole('status')).toHaveTextContent('Your role changed: you can now only view this album.');
  });

  it('says so when the role is raised live, and offers the controls again', async () => {
    const { rerender } = renderHeader(albumAs(AlbumUserRole.Viewer));

    await rerender({ album: albumAs(AlbumUserRole.Editor) });

    expect(await screen.findByRole('button', { name: 'Add photos' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('you can now add to and edit this album');
  });

  it('keeps activity reachable when comments are turned off, so likes and history stay visible', () => {
    renderHeader(albumAs(AlbumUserRole.Viewer, { isActivityEnabled: false }));
    expect(screen.getByRole('button', { name: /^Activity/ })).toBeInTheDocument();
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

    // INTERACTION-REQUIREMENTS.md (Sept 24 second pass), CollectionHeader.jsx:1410-1510.
    it('keeps Add photos and Share in the row and moves everything else into "…"', async () => {
      renderHeader(albumAs(AlbumUserRole.Owner));

      const toolbar = screen.getByRole('toolbar');
      expect(within(toolbar).getByRole('button', { name: 'Add photos' })).toBeInTheDocument();
      expect(within(toolbar).getByRole('button', { name: 'Share' })).toBeInTheDocument();
      for (const name of ['Shared links', 'Slideshow', 'Download', /^Activity/]) {
        expect(within(toolbar).queryByRole('button', { name })).toBeNull();
      }

      const menu = await openMore();
      for (const name of ['Shared links', 'Slideshow', 'Download', 'Activity']) {
        expect(menu.getByRole(name === 'Activity' ? 'menuitemcheckbox' : 'menuitem', { name })).toBeInTheDocument();
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
      expect(menu.queryByRole('menuitem', { name: 'Shared links' })).toBeNull();
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
      await fireEvent.click(menu.getByRole('menuitemcheckbox', { name: 'Activity (3)' }));
      expect(onToggleActivity).toHaveBeenCalledOnce();
    });
  });
});
