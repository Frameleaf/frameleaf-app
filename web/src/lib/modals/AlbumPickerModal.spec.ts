import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { getAnimateMock } from '$lib/__mocks__/animate.mock';
import { getIntersectionObserverMock } from '$lib/__mocks__/intersection-observer.mock';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { getVisualViewportMock } from '$lib/__mocks__/visual-viewport.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { deferredPromise } from '@test-data/deferred';
import { albumFactory } from '@test-data/factories/album-factory';
import AlbumPickerModal from './AlbumPickerModal.svelte';

describe('AlbumPickerModal component', () => {
  const onClose = vi.fn();

  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', getIntersectionObserverMock());
    vi.stubGlobal('visualViewport', getVisualViewportMock());
    vi.resetAllMocks();
    Element.prototype.animate = getAnimateMock();
  });

  afterAll(async () => {
    await waitFor(() => {
      expect(document.body.style.pointerEvents).not.toBe('none');
    });
  });

  it('shows the singular selection count title when selectedItemsCount is 1', async () => {
    // Called by onMount()
    sdkMock.getAllAlbums.mockResolvedValueOnce([]);

    render(AlbumPickerModal, { props: { onClose, selectedItemsCount: 1 } });

    expect(await screen.findByText('Add 1 item to album')).toBeInTheDocument();
    expect(screen.queryByText('Select albums')).not.toBeInTheDocument();
  });

  it('shows the plural selection count title when selectedItemsCount is greater than 1', async () => {
    sdkMock.getAllAlbums.mockResolvedValueOnce([]);

    render(AlbumPickerModal, { props: { onClose, selectedItemsCount: 3 } });

    expect(await screen.findByText('Add 3 items to album')).toBeInTheDocument();
    expect(screen.queryByText('Select albums')).not.toBeInTheDocument();
  });

  it('shows the generic title when selectedItemsCount is not provided', async () => {
    sdkMock.getAllAlbums.mockResolvedValueOnce([]);

    render(AlbumPickerModal, { props: { onClose } });

    expect(await screen.findByText('Select albums')).toBeInTheDocument();
    expect(screen.queryByText('Add 1 item to album')).not.toBeInTheDocument();
  });
  it.each(['current', 'close', 'session'])(
    'completes album creation only for its owning picker: %s',
    async (change) => {
      sdkMock.getAllAlbums.mockResolvedValueOnce([]);
      const pending = deferredPromise<ReturnType<typeof albumFactory.build>>();
      sdkMock.createAlbum.mockReturnValueOnce(pending.promise);
      const view = render(AlbumPickerModal, { onClose });
      const input = await screen.findByPlaceholderText('Search');
      await fireEvent.input(input, { target: { value: 'Trips' } });
      await fireEvent.click(screen.getByRole('button', { name: /New Album/ }));
      await waitFor(() => expect(sdkMock.createAlbum).toHaveBeenCalledWith({ createAlbumDto: { albumName: 'Trips' } }));
      if (change === 'close') {
        view.unmount();
      } else if (change === 'session') {
        authManager.reset();
      }
      const album = albumFactory.build({ albumName: 'Trips' });
      pending.resolve(album);
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (change === 'current') {
        expect(onClose).toHaveBeenCalledWith([album]);
      } else {
        expect(onClose).not.toHaveBeenCalled();
      }
    },
  );
});
