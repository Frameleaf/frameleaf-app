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
     * FL-55: what the activity side panel shows for the open item. A shared space mounts its own
     * per-item conversation here; without it the panel keeps the album activity viewer.
     */
    activityPanel?: Snippet<[AssetResponseDto]>;
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
    activityPanel,
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

    cursor = { ...cursor, current: updatedAsset };
    notifyAssetUpdate?.(updatedAsset);
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
        hasNext =
          order === 'previous' ? await navigateToAsset(cursor.previousAsset) : await navigateToAsset(cursor.nextAsset);
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

  const toggleSlideshowFullScreen = async () => {
    try {
      await (document.fullscreenElement ? document.exitFullscreen() : assetViewerHtmlElement?.requestFullscreen?.());
    } catch (error) {
      handleError(error, $t('errors.unable_to_enter_fullscreen'));
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

  const handlePreAction = (action: Action) => {
    return preAction?.(action);
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
<OnEvents {onAssetUpdate} {onAssetsUndoArchive} />

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
  class="fixed inset-s-0 top-0 grid size-full grid-cols-4 grid-rows-[64px_1fr] overflow-hidden bg-black"
  use:focusTrap
  bind:this={assetViewerHtmlElement}
>
  <!-- Top navigation bar -->
  {#if $slideshowState === SlideshowState.None && !assetViewerManager.isShowEditor}
    <div class="col-span-4 col-start-1 row-span-1 row-start-1 transition-transform">
      <AssetViewerNavBar
        {asset}
        {album}
        {person}
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
        {isFullScreen}
        {asset}
        title={album?.albumName ?? person?.name}
        assetType={previewStackedAsset?.type ?? asset.type}
        onToggleFullScreen={() => void toggleSlideshowFullScreen()}
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
    <div class="col-span-1 col-start-1 row-span-full row-start-1 my-auto justify-self-start">
      <PreviousAssetAction onPreviousAsset={() => navigateAsset('previous')} />
    </div>
  {/if}

  <!-- Asset Viewer -->
  <!-- FL-36: while a slideshow runs, each item arrives with the chosen transition. -->
  <div
    data-viewer-content
    class="relative z-[-1] col-span-4 col-start-1 row-span-full row-start-1"
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

    <!-- FL-35: the original file is missing from its library; offer the relink route. -->
    {#if asset.isOffline && $slideshowState === SlideshowState.None && !assetViewerManager.isShowEditor}
      <div class="pointer-events-none absolute inset-x-0 top-16 z-10 px-4 pt-2">
        <ViewerOfflineBanner {asset} />
      </div>
    {/if}

    {#if showActivityStatus}
      <div class="absolute inset-e-0 bottom-0 me-8 mb-20">
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
      <div class="absolute inset-e-0 bottom-0 me-6 mb-6 drop-shadow-[0_0_1px_rgba(0,0,0,0.4)]">
        <OcrButton />
      </div>
    {/if}

    {#if $slideshowState !== SlideshowState.None}
      <SlideshowMetadataOverlay {asset} />
      <SlideshowMemoriesOverlay {asset} {album} {person} />
    {/if}
  </div>

  {#if $slideshowState === SlideshowState.None && showNavigation && !assetViewerManager.isShowEditor && !assetViewerManager.isFaceEditMode && nextAsset}
    <div class="col-span-1 col-start-4 row-span-full row-start-1 my-auto justify-self-end">
      <NextAssetAction onNextAsset={() => navigateAsset('next')} />
    </div>
  {/if}

  {#if showDetailPanel}
    <div
      transition:motionFly={{ duration: 150 }}
      id="detail-panel"
      class="row-span-4 row-start-1 w-90 overflow-y-auto bg-light transition-all dark:border-l dark:border-s-immich-dark-gray"
      translate="yes"
    >
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
  {#if stack && withStacked && !assetViewerManager.isShowEditor && $slideshowState === SlideshowState.None}
    <div id="stack-slideshow" class="absolute bottom-0 col-span-4 col-start-1 w-fit max-w-full">
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
    <div class="absolute inset-x-0 bottom-0 col-span-4 col-start-1">
      <ViewerFilmstrip
        assets={filmstripAssets}
        currentAssetId={asset.id}
        onSelect={(selected) => handlePromiseError(navigate({ targetRoute: 'current', assetId: selected.id }))}
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
  #immich-asset-viewer {
    contain: layout;
  }
</style>
