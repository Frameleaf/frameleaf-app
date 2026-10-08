<script lang="ts">
  import { isForwardKey } from '$lib/frameleaf/reading-direction';
  import { browser } from '$app/environment';
  import { replaceState } from '$app/navigation';
  import { page } from '$app/state';
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
  import { readEditorContinuity } from '$lib/frameleaf/editor-continuity';
  import ViewerOfflineBanner from '$lib/components/frameleaf/ViewerOfflineBanner.svelte';
  import {
    bumpPlaybackRevision,
    currentDevelopPlaybackRevision,
    markDevelopPlaybackUnresolved,
    playbackCacheKey,
    setDevelopPlaybackRevision,
  } from '$lib/frameleaf/playback-revision.svelte';
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
    getAssetDevelop,
    getStack,
    type AlbumResponseDto,
    type AssetResponseDto,
    type PersonResponseDto,
    type StackResponseDto,
  } from '@frameleaf/sdk';
  import ActivityPanel from '$lib/components/frameleaf/ActivityPanel.svelte';
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import { CommandPaletteDefaultProvider, Icon } from '@frameleaf/ui';
  import { mdiCheck, mdiClose } from '@mdi/js';
  import { onDestroy, onMount, tick, untrack, type Snippet } from 'svelte';
  import { t } from 'svelte-i18n';
  import { dock, motionFade, motionFly, motionSlide, prefersReducedMotion } from '$lib/frameleaf/motion';
  import { pendingRender } from '$lib/components/frameleaf/editor/pending-render.svelte';
  import { DURATION, EXIT_DURATION, ICON_SIZE } from '$lib/frameleaf/tokens';
  import { languageManager } from '$lib/managers/language-manager.svelte';
  import {
    arriveFrom,
    captureHoldover,
    fadeAway,
    infoCardIn,
    isPhoneSheet,
    neighbourThumbnail,
    SWIPE_GAP,
    ViewerSwipe,
    type HoldoverBox,
    type SwipeOrder,
  } from './viewer-motion';
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
  let developLookupGeneration = 0;
  let viewerAlive = true;
  /**
   * The owner's photo may have a saved edit, and the address of its preview follows that edit. The
   * photo is on screen from the first frame all the same (its thumbhash and thumbnail never depend on
   * the edit, and the viewer's opening zoom needs somewhere to land); this lookup only settles which
   * preview address is current. A photo with no saved edit keeps the address it started with, so
   * nothing reloads; one with an edit swaps its preview once.
   */
  const hasDevelopLookup = (current: AssetResponseDto) =>
    current.type === AssetTypeEnum.Image &&
    authManager.authenticated &&
    !authManager.isSharedLink &&
    current.ownerId === authManager.user.id;
  // The item whose preview address is settled: its lookup answered, failed, or took too long to wait for.
  let previewSettledFor = $state<string>();
  /**
   * Until then the photo shows its thumbnail and does not ask for the preview, so a photo with a
   * saved edit never requests (or flashes a cached copy of) the preview from before the edit.
   */
  const holdPreview = $derived(hasDevelopLookup(asset) && previewSettledFor !== asset.id);
  // A slow lookup stops holding the preview back: it loads at the address known so far and swaps if needed.
  const PREVIEW_HOLD_MS = 400;
  $effect(() => {
    const current = asset;
    const generation = ++developLookupGeneration;
    if (!hasDevelopLookup(current)) {
      return;
    }
    let active = true;
    const holdTimer = setTimeout(() => (previewSettledFor = current.id), PREVIEW_HOLD_MS);
    const settle = () => {
      clearTimeout(holdTimer);
      previewSettledFor = current.id;
    };
    void getAssetDevelop({ id: current.id })
      .then((develop) => {
        if (!active || generation !== developLookupGeneration) {
          return;
        }
        setDevelopPlaybackRevision(current.id, develop.currentRevisionId);
        settle();
      })
      .catch(() => {
        if (!active || generation !== developLookupGeneration) {
          return;
        }
        // A fresh key still reaches the media route, which chooses the current version itself.
        markDevelopPlaybackUnresolved(current.id);
        bumpPlaybackRevision(current.id);
        settle();
      });
    return () => {
      active = false;
      clearTimeout(holdTimer);
    };
  });
  const nextAsset = $derived(cursor.nextAsset);
  const previousAsset = $derived(cursor.previousAsset);
  let sharedLink = getSharedLink();
  let fullscreenElement = $state<Element>();

  /**
   * FL-148: outside a slideshow, `cursor.nextAsset` / `cursor.previousAsset` come from an async
   * neighbour lookup the caller runs after the asset changes (TimelineAssetViewer's `loadCloseAssets`),
   * which can still be in flight - most visibly at a month boundary, where it lazily loads the next
   * timeline bucket over the network. A real ArrowRight/ArrowLeft press (or button click) that lands
   * before that lookup resolves must not be dropped as if there were no such neighbour: it is queued
   * here and replayed by the `$effect` below once the lookup settles for this same asset.
   *
   * `queuedAt` bounds how long a queued press stays valid (see `PENDING_NAVIGATION_TTL_MS`): a lookup
   * that only settles long after the press is no longer "the same interaction" as far as the person is
   * concerned, and replaying it then would move them without a fresh keypress or click.
   */
  let pendingNavigation = $state<{ order: 'previous' | 'next'; forAssetId: string; queuedAt: number } | undefined>();

  /** FL-148: see `pendingNavigation`'s doc comment; ~1.5s is long enough to ride out a normal bucket
   * fetch but short enough that a press this stale no longer reads as "the same interaction". */
  const PENDING_NAVIGATION_TTL_MS = 1500;
  const PEEK_SELECTOR = { next: '[data-viewer-peek="next"]', previous: '[data-viewer-peek="previous"]' } as const;

  /**
   * FL-148: a second arrow press (or click) that arrives while the first navigation is still in
   * flight used to be dropped outright (`tracker.isActive()` returning early with nothing queued).
   * The latest such request is kept here and replayed - through the normal `navigateAsset` path,
   * including the neighbour-not-loaded queueing above - once the in-flight one settles.
   */
  let queuedWhileBusy: 'previous' | 'next' | undefined;

  /**
   * FL-148: the single guard both the ArrowLeft/ArrowRight shortcut and the two replay paths below
   * check - the same conditions `NextAssetAction`/`PreviousAssetAction` used to be conditionally
   * rendered under. A press queued before the neighbour resolved (or before a prior navigation
   * finished) must be re-checked against this at replay time too: the person may have opened the
   * editor, entered face-edit mode, started a slideshow, or the caller may have turned navigation off,
   * in the meantime, and a stale press must not swap the asset out from under any of those.
   */
  const canNavigateByKey = () =>
    $slideshowState === SlideshowState.None &&
    showNavigation &&
    !assetViewerManager.isShowEditor &&
    !assetViewerManager.isFaceEditMode;

  // FL-148 P1: the moment any of those guards turns false, drop whatever was queued - it must not
  // survive into the editor, face-edit mode or a slideshow just because its neighbour or its
  // in-flight navigation happened to resolve after the person moved on.
  $effect(() => {
    if (canNavigateByKey()) {
      return;
    }
    pendingNavigation = undefined;
    queuedWhileBusy = undefined;
  });

  // A reload reconstructs the viewer with isShowEditor=false. If this tab has an unsaved draft,
  // reopen its editor only after the owner asset has passed the usual route and privacy checks.
  let resumedEditorFor: string | undefined;
  $effect(() => {
    const editable =
      authManager.authenticated &&
      !authManager.isSharedLink &&
      asset.ownerId === authManager.user.id &&
      !asset.isTrashed &&
      (asset.type === AssetTypeEnum.Image || asset.type === AssetTypeEnum.Video);
    if (!editable || resumedEditorFor === asset.id) {
      return;
    }
    resumedEditorFor = asset.id;
    if (readEditorContinuity(asset.id)) {
      untrack(() => assetViewerManager.openEditor());
    }
  });

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
      if (onAssetSuppressed) {
        void onAssetSuppressed(updatedAsset);
      } else {
        void onAssetsDelete([updatedAsset.id]);
      }
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

  /**
   * FL-113: Studio's "Back to the quick editor" arrives as `?edit=1` on the asset's page. The editor
   * opens on the draft the person left (QuickEditor picks it up from `editor-continuity.ts`), and
   * only for an asset this account may edit, the same rule as the viewer's Edit action.
   */
  let editRequestHandled = false;
  $effect(() => {
    const requested = page.url.searchParams.get('edit') === '1';
    if (!requested || editRequestHandled) {
      return;
    }
    const editable =
      authManager.authenticated &&
      asset.ownerId === authManager.user.id &&
      !asset.isTrashed &&
      (asset.type === AssetTypeEnum.Image || asset.type === AssetTypeEnum.Video);
    editRequestHandled = true;
    untrack(() => {
      const url = new URL(page.url);
      url.searchParams.delete('edit');
      replaceState(url, page.state);
      if (editable) {
        assetViewerManager.openEditor();
      }
    });
  });

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
    viewerAlive = false;
    resetSwipe();
    stopHoldoverFade?.();
    activityManager.reset();
    assetViewerManager.resetPanelState();
    syncAssetViewerOpenClass(false);
    preloadManager.destroy();
  });

  const closeViewer = () => {
    onClose?.(asset.id);
  };

  // FL-115: choosing a restored version (or the original again) for playback changes the file the
  // video playback, photo preview and photo full-size URLs serve without changing the asset's thumbhash,
  // so all of them get a fresh cache key (see playback-revision.svelte.ts; getAssetUrl reads it too).
  const videoCacheKey = $derived(playbackCacheKey(asset));

  // FL-113: the quick editor says whether a saved version changed what the viewer should show.
  const closeEditor = async (refreshAsset = false) => {
    if (refreshAsset) {
      // What the photo shows is about to change: the current picture stays until the new one has loaded.
      holdCurrentPhoto('ready');
      bumpPlaybackRevision(asset.id);
      const refreshedAsset = await getAssetInfo({ id: asset.id });
      onAssetChange?.(refreshedAsset);
      assetViewerManager.setAsset(refreshedAsset);
    }
    assetViewerManager.closeEditor();
    await tick();
    if (viewerAlive && !assetViewerManager.isShowEditor) {
      assetViewerHtmlElement
        ?.querySelector<HTMLButtonElement>(`button[aria-label=${CSS.escape($t('frameleaf_viewer_edit'))}]`)
        ?.focus();
    }
  };

  const refreshRenderedPhoto = async (assetId: string) => {
    if (!viewerAlive || asset.id !== assetId) {
      return;
    }
    const generation = ++developLookupGeneration;
    try {
      const develop = await getAssetDevelop({ id: assetId });
      if (!viewerAlive || asset.id !== assetId || generation !== developLookupGeneration) {
        return;
      }
      // The photo on screen stays as a still until the finished edit has loaded, then fades into it.
      if (currentDevelopPlaybackRevision(asset) !== develop.currentRevisionId) {
        holdCurrentPhoto('ready');
      }
      setDevelopPlaybackRevision(assetId, develop.currentRevisionId);
      const refreshedAsset = await getAssetInfo({ id: assetId });
      if (!viewerAlive || asset.id !== assetId || generation !== developLookupGeneration) {
        return;
      }
      onAssetChange?.(refreshedAsset);
      assetViewerManager.setAsset(refreshedAsset);
    } catch (error) {
      if (viewerAlive && asset.id === assetId && generation === developLookupGeneration) {
        markDevelopPlaybackUnresolved(assetId);
        bumpPlaybackRevision(assetId);
        handleError(error, $t('frameleaf_editor_versions_error'));
      }
    }
  };

  /**
   * Undo after Cancel or Escape in the editor: the draft is back where the editor looks for it, so
   * opening the editor on that item resumes it. The viewer may have moved on, or closed, since.
   */
  const reopenEditor = (assetId: string) => {
    if (!viewerAlive) {
      handlePromiseError(navigate({ targetRoute: 'current', assetId }));
      return;
    }
    if (asset.id === assetId) {
      assetViewerManager.openEditor();
      return;
    }
    // Arriving on the item reopens its draft (the resume effect above).
    handlePromiseError(goToAsset({ id: assetId }));
  };

  /** Undo after closing the face tagger with unsaved tags: it opens on that item again and picks them up. */
  const reopenFaceTagger = (assetId: string) => {
    const arrive = viewerAlive
      ? asset.id === assetId
        ? undefined
        : goToAsset({ id: assetId })
      : navigate({ targetRoute: 'current', assetId });
    handlePromiseError(Promise.resolve(arrive).then(() => assetViewerManager.openFaceEditMode()));
  };

  /** An edit saved for the open item that is still being finished, or has just arrived. */
  const editInProgress = $derived(pendingRender(asset.id));

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
    arriving = { order, at: Date.now() };
    preloadManager.cancelBeforeNavigation(order);

    if ($slideshowState !== SlideshowState.PlaySlideshow) {
      const target = order === 'previous' ? previousAsset : nextAsset;
      if (target === undefined) {
        // FL-148: the neighbour lookup for this asset has not resolved yet - queue the latest intent
        // rather than silently dropping it; the replay effect below fires once it does (or does
        // nothing further if there truly is no such neighbour).
        pendingNavigation = { order, forAssetId: asset.id, queuedAt: Date.now() };
        return;
      }
    }
    pendingNavigation = undefined;

    if (tracker.isActive()) {
      // FL-148: queue the latest request instead of dropping it; it replays (below) once the
      // in-flight navigation ends.
      queuedWhileBusy = order;
      return;
    }

    void tracker
      .invoke(async () => {
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
      }, $t('error_while_navigating'))
      .then(() => {
        if (!queuedWhileBusy) {
          return;
        }
        const queuedOrder = queuedWhileBusy;
        queuedWhileBusy = undefined;
        // FL-148 P1: re-check the same guard navigateAssetByKey checks before the initial press - the
        // editor, face-edit mode or a slideshow may have opened while the first navigation was still
        // in flight, and this queued press must not fire into that state.
        if (!canNavigateByKey()) {
          return;
        }
        navigateAsset(queuedOrder);
      });
  };

  // FL-148: replays a navigation intent queued above once its neighbour lookup resolves for the same
  // asset. If the displayed asset changed for some other reason first, the stale intent is dropped.
  $effect(() => {
    if (!pendingNavigation || pendingNavigation.forAssetId !== asset.id) {
      pendingNavigation = undefined;
      return;
    }
    const target = pendingNavigation.order === 'previous' ? previousAsset : nextAsset;
    if (target === undefined) {
      return;
    }
    const { order, queuedAt } = pendingNavigation;
    pendingNavigation = undefined;
    // FL-148 P2: a lookup that only settles well after the press is no longer "the same interaction" -
    // require a fresh press instead of jumping the person with no recent input of their own.
    if (Date.now() - queuedAt > PENDING_NAVIGATION_TTL_MS) {
      return;
    }
    // FL-148 P1: re-check the same guard navigateAssetByKey checks before the initial press - the
    // editor, face-edit mode or a slideshow may have opened while the neighbour was still loading.
    if (!canNavigateByKey()) {
      return;
    }
    navigateAsset(order);
  });

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
   * FL-148: the ArrowLeft/ArrowRight shortcuts used to live only inside `NextAssetAction` /
   * `PreviousAssetAction`, which are conditionally rendered on `nextAsset`/`previousAsset` already
   * being resolved - so while that (async) lookup was still in flight the keypress had no listener to
   * reach at all. Binding the shortcut here, unconditionally, keeps it always reachable; `canNavigateByKey`
   * reproduces the same visibility guards those components rendered under (see its doc comment) so it
   * does nothing when the on-screen buttons would not have been there either, and the two replay paths
   * above re-check it too, since a queued press can outlive the state it was made in.
   */
  const navigateAssetByKey = (order: 'previous' | 'next') => {
    if (!canNavigateByKey()) {
      return;
    }
    navigateAsset(order);
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
            isRejected: action.rating === -1,
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
   * FL-35: the filmstrip is a client preference, needs a real list of neighbours, and stays out of
   * the way of the slideshow and the editor. It is the collection's strip and never changes meaning:
   * a stacked photo shows its stack as a second row above it, so the filmstrip button always does
   * what it says.
   */
  const showFilmstripStrip = $derived(
    $showFilmstrip &&
      filmstripAssets.length > 1 &&
      $slideshowState === SlideshowState.None &&
      !assetViewerManager.isShowEditor,
  );
  /** The strips' height, so the information card ends above them however many rows there are. */
  let stripsHeight = $state(0);

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
    onTap: () => {
      // On a phone the information sheet covers the button that opened it: a tap on the photo closes it.
      if (showDetailPanel && isPhoneSheet()) {
        assetViewerManager.closeDetailPanel();
        return;
      }
      chromeHidden = !chromeHidden;
    },
  });

  /**
   * The still of the photo that was on screen, kept over the incoming one so the canvas never goes
   * black: between two items it fades at once; when a finished edit arrives it waits for the new
   * render to load first.
   */
  type Holdover = HoldoverBox & { key: number; until: 'now' | 'ready' };
  /** How long a still waits for a finished edit before it gives way anyway. */
  const HOLDOVER_LIMIT_MS = 8000;
  let holdover = $state<Holdover | null>(null);
  let holdoverElement = $state<HTMLImageElement>();
  let holdoverKey = 0;
  // The loader the still was taken from: the still gives way once a different one has loaded.
  let holdoverLoader: unknown;
  let stopHoldoverFade: (() => void) | undefined;

  const showHoldover = (box: HoldoverBox | null, until: Holdover['until']) => {
    stopHoldoverFade?.();
    stopHoldoverFade = undefined;
    holdoverLoader = assetViewerManager.imageLoaderStatus;
    holdover = box ? { ...box, key: ++holdoverKey, until } : null;
  };

  const holdCurrentPhoto = (until: Holdover['until']) => {
    // A slideshow brings its own transition between items.
    if ($slideshowState !== SlideshowState.None) {
      return;
    }
    showHoldover(captureHoldover(assetViewerManager.imgRef, assetViewerHtmlElement), until);
  };

  const releaseHoldover = (duration?: number) => {
    if (!holdover || stopHoldoverFade) {
      return;
    }
    const { key } = holdover;
    stopHoldoverFade = fadeAway(
      holdoverElement,
      () => {
        stopHoldoverFade = undefined;
        if (holdover?.key === key) {
          holdover = null;
        }
      },
      duration,
    );
  };

  $effect(() => {
    const current = holdover;
    if (!current || !holdoverElement) {
      return;
    }
    if (current.until === 'now') {
      untrack(() => releaseHoldover());
      return;
    }
    const status = assetViewerManager.imageLoaderStatus;
    const arrived =
      !!status &&
      status !== holdoverLoader &&
      (status.quality.preview === 'success' || status.quality.original === 'success' || status.hasError);
    if (arrived) {
      untrack(() => releaseHoldover(DURATION.spring));
      return;
    }
    // Zooming in is asking to look at the real picture: the still never sits over that.
    if (assetViewerManager.zoom > 1) {
      untrack(() => releaseHoldover(DURATION.fast));
      return;
    }
    const timer = setTimeout(() => releaseHoldover(DURATION.spring), HOLDOVER_LIMIT_MS);
    return () => clearTimeout(timer);
  });

  /**
   * Swiping sideways at normal zoom: the photo follows the finger with the neighbour beside it, and
   * moves on past a quarter of the width or on a flick. Under Reduce Motion nothing follows; the
   * swipe still moves on, with the crossfade.
   */
  let canvasElement = $state<HTMLElement>();
  let stageElement = $state<HTMLElement>();
  let swipeX = $state<number | null>(null);
  /**
   * following: the finger is down. settling: springing back after a short drag. leaving: sliding off
   * after a release. snapping: the next item is in place, with no animation.
   */
  let swipePhase = $state<'following' | 'settling' | 'leaving' | 'snapping' | null>(null);
  let swipeCommit: { order: SwipeOrder; timer: ReturnType<typeof setTimeout> } | undefined;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;

  const SWIPE_ORDERS: SwipeOrder[] = ['previous', 'next'];
  const neighbour = (order: SwipeOrder) => (order === 'next' ? nextAsset : previousAsset);
  const resetSwipe = () => {
    if (swipeCommit) {
      clearTimeout(swipeCommit.timer);
      swipeCommit = undefined;
    }
    clearTimeout(settleTimer);
    swipePhase = null;
    swipeX = null;
  };

  /** Back to rest on the spring; the neighbours stay beside the photo until it has settled. */
  const settleSwipe = () => {
    const moved = swipeX !== null;
    resetSwipe();
    if (moved) {
      swipePhase = 'settling';
      settleTimer = setTimeout(() => {
        if (swipePhase === 'settling') {
          swipePhase = null;
        }
      }, DURATION.spring);
    }
  };

  const commitSwipe = (order: SwipeOrder) => {
    if (swipeX === null || !stageElement) {
      resetSwipe();
      navigateAsset(order);
      return;
    }
    const travel = stageElement.clientWidth + SWIPE_GAP;
    swipePhase = 'leaving';
    swipeX = order === 'next' ? -travel : travel;
    const move = () => {
      navigateAsset(order);
      // The item did not change (the move was refused or is still loading): put the photo back.
      swipeCommit = { order, timer: setTimeout(settleSwipe, PENDING_NAVIGATION_TTL_MS) };
    };
    swipeCommit = { order, timer: setTimeout(move, DURATION.slow) };
  };

  /** The neighbour the swipe brought to the middle becomes the still over the item now loading in its place. */
  const finishSwipe = () => {
    const order = swipeCommit?.order;
    const peek = order ? canvasElement?.querySelector<HTMLImageElement>(PEEK_SELECTOR[order]) : null;
    resetSwipe();
    showHoldover(captureHoldover(peek, assetViewerHtmlElement), 'now');
    swipePhase = 'snapping';
    // Once the page shows the new item at rest, with easing still off, easing comes back.
    void tick().then(() => {
      void canvasElement?.getBoundingClientRect();
      if (swipePhase === 'snapping') {
        swipePhase = null;
      }
    });
  };

  const swipe = new ViewerSwipe({
    canGo: (order) => showNavigation && !!neighbour(order),
    onEngage: () => {
      gesture.cancel();
      clearTimeout(settleTimer);
      swipePhase = 'following';
    },
    onDrag: (x) => {
      if (!prefersReducedMotion()) {
        swipeX = x;
      }
    },
    onRelease: settleSwipe,
    onCommit: commitSwipe,
  });

  /** Which way the last arrow key, button or swipe was heading, for the incoming item's settle. */
  let arriving: { order: SwipeOrder; at: number } | undefined;
  let shownAssetId: string | undefined;
  $effect.pre(() => {
    const id = asset.id;
    if (id === shownAssetId) {
      return;
    }
    const first = shownAssetId === undefined;
    shownAssetId = id;
    if (first) {
      return;
    }
    // Before the page updates: the outgoing photo is still there to take a still of.
    untrack(() => {
      const heading = arriving;
      arriving = undefined;
      if (swipeCommit) {
        finishSwipe();
        return;
      }
      holdCurrentPhoto('now');
      if (heading && Date.now() - heading.at < PENDING_NAVIGATION_TTL_MS && $slideshowState === SlideshowState.None) {
        arriveFrom(canvasElement, (heading.order === 'next') === languageManager.rtl ? -1 : 1);
      }
    });
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
    if (!swipeCommit) {
      swipe.start(event.pointerId, event.clientX, event.clientY, stageElement?.clientWidth || innerWidth);
    }
  };

  // A second finger anywhere (a pinch) ends the gesture; the canvas handler covers the canvas itself.
  const onWindowPointerDown = (event: PointerEvent) => {
    if (gesture.active && gesture.pointerId !== event.pointerId) {
      gesture.cancel();
    }
    if (swipe.active && swipe.pointerId !== event.pointerId) {
      swipe.cancel();
    }
  };

  const onWindowPointerMove = (event: PointerEvent) => {
    if (assetViewerManager.zoom > 1) {
      swipe.cancel();
      if (gesture.active) {
        gesture.cancel();
      }
      return;
    }
    gesture.move(event.pointerId, event.clientX, event.clientY);
    // One drag is either the downward close or the sideways move, never both.
    if (gesture.dragging) {
      swipe.cancel();
      return;
    }
    swipe.move(event.pointerId, event.clientX, event.clientY);
  };

  // The chrome comes back whenever something else takes over the screen.
  $effect(() => {
    if (gesturesEnabled) {
      return;
    }
    chromeHidden = false;
    gesture.cancel();
    untrack(() => swipe.cancel());
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
      : swipeX === null
        ? undefined
        : `translateX(${swipeX}px)`,
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

  /**
   * The information card: a glass card that arrives from the side from 761px, a bottom sheet on
   * phones. Both leave faster than they arrive, and both are a crossfade under Reduce Motion.
   */
  /** Share of the sheet's height a downward drag must pass to close it, or a flick this fast (px per ms). */
  const SHEET_DISMISS_RATIO = 0.3;
  const SHEET_FLICK_VELOCITY = 0.5;
  let infoElement = $state<HTMLElement>();
  let infoBody = $state<HTMLElement>();
  let sheetDrag = $state<number | null>(null);
  /** The finger is on the sheet: it moves without easing. */
  let sheetFollowing = $state(false);
  let sheetPointer: { id: number; y: number; lastY: number; lastTime: number; velocity: number } | undefined;

  const infoOut = (node: Element) => {
    if (!isPhoneSheet()) {
      return motionFly(node, { x: languageManager.rtl ? -8 : 8, duration: EXIT_DURATION.sheet });
    }
    const from = sheetDrag;
    if (from === null || prefersReducedMotion()) {
      return dock(node, { y: 24 }, { direction: 'out' });
    }
    // Dragged away: the sheet carries on down from where the finger left it.
    const rest = Math.max(0, (node as HTMLElement).offsetHeight - from);
    return {
      duration: EXIT_DURATION.dock,
      css: (t: number, u: number) => `opacity: ${t}; translate: 0 ${from + u * rest}px`,
    };
  };

  const onSheetPointerDown = (event: PointerEvent) => {
    if (!isPhoneSheet() || event.button > 0 || (event.target as Element).closest('button')) {
      return;
    }
    sheetPointer = {
      id: event.pointerId,
      y: event.clientY,
      lastY: event.clientY,
      lastTime: event.timeStamp,
      velocity: 0,
    };
    sheetFollowing = true;
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  };

  const onSheetPointerMove = (event: PointerEvent) => {
    if (!sheetPointer || sheetPointer.id !== event.pointerId) {
      return;
    }
    if (event.timeStamp > sheetPointer.lastTime) {
      sheetPointer.velocity = (event.clientY - sheetPointer.lastY) / (event.timeStamp - sheetPointer.lastTime);
      sheetPointer.lastY = event.clientY;
      sheetPointer.lastTime = event.timeStamp;
    }
    const travel = Math.max(0, event.clientY - sheetPointer.y);
    // Under Reduce Motion the sheet does not follow; the release still decides.
    sheetDrag = prefersReducedMotion() ? null : travel;
  };

  const onSheetPointerEnd = (event: PointerEvent) => {
    const pointer = sheetPointer;
    if (!pointer || pointer.id !== event.pointerId) {
      return;
    }
    sheetPointer = undefined;
    sheetFollowing = false;
    const travel = Math.max(0, event.clientY - pointer.y);
    const height = infoElement?.offsetHeight ?? 0;
    const dismissed =
      event.type === 'pointerup' &&
      ((height > 0 && travel > height * SHEET_DISMISS_RATIO) ||
        (travel > 24 && pointer.velocity > SHEET_FLICK_VELOCITY));
    if (dismissed) {
      // `infoOut` reads the drag to carry on from it; it is cleared once the sheet has gone.
      assetViewerManager.closeDetailPanel();
      return;
    }
    sheetDrag = null;
  };

  $effect(() => {
    if (showDetailPanel) {
      return;
    }
    sheetDrag = null;
    sheetPointer = undefined;
    sheetFollowing = false;
  });

  // Moving to another item with the card open: the card stays put and only its contents blink over.
  let infoAssetId: string | undefined;
  $effect(() => {
    const id = asset.id;
    const body = infoBody;
    if (!body) {
      infoAssetId = undefined;
      return;
    }
    if (infoAssetId !== undefined && infoAssetId !== id && typeof body.animate === 'function') {
      body.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: DURATION.fast, easing: 'ease-out' });
    }
    infoAssetId = id;
  });

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
  onpointerup={(event) => {
    swipe.end(event.pointerId, event.clientX);
    gesture.end(event.pointerId, event.clientX, event.clientY);
  }}
  onpointercancel={(event) => {
    if (gesture.pointerId === event.pointerId) {
      gesture.cancel();
    }
    swipe.cancel();
  }}
/>

<svelte:document
  bind:fullscreenElement
  use:shortcuts={[
    { shortcut: { key: 'ArrowUp' }, onShortcut: () => navigateStack('previous') },
    { shortcut: { key: 'ArrowDown' }, onShortcut: () => navigateStack('next') },
    {
      shortcut: { key: 'ArrowLeft' },
      onShortcut: () => navigateAssetByKey(isForwardKey('ArrowLeft') ? 'next' : 'previous'),
    },
    {
      shortcut: { key: 'ArrowRight' },
      onShortcut: () => navigateAssetByKey(isForwardKey('ArrowRight') ? 'next' : 'previous'),
    },
  ]}
/>

<section
  id="immich-asset-viewer"
  data-asset-id={cursor.current.id}
  class="fl-media-viewer fixed inset-s-0 top-0 grid size-full grid-cols-4 grid-rows-[auto_1fr] overflow-hidden"
  class:chrome-hidden={chromeHidden}
  class:dragging={!!dismissDrag}
  class:with-footer={showFilmstripStrip || showStackStrip}
  class:info-open={showDetailPanel}
  style:--fl-viewer-strips-height="{stripsHeight}px"
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
    class:following={swipePhase === 'following' || swipePhase === 'snapping'}
    class:leaving={swipePhase === 'leaving'}
    style:transform={canvasTransform}
    bind:this={canvasElement}
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
    <div class="fl-viewer-stage" bind:this={stageElement}>
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
          onPlayEncoded={() => setPlayOriginalVideo(false)}
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
        <!-- On screen from the first frame: the opening zoom lands on its fitted box, and moving between items never blanks. -->
        <PhotoViewer cursor={{ ...cursor, current: asset }} {sharedLink} holdFullSize={holdPreview} />
      {:else if viewerKind === 'VideoViewer'}
        <VideoViewer
          {asset}
          cacheKey={videoCacheKey}
          projectionType={asset.exifInfo?.projectionType}
          loopVideo={$slideshowState !== SlideshowState.PlaySlideshow}
          extendedControls
          onPreviousAsset={() => navigateAsset('previous')}
          onNextAsset={() => navigateAsset('next')}
          onClose={closeViewer}
          onVideoEnded={() => navigateAsset()}
          onVideoStarted={handleVideoStarted}
          playOriginalVideo={isPlayingOriginalVideo}
          onPlayEncoded={() => setPlayOriginalVideo(false)}
        />
      {/if}

      <!-- The neighbours, beside the photo while a swipe drags it. -->
      {#if (swipeX !== null || swipePhase === 'settling') && showNavigation}
        {#each SWIPE_ORDERS as order (order)}
          {@const url = neighbourThumbnail(neighbour(order))}
          {#if url}
            <img
              class="fl-viewer-peek"
              data-viewer-peek={order}
              src={url}
              alt=""
              aria-hidden="true"
              draggable="false"
            />
          {/if}
        {/each}
      {/if}
    </div>

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
      <div class="fl-viewer-float absolute inset-e-0 me-8 mb-20" data-viewer-chrome>
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
        class="fl-viewer-float absolute inset-e-0 me-6 mb-6 drop-shadow-[0_0_1px_rgba(0,0,0,0.4)]"
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

  <!-- The photo that was on screen, as a still over the one arriving (see `holdover`). -->
  {#if holdover}
    {#key holdover.key}
      <img
        bind:this={holdoverElement}
        class="fl-viewer-holdover"
        src={holdover.src}
        alt=""
        aria-hidden="true"
        decoding="sync"
        draggable="false"
        data-testid="viewer-holdover"
        style:left="{holdover.left}px"
        style:top="{holdover.top}px"
        style:width="{holdover.width}px"
        style:height="{holdover.height}px"
      />
    {/key}
  {/if}

  {#if $slideshowState === SlideshowState.None && showNavigation && !assetViewerManager.isShowEditor && !assetViewerManager.isFaceEditMode && nextAsset}
    <div
      class="fl-viewer-next col-span-1 col-start-4 row-span-full row-start-1 my-auto justify-self-end"
      data-viewer-chrome
    >
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
      class:sheet-dragging={sheetFollowing}
      translate="yes"
      style:translate={sheetDrag === null ? undefined : `0 ${sheetDrag}px`}
      bind:this={infoElement}
      in:infoCardIn
      out:infoOut
      onfocusin={() => (infoHadFocus = true)}
      onfocusout={infoFocusOut}
    >
      <!-- The header stays put above the scrolling details, so Close is always in reach; on phones it is also the grab area. -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <header
        class="fl-viewer-info-head"
        onpointerdown={onSheetPointerDown}
        onpointermove={onSheetPointerMove}
        onpointerup={onSheetPointerEnd}
        onpointercancel={onSheetPointerEnd}
      >
        <span class="fl-viewer-sheet-handle" aria-hidden="true"></span>
        <h2>{$t('frameleaf_viewer_information_heading')}</h2>
        <button
          type="button"
          class="fl-viewer-info-close"
          aria-label={$t('close')}
          onclick={() => assetViewerManager.closeDetailPanel()}
        >
          <Icon icon={mdiClose} size={ICON_SIZE.xl} aria-hidden />
        </button>
      </header>
      <!--
          FL-35 stops at the viewer's media sources, navigation and actions. FL-36 rebuilt
          the panel itself — the inline description, date and timezone, location, tag and
          rating edits, the enrichment card and the file, path and checksum details — in
          place, so there is no second panel and no opt-in switch between them. The people
          and face edits are FL-38 and continue to live inside DetailPanel.
        -->
      <div class="fl-viewer-info-body" bind:this={infoBody}>
        <DetailPanel {asset} currentAlbum={album} {onAssetUpdate} {onAssetSuppressed} />
      </div>
    </div>
  {/if}

  <!--
    FL-113: the quick editor is a full-screen, media-aware surface layered over the viewer,
    not a side panel. Photos edit through the server develop recipe pipeline; videos keep the
    production video editor's commands inside the same frame.
  -->
  {#if assetViewerManager.isShowEditor && authManager.authenticated && !authManager.isSharedLink && asset.ownerId === authManager.user.id}
    <!-- The editor and the viewer crossfade into each other; leaving is the shorter of the two. -->
    <div in:motionFade={{ duration: DURATION.fade }} out:motionFade={{ duration: EXIT_DURATION.sheet }}>
      <QuickEditor {asset} onClose={closeEditor} onRendered={refreshRenderedPhoto} onReopen={reopenEditor} />
    </div>
  {/if}

  <!--
    A saved edit that is still being finished: said on the photo, so the unchanged picture is not
    read as a save that did not work. It ends with a tick as the new picture fades in.
  -->
  {#if editInProgress && !assetViewerManager.isShowEditor && $slideshowState === SlideshowState.None}
    <div
      class="fl-viewer-edit-status"
      class:ready={editInProgress.ready}
      role="status"
      data-viewer-chrome
      data-testid="viewer-edit-status"
      in:dock={{ y: -8 }}
      out:dock={{ y: -8 }}
    >
      {#if editInProgress.ready}
        <Icon icon={mdiCheck} size={ICON_SIZE.md} aria-hidden />
        <span>{$t('frameleaf_viewer_edit_ready')}</span>
      {:else}
        <span>
          {editInProgress.progress === null
            ? $t('frameleaf_viewer_edit_finishing')
            : $t('frameleaf_viewer_edit_finishing_progress', {
                values: { progress: Math.round(editInProgress.progress) },
              })}
        </span>
        <span class="fl-viewer-edit-bar" class:waiting={editInProgress.progress === null} aria-hidden="true">
          <span style:width="{editInProgress.progress ?? 100}%"></span>
        </span>
      {/if}
    </div>
  {/if}

  <!-- FL-38: the face tagger is a modal dialog over the viewer (FaceTagger.jsx), for photos and videos alike. -->
  {#if assetViewerManager.isFaceEditMode}
    {#key asset.id}
      <FaceTagger
        {asset}
        onClose={() => assetViewerManager.closeFaceEditMode()}
        onSaved={refreshFaces}
        onReopen={reopenFaceTagger}
      />
    {/key}
  {/if}

  <!--
    FL-35: the strips above the footer. The filmstrip (shown only when the caller supplied the
    neighbours) is the collection; a stacked photo adds its stack, with keep-this and set-primary,
    as a row above it.
  -->
  {#if (showStackStrip && stack) || showFilmstripStrip}
    <div
      class="fl-viewer-strip absolute inset-x-0 bottom-0 col-span-4 col-start-1"
      data-viewer-chrome="footer"
      bind:clientHeight={stripsHeight}
    >
      {#if showStackStrip && stack}
        <div id="stack-slideshow" transition:motionSlide={{ duration: DURATION.slow }}>
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
      {#if showFilmstripStrip}
        <ViewerFilmstrip
          assets={filmstripAssets}
          currentAssetId={asset.id}
          onSelect={(selected) => handlePromiseError(goToAsset(selected))}
        />
      {/if}
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
      class="row-span-5 row-start-1 w-90 overflow-y-auto transition-all md:w-115 dark:border-s dark:border-s-immich-dark-gray"
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
    background: var(--fl-viewer-canvas);
    color: var(--fl-viewer-text);
    /*
     * What sits along the bottom edge: the 60px footer (V-13) and, on phones, the bottom toolbar above
     * it (AssetViewerNavBar, apple-style.css:756-763). Strips, badges and video controls clear both.
     */
    --fl-viewer-footer-height: calc(60px + env(safe-area-inset-bottom));
    --fl-viewer-toolbar-offset: var(--fl-viewer-footer-height);
    --fl-viewer-info-width: 340px;
  }

  .fl-viewer-canvas {
    isolation: isolate;
    transition:
      transform var(--fl-duration) var(--fl-spring),
      opacity var(--fl-motion-slow) var(--fl-ease),
      padding-inline-end var(--fl-duration) var(--fl-snappy);
  }

  .fl-viewer-stage {
    position: relative;
    width: 100%;
    height: 100%;
  }

  /* A swipe: the finger moves the photo directly; a committed swipe leaves without overshoot. */
  .fl-viewer-canvas.following {
    transition: none;
  }

  .fl-viewer-canvas.leaving {
    transition: transform var(--fl-motion-slow) var(--fl-snappy);
  }

  .fl-viewer-peek {
    position: absolute;
    top: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    pointer-events: none;
    user-select: none;
  }

  .fl-viewer-peek[data-viewer-peek='next'] {
    left: calc(100% + var(--fl-space-4));
  }

  .fl-viewer-peek[data-viewer-peek='previous'] {
    right: calc(100% + var(--fl-space-4));
  }

  /* A saved edit on its way: a small frosted pill under the header. */
  .fl-viewer-edit-status {
    position: absolute;
    top: calc(64px + env(safe-area-inset-top, 0px) + var(--fl-space-3));
    inset-inline: 0;
    z-index: 4;
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
    width: fit-content;
    max-width: calc(100% - var(--fl-space-8));
    min-height: 34px;
    margin-inline: auto;
    padding: var(--fl-space-1) var(--fl-space-3);
    border: 1px solid var(--fl-viewer-border);
    border-radius: var(--fl-radius-pill);
    background: color-mix(in srgb, var(--fl-viewer-panel) 82%, transparent);
    backdrop-filter: var(--fl-material-blur);
    color: var(--fl-viewer-text);
    font: var(--fl-type-caption);
    font-variant-numeric: tabular-nums;
    pointer-events: none;
  }

  .fl-viewer-edit-status.ready {
    color: var(--fl-on-material-accent);
  }

  .fl-viewer-edit-bar {
    width: 56px;
    height: 3px;
    overflow: hidden;
    border-radius: var(--fl-radius-pill);
    background: color-mix(in srgb, var(--fl-viewer-text) 18%, transparent);
  }

  .fl-viewer-edit-bar span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--fl-accent);
    transition: width var(--fl-motion-slow) var(--fl-ease);
  }

  /* Waiting its turn: no number yet, so the bar breathes instead of filling. */
  .fl-viewer-edit-bar.waiting span {
    animation: fl-skeleton-pulse var(--fl-duration-pulse) var(--fl-ease) infinite;
  }

  .fl-viewer-holdover {
    position: absolute;
    z-index: -1;
    object-fit: contain;
    pointer-events: none;
    user-select: none;
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
      opacity var(--fl-motion-slow) var(--fl-ease),
      translate var(--fl-duration-dock) var(--fl-spring),
      margin-inline-end var(--fl-duration) var(--fl-snappy);
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
    border-top: 1px solid var(--fl-viewer-border);
  }

  .fl-viewer-strip::before {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    /* The same material as the header and footer it sits between. */
    background: color-mix(in srgb, var(--fl-viewer-panel) 60%, transparent);
    backdrop-filter: var(--fl-material-blur);
  }

  /* What floats on the photo's bottom corner (text recognition, likes) sits above the footer and any strips. */
  .fl-viewer-float {
    bottom: var(--fl-viewer-toolbar-offset);
  }

  .with-footer .fl-viewer-float {
    bottom: calc(var(--fl-viewer-toolbar-offset) + var(--fl-viewer-strips-height, 0px));
  }

  .fl-viewer-sheet-handle {
    display: none;
  }

  /* Information: the floating glass card on tablet and desktop (apple-style.css:515-560). */
  .fl-viewer-info {
    position: absolute;
    top: max(76px, calc(env(safe-area-inset-top) + 68px));
    inset-inline-end: max(var(--fl-space-4), env(safe-area-inset-right));
    bottom: 76px;
    z-index: 5;
    display: flex;
    flex-direction: column;
    width: var(--fl-viewer-info-width);
    max-width: calc(100vw - 32px);
    overflow: hidden;
    border: 1px solid var(--fl-material-edge);
    border-radius: var(--fl-radius-sheet);
    background: color-mix(in srgb, var(--fl-viewer-panel) 72%, transparent);
    backdrop-filter: blur(36px) saturate(180%);
    box-shadow: var(--fl-shadow-4);
    color: var(--fl-viewer-text);
  }

  /* media-viewer.css:958-972: the heading and Close stay; only the details scroll. */
  .fl-viewer-info-head {
    position: relative;
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-2);
    padding: var(--fl-space-2);
    padding-inline-start: var(--fl-space-5);
    border-bottom: 1px solid var(--fl-viewer-border);
  }

  .fl-viewer-info-head h2 {
    margin: 0;
    font: var(--fl-type-headline);
    letter-spacing: var(--fl-tracking-headline);
  }

  .fl-viewer-info-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--fl-control-height);
    height: var(--fl-control-height);
    border: 0;
    border-radius: var(--fl-radius-pill);
    background: transparent;
    color: inherit;
    cursor: pointer;
    transition: background-color var(--fl-motion-fast) var(--fl-ease);
  }

  .fl-viewer-info-close:hover {
    background: color-mix(in srgb, var(--fl-viewer-text) 10%, transparent);
  }

  .fl-viewer-info-close:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-inset);
  }

  .fl-viewer-info-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  /* Clear of the filmstrip or stack strip (apple-style.css:540-542). */
  .with-footer .fl-viewer-info {
    bottom: calc(76px + var(--fl-viewer-strips-height, 0px) + var(--fl-space-3));
  }

  /*
   * With the card open the photo and the Next arrow move aside by its width, so the photo sits in
   * the free space and Next is never under the card.
   */
  @media (min-width: 761px) {
    .info-open .fl-viewer-canvas {
      padding-inline-end: calc(var(--fl-viewer-info-width) + var(--fl-space-4) * 2);
    }

    .info-open .fl-viewer-next {
      margin-inline-end: calc(var(--fl-viewer-info-width) + var(--fl-space-4));
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
      border-radius: var(--fl-radius-capsule) var(--fl-radius-capsule) 0 0;
      transition: translate var(--fl-duration) var(--fl-spring);
    }

    /* The finger moves the sheet directly. */
    .fl-viewer-info.sheet-dragging {
      transition: none;
    }

    .fl-viewer-info-head {
      padding-top: var(--fl-space-4);
      cursor: grab;
      touch-action: none;
    }

    .fl-viewer-sheet-handle {
      position: absolute;
      top: var(--fl-space-2);
      left: 50%;
      display: block;
      width: 40px;
      height: 4px;
      border-radius: var(--fl-radius-pill);
      background: color-mix(in srgb, var(--fl-viewer-text) 24%, transparent);
      translate: -50% 0;
    }
  }

  @media (max-width: 700px) {
    #immich-asset-viewer {
      --fl-viewer-toolbar-offset: calc(var(--fl-viewer-footer-height) + 53px);
    }
  }

  @media (prefers-contrast: more), (prefers-reduced-transparency: reduce) {
    .fl-viewer-strip::before {
      background: var(--fl-viewer-panel);
      backdrop-filter: none;
    }

    .fl-viewer-info,
    .fl-viewer-edit-status {
      background: var(--fl-viewer-panel);
      backdrop-filter: none;
    }
  }

  /* Reduce Motion: crossfades instead of movement (apple-style.css:466-490, 553-557). */
  @media (prefers-reduced-motion: reduce) {
    .fl-viewer-canvas {
      transition: opacity var(--fl-duration-reduced) var(--fl-ease);
    }

    [data-viewer-chrome] {
      transition: opacity var(--fl-duration-reduced) var(--fl-ease);
    }

    .chrome-hidden [data-viewer-chrome] {
      translate: none !important;
    }
  }
</style>
