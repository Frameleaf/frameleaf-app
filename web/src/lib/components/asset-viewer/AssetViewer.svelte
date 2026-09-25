<script lang="ts">
  import { browser } from '$app/environment';
  import { focusTrap } from '$lib/actions/focus-trap';
  import { shortcuts } from '$lib/actions/shortcut';
  import type { Action, OnAction, PreAction } from '$lib/components/asset-viewer/actions/action';
  import NextAssetAction from '$lib/components/asset-viewer/actions/NextAssetAction.svelte';
  import PreviousAssetAction from '$lib/components/asset-viewer/actions/PreviousAssetAction.svelte';
  import AssetViewerNavBar from '$lib/components/asset-viewer/AssetViewerNavBar.svelte';
  import { preloadManager } from '$lib/components/asset-viewer/PreloadManager.svelte';
  import QuickEditor from '$lib/components/frameleaf/editor/QuickEditor.svelte';
  import FaceTagger from '$lib/components/frameleaf/FaceTagger.svelte';
  import ViewerFilmstrip from '$lib/components/frameleaf/ViewerFilmstrip.svelte';
  import ViewerFooter from '$lib/components/frameleaf/ViewerFooter.svelte';
  import ViewerLiveBadge from '$lib/components/frameleaf/ViewerLiveBadge.svelte';
  import { sessionAccess } from '$lib/frameleaf/session-access.svelte';
  import ViewerOfflineBanner from '$lib/components/frameleaf/ViewerOfflineBanner.svelte';
  import ViewerStackStrip from '$lib/components/frameleaf/ViewerStackStrip.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import { AssetAction } from '$lib/constants';
  import { isPanorama } from '$lib/frameleaf/viewer-media';
  import { showFilmstrip } from '$lib/frameleaf/viewer-preferences';
  import { slideshowStage, type SlideshowDirection } from '$lib/frameleaf/slideshow-stage.svelte';
  import { activityManager } from '$lib/managers/activity-manager.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
  import { getAssetActions } from '$lib/services/asset.service';
  import { faceManager } from '$lib/stores/face.svelte';
  import { ocrManager } from '$lib/stores/ocr.svelte';
  import { alwaysLoadOriginalVideo } from '$lib/stores/preferences.store';
  import { SlideshowNavigation, SlideshowState, slideshowStore } from '$lib/stores/slideshow.store';
  import { getSharedLink, handlePromiseError } from '$lib/utils';
  import type { OnUndoDelete } from '$lib/utils/actions';
  import { navigateToAsset } from '$lib/utils/asset-utils';
  import { handleError } from '$lib/utils/handle-error';
  import { navigate } from '$lib/utils/navigation';
  import { InvocationTracker } from '$lib/utils/invocationTracker';
  import { SlideshowHistory } from '$lib/utils/slideshow-history';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import {
    AssetTypeEnum,
    AssetVisibility,
    getAssetInfo,
    getStack,
    type AlbumResponseDto,
    type AssetResponseDto,
    type PersonResponseDto,
    type StackResponseDto,
  } from '@immich/sdk';
  import ActivityPanel from '$lib/components/frameleaf/ActivityPanel.svelte';
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import { CommandPaletteDefaultProvider } from '@immich/ui';
  import { onDestroy, onMount, untrack, type Snippet } from 'svelte';
  import type { SwipeCustomEvent } from 'svelte-gestures';
  import { t } from 'svelte-i18n';
  import { motionFly } from '$lib/frameleaf/motion';
  import { isGestureExempt, ViewerGesture, type DismissDrag } from '$lib/frameleaf/viewer-gesture';
  import type { ViewerPosition } from '$lib/frameleaf/viewer-position';
  import ActivityStatus from './ActivityStatus.svelte';
  import DetailPanel from './DetailPanel.svelte';
  import ImagePanoramaViewer from './ImagePanoramaViewer.svelte';
  import OcrButton from './OcrButton.svelte';
  import PhotoViewer from './PhotoViewer.svelte';
  import SlideshowBar from './SlideshowBar.svelte';
  import SlideshowSettingsPanel from '$lib/components/frameleaf/SlideshowSettingsPanel.svelte';
  import SlideshowMemoriesOverlay from './SlideshowMemoriesOverlay.svelte';
  import SlideshowMetadataOverlay from './SlideshowMetadataOverlay.svelte';
  import VideoViewer from './VideoWrapperViewer.svelte';

  export type AssetCursor = {
    current: AssetResponseDto;
    nextAsset?: AssetResponseDto;
    previousAsset?: AssetResponseDto;
  };

  interface Props {
    cursor: AssetCursor;
    showNavigation?: boolean;
    withStacked?: boolean;
    isShared?: boolean;
    album?: AlbumResponseDto;
    person?: PersonResponseDto;
    onAssetChange?: (asset: AssetResponseDto) => void;
    onAssetUpdate?: (asset: AssetResponseDto) => void;
    onAssetSuppressed?: (asset: AssetResponseDto) => void | Promise<void>;
    preAction?: PreAction;
    onAction?: OnAction;
    onUndoDelete?: OnUndoDelete;
    onClose?: (assetId: string) => void;
    onRandom?: () => Promise<{ id: string } | undefined>;
    /**
     * FL-35: the neighbours the caller already holds, for the filmstrip. The viewer never
     * loads a list of its own, so a caller that cannot supply one simply has no filmstrip.
     */
    filmstripAssets?: TimelineAsset[];
    /**
     * V-17: how the viewer moves to another item of the caller's list. By default it changes the item in
     * the address; a page whose address carries no item (Explore, the map) opens it in place instead.
     */
    onNavigateToAsset?: (asset: Pick<AssetResponseDto, 'id'>) => Promise<void>;
    /**
     * FL-55: what the activity side panel shows for the open item. A shared space mounts its own
     * per-item conversation here; without it the panel keeps the album activity viewer.
     */
    activityPanel?: Snippet<[AssetResponseDto]>;
    /** V-12: where the open item sits in the caller's collection, for the footer's "n of N". */
    position?: ViewerPosition | null;
  }

  let {
    cursor,
    showNavigation = true,
    withStacked = false,
    isShared = false,
    album,
    person,
    onAssetChange,
    onAssetUpdate: notifyAssetUpdate,
    onAssetSuppressed,
    preAction,
    onAction,
    onUndoDelete,
    onClose,
    onRandom,
    filmstripAssets = [],
    onNavigateToAsset,
    activityPanel,
    position = null,
  }: Props = $props();

  const {
    restartProgress: restartSlideshowProgress,
    stopProgress: stopSlideshowProgress,
    slideshowNavigation,
    slideshowState,
    slideshowRepeat,
    slideshowAutoplay,
    slideshowTransition,
    slideshowDelay,
    settingsOpen: slideshowSettingsOpen,
  } = slideshowStore;
  // FL-36: which way the slideshow last moved, so a Slide transition arrives from that side.
  let slideshowDirection = $state<SlideshowDirection>('next');

  let previewStackedAsset: AssetResponseDto | undefined = $state();
  let stack: StackResponseDto | null = $state(null);

  const asset = $derived(previewStackedAsset ?? cursor.current);
  const nextAsset = $derived(cursor.nextAsset);
  const previousAsset = $derived(cursor.previousAsset);
  let sharedLink = getSharedLink();
  let fullscreenElement = $state<Element>();

  let isPlayingOriginalVideo = $state($alwaysLoadOriginalVideo);
  let slideshowStartAssetId = $state<string>();

  const setPlayOriginalVideo = (value: boolean) => {
    isPlayingOriginalVideo = value;
  };

  const refreshStack = async () => {
    if (authManager.isSharedLink || !withStacked) {
      return;
    }

    if (asset.stack) {
      stack = await getStack({ id: asset.stack.id });
    }

    if (!stack?.assets.some(({ id }) => id === asset.id)) {
      stack = null;
    }
  };

  const handleFavorite = async () => {
    if (!album || !album.isActivityEnabled) {
      return;
    }

    try {
      await activityManager.toggleLike();
    } catch (error) {
      handleError(error, $t('errors.unable_to_change_favorite'));
    }
  };

  const onAssetUpdate = (updatedAsset: AssetResponseDto) => {
    if (asset.id !== updatedAsset.id) {
      return;
    }

    // FL-35 / FL-34: an item Locked elsewhere is never shown to a session that has not unlocked; the
    // viewer moves on as if it had been removed.
    if (updatedAsset.visibility === AssetVisibility.Locked && !sessionAccess.isElevated) {
      void onAssetsDelete([updatedAsset.id]);
      return;
    }

    cursor = { ...cursor, current: updatedAsset };
    notifyAssetUpdate?.(updatedAsset);
  };

  /**
   * FL-35: the open item was deleted or moved to the trash elsewhere (another tab, another device, a
   * bulk action): show its neighbour, as a local delete does, or close when there is none. A delete
   * made here has already moved on before this arrives, so it is not the open item any more.
   */
  const onAssetsDelete = async (ids: string[]) => {
    // The page already moved on from an item it removed here: the viewer still shows it until the
    // next item loads, and acting now would close the viewer and cancel that load.
    if (!ids.includes(asset.id) || movedPast.has(asset.id)) {
      return;
    }
    const next = cursor.nextAsset && !ids.includes(cursor.nextAsset.id) ? cursor.nextAsset : undefined;
    const previous = cursor.previousAsset && !ids.includes(cursor.previousAsset.id) ? cursor.previousAsset : undefined;
    if (!(await goToAsset(next)) && !(await goToAsset(previous))) {
      closeViewer();
    }
  };

  const onAssetsUndoArchive = async (assets: TimelineAsset[]) => {
    if (assets.length === 0) {
      return;
    }
    const restoredAsset = assets[0];
    await assetViewerManager.setAssetId(restoredAsset.id);
    await navigate({ targetRoute: 'current', assetId: restoredAsset.id });
  };

  onMount(() => {
    syncAssetViewerOpenClass(true);
    // FL-36: a slideshow starts only from a stopped viewer; resuming from pause is not a new run.
    let previousSlideshowState = $slideshowState;
    const slideshowStateUnsubscribe = slideshowState.subscribe((value) => {
      const previous = previousSlideshowState;
      previousSlideshowState = value;
      if (value === SlideshowState.PlaySlideshow && previous !== SlideshowState.PauseSlideshow) {
        slideshowHistory.reset();
        slideshowHistory.queue(toTimelineAsset(asset));
        handlePlaySlideshow();
      } else if (value === SlideshowState.StopSlideshow) {
        handlePromiseError(handleStopSlideshow());
      }
    });

    const slideshowNavigationUnsubscribe = slideshowNavigation.subscribe((value) => {
      if (value !== SlideshowNavigation.Shuffle) {
        return;
      }

      slideshowHistory.reset();
      slideshowHistory.queue(toTimelineAsset(asset));
    });

    return () => {
      slideshowStateUnsubscribe();
      slideshowNavigationUnsubscribe();
    };
  });

  onDestroy(() => {
    activityManager.reset();
    assetViewerManager.resetPanelState();
    syncAssetViewerOpenClass(false);
    preloadManager.destroy();
  });

  const closeViewer = () => {
    onClose?.(asset.id);
  };

  // FL-113: the quick editor says whether a saved version changed what the viewer should show.
  const closeEditor = async (refreshAsset = false) => {
    if (refreshAsset) {
      const refreshedAsset = await getAssetInfo({ id: asset.id });
      onAssetChange?.(refreshedAsset);
      assetViewerManager.setAsset(refreshedAsset);
    }
    assetViewerManager.closeEditor();
  };

  // FL-38: after the face tagger saves, re-read the asset and its faces, as closeEditor does.
  const refreshFaces = async () => {
    const refreshedAsset = await getAssetInfo({ id: asset.id });
    onAssetChange?.(refreshedAsset);
    assetViewerManager.setAsset(refreshedAsset);
    faceManager.clear();
    await faceManager.getAssetFaces(refreshedAsset.id);
  };

  const goToAsset = async (target: Pick<AssetResponseDto, 'id'> | undefined | null) => {
    if (!onNavigateToAsset) {
      return navigateToAsset(target);
    }
    if (!target) {
      return false;
    }
    await onNavigateToAsset(target);
    return true;
  };

  const tracker = new InvocationTracker();
  const navigateAsset = (order?: 'previous' | 'next') => {
    if (!order) {
      if ($slideshowState === SlideshowState.PlaySlideshow) {
        order = $slideshowNavigation === SlideshowNavigation.AscendingOrder ? 'previous' : 'next';
      } else {
        return;
      }
    }

    slideshowDirection = order;
    preloadManager.cancelBeforeNavigation(order);

    if (tracker.isActive()) {
      return;
    }

    void tracker.invoke(async () => {
      const isShuffle =
        $slideshowState === SlideshowState.PlaySlideshow && $slideshowNavigation === SlideshowNavigation.Shuffle;

      let hasNext: boolean;

      if (isShuffle) {
        hasNext = order === 'previous' ? slideshowHistory.previous() : slideshowHistory.next();
        if (!hasNext) {
          const asset = await onRandom?.();
          if (asset) {
            slideshowHistory.queue(asset);
            hasNext = true;
          }
        }
      } else {
        hasNext = order === 'previous' ? await goToAsset(cursor.previousAsset) : await goToAsset(cursor.nextAsset);
      }

      if ($slideshowState !== SlideshowState.PlaySlideshow) {
        return;
      }

      if (hasNext) {
        $restartSlideshowProgress = true;
        return;
      }

      if ($slideshowRepeat && slideshowStartAssetId) {
        await assetViewerManager.setAssetId(slideshowStartAssetId);
        $restartSlideshowProgress = true;
        return;
      }

      await handleStopSlideshow();
    }, $t('error_while_navigating'));
  };

  const navigateStack = (direction: 'previous' | 'next') => {
    if (!stack || !withStacked || assetViewerManager.isShowEditor) {
      return;
    }
    const assets = stack.assets;
    const currentIndex = assets.findIndex(({ id }) => id === asset.id);
    if (currentIndex === -1) {
      return;
    }
    const nextIndex = direction === 'previous' ? currentIndex - 1 : currentIndex + 1;
    if (nextIndex < 0 || nextIndex >= assets.length) {
      return;
    }
    cursor = { ...cursor, current: assets[nextIndex] };
    notifyAssetUpdate?.(cursor.current);
  };

  /**
   * Slide show mode
   */

  let assetViewerHtmlElement = $state<HTMLElement>();

  const slideshowHistory = new SlideshowHistory((asset) => {
    handlePromiseError(assetViewerManager.setAssetId(asset.id).then(() => ($restartSlideshowProgress = true)));
  });

  const handleVideoStarted = () => {
    if ($slideshowState === SlideshowState.PlaySlideshow) {
      $stopSlideshowProgress = true;
    }
  };

  // FL-36 / V-18 (MediaViewer.jsx:254-263): the slideshow plays in the viewer. Full screen is an
  // explicit choice from the slideshow controls, never forced.
  const handlePlaySlideshow = () => {
    slideshowStartAssetId = asset.id;
    if (!$slideshowAutoplay) {
      $slideshowState = SlideshowState.PauseSlideshow;
    }
  };

  const handleStopSlideshow = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      }
    } catch (error) {
      handleError(error, $t('errors.unable_to_exit_fullscreen'));
    } finally {
      $stopSlideshowProgress = true;
      $slideshowState = SlideshowState.None;
    }
  };

  /**
   * Items this viewer moved to the trash or deleted while a page's `preAction` took it to a neighbour
   * (every page that passes `preAction` moves on from the open item it removes). Showing an item
   * again, after an undo, takes it off the list.
   */
  const movedPast = new Set<string>();
  $effect(() => {
    movedPast.delete(asset.id);
  });

  const handlePreAction = async (action: Action) => {
    if (!preAction) {
      return;
    }
    const removedId =
      action.type === AssetAction.DELETE || action.type === AssetAction.TRASH ? action.asset.id : undefined;
    const shown = asset.id;
    await preAction(action);
    if (removedId === shown) {
      movedPast.add(shown);
    }
  };

  const handleAction = async (action: Action) => {
    switch (action.type) {
      case AssetAction.DELETE:
      case AssetAction.TRASH: {
        eventManager.emit('AssetsDelete', [action.asset.id]);
        break;
      }
      case AssetAction.REMOVE_ASSET_FROM_STACK: {
        stack = action.stack;
        if (stack) {
          cursor = { ...cursor, current: stack.assets[0] };
          notifyAssetUpdate?.(cursor.current);
        }
        break;
      }
      case AssetAction.STACK:
      case AssetAction.SET_STACK_PRIMARY_ASSET: {
        stack = action.stack;
        break;
      }
      case AssetAction.SET_PERSON_FEATURED_PHOTO: {
        const assetInfo = await getAssetInfo({ id: asset.id });
        cursor.current = { ...asset, people: assetInfo.people };
        eventManager.emit('AssetUpdate', cursor.current);
        break;
      }
      case AssetAction.RATING: {
        cursor.current = {
          ...asset,
          exifInfo: {
            ...asset.exifInfo,
            rating: action.rating,
          },
        };
        notifyAssetUpdate?.(cursor.current);
        break;
      }
      case AssetAction.UNSTACK: {
        closeViewer();
        break;
      }
      // no default
    }

    onAction?.(action);
  };

  let isFullScreen = $derived(!!fullscreenElement);

  $effect(() => {
    if (album && !album.isActivityEnabled && activityManager.commentCount === 0) {
      assetViewerManager.closeActivityPanel();
    }
  });
  $effect(() => {
    if (album && isShared && asset.id) {
      handlePromiseError(activityManager.init(album.id, asset.id));
    }
  });

  const syncAssetViewerOpenClass = (isOpen: boolean) => {
    if (browser) {
      document.body.classList.toggle('asset-viewer-open', isOpen);
    }
  };

  const refresh = async () => {
    // FL-35: a panorama always opens looking around again after a navigation.
    assetViewerManager.resetPanoramaView();
    await refreshStack();
    ocrManager.clear();
    faceManager.clear();
    if (!sharedLink) {
      if (previewStackedAsset) {
        await ocrManager.getAssetOcr(previewStackedAsset.id);
        await faceManager.getAssetFaces(previewStackedAsset.id);
      }
      await ocrManager.getAssetOcr(asset.id);
      await faceManager.getAssetFaces(asset.id);
    }
  };

  $effect(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    asset;
    untrack(() => handlePromiseError(refresh()));
  });

  let lastCursor = $state<AssetCursor>();

  $effect(() => {
    if (cursor.current.id === lastCursor?.current.id) {
      return;
    }
    if (lastCursor) {
      preloadManager.updateAfterNavigation(lastCursor, cursor, sharedLink);
    }
    if (!lastCursor) {
      preloadManager.initializePreloads(cursor, sharedLink);
    }
    lastCursor = cursor;
  });

  const viewerKind = $derived.by(() => {
    if (previewStackedAsset) {
      return previewStackedAsset.type === AssetTypeEnum.Image ? 'PhotoViewer' : 'StackVideoViewer';
    }
    if (asset.type === AssetTypeEnum.Video) {
      return 'VideoViewer';
    }
    if (assetViewerManager.isPlayingMotionPhoto && asset.livePhotoVideoId) {
      return 'LiveVideoViewer';
    }
    // FL-35: a panorama looks around by default; "Fit panorama" shows the flat frame.
    if (isPanorama(asset) && !assetViewerManager.isPanoramaFlattened) {
      return 'ImagePanaramaViewer';
    }
    return 'PhotoViewer';
  });

  const showActivityStatus = $derived(
    $slideshowState === SlideshowState.None &&
      isShared &&
      ((album && album.isActivityEnabled) || activityManager.commentCount > 0) &&
      !activityManager.isLoading,
  );

  const showOcrButton = $derived(
    $slideshowState === SlideshowState.None &&
      asset.type === AssetTypeEnum.Image &&
      !assetViewerManager.isShowEditor &&
      ocrManager.hasOcrData,
  );

  const { Tag, TagPeople } = $derived(getAssetActions($t, asset));
  const showDetailPanel = $derived(
    asset.hasMetadata &&
      $slideshowState === SlideshowState.None &&
      assetViewerManager.isShowDetailPanel &&
      !assetViewerManager.isShowEditor,
  );

  /**
   * FL-35: the filmstrip is a client preference, needs a real list of neighbours, and
   * stays out of the way of the slideshow, the editor and the stack strip.
   */
  const showFilmstripStrip = $derived(
    $showFilmstrip &&
      filmstripAssets.length > 1 &&
      $slideshowState === SlideshowState.None &&
      !assetViewerManager.isShowEditor &&
      !(stack && withStacked),
  );

  /**
   * FL-35 hands-on viewer (apple-style.css:366-407, MediaViewer.jsx:197-199 and 524-578): a tap on the
   * photo hides and shows the chrome, and a downward drag at normal zoom closes the viewer. The drag
   * follows the finger by scaling the canvas and fading the black behind it.
   */
  let chromeHidden = $state(false);
  let dismissDrag = $state<DismissDrag | null>(null);

  const gesture = new ViewerGesture({
    onDrag: (drag) => (dismissDrag = drag),
    onRelease: () => (dismissDrag = null),
    onDismiss: () => {
      dismissDrag = null;
      onClose?.(stack?.primaryAssetId ?? asset.id);
    },
    onTap: () => (chromeHidden = !chromeHidden),
  });

  const gesturesEnabled = $derived(
    $slideshowState === SlideshowState.None &&
      !assetViewerManager.isShowEditor &&
      !assetViewerManager.isFaceEditMode &&
      !ocrManager.showOverlay &&
      // Dragging a panorama looks around it, so it never closes the viewer.
      viewerKind !== 'ImagePanaramaViewer',
  );

  /**
   * Every pointer down anywhere, tracked on the window (capture phase, so it is counted before the
   * canvas sees it). The swipe starts only while exactly one pointer is down: lifting and replacing
   * one finger of a pinch never restarts it.
   */
  const activePointers = new Set<number>();
  const releasePointer = (event: PointerEvent) => activePointers.delete(event.pointerId);

  const onCanvasPointerDown = (event: PointerEvent) => {
    if (
      activePointers.size !== 1 ||
      !gesturesEnabled ||
      event.button > 0 ||
      assetViewerManager.zoom > 1 ||
      isGestureExempt(event.target)
    ) {
      return;
    }
    gesture.start(event.pointerId, event.clientX, event.clientY);
  };

  // A second finger anywhere (a pinch) ends the gesture; the canvas handler covers the canvas itself.
  const onWindowPointerDown = (event: PointerEvent) => {
    if (gesture.active && gesture.pointerId !== event.pointerId) {
      gesture.cancel();
    }
  };

  const onWindowPointerMove = (event: PointerEvent) => {
    if (gesture.active && assetViewerManager.zoom > 1) {
      gesture.cancel();
      return;
    }
    gesture.move(event.pointerId, event.clientX, event.clientY);
  };

  // The chrome comes back whenever something else takes over the screen.
  $effect(() => {
    if (gesturesEnabled) {
      return;
    }
    chromeHidden = false;
    gesture.cancel();
  });

  // FL-36: a slideshow hides the chrome while it plays; ending it brings the chrome back.
  $effect(() => {
    if ($slideshowState === SlideshowState.None) {
      untrack(() => (chromeHidden = false));
    }
  });

  const canvasTransform = $derived(
    dismissDrag
      ? `translate(${dismissDrag.x}px, ${dismissDrag.y}px) scale(${1 - dismissDrag.progress * 0.25})`
      : undefined,
  );

  /** V-13: the footer's full-screen toggle (MediaViewer.jsx:1799-1806). */
  const toggleFullscreen = async () => {
    try {
      await (document.fullscreenElement ? document.exitFullscreen() : assetViewerHtmlElement?.requestFullscreen());
    } catch (error) {
      handleError(error, $t('errors.unable_to_enter_fullscreen'));
    }
  };

  // V-13 / FL-36: the footer's cog and the slideshow share `slideshowStore.settingsOpen`; the viewer
  // renders `SlideshowSettingsPanel` for it (below), which returns focus to the control that opened it.

  /** Hidden chrome comes back as soon as the keyboard is used, so nothing focusable stays invisible. */
  const revealChrome = () => {
    if (chromeHidden) {
      chromeHidden = false;
    }
  };

  /**
   * MediaViewer.jsx:733-744: with the slideshow settings open, Escape closes them first, wherever
   * focus is, before anything else in the viewer (closing the viewer, ending a slideshow) sees it.
   */
  const closeSettingsOnEscape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !$slideshowSettingsOpen) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    void slideshowStore.closeSettings();
  };

  /**
   * Closing the information card from inside it puts focus back on the Information button, not on
   * the page behind the viewer.
   */
  let infoHadFocus = false;
  const infoFocusOut = (event: FocusEvent) => {
    const next = event.relatedTarget as Node | null;
    if (next && !(event.currentTarget as HTMLElement).contains(next)) {
      infoHadFocus = false;
    }
  };

  const VIDEO_VIEWERS = new Set(['VideoViewer', 'StackVideoViewer', 'LiveVideoViewer']);

  // FL-36 / V-18: the footer stays while an inline slideshow plays, so Pause and the settings are
  // reachable; the slideshow's idle hide and tap toggle hide it with the rest of the chrome.
  const showFooter = $derived(!assetViewerManager.isShowEditor);

  const showStackStrip = $derived(
    !!stack && withStacked && !assetViewerManager.isShowEditor && $slideshowState === SlideshowState.None,
  );

  $effect(() => {
    if (showDetailPanel || !infoHadFocus) {
      return;
    }
    infoHadFocus = false;
    assetViewerHtmlElement?.querySelector<HTMLElement>(':scope [data-viewer-chrome] [data-viewer-info]')?.focus();
  });

  const onSwipe = (event: SwipeCustomEvent) => {
    if (assetViewerManager.zoom > 1) {
      return;
    }

    if (ocrManager.showOverlay) {
      return;
    }

    if (event.detail.direction === 'left') {
      navigateAsset('next');
    } else if (event.detail.direction === 'right') {
      navigateAsset('previous');
    }
  };
</script>

<CommandPaletteDefaultProvider name={$t('assets')} actions={[Tag, TagPeople]} />
<OnEvents {onAssetUpdate} {onAssetsUndoArchive} {onAssetsDelete} />

<svelte:window
  onkeydowncapture={closeSettingsOnEscape}
  onkeydown={revealChrome}
  onpointerdowncapture={(event) => activePointers.add(event.pointerId)}
  onpointerupcapture={releasePointer}
  onpointercancelcapture={releasePointer}
  onpointerdown={onWindowPointerDown}
  onpointermove={onWindowPointerMove}
  onpointerup={(event) => gesture.end(event.pointerId, event.clientX, event.clientY)}
  onpointercancel={(event) => {
    if (gesture.pointerId === event.pointerId) {
      gesture.cancel();
    }
  }}
/>

<svelte:document
  bind:fullscreenElement
  use:shortcuts={[
    { shortcut: { key: 'ArrowUp' }, onShortcut: () => navigateStack('previous') },
    { shortcut: { key: 'ArrowDown' }, onShortcut: () => navigateStack('next') },
  ]}
/>

<section
  id="immich-asset-viewer"
  data-asset-id={cursor.current.id}
  class="fl-media-viewer fixed inset-s-0 top-0 grid size-full grid-cols-4 grid-rows-[auto_1fr] overflow-hidden"
  class:chrome-hidden={chromeHidden}
  class:dragging={!!dismissDrag}
  class:with-footer={showFilmstripStrip || showStackStrip}
  style:background-color={dismissDrag ? `rgb(0 0 0 / ${1 - dismissDrag.progress})` : undefined}
  data-theme="dark"
  use:focusTrap
  bind:this={assetViewerHtmlElement}
  onfocusin={revealChrome}
>
  <!--
    Top navigation bar. The header and the footer stack at the same level, z-2, as in the template
    (apple-style.css:383-385), so where they overlap the later footer paints on top. The More menu is kept
    clear of the footer by its height cap (`.mv-menu` max-height: calc(100dvh - 150px), media-viewer.css:145;
    see AssetViewerNavBar), not by raising the header above the footer.
  -->
  {#if $slideshowState === SlideshowState.None && !assetViewerManager.isShowEditor}
    <div class="relative z-2 col-span-4 col-start-1 row-span-1 row-start-1" data-viewer-chrome="header">
      <AssetViewerNavBar
        {asset}
        {album}
        {stack}
        preAction={handlePreAction}
        onAction={handleAction}
        {onUndoDelete}
        onClose={onClose ? () => onClose(stack?.primaryAssetId ?? asset.id) : undefined}
        {isPlayingOriginalVideo}
        {setPlayOriginalVideo}
        canNavigateCollection={!!(nextAsset || previousAsset)}
        canShowFilmstrip={filmstripAssets.length > 1}
      />
    </div>
  {/if}

  {#if $slideshowState !== SlideshowState.None}
    <div class="absolute inset-s-0 top-0 flex w-full justify-start">
      <SlideshowBar
        {asset}
        bind:chromeHidden
        title={album?.albumName ?? person?.name}
        assetType={previewStackedAsset?.type ?? asset.type}
        onPrevious={() => navigateAsset('previous')}
        onNext={() => navigateAsset('next')}
        onClose={() => ($slideshowState = SlideshowState.StopSlideshow)}
      />
    </div>
  {/if}

  <!-- FL-36: the slideshow settings panel (MediaViewer.jsx:2086); any control may open it through slideshowStore.toggleSettings. -->
  {#if $slideshowSettingsOpen}
    <SlideshowSettingsPanel onClose={() => void slideshowStore.closeSettings()} />
  {/if}

  {#if $slideshowState === SlideshowState.None && showNavigation && !assetViewerManager.isShowEditor && !assetViewerManager.isFaceEditMode && previousAsset}
    <div class="col-span-1 col-start-1 row-span-full row-start-1 my-auto justify-self-start" data-viewer-chrome>
      <PreviousAssetAction onPreviousAsset={() => navigateAsset('previous')} />
    </div>
  {/if}

  <!-- Asset Viewer -->
  <!-- FL-36: while a slideshow runs, each item arrives with the chosen transition. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    data-viewer-content
    class="fl-viewer-canvas relative z-[-1] col-span-4 col-start-1 row-span-full row-start-1"
    class:fl-viewer-video={VIDEO_VIEWERS.has(viewerKind)}
    style:transform={canvasTransform}
    onpointerdown={onCanvasPointerDown}
    {@attach slideshowStage(
      () => ({
        active: $slideshowState !== SlideshowState.None,
        assetId: asset.id,
        transition: $slideshowTransition,
        intervalSeconds: $slideshowDelay,
        direction: slideshowDirection,
        video: asset.type === AssetTypeEnum.Video,
      }),
      () => $slideshowState === SlideshowState.PauseSlideshow || $slideshowSettingsOpen,
    )}
  >
    {#if viewerKind === 'StackVideoViewer'}
      <VideoViewer
        asset={previewStackedAsset!}
        cacheKey={previewStackedAsset!.thumbhash}
        projectionType={previewStackedAsset!.exifInfo?.projectionType}
        loopVideo={true}
        onPreviousAsset={() => navigateAsset('previous')}
        onNextAsset={() => navigateAsset('next')}
        onClose={closeViewer}
        onVideoEnded={() => navigateAsset()}
        onVideoStarted={handleVideoStarted}
        playOriginalVideo={isPlayingOriginalVideo}
      />
    {:else if viewerKind === 'LiveVideoViewer'}
      <VideoViewer
        {asset}
        assetId={asset.livePhotoVideoId!}
        cacheKey={asset.thumbhash}
        projectionType={asset.exifInfo?.projectionType}
        loopVideo={$slideshowState !== SlideshowState.PlaySlideshow}
        onPreviousAsset={() => navigateAsset('previous')}
        onNextAsset={() => navigateAsset('next')}
        onVideoEnded={() => (assetViewerManager.isPlayingMotionPhoto = false)}
        playOriginalVideo={isPlayingOriginalVideo}
      />
    {:else if viewerKind === 'ImagePanaramaViewer'}
      <ImagePanoramaViewer {asset} />
    {:else if viewerKind === 'PhotoViewer'}
      <PhotoViewer cursor={{ ...cursor, current: asset }} {sharedLink} {onSwipe} />
    {:else if viewerKind === 'VideoViewer'}
      <VideoViewer
        {asset}
        cacheKey={asset.thumbhash}
        projectionType={asset.exifInfo?.projectionType}
        loopVideo={$slideshowState !== SlideshowState.PlaySlideshow}
        extendedControls
        onPreviousAsset={() => navigateAsset('previous')}
        onNextAsset={() => navigateAsset('next')}
        onClose={closeViewer}
        onVideoEnded={() => navigateAsset()}
        onVideoStarted={handleVideoStarted}
        playOriginalVideo={isPlayingOriginalVideo}
      />
    {/if}

    <!-- V-16: a Live Photo plays its clip from the on-photo badge (MediaViewer.jsx:1522-1543). -->
    {#if asset.livePhotoVideoId && (viewerKind === 'PhotoViewer' || viewerKind === 'LiveVideoViewer') && !isPanorama(asset) && !assetViewerManager.isShowEditor}
      <div class="fl-live-badge-slot pointer-events-none absolute z-10">
        <ViewerLiveBadge />
      </div>
    {/if}

    <!-- FL-35: the original file is missing from its library; offer the relink route. -->
    {#if asset.isOffline && $slideshowState === SlideshowState.None && !assetViewerManager.isShowEditor}
      <div class="pointer-events-none absolute inset-x-0 top-16 z-10 px-4 pt-2">
        <ViewerOfflineBanner {asset} />
      </div>
    {/if}

    {#if showActivityStatus}
      <div
        class="absolute inset-e-0 bottom-0 me-8 mb-20"
        style:bottom="var(--fl-viewer-toolbar-offset)"
        data-viewer-chrome
      >
        <ActivityStatus
          disabled={!album?.isActivityEnabled}
          isLiked={activityManager.isLiked}
          numberOfComments={activityManager.commentCount}
          numberOfLikes={activityManager.likeCount}
          onFavorite={handleFavorite}
        />
      </div>
    {/if}

    {#if showOcrButton}
      <div
        class="absolute inset-e-0 bottom-0 me-6 mb-6 drop-shadow-[0_0_1px_rgba(0,0,0,0.4)]"
        style:bottom="var(--fl-viewer-toolbar-offset)"
        data-viewer-chrome
      >
        <OcrButton />
      </div>
    {/if}

    {#if $slideshowState !== SlideshowState.None}
      <SlideshowMetadataOverlay {asset} />
      <SlideshowMemoriesOverlay {asset} {album} {person} />
    {/if}
  </div>

  {#if $slideshowState === SlideshowState.None && showNavigation && !assetViewerManager.isShowEditor && !assetViewerManager.isFaceEditMode && nextAsset}
    <div class="col-span-1 col-start-4 row-span-full row-start-1 my-auto justify-self-end" data-viewer-chrome>
      <NextAssetAction onNextAsset={() => navigateAsset('next')} />
    </div>
  {/if}

  {#if showDetailPanel}
    <!--
      FL-36: information floats over the photo as a glass card from 761px (apple-style.css:515-560),
      entering on the spring; phones keep the bottom sheet (media-viewer.css:1942-1987). Either way it
      stays dark, like the rest of the viewer.
    -->
    <div
      id="detail-panel"
      class="fl-viewer-info fl-continuous-corners dark"
      translate="yes"
      onfocusin={() => (infoHadFocus = true)}
      onfocusout={infoFocusOut}
    >
      <span class="fl-viewer-sheet-handle" aria-hidden="true"></span>
      <!--
          FL-35 stops at the viewer's media sources, navigation and actions. FL-36 rebuilt
          the panel itself — the inline description, date and timezone, location, tag and
          rating edits, the enrichment card and the file, path and checksum details — in
          place, so there is no second panel and no opt-in switch between them. The people
          and face edits are FL-38 and continue to live inside DetailPanel.
        -->
      <DetailPanel {asset} currentAlbum={album} {onAssetUpdate} {onAssetSuppressed} />
    </div>
  {/if}

  <!--
    FL-113: the quick editor is a full-screen, media-aware surface layered over the viewer,
    not a side panel. Photos edit through the server develop recipe pipeline; videos keep the
    production video editor's commands inside the same frame.
  -->
  {#if assetViewerManager.isShowEditor}
    <QuickEditor {asset} onClose={closeEditor} />
  {/if}

  <!-- FL-38: the face tagger is a modal dialog over the viewer (FaceTagger.jsx), for photos and videos alike. -->
  {#if assetViewerManager.isFaceEditMode}
    {#key asset.id}
      <FaceTagger {asset} onClose={() => assetViewerManager.closeFaceEditMode()} onSaved={refreshFaces} />
    {/key}
  {/if}

  <!-- FL-35: the stack strip carries keep-this and set-primary beside the members. -->
  {#if showStackStrip && stack}
    <div
      id="stack-slideshow"
      class="fl-viewer-strip absolute bottom-0 col-span-4 col-start-1 w-fit max-w-full"
      data-viewer-chrome="footer"
    >
      <ViewerStackStrip
        {stack}
        {asset}
        onAction={handleAction}
        onSelect={(stackedAsset) => {
          cursor = { ...cursor, current: stackedAsset };
          notifyAssetUpdate?.(stackedAsset);
          previewStackedAsset = undefined;
        }}
        onPreview={(stackedAsset) => (previewStackedAsset = stackedAsset)}
      />
    </div>
  {/if}

  <!-- FL-35: the filmstrip, shown only when the caller supplied the neighbours. -->
  {#if showFilmstripStrip}
    <div class="fl-viewer-strip absolute inset-x-0 bottom-0 col-span-4 col-start-1" data-viewer-chrome="footer">
      <ViewerFilmstrip
        assets={filmstripAssets}
        currentAssetId={asset.id}
        onSelect={(selected) => handlePromiseError(goToAsset(selected))}
      />
    </div>
  {/if}

  <!-- V-13: the footer (MediaViewer.jsx:1693-1797), frosted over the bottom of the photo. -->
  {#if showFooter}
    <div class="absolute inset-x-0 bottom-0 z-2 col-span-4 col-start-1" data-viewer-chrome="footer">
      <ViewerFooter
        {asset}
        {position}
        canNavigateCollection={!!(nextAsset || previousAsset)}
        canShowFilmstrip={filmstripAssets.length > 1}
        hasStack={!!stack && withStacked}
        zoomable={viewerKind === 'PhotoViewer' && !previewStackedAsset}
        {isPlayingOriginalVideo}
        {setPlayOriginalVideo}
        fullscreen={isFullScreen}
        onToggleFullscreen={() => handlePromiseError(toggleFullscreen())}
      />
    </div>
  {/if}

  {#if isShared && album && assetViewerManager.isShowActivityPanel && authManager.authenticated}
    <div
      transition:motionFly={{ duration: 150 }}
      id="activity-panel"
      class="row-span-5 row-start-1 w-90 overflow-y-auto transition-all md:w-115 dark:border-l dark:border-s-immich-dark-gray"
      translate="yes"
    >
      {#if activityPanel}
        {@render activityPanel(asset)}
      {:else}
        <!-- AL-18: the item's likes and comments in the Frameleaf activity panel (ActivityPanel.jsx). -->
        <Theme theme="dark">
          <ActivityPanel {album} assetId={asset.id} onClose={() => assetViewerManager.closeActivityPanel()} />
        </Theme>
      {/if}
    </div>
  {/if}
</section>

<style>
  /* .mv-live-badge sits 14px into the photo's top-left corner, under the 64px header (media-viewer.css:478-481). */
  .fl-live-badge-slot {
    top: calc(64px + env(safe-area-inset-top, 0px) + 14px);
    inset-inline-start: max(14px, env(safe-area-inset-left));
  }

  #immich-asset-viewer {
    contain: layout;
    /* apple-style.css:366-370: a pure black canvas in both themes. */
    background: #000;
    color: #fff;
    /*
     * What sits along the bottom edge: the 60px footer (V-13) and, on phones, the bottom toolbar above
     * it (AssetViewerNavBar, apple-style.css:756-763). Strips, badges and video controls clear both.
     */
    --fl-viewer-footer-height: calc(60px + env(safe-area-inset-bottom));
    --fl-viewer-toolbar-offset: var(--fl-viewer-footer-height);
  }

  .fl-viewer-canvas {
    isolation: isolate;
    transition:
      transform 460ms var(--fl-spring),
      opacity 300ms ease;
  }

  /* A video keeps its controls clear of the phone toolbar. */
  .fl-viewer-video {
    padding-bottom: var(--fl-viewer-toolbar-offset);
  }

  .dragging .fl-viewer-canvas {
    transition: none;
  }

  /* #13 tap hides the controls (apple-style.css:383-403). */
  [data-viewer-chrome] {
    transition:
      opacity 260ms ease,
      translate 420ms var(--fl-spring);
  }

  .chrome-hidden [data-viewer-chrome] {
    opacity: 0;
    pointer-events: none;
  }

  @media (min-width: 701px) {
    .chrome-hidden [data-viewer-chrome='header'] {
      translate: 0 -12px;
    }
  }

  .chrome-hidden [data-viewer-chrome='footer'] {
    translate: 0 12px;
  }

  /* The frosted strips above the footer: the stack strip and the filmstrip (apple-style.css:383-392). */
  .fl-viewer-strip {
    isolation: isolate;
    bottom: var(--fl-viewer-toolbar-offset);
    border-top: 1px solid #ffffff14;
  }

  .fl-viewer-strip::before {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    background: #1c1c1e99;
    backdrop-filter: var(--fl-material-blur);
  }

  .fl-viewer-sheet-handle {
    display: none;
  }

  /* Information: the floating glass card on tablet and desktop (apple-style.css:515-560). */
  .fl-viewer-info {
    position: absolute;
    top: max(76px, calc(env(safe-area-inset-top) + 68px));
    right: max(16px, env(safe-area-inset-right));
    bottom: 76px;
    z-index: 5;
    width: 340px;
    max-width: calc(100vw - 32px);
    overflow-y: auto;
    overscroll-behavior: contain;
    border: 1px solid #ffffff1f;
    border-radius: 20px;
    background: color-mix(in srgb, #1c1c1e 72%, transparent);
    backdrop-filter: blur(36px) saturate(180%);
    box-shadow: 0 24px 80px #000a;
    color: #f1f1f2;
    animation: fl-card-in 420ms var(--fl-spring) both;
  }

  /* Clear of the filmstrip or stack strip (apple-style.css:540-542). */
  .with-footer .fl-viewer-info {
    bottom: 168px;
  }

  @supports (corner-shape: squircle) {
    .fl-viewer-info {
      border-radius: 36px;
    }
  }

  /* Phones: the bottom sheet (media-viewer.css:1942-1987), above the bottom toolbar. */
  @media (max-width: 760px) {
    .fl-viewer-info,
    .with-footer .fl-viewer-info {
      inset: auto 0 0;
      width: 100%;
      max-width: none;
      max-height: min(74%, calc(100% - 72px));
      padding-bottom: env(safe-area-inset-bottom);
      border-width: 1px 0 0;
      border-radius: 16px 16px 0 0;
      animation: fl-sheet-in 240ms var(--fl-spring) both;
    }

    .fl-viewer-sheet-handle {
      display: block;
      width: 40px;
      height: 4px;
      margin: 7px auto 0;
      border-radius: 2px;
      background: #ffffff24;
    }
  }

  @media (max-width: 700px) {
    #immich-asset-viewer {
      --fl-viewer-toolbar-offset: calc(var(--fl-viewer-footer-height) + 53px);
    }
  }

  @keyframes fl-card-in {
    from {
      opacity: 0;
      translate: 16px 0;
      scale: 0.98;
    }
  }

  @keyframes fl-sheet-in {
    from {
      opacity: 0;
      translate: 0 24px;
    }
  }

  @keyframes fl-fade-in {
    from {
      opacity: 0;
    }
  }

  @media (prefers-contrast: more), (prefers-reduced-transparency: reduce) {
    .fl-viewer-strip::before {
      background: #1c1c1e;
      backdrop-filter: none;
    }

    .fl-viewer-info {
      background: #1c1c1e;
      backdrop-filter: none;
    }
  }

  /* Reduce Motion: crossfades instead of movement (apple-style.css:466-490, 553-557). */
  @media (prefers-reduced-motion: reduce) {
    .fl-viewer-canvas {
      transition: opacity 150ms ease;
    }

    [data-viewer-chrome] {
      transition: opacity 150ms ease;
    }

    .chrome-hidden [data-viewer-chrome] {
      translate: none !important;
    }

    .fl-viewer-info {
      animation: fl-fade-in 200ms ease both;
    }
  }
</style>
