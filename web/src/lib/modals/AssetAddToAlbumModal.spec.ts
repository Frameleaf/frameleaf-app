import { AlbumUserRole } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { getAnimateMock } from '$lib/__mocks__/animate.mock';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { deferredPromise } from '@test-data/deferred';
import { albumFactory } from '@test-data/factories/album-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import AssetAddToAlbumModal from './AssetAddToAlbumModal.svelte';

describe('AssetAddToAlbumModal', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
  });

  beforeEach(() => {
    vi.resetAllMocks();
    Element.prototype.animate = getAnimateMock();
  });

  it('puts the cursor in search while albums load, then adds to the chosen album', async () => {
    const user = userAdminFactory.build();
    authManager.setUser(user);
    const album = albumFactory.build({ albumName: 'Trips', albumUsers: [{ user, role: AlbumUserRole.Owner }] });
    const albums = deferredPromise<(typeof album)[]>();
    sdkMock.getAllAlbums.mockReturnValueOnce(albums.promise);
    sdkMock.addAssetsToAlbum.mockResolvedValueOnce([]);
    const onClose = vi.fn();

    render(AssetAddToAlbumModal, { assetIds: ['asset-1'], onClose });

    await waitFor(() => expect(screen.getByRole('searchbox', { hidden: true })).toHaveFocus());

    albums.resolve([album]);
    await fireEvent.click(await screen.findByRole('checkbox', { name: /Trips/, hidden: true }));
    await fireEvent.submit(document.querySelector('form')!);

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(sdkMock.addAssetsToAlbum).toHaveBeenCalledWith(
      expect.objectContaining({ id: album.id, bulkIdsDto: { ids: ['asset-1'] } }),
    );
  });

  it('leads with recent albums and adds to a ticked album and a new one', async () => {
    const user = userAdminFactory.build();
    authManager.setUser(user);
    const member = [{ user, role: AlbumUserRole.Owner }];
    const older = albumFactory.build({ albumName: 'Older', albumUsers: member });
    const latest = albumFactory.build({ albumName: 'Latest', albumUsers: member });
    const created = albumFactory.build({ albumName: 'Banff', albumUsers: member });
    sdkMock.getAllAlbums.mockResolvedValueOnce([older, latest]);
    sdkMock.getRecentlyAddedAlbums.mockResolvedValueOnce({ albumIds: [latest.id] });
    sdkMock.createAlbum.mockResolvedValueOnce(created);
    sdkMock.addAssetsToAlbums.mockResolvedValueOnce({ success: true });
    const onClose = vi.fn();

    render(AssetAddToAlbumModal, { assetIds: ['asset-1'], onClose });

    const boxes = await screen.findAllByRole('checkbox', { hidden: true });
    expect(boxes[0].closest('label')).toHaveTextContent('Latest');
    await fireEvent.click(boxes[0]);
    const search = screen.getByRole('searchbox', { hidden: true });
    await fireEvent.input(search, { target: { value: 'Banff' } });
    await fireEvent.keyDown(search, { key: 'Enter' });
    expect(sdkMock.createAlbum).not.toHaveBeenCalled();
    await fireEvent.submit(document.querySelector('form')!);

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(sdkMock.createAlbum).toHaveBeenCalledWith({ createAlbumDto: { albumName: 'Banff' } });
    expect(sdkMock.addAssetsToAlbums).toHaveBeenCalledWith(
      expect.objectContaining({ albumsAddAssetsDto: { albumIds: [latest.id, created.id], assetIds: ['asset-1'] } }),
    );
  });
});
