import {
  AssetTypeEnum,
  AssetVisibility,
  deleteAssets,
  getAssetInfo,
  updateAsset,
  type AssetResponseDto,
} from '@immich/sdk';
import { fireEvent, screen, waitFor } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { getAnimateMock } from '$lib/__mocks__/animate.mock';
import { getResizeObserverMock } from '$lib/__mocks__/resize-observer.mock';
import { assetCacheManager } from '$lib/managers/AssetCacheManager.svelte';
import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { SlideshowState, slideshowStore } from '$lib/stores/slideshow.store';
// The application-wide socket subscription the layout loads; the viewer only listens to its events.
import '$lib/stores/websocket';
import { renderWithTooltips } from '$tests/helpers';
import { assetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import { stubFocusVisible } from '@test-data/focus-visible';
import AssetViewer from './AssetViewer.svelte';

const { socketListeners } = vi.hoisted(() => ({ socketListeners: new Map<string, (...args: unknown[]) => void>() }));
const { app } = vi.hoisted(() => ({ app: { page: { url: new URL('http://localhost/photos'), state: {} } } }));
vi.mock('$app/state', () => ({ page: app.page }));
vi.mock('$app/navigation', async () => ({
  ...(await vi.importActual<typeof import('$app/navigation')>('$app/navigation')),
  replaceState: vi.fn(),
}));
vi.mock('socket.io-client', () => ({
  io: () => {
    const socket = {
      on: (name: string, handler: (...args: unknown[]) => void) => {
        socketListeners.set(name, handler);
        return socket;
      },
      off: vi.fn(),
    };
    return socket;
  },
}));

vi.mock('$lib/components/asset-viewer/VideoWrapperViewer.svelte', async () => {
  const { default: MockText } = await import('@test-data/components/MockText.svelte');
  return { default: MockText };
});

// The photo-sphere viewer loads its image over the network; the gesture tests only need it mounted.
vi.mock('$lib/components/asset-viewer/ImagePanoramaViewer.svelte', async () => {
  const { default: MockText } = await import('@test-data/components/MockText.svelte');
  return { default: MockText };
});

vi.mock('$lib/components/frameleaf/editor/QuickEditor.svelte', async () => {
  const { default: MockViewerControls } = await import('@test-data/components/MockViewerControls.svelte');
  return { default: MockViewerControls };
});

vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: {
    init: vi.fn(),
    loadFeatureFlags: vi.fn(),
    value: { smartSearch: true, trash: true },
  } as never,
}));

vi.mock('$lib/stores/ocr.svelte', () => ({
  ocrManager: {
    clear: vi.fn(),
    getAssetOcr: vi.fn(),
    hasOcrData: false,
    showOverlay: false,
  },
}));

vi.mock('@immich/sdk', async () => {
  const sdk = await vi.importActual<typeof import('@immich/sdk')>('@immich/sdk');
  return {
    ...sdk,
    updateAsset: vi.fn(),
    getFaces: vi.fn().mockResolvedValue([]),
    getAssetInfo: vi.fn(),
    deleteAssets: vi.fn().mockResolvedValue(undefined),
  };
});

describe('AssetViewer', () => {
  beforeAll(() => {
    Element.prototype.animate = getAnimateMock();
    vi.stubGlobal('ResizeObserver', getResizeObserverMock());
  });

  afterEach(() => {
    slideshowStore.slideshowState.set(SlideshowState.None);
    assetCacheManager.invalidate();
    authManager.reset();
    vi.clearAllMocks();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('notifies the parent when the current asset changes through an event', async () => {
    const user = userAdminFactory.build();
    const asset = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image });
    const onAssetUpdate = vi.fn();
    authManager.setUser(user);
    authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
    renderWithTooltips(AssetViewer, { cursor: { current: asset }, showNavigation: false, onAssetUpdate });
    const updated = { ...asset, isFavorite: !asset.isFavorite };
    eventManager.emit('AssetUpdate', updated);
    await waitFor(() => expect(onAssetUpdate).toHaveBeenCalledWith(updated));
    onAssetUpdate.mockClear();
    eventManager.emit('AssetUpdate', { ...updated, id: 'another-asset' });
    expect(onAssetUpdate).not.toHaveBeenCalled();
  });

  describe('back from Studio to the quick editor (FL-113)', () => {
    afterEach(() => {
      app.page.url = new URL('http://localhost/photos');
      assetViewerManager.closeEditor();
    });

    it('opens the editor for ?edit=1 on the owner’s item and drops the flag from the address', async () => {
      const user = userAdminFactory.build();
      authManager.setUser(user);
      authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
      const asset = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Video });
      app.page.url = new URL(`http://localhost/photos/${asset.id}?edit=1`);

      renderWithTooltips(AssetViewer, { cursor: { current: asset }, showNavigation: false });

      await waitFor(() => expect(assetViewerManager.isShowEditor).toBe(true));
      const { replaceState } = await import('$app/navigation');
      const [url] = vi.mocked(replaceState).mock.calls.at(-1) ?? [];
      expect(String(url)).toBe(`http://localhost/photos/${asset.id}`);
    });

    it('does not open an editor on someone else’s item', async () => {
      const user = userAdminFactory.build();
      authManager.setUser(user);
      authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
      const asset = assetFactory.build({ ownerId: 'someone-else', type: AssetTypeEnum.Image });
      app.page.url = new URL(`http://localhost/photos/${asset.id}?edit=1`);

      renderWithTooltips(AssetViewer, { cursor: { current: asset }, showNavigation: false });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(assetViewerManager.isShowEditor).toBe(false);
    });
  });

  describe('the open item removed elsewhere (FL-35)', () => {
    const setup = (props: Record<string, unknown> = {}, { alone = false } = {}) => {
      const user = userAdminFactory.build();
      authManager.setUser(user);
      authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
      const current = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image });
      const nextAsset = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image });
      const onNavigateToAsset = vi.fn().mockResolvedValue(undefined);
      const onClose = vi.fn();
      renderWithTooltips(AssetViewer, {
        cursor: alone ? { current } : { current, nextAsset },
        showNavigation: true,
        onNavigateToAsset,
        onClose,
        ...props,
      });
      return { current, nextAsset, onNavigateToAsset, onClose };
    };

    it('moves to a neighbour that is still there', async () => {
      const { current, nextAsset, onNavigateToAsset, onClose } = setup();
      eventManager.emit('AssetsDelete', [current.id]);
      await waitFor(() => expect(onNavigateToAsset).toHaveBeenCalledWith(nextAsset));
      expect(onClose).not.toHaveBeenCalled();
    });

    it('closes when the neighbours went too', async () => {
      const { current, nextAsset, onNavigateToAsset, onClose } = setup();
      eventManager.emit('AssetsDelete', [current.id, nextAsset.id]);
      await waitFor(() => expect(onClose).toHaveBeenCalledWith(current.id));
      expect(onNavigateToAsset).not.toHaveBeenCalled();
    });

    it('moves on when the open item is Locked elsewhere and this session has not unlocked', async () => {
      const { current, nextAsset, onNavigateToAsset } = setup();
      eventManager.emit('AssetUpdate', { ...current, visibility: AssetVisibility.Locked });
      await waitFor(() => expect(onNavigateToAsset).toHaveBeenCalledWith(nextAsset));
    });

    it('does not close when the page already moved on from an item removed here (trash viewer ordering)', async () => {
      // The page's preAction navigated to the next item and reset its neighbour lookup, so until the
      // next item loads the viewer still shows the removed one, with no neighbours.
      const preAction = vi.fn().mockResolvedValue(undefined);
      const { current, onNavigateToAsset, onClose } = setup({ preAction }, { alone: true });
      await fireEvent.click(await screen.findByLabelText('frameleaf_viewer_move_to_trash'));
      await waitFor(() => expect(deleteAssets).toHaveBeenCalled());
      expect(preAction).toHaveBeenCalledWith(
        expect.objectContaining({ asset: expect.objectContaining({ id: current.id }) }),
      );
      // the viewer's own event has fired; now the server's arrives for the same item
      eventManager.emit('AssetsDelete', [current.id]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(onClose).not.toHaveBeenCalled();
      expect(onNavigateToAsset).not.toHaveBeenCalled();
    });

    it('still moves on by itself from an item removed here when no page step does', async () => {
      const { nextAsset, onNavigateToAsset } = setup();
      await fireEvent.click(await screen.findByLabelText('frameleaf_viewer_move_to_trash'));
      await waitFor(() => expect(onNavigateToAsset).toHaveBeenCalledWith(nextAsset));
    });

    it('ignores deletions of other items', async () => {
      const { onNavigateToAsset, onClose } = setup();
      eventManager.emit('AssetsDelete', ['someone-else']);
      await Promise.resolve();
      expect(onNavigateToAsset).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('ArrowRight/ArrowLeft races the neighbour lookup (FL-148)', () => {
    const buildAssets = () => {
      const user = userAdminFactory.build();
      authManager.setUser(user);
      authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
      const current = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image });
      const nextAsset = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image });
      return { current, nextAsset };
    };

    it('queues an ArrowRight press made before the caller resolves the next asset, and replays it once it does', async () => {
      const { current, nextAsset } = buildAssets();
      const onNavigateToAsset = vi.fn().mockResolvedValue(undefined);

      // The caller's async neighbour lookup (TimelineAssetViewer's loadCloseAssets) has not resolved
      // yet - there is no on-screen "next" button - but a real ArrowRight keypress must not be lost.
      const view = renderWithTooltips(AssetViewer, {
        cursor: { current },
        showNavigation: true,
        onNavigateToAsset,
      });

      await fireEvent.keyDown(document, { key: 'ArrowRight' });
      await Promise.resolve();
      expect(onNavigateToAsset).not.toHaveBeenCalled();

      // The lookup settles for the same asset.
      await view.rerender({
        componentProps: { cursor: { current, nextAsset }, showNavigation: true, onNavigateToAsset },
      });

      await waitFor(() => expect(onNavigateToAsset).toHaveBeenCalledWith(nextAsset));
    });

    it('drops a queued press if the displayed asset changes for another reason first', async () => {
      const { current, nextAsset } = buildAssets();
      const anotherAsset = assetFactory.build({ ownerId: current.ownerId, type: AssetTypeEnum.Image });
      const onNavigateToAsset = vi.fn().mockResolvedValue(undefined);

      const view = renderWithTooltips(AssetViewer, {
        cursor: { current },
        showNavigation: true,
        onNavigateToAsset,
      });

      await fireEvent.keyDown(document, { key: 'ArrowRight' });
      await Promise.resolve();

      // The viewer moved to a different asset before the original lookup resolved (e.g. the user
      // clicked a thumbnail elsewhere); the stale queued intent must not fire once that new asset's
      // own neighbours resolve.
      await view.rerender({
        componentProps: { cursor: { current: anotherAsset, nextAsset }, showNavigation: true, onNavigateToAsset },
      });
      await Promise.resolve();

      expect(onNavigateToAsset).not.toHaveBeenCalled();
    });

    it('replays the latest ArrowRight press made while a navigation is still in flight', async () => {
      const { current, nextAsset } = buildAssets();

      let resolveFirst!: () => void;
      const onNavigateToAsset = vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveFirst = resolve;
          }),
      );

      renderWithTooltips(AssetViewer, {
        cursor: { current, nextAsset },
        showNavigation: true,
        onNavigateToAsset,
      });

      await fireEvent.keyDown(document, { key: 'ArrowRight' });
      await waitFor(() => expect(onNavigateToAsset).toHaveBeenCalledTimes(1));

      // The first navigation is still in flight (`tracker.isActive()`); this press must be queued,
      // not dropped.
      await fireEvent.keyDown(document, { key: 'ArrowRight' });
      await Promise.resolve();
      expect(onNavigateToAsset).toHaveBeenCalledTimes(1);

      resolveFirst();
      await waitFor(() => expect(onNavigateToAsset).toHaveBeenCalledTimes(2));
    });
  });

  it('puts the Live badge on a Live Photo (V-16)', () => {
    const user = userAdminFactory.build();
    authManager.setUser(user);
    authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
    const asset = assetFactory.build({
      ownerId: user.id,
      type: AssetTypeEnum.Image,
      livePhotoVideoId: 'motion',
      exifInfo: { projectionType: null },
    });
    const view = renderWithTooltips(AssetViewer, { cursor: { current: asset }, showNavigation: false });
    expect(view.getByTestId('viewer-live-badge')).toBeInTheDocument();
  });

  it('refreshes the asset when the video editor explicitly requests it', async () => {
    const user = userAdminFactory.build();
    const asset = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image });
    const updated = { ...asset, isEdited: true, thumbhash: 'new-thumbhash' };
    authManager.setUser(user);
    authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
    assetViewerManager.isShowEditor = true;
    vi.mocked(getAssetInfo).mockResolvedValue(updated);
    const onAssetChange = vi.fn();
    const { getByRole } = renderWithTooltips(AssetViewer, {
      cursor: { current: asset },
      showNavigation: false,
      onAssetChange,
    });

    await fireEvent.click(getByRole('button', { name: 'Save video edits' }));

    await waitFor(() => expect(onAssetChange).toHaveBeenCalledWith(updated));
    expect(assetViewerManager.asset).toEqual(updated);
    expect(assetViewerManager.isShowEditor).toBe(false);
  });

  it.each([true, false])(
    'refreshes the viewer and cached asset after the queued editor unmounts (isEdited=%s)',
    async (isEdited) => {
      const user = userAdminFactory.build();
      const asset = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Video, isEdited: !isEdited });
      const published = { ...asset, isEdited, duration: 5000, thumbhash: 'published-thumbhash' };
      authManager.setUser(user);
      authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
      vi.mocked(getAssetInfo).mockResolvedValue(asset);
      await assetCacheManager.getAsset({ id: asset.id });
      assetViewerManager.isShowEditor = true;
      const onAssetUpdate = vi.fn();
      const view = renderWithTooltips(AssetViewer, {
        cursor: { current: asset },
        showNavigation: false,
        onAssetUpdate,
      });

      // Queue acceptance closes the editor before media publication changes metadata.
      await fireEvent.click(view.getByRole('button', { name: 'Save video edits' }));
      await waitFor(() => expect(view.queryByRole('button', { name: 'Save video edits' })).not.toBeInTheDocument());
      expect(assetViewerManager.isShowEditor).toBe(false);
      vi.mocked(getAssetInfo).mockResolvedValue(published);

      // This is the application-wide socket subscription, not an editor listener.
      const publish = socketListeners.get('on_asset_update');
      expect(publish).toBeDefined();
      publish?.(published);
      await waitFor(() => expect(onAssetUpdate).toHaveBeenCalledWith(published));
      expect(await assetCacheManager.getAsset({ id: asset.id })).toEqual(published);
      onAssetUpdate.mockClear();
      publish?.({ ...published, id: 'unrelated-asset' });
      expect(onAssetUpdate).not.toHaveBeenCalled();
    },
  );

  it.skip('updates the top bar favorite action after pressing favorite', async () => {
    const ownerId = 'owner-id';
    const user = userAdminFactory.build({ id: ownerId });
    const asset = assetFactory.build({ ownerId, isFavorite: false, isTrashed: false, type: AssetTypeEnum.Image });

    authManager.setUser(user);
    authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));

    vi.mocked(updateAsset).mockResolvedValue({ ...asset, isFavorite: true });

    const { getByLabelText, queryByLabelText } = renderWithTooltips(AssetViewer, {
      cursor: { current: asset },
      showNavigation: false,
    });

    expect(getByLabelText('frameleaf_viewer_add_to_favorites')).toBeInTheDocument();
    expect(queryByLabelText('frameleaf_viewer_remove_from_favorites')).toBeNull();

    await fireEvent.click(getByLabelText('frameleaf_viewer_add_to_favorites'));

    await waitFor(() =>
      expect(updateAsset).toHaveBeenCalledWith({ id: asset.id, updateAssetDto: { isFavorite: true } }),
    );
    await waitFor(() => expect(getByLabelText('frameleaf_viewer_remove_from_favorites')).toBeInTheDocument());
  });

  // FL-35 hands-on viewer (apple-style.css:366-407, MediaViewer.jsx:524-578).
  describe('hands-on viewer', () => {
    const renderImage = (props: Record<string, unknown> = {}, overrides: Partial<AssetResponseDto> = {}) => {
      const user = userAdminFactory.build();
      const asset = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image, ...overrides });
      authManager.setUser(user);
      authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
      const view = renderWithTooltips(AssetViewer, { cursor: { current: asset }, showNavigation: false, ...props });
      const viewer = view.container.ownerDocument.querySelector<HTMLElement>('#immich-asset-viewer')!;
      const canvas = viewer.querySelector<HTMLElement>('[data-viewer-content]')!;
      return { asset, viewer, canvas };
    };

    it('draws a pure black canvas with the viewer tokens', () => {
      const { viewer } = renderImage();
      expect(viewer).toHaveClass('fl-media-viewer');
      expect(viewer).toHaveAttribute('data-theme', 'dark');
    });

    it('hides and shows the chrome on a tap on the photo', async () => {
      const { viewer, canvas } = renderImage();
      await fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 200, clientY: 200 });
      await fireEvent.pointerUp(document, { pointerId: 1, clientX: 201, clientY: 200 });
      expect(viewer).toHaveClass('chrome-hidden');

      await fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 200, clientY: 200 });
      await fireEvent.pointerUp(document, { pointerId: 1, clientX: 200, clientY: 200 });
      expect(viewer).not.toHaveClass('chrome-hidden');
    });

    it('closes on a downward swipe at normal zoom', async () => {
      const onClose = vi.fn();
      const { asset, viewer, canvas } = renderImage({ onClose });
      await fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 200, clientY: 200 });
      await fireEvent.pointerMove(document, { pointerId: 1, clientX: 200, clientY: 300 });
      expect(viewer).toHaveClass('dragging');
      expect(canvas.style.transform).toContain('scale(');
      await fireEvent.pointerUp(document, { pointerId: 1, clientX: 200, clientY: 340 });
      expect(onClose).toHaveBeenCalledWith(asset.id);
    });

    it('springs back from a short swipe and ignores presses on controls', async () => {
      const onClose = vi.fn();
      const { viewer, canvas } = renderImage({ onClose });
      await fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 200, clientY: 200 });
      await fireEvent.pointerMove(document, { pointerId: 1, clientX: 200, clientY: 250 });
      await fireEvent.pointerUp(document, { pointerId: 1, clientX: 200, clientY: 250 });
      expect(onClose).not.toHaveBeenCalled();
      expect(viewer).not.toHaveClass('dragging');
      expect(canvas.style.transform).toBe('');

      const button = document.createElement('button');
      canvas.append(button);
      await fireEvent.pointerDown(button, { pointerId: 1, clientX: 200, clientY: 200 });
      await fireEvent.pointerUp(document, { pointerId: 1, clientX: 200, clientY: 200 });
      expect(viewer).not.toHaveClass('chrome-hidden');
    });

    const swipeDown = async (canvas: HTMLElement) => {
      await fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 200, clientY: 200 });
      await fireEvent.pointerMove(document, { pointerId: 1, clientX: 200, clientY: 300 });
      await fireEvent.pointerUp(document, { pointerId: 1, clientX: 200, clientY: 360 });
    };

    // B1: a two-finger pinch at normal zoom must never close the viewer.
    it('never closes on a pinch: a second finger ends the gesture and neither finger restarts it', async () => {
      const onClose = vi.fn();
      const { viewer, canvas } = renderImage({ onClose });
      await fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 200, clientY: 200 });
      await fireEvent.pointerDown(canvas, { pointerId: 2, clientX: 300, clientY: 200 });
      await fireEvent.pointerMove(document, { pointerId: 1, clientX: 200, clientY: 400 });
      await fireEvent.pointerMove(document, { pointerId: 2, clientX: 300, clientY: 450 });
      await fireEvent.pointerUp(document, { pointerId: 2, clientX: 300, clientY: 450 });
      await fireEvent.pointerUp(document, { pointerId: 1, clientX: 200, clientY: 400 });
      expect(onClose).not.toHaveBeenCalled();
      expect(viewer).not.toHaveClass('dragging');
      expect(viewer).not.toHaveClass('chrome-hidden');
    });

    it('never restarts the swipe when one finger of a pinch is lifted and put back', async () => {
      const onClose = vi.fn();
      const { viewer, canvas } = renderImage({ onClose });
      await fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 200, clientY: 200 });
      await fireEvent.pointerDown(canvas, { pointerId: 2, clientX: 300, clientY: 200 });
      await fireEvent.pointerUp(document, { pointerId: 1, clientX: 200, clientY: 200 });
      // Finger 2 is still down: putting finger 1 back is still a pinch, not a new swipe.
      await fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 200, clientY: 200 });
      await fireEvent.pointerMove(document, { pointerId: 1, clientX: 200, clientY: 420 });
      expect(viewer).not.toHaveClass('dragging');
      await fireEvent.pointerUp(document, { pointerId: 1, clientX: 200, clientY: 420 });
      await fireEvent.pointerUp(document, { pointerId: 2, clientX: 300, clientY: 200 });
      expect(onClose).not.toHaveBeenCalled();

      // With every finger up, a single finger swipes again.
      await fireEvent.pointerDown(canvas, { pointerId: 3, clientX: 200, clientY: 200 });
      await fireEvent.pointerMove(document, { pointerId: 3, clientX: 200, clientY: 300 });
      await fireEvent.pointerUp(document, { pointerId: 3, clientX: 200, clientY: 360 });
      expect(onClose).toHaveBeenCalledOnce();
    });

    it('ignores another pointer’s moves and releases while following one', async () => {
      const onClose = vi.fn();
      const { canvas } = renderImage({ onClose });
      await fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 200, clientY: 200 });
      await fireEvent.pointerMove(document, { pointerId: 9, clientX: 200, clientY: 500 });
      await fireEvent.pointerUp(document, { pointerId: 9, clientX: 200, clientY: 500 });
      expect(onClose).not.toHaveBeenCalled();
    });

    it('lets go when the photo is zoomed in mid-drag', async () => {
      const onClose = vi.fn();
      const { viewer, canvas } = renderImage({ onClose });
      await fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 200, clientY: 200 });
      await fireEvent.pointerMove(document, { pointerId: 1, clientX: 200, clientY: 260 });
      assetViewerManager.zoom = 2;
      await fireEvent.pointerMove(document, { pointerId: 1, clientX: 200, clientY: 400 });
      await fireEvent.pointerUp(document, { pointerId: 1, clientX: 200, clientY: 400 });
      expect(onClose).not.toHaveBeenCalled();
      expect(viewer).not.toHaveClass('dragging');
      assetViewerManager.resetZoomState();
    });

    it('never closes a panorama, the editor or a slideshow by swiping', async () => {
      const onClose = vi.fn();
      const panorama = renderImage({ onClose }, { exifInfo: { projectionType: 'EQUIRECTANGULAR' } });
      await swipeDown(panorama.canvas);
      expect(onClose).not.toHaveBeenCalled();
      panorama.viewer.remove();

      assetViewerManager.isShowEditor = true;
      const editor = renderImage({ onClose });
      await swipeDown(editor.canvas);
      expect(onClose).not.toHaveBeenCalled();
      assetViewerManager.closeEditor();
      editor.viewer.remove();

      slideshowStore.slideshowState.set(SlideshowState.PlaySlideshow);
      const slideshow = renderImage({ onClose });
      await swipeDown(slideshow.canvas);
      expect(onClose).not.toHaveBeenCalled();
    });

    it('brings hidden chrome back when the keyboard is used', async () => {
      const { viewer, canvas } = renderImage();
      await fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 200, clientY: 200 });
      await fireEvent.pointerUp(document, { pointerId: 1, clientX: 200, clientY: 200 });
      expect(viewer).toHaveClass('chrome-hidden');
      await fireEvent.keyDown(document, { key: 'Tab' });
      expect(viewer).not.toHaveClass('chrome-hidden');
    });

    // V-13 / V-12: the footer with the position.
    it('draws the footer with the position in the collection', () => {
      const { viewer } = renderImage({ position: { index: 2, total: 40 } });
      const footer = viewer.querySelector('[data-testid="viewer-footer"]')!;
      expect(footer).not.toBeNull();
      expect(footer.querySelector('[data-testid="viewer-position"]')).toHaveAttribute('aria-live', 'polite');
    });
  });

  // FL-36 / V-18 (MediaViewer.jsx:254-263): the slideshow plays in the viewer; full screen is a choice.
  it('starts a slideshow in the viewer without forcing full screen', async () => {
    const user = userAdminFactory.build();
    const asset = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image });
    authManager.setUser(user);
    authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    HTMLElement.prototype.requestFullscreen = requestFullscreen;
    Object.defineProperty(document, 'fullscreenEnabled', { value: true, configurable: true });
    const { findByTestId, getByLabelText } = renderWithTooltips(AssetViewer, {
      cursor: { current: asset },
      showNavigation: false,
    });

    slideshowStore.slideshowState.set(SlideshowState.PlaySlideshow);

    expect(await findByTestId('slideshow-controls')).toBeInTheDocument();
    expect(requestFullscreen).not.toHaveBeenCalled();
    // the footer stays while the slideshow plays, with Pause, the settings and full screen
    expect(await findByTestId('viewer-footer')).toBeInTheDocument();
    expect(getByLabelText('frameleaf_viewer_pause_slideshow')).toBeInTheDocument();
    await fireEvent.click(getByLabelText('frameleaf_viewer_enter_fullscreen'));
    expect(requestFullscreen).toHaveBeenCalledOnce();

    // the viewer renders the settings panel for the footer's cog
    await fireEvent.click(getByLabelText('frameleaf_viewer_slideshow_settings'));
    expect(await findByTestId('slideshow-settings')).toBeInTheDocument();
    slideshowStore.slideshowState.set(SlideshowState.StopSlideshow);
    await waitFor(() => expect(get(slideshowStore.settingsOpen)).toBe(false));
  });

  // FL-36 + V-13: during a slideshow a tap on the photo toggles the one chrome state (header, footer, capsule).
  it('toggles the shared chrome with a tap during a slideshow and restores it when the slideshow ends', async () => {
    // the focus trap's initial focus is not keyboard focus here, so it does not hold the chrome
    const focusVisible = stubFocusVisible();
    onTestFinished(() => focusVisible.restore());
    const user = userAdminFactory.build();
    const asset = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image });
    authManager.setUser(user);
    authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
    const { container, findByTestId } = renderWithTooltips(AssetViewer, {
      cursor: { current: asset },
      showNavigation: false,
    });
    const viewer = container.querySelector<HTMLElement>(':scope #immich-asset-viewer')!;
    const canvas = viewer.querySelector<HTMLElement>(':scope [data-viewer-content]')!;

    slideshowStore.slideshowState.set(SlideshowState.PlaySlideshow);
    await findByTestId('slideshow-controls');
    await fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10, pointerId: 1 });
    await fireEvent.pointerUp(canvas, { clientX: 10, clientY: 10, pointerId: 1 });
    await waitFor(() => expect(viewer).toHaveClass('chrome-hidden'));

    slideshowStore.slideshowState.set(SlideshowState.StopSlideshow);
    await waitFor(() => expect(viewer).not.toHaveClass('chrome-hidden'));
  });

  // A key press reveals the chrome (revealChrome); the slideshow's idle hide must start again.
  it('hides the chrome again after a key press reveals it during a slideshow', async () => {
    const focusVisible = stubFocusVisible();
    onTestFinished(() => focusVisible.restore());
    const user = userAdminFactory.build();
    const asset = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image });
    authManager.setUser(user);
    authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
    // photos stay up longer than the test, so the slideshow never runs out of items and ends
    slideshowStore.slideshowDelay.set(60);
    vi.useFakeTimers();
    try {
      const { container } = renderWithTooltips(AssetViewer, { cursor: { current: asset }, showNavigation: false });
      const viewer = container.querySelector<HTMLElement>(':scope #immich-asset-viewer')!;
      slideshowStore.slideshowState.set(SlideshowState.PlaySlideshow);
      await vi.advanceTimersByTimeAsync(2500);
      expect(viewer).toHaveClass('chrome-hidden');

      await fireEvent.keyDown(document.body, { key: 'Shift' });
      expect(viewer).not.toHaveClass('chrome-hidden');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(viewer).toHaveClass('chrome-hidden');
    } finally {
      vi.useRealTimers();
      slideshowStore.slideshowDelay.set(5);
    }
  });

  // MediaViewer.jsx:740: with the settings open, Escape closes them first, wherever focus is.
  it('closes the slideshow settings on Escape before anything else sees it', async () => {
    const user = userAdminFactory.build();
    const asset = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image });
    authManager.setUser(user);
    authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
    const onClose = vi.fn();
    const { findByTestId, queryByTestId } = renderWithTooltips(AssetViewer, {
      cursor: { current: asset },
      showNavigation: false,
      onClose,
    });
    slideshowStore.openSettings();
    await findByTestId('slideshow-settings');
    (document.activeElement as HTMLElement | null)?.blur();

    await fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(queryByTestId('slideshow-settings')).not.toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
  });

  // Resuming from pause is not a new run: Autoplay off must not bounce a resumed slideshow back to paused.
  it('keeps a resumed slideshow playing when Autoplay is off', async () => {
    const user = userAdminFactory.build();
    const asset = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image });
    authManager.setUser(user);
    authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
    slideshowStore.slideshowAutoplay.set(false);
    renderWithTooltips(AssetViewer, { cursor: { current: asset }, showNavigation: false });

    slideshowStore.slideshowState.set(SlideshowState.PlaySlideshow);
    await waitFor(() => expect(get(slideshowStore.slideshowState)).toBe(SlideshowState.PauseSlideshow));
    slideshowStore.slideshowState.set(SlideshowState.PlaySlideshow);
    await Promise.resolve();
    expect(get(slideshowStore.slideshowState)).toBe(SlideshowState.PlaySlideshow);
    slideshowStore.slideshowAutoplay.set(true);
  });
});
