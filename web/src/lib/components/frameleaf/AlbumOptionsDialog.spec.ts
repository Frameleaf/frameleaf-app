import { AlbumUserRole } from '@frameleaf/sdk';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { albumFactory } from '@test-data/factories/album-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import AlbumOptionsDialog from './AlbumOptionsDialog.svelte';

describe('AlbumOptionsDialog lock switch', () => {
  const me = userAdminFactory.build();
  const albumWith = (role: AlbumUserRole) => albumFactory.build({ isLocked: false, albumUsers: [{ user: me, role }] });

  beforeEach(() => authManager.setUser(me));
  afterEach(() => {
    cleanup();
    authManager.reset();
  });

  it('lets the owner lock the album', async () => {
    const album = albumWith(AlbumUserRole.Owner);
    sdkMock.updateAlbumInfo.mockResolvedValue({ ...album, isLocked: true });
    render(AlbumOptionsDialog, { album, open: true, onUpdated: vi.fn() });

    await fireEvent.click(screen.getByRole('switch', { name: /frameleaf_album_options_locked/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() =>
      expect(sdkMock.updateAlbumInfo).toHaveBeenCalledWith({
        id: album.id,
        updateAlbumDto: expect.objectContaining({ isLocked: true }),
      }),
    );
  });

  it('hides the switch from editors and never sends it', async () => {
    const album = albumWith(AlbumUserRole.Editor);
    sdkMock.updateAlbumInfo.mockResolvedValue(album);
    render(AlbumOptionsDialog, { album, open: true, onUpdated: vi.fn() });

    expect(screen.queryByRole('switch', { name: /frameleaf_album_options_locked/ })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() => expect(sdkMock.updateAlbumInfo).toHaveBeenCalled());
    expect(sdkMock.updateAlbumInfo.mock.calls[0][0].updateAlbumDto).not.toHaveProperty('isLocked');
  });
});
