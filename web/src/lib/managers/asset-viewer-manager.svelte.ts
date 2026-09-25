import { getAssetInfo, type AssetResponseDto } from '@immich/sdk';
import type { ZoomImageWheelState } from '@zoom-image/core';
import { cubicOut } from 'svelte/easing';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { userPreferencesManager } from '$lib/managers/user-preferences-manager.svelte';
import type { ImageLoaderStatus } from '$lib/utils/adaptive-image-loader.svelte';
import { canCopyImageToClipboard } from '$lib/utils/asset-utils';
import { BaseEventManager } from '$lib/utils/base-event-manager.svelte';
import type { AssetGridRouteSearchParams } from '$lib/utils/navigation';

export interface Faces {
  id: string;
  imageHeight: number;
  imageWidth: number;
  boundingBoxX1: number;
  boundingBoxX2: number;
  boundingBoxY1: number;
  boundingBoxY2: number;
}

const createDefaultZoomState = (): ZoomImageWheelState => ({
  currentRotation: 0,
  currentZoom: 1,
  enable: true,
  currentPositionX: 0,
  currentPositionY: 0,
});

export type Events = {
  Zoom: [];
  ZoomChange: [ZoomImageWheelState];
  Copy: [];
};

class AssetViewerManager extends BaseEventManager<Events> {
  #zoomState = $state(createDefaultZoomState());
  #animationFrameId: number | null = null;

  imgRef = $state<HTMLImageElement | undefined>();
  imageLoaderStatus = $state<ImageLoaderStatus | undefined>();
  #isImageLoading = $derived.by(() => {
    const quality = this.imageLoaderStatus?.quality;
    if (!quality || this.imageLoaderStatus?.hasError) {
      return false;
    }
    const previewOrOriginalReady = quality.preview === 'success' || quality.original === 'success';
    const loadingOriginal = this.zoom > 1 && quality.original !== 'success';
    return !previewOrOriginalReady || loadingOriginal;
  });
  isShowActivityPanel = $state(false);
  isPlayingMotionPhoto = $state(false);
  isShowEditor = $state(false);
  /**
   * FL-35: a panorama opens in the photo-sphere viewer. When the viewer offers "Fit
   * panorama" the user is asking to see the flat equirectangular frame instead, which the
   * ordinary photo viewer renders. Reset on every asset change.
   */
  #isPanoramaFlattened = $state(false);
  #isFaceEditMode = $state(false);
  #viewingAssetStoreState = $state<AssetResponseDto>();
  #viewState = $state<boolean>(false);
  #highlightedFaces = $state<Faces[]>([]);
  #showingHiddenPeople = $state(false);
  gridScrollTarget = $state<AssetGridRouteSearchParams | null | undefined>();

  get asset() {
    return this.#viewingAssetStoreState;
  }

  get isViewing() {
    return this.#viewState;
  }

  get isImageLoading() {
    return this.#isImageLoading;
  }

  get isShowDetailPanel() {
    return userPreferencesManager.showDetailPanel;
  }

  get isShowAssetPath() {
    return userPreferencesManager.showAssetPath;
  }

  get isFaceEditMode() {
    return this.#isFaceEditMode;
  }

  get zoomState() {
    return this.#zoomState;
  }

  set zoomState(state: ZoomImageWheelState) {
    this.#zoomState = state;
    this.emit('ZoomChange', state);
  }

  get zoom() {
    return this.#zoomState.currentZoom;
  }

  set zoom(zoom: number) {
    this.cancelZoomAnimation();
    this.zoomState = { ...this.zoomState, currentZoom: zoom };
  }

  canZoomIn() {
    return this.hasListeners('Zoom') && this.zoom <= 1;
  }

  canZoomOut() {
    return this.hasListeners('Zoom') && this.zoom > 1;
  }

  canCopyImage() {
    return canCopyImageToClipboard() && !!assetViewerManager.imgRef;
  }

  private set isShowDetailPanel(value: boolean) {
    userPreferencesManager.showDetailPanel = value;
  }

  private set isShowAssetPath(value: boolean) {
    userPreferencesManager.showAssetPath = value;
  }

  onZoomChange(state: ZoomImageWheelState) {
    // bypass event emitter to avoid loop
    this.#zoomState = state;
  }

  cancelZoomAnimation() {
    if (this.#animationFrameId === null) {
      return;
    }

    cancelAnimationFrame(this.#animationFrameId);
    this.#animationFrameId = null;
  }

  animatedZoom(targetZoom: number, duration = 300) {
    this.cancelZoomAnimation();

    const startZoom = this.#zoomState.currentZoom;
    const startTime = performance.now();

    const frame = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const linearProgress = Math.min(elapsed / duration, 1);
      const easedProgress = cubicOut(linearProgress);
      const interpolatedZoom = startZoom + (targetZoom - startZoom) * easedProgress;

      this.zoomState = { ...this.#zoomState, currentZoom: interpolatedZoom };

      this.#animationFrameId = linearProgress < 1 ? requestAnimationFrame(frame) : null;
    };

    this.#animationFrameId = requestAnimationFrame(frame);
  }

  resetZoomState() {
    this.cancelZoomAnimation();
    this.zoomState = createDefaultZoomState();
  }

  toggleActivityPanel() {
    this.closeDetailPanel();
    this.isShowActivityPanel = !this.isShowActivityPanel;
  }

  closeActivityPanel() {
    this.isShowActivityPanel = false;
  }

  toggleAssetPath() {
    this.isShowAssetPath = !this.isShowAssetPath;
  }

  toggleDetailPanel() {
    this.closeActivityPanel();
    this.isShowDetailPanel = !this.isShowDetailPanel;
  }

  closeDetailPanel() {
    this.isShowDetailPanel = false;
  }

  /**
   * V-15: a field of the information panel that should take focus once it renders, such as the tag
   * box for the T key (MediaViewer.jsx:803-807, `data-mv-focus="tags"`). The field clears it.
   */
  focusRequest = $state<'tags' | null>(null);

  /** Opens the information panel and asks one of its fields to take focus. */
  focusDetailField(field: 'tags') {
    this.closeActivityPanel();
    this.isShowDetailPanel = true;
    this.focusRequest = field;
  }

  openEditor() {
    this.closeActivityPanel();
    this.isShowEditor = true;
  }

  closeEditor() {
    this.isShowEditor = false;
  }

  /** FL-38: opens or closes the face tagger (`frameleaf/FaceTagger.svelte`), mounted by AssetViewer. */
  toggleFaceEditMode() {
    this.#isFaceEditMode = !this.#isFaceEditMode;
  }

  closeFaceEditMode() {
    this.#isFaceEditMode = false;
  }

  resetPanelState() {
    this.closeEditor();
    this.closeFaceEditMode();
    this.resetPanoramaView();
  }

  get isPanoramaFlattened() {
    return this.#isPanoramaFlattened;
  }

  togglePanoramaView() {
    this.#isPanoramaFlattened = !this.#isPanoramaFlattened;
  }

  resetPanoramaView() {
    this.#isPanoramaFlattened = false;
  }

  get highlightedFaces() {
    return this.#highlightedFaces;
  }

  setHighlightedFaces(faces: Faces[]) {
    this.#highlightedFaces = faces;
  }

  clearHighlightedFaces() {
    this.#highlightedFaces = [];
  }

  get isShowingHiddenPeople() {
    return this.#showingHiddenPeople;
  }

  toggleHiddenPeople() {
    this.#showingHiddenPeople = !this.#showingHiddenPeople;
  }

  hideHiddenPeople() {
    this.#showingHiddenPeople = false;
  }

  setAsset(asset: AssetResponseDto) {
    this.#viewingAssetStoreState = asset;
    this.#viewState = true;
  }

  async setAssetId(id: string): Promise<AssetResponseDto> {
    const asset = await getAssetInfo({ ...authManager.params, id });
    this.setAsset(asset);
    return asset;
  }

  showAssetViewer(show: boolean) {
    this.#viewState = show;
  }
}

export const assetViewerManager = new AssetViewerManager();
