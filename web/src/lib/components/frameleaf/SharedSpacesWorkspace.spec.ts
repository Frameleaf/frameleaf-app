import {
  AlbumKind,
  AlbumUserRole,
  type AlbumResponseDto,
  type PartnerResponseDto,
  UserAvatarColor,
} from '@frameleaf/sdk';
import { fireEvent, screen, waitFor, within } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { resetIconCatalogueCache } from '$lib/frameleaf/icon-catalogue';
import { renderWithTooltips } from '$tests/helpers';
import { albumFactory } from '@test-data/factories/album-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import SharedSpacesWorkspace from './SharedSpacesWorkspace.svelte';

const me = userAdminFactory.build({ id: 'me', isAdmin: false });
const jamie = userAdminFactory.build({ id: 'jamie', name: 'Jamie' });

vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: { user: { id: 'me', isAdmin: false, name: 'Me', email: 'me@example.com' }, params: {} },
}));
vi.mock('$lib/components/assets/thumbnail/ImageThumbnail.svelte', async () => {
  const { default: TestImage } = await import('$lib/../test-data/frameleaf/TestImage.svelte');
  return { default: TestImage };
});

const ownedSpace = (overrides: Parameters<typeof albumFactory.build>[0] = {}): AlbumResponseDto =>
  albumFactory.build({
    kind: AlbumKind.Space,
    albumUsers: [
      { user: me, role: AlbumUserRole.Owner },
      { user: jamie, role: AlbumUserRole.Editor },
    ],
    ...overrides,
  });

const familySpace = ownedSpace({ id: 'family-space', albumName: 'Family Space', assetCount: 42 });

const partner: PartnerResponseDto = {
  id: 'jamie',
  name: 'Jamie',
  email: 'jamie@example.com',
  avatarColor: UserAvatarColor.Primary,
  profileChangedAt: '2026-09-01T00:00:00.000Z',
  profileImagePath: '',
};

describe('SharedSpacesWorkspace', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    // The create dialog's icon chooser asks the server for its catalogue.
    resetIconCatalogueCache();
    sdkMock.getAlbumIconCatalogue.mockResolvedValue({ version: '7.4.47', names: [], suggested: [] });
  });

  it('lists every shared space and every partner', () => {
    renderWithTooltips(SharedSpacesWorkspace, { spaces: [familySpace], partners: [partner], onRefresh: vi.fn() });

    expect(screen.getByRole('heading', { level: 1, name: 'Shared spaces' })).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Family Space' })).toBeInTheDocument();
    // FL-326: what a partner shares arrives as your own copies, so the card is a summary, not a
    // link to a library that no longer exists; managing partners is in Settings.
    const partners = screen.getByRole('region', { name: /Partners/ });
    expect(within(partners).getByText('Jamie')).toBeInTheDocument();
    expect(within(partners).getByText('Shares photos into your library')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Jamie/ })).toBeNull();
    expect(within(partners).getByRole('link', { name: 'Manage partners' })).toHaveAttribute(
      'href',
      '/user-settings?isOpen=sharing',
    );
  });

  it('says how far a partner’s library has been copied into yours', () => {
    renderWithTooltips(SharedSpacesWorkspace, {
      spaces: [],
      partners: [{ ...partner, backfill: { state: 'running', total: 40, done: 12 } as never }],
      onRefresh: vi.fn(),
    });

    expect(screen.getByText('Copying 12 of 40 items')).toBeInTheDocument();
  });

  it('shows the empty state with a create action when there are no shared spaces', () => {
    renderWithTooltips(SharedSpacesWorkspace, { spaces: [], partners: [], onRefresh: vi.fn() });

    expect(screen.getByRole('heading', { level: 2, name: 'No shared spaces yet' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open .* library/ })).toBeNull();
  });

  it('opens the create dialog for a shared space, not an album or a collection', async () => {
    renderWithTooltips(SharedSpacesWorkspace, { spaces: [familySpace], partners: [], onRefresh: vi.fn() });

    await fireEvent.click(screen.getByRole('button', { name: 'New shared space' }));

    // The prototype titles it `New ${kind}` (CollectionHeader.jsx), as the button that opens it.
    expect(screen.getByRole('heading', { name: 'New shared space' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'A shared space is a top-level library that everyone you invite adds to. Invite people from its page once it exists.',
      ),
    ).toBeInTheDocument();
  });
  describe('space menu on the Frameleaf Menu (FL-83 AL-45)', () => {
    const joinedSpace = albumFactory.build({
      id: 'club-space',
      albumName: 'Book Club',
      kind: AlbumKind.Space,
      assetCount: 3,
      albumUsers: [
        { user: jamie, role: AlbumUserRole.Owner },
        { user: me, role: AlbumUserRole.Viewer },
      ],
    });

    const openMenu = async (name: string) => {
      await fireEvent.click(screen.getByRole('button', { name: `Actions for ${name}` }));
      return within(await screen.findByRole('menu', { name: `Actions for ${name}` }));
    };

    it('uses the Frameleaf menu, not the legacy context menu', async () => {
      renderWithTooltips(SharedSpacesWorkspace, { spaces: [familySpace], partners: [], onRefresh: vi.fn() });
      const menu = await openMenu('Family Space');
      expect(menu.getByRole('menuitem', { name: 'Open' })).toBeInTheDocument();
      expect(menu.getByRole('menuitem', { name: 'Open the photos' })).toBeInTheDocument();
      expect(menu.getByRole('menuitem', { name: 'Download' })).toBeInTheDocument();
      // The Frameleaf Menu (the one the Albums page uses), whose list sits in its own root.
      const root = screen.getByRole('menu', { name: 'Actions for Family Space' }).closest('.menu-root');
      expect(root).not.toBeNull();
      expect(root?.querySelector('button[aria-haspopup]')).toHaveAccessibleName('Actions for Family Space');
    });

    it('edits a space in the Frameleaf edit dialog', async () => {
      renderWithTooltips(SharedSpacesWorkspace, { spaces: [familySpace], partners: [], onRefresh: vi.fn() });
      const menu = await openMenu('Family Space');
      await fireEvent.click(menu.getByRole('menuitem', { name: 'Edit' }));

      const dialog = within(await screen.findByRole('dialog', { name: /shared space/i }));
      expect(dialog.getByRole('textbox', { name: 'Name' })).toHaveValue('Family Space');
    });

    it('shares a space from its menu in the Frameleaf share dialog', async () => {
      sdkMock.searchUsers.mockResolvedValue([jamie]);
      renderWithTooltips(SharedSpacesWorkspace, { spaces: [familySpace], partners: [], onRefresh: vi.fn() });
      const menu = await openMenu('Family Space');
      await fireEvent.click(menu.getByRole('menuitem', { name: 'Share' }));

      expect(await screen.findByRole('dialog', { name: 'Share this shared space' })).toBeInTheDocument();
    });

    it('deletes an owned space after the Frameleaf confirmation', async () => {
      const onRefresh = vi.fn();
      sdkMock.deleteAlbum.mockResolvedValue(undefined as never);
      renderWithTooltips(SharedSpacesWorkspace, { spaces: [familySpace], partners: [], onRefresh });
      const menu = await openMenu('Family Space');
      expect(menu.queryByRole('menuitem', { name: 'Leave' })).toBeNull();
      await fireEvent.click(menu.getByRole('menuitem', { name: 'Delete' }));

      await screen.findByRole('dialog', { name: 'Delete “Family Space”?' });
      await fireEvent.click(screen.getByRole('button', { name: 'Delete shared space' }));

      await waitFor(() => expect(sdkMock.deleteAlbum).toHaveBeenCalledWith({ id: 'family-space' }));
      await waitFor(() => expect(onRefresh).toHaveBeenCalled());
    });

    it('leaves a space someone else owns after the Frameleaf confirmation', async () => {
      const onRefresh = vi.fn();
      sdkMock.removeUserFromAlbum.mockResolvedValue(undefined as never);
      renderWithTooltips(SharedSpacesWorkspace, { spaces: [joinedSpace], partners: [], onRefresh });
      const menu = await openMenu('Book Club');
      expect(menu.queryByRole('menuitem', { name: 'Delete' })).toBeNull();
      expect(menu.queryByRole('menuitem', { name: 'Edit' })).toBeNull();
      await fireEvent.click(menu.getByRole('menuitem', { name: 'Leave' }));

      await screen.findByRole('dialog', { name: 'Leave “Book Club”?' });
      await fireEvent.click(screen.getByRole('button', { name: 'Leave shared space' }));

      await waitFor(() => expect(sdkMock.removeUserFromAlbum).toHaveBeenCalledWith({ id: 'club-space', userId: 'me' }));
      await waitFor(() => expect(onRefresh).toHaveBeenCalled());
    });
  });
});
