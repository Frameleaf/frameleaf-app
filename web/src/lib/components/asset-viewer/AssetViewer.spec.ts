import { AssetTypeEnum, getAssetInfo, updateAsset } from '@immich/sdk';
import { fireEvent, waitFor } from '@testing-library/svelte';
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
import AssetViewer from './AssetViewer.svelte';

const { socketListeners } = vi.hoisted(() => ({ socketListeners: new Map<string, (...args: unknown[]) => void>() }));
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

    expect(getByLabelText('to_favorite')).toBeInTheDocument();
    expect(queryByLabelText('unfavorite')).toBeNull();

    await fireEvent.click(getByLabelText('to_favorite'));

    await waitFor(() =>
      expect(updateAsset).toHaveBeenCalledWith({ id: asset.id, updateAssetDto: { isFavorite: true } }),
    );
    await waitFor(() => expect(getByLabelText('unfavorite')).toBeInTheDocument());
  });
});
