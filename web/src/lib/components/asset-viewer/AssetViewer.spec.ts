import { AssetTypeEnum, getAssetInfo, updateAsset } from '@immich/sdk';
import { fireEvent, waitFor } from '@testing-library/svelte';
import { getAnimateMock } from '$lib/__mocks__/animate.mock';
import { getResizeObserverMock } from '$lib/__mocks__/resize-observer.mock';
import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { editManager } from '$lib/managers/edit/edit-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { SlideshowState, slideshowStore } from '$lib/stores/slideshow.store';
import { renderWithTooltips } from '$tests/helpers';
import { assetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import AssetViewer from './AssetViewer.svelte';

vi.mock('$lib/components/asset-viewer/editor/EditorPanel.svelte', async () => {
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

vi.mock('$lib/stores/face.svelte', () => ({
  faceManager: { clear: vi.fn(), getAssetFaces: vi.fn(), data: [], facesByPersonId: new Map(), people: [] },
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
    editManager.hasAppliedEdits = false;
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

  it.each(['lock', 'account'] as const)('does not restore an editor refresh after %s changes', async (change) => {
    const user = userAdminFactory.build();
    const asset = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image });
    authManager.setUser(user);
    eventManager.emit('AuthUserLoaded', user);
    authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
    assetViewerManager.setAsset(asset);
    assetViewerManager.isShowEditor = true;
    let resolve!: (value: typeof asset) => void;
    vi.mocked(getAssetInfo).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const onAssetChange = vi.fn();
    const { getByRole } = renderWithTooltips(AssetViewer, {
      cursor: { current: asset },
      showNavigation: false,
      onAssetChange,
    });
    await fireEvent.click(getByRole('button', { name: 'Save video edits' }));
    await waitFor(() => expect(getAssetInfo).toHaveBeenCalledOnce());
    if (change === 'lock') {
      eventManager.emit('SessionLocked');
    } else {
      eventManager.emit('AuthUserLoaded', userAdminFactory.build());
    }
    resolve(asset);
    await waitFor(() => expect(assetViewerManager.isShowEditor).toBe(false));
    expect(assetViewerManager.asset).toBeUndefined();
    expect(onAssetChange).not.toHaveBeenCalled();
  });

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
