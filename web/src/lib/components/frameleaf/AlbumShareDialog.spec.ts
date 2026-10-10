import { AlbumKind, AlbumUserRole } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { albumFactory } from '@test-data/factories/album-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import AlbumShareDialog from './AlbumShareDialog.svelte';

vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: { user: { id: 'me', isAdmin: false, name: 'Me', email: 'me@example.com' }, params: {} },
}));

const me = userAdminFactory.build({ id: 'me', name: 'Me' });
const jamie = userAdminFactory.build({ id: 'jamie', name: 'Jamie' });

describe('AlbumShareDialog', () => {
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
    sdkMock.searchUsers.mockResolvedValue([]);
  });

  it('asks before removing a member, as the space Members panel does, then removes them', async () => {
    sdkMock.removeUserFromAlbum.mockResolvedValue(undefined as never);
    const onChanged = vi.fn();
    const space = albumFactory.build({
      id: 'space-1',
      albumName: 'Family Space',
      kind: AlbumKind.Space,
      albumUsers: [
        { user: me, role: AlbumUserRole.Owner },
        { user: jamie, role: AlbumUserRole.Editor },
      ],
    });
    render(AlbumShareDialog, { album: space, open: true, onChanged, onLeave: vi.fn() });

    await fireEvent.click(screen.getByRole('button', { name: 'Remove Jamie' }));
    expect(sdkMock.removeUserFromAlbum).not.toHaveBeenCalled();

    const confirm = within(await screen.findByRole('dialog', { name: 'Remove Jamie?' }));
    await fireEvent.click(confirm.getByRole('button', { name: 'Remove member' }));

    await waitFor(() => expect(sdkMock.removeUserFromAlbum).toHaveBeenCalledWith({ id: 'space-1', userId: 'jamie' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('invites several people at once with one role', async () => {
    const sam = userAdminFactory.build({ id: 'sam', name: 'Sam' });
    sdkMock.searchUsers.mockResolvedValue([jamie, sam]);
    sdkMock.addUsersToAlbum.mockResolvedValue(undefined as never);
    const album = albumFactory.build({ id: 'album-1', albumUsers: [{ user: me, role: AlbumUserRole.Owner }] });
    render(AlbumShareDialog, { album, open: true, onChanged: vi.fn(), onLeave: vi.fn() });

    const people = within(await screen.findByRole('listbox', { name: 'People to invite' }));
    expect(screen.getByRole('button', { name: 'Invite' })).toBeDisabled();
    await fireEvent.click(people.getByRole('option', { name: /Jamie/ }));
    await fireEvent.click(people.getByRole('option', { name: /Sam/ }));
    expect(people.getByRole('option', { name: /Jamie/ })).toHaveAttribute('aria-selected', 'true');

    await fireEvent.click(screen.getByRole('button', { name: 'Invite 2 people' }));
    await waitFor(() =>
      expect(sdkMock.addUsersToAlbum).toHaveBeenCalledWith({
        id: 'album-1',
        addUsersDto: {
          albumUsers: [
            { userId: 'jamie', role: AlbumUserRole.Editor },
            { userId: 'sam', role: AlbumUserRole.Editor },
          ],
        },
      }),
    );
  });

  it("lists this album's public links with copy, edit and delete, and still offers another", async () => {
    const album = albumFactory.build({
      id: 'album-1',
      albumName: 'Summer',
      albumUsers: [{ user: me, role: AlbumUserRole.Owner }],
    });
    sdkMock.getAllSharedLinks.mockResolvedValue([
      { id: 'link-1', key: 'abc', slug: 'summer', album, assets: [], createdAt: new Date().toISOString() } as never,
    ]);
    render(AlbumShareDialog, { album, open: true, section: 'links', onChanged: vi.fn(), onLeave: vi.fn() });

    const links = within(await screen.findByRole('list', { name: 'Public links' }));
    expect(sdkMock.getAllSharedLinks).toHaveBeenCalledWith({ albumId: 'album-1' });
    expect(links.getByText('/s/summer')).toBeInTheDocument();
    expect(links.getByRole('button', { name: 'Copy link /s/summer' })).toBeInTheDocument();
    expect(links.getByRole('button', { name: 'Edit link /s/summer' })).toBeInTheDocument();
    expect(links.getByRole('button', { name: 'Delete link /s/summer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create another link' })).toBeInTheDocument();
  });
});
