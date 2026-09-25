<script lang="ts">
  /**
   * Frameleaf memory player (FL-62).
   *
   * Ported from the approved prototype (`design/frameleaf/template/src/MemoryPlayer.jsx`),
   * but built on the production `memoryManager` (`$lib/managers/memory-manager.svelte`)
   * instead of the prototype's client-derived memory index and localStorage overrides:
   * remove/favorite/delete all call the real memory endpoints through the manager, which
   * already handled navigation, the progress timer and the video/photo viewers correctly
   * before this story and is extended here rather than replaced.
   *
   * What this story adds on top of the pre-existing viewer:
   *  - The shared Memories engine (`$lib/frameleaf/memory-engine`, memory-engine.mjs in the Sept 24
   *    template): a title card with the overline by kind before the first item (MEMORY_TITLE_MS),
   *    a blurred backdrop, the deterministic per-item pan and zoom, and a lower third with the
   *    place over the day (MemoryPlayer.jsx, memories.css). The viewer's Memories slideshow and the
   *    Memories card previews use the same engine; under Reduce Motion photos only crossfade.
   *  - Share, which the legacy viewer had commented out entirely; it now opens the shared
   *    `ShareSheet` with the memory's current asset ids.
   *  - "Make a movie in Studio", which did not exist before this story. Studio itself has
   *    not landed yet (see `$lib/frameleaf/studio-handoff.ts` for the full contract), so
   *    this queues the asset list for Studio to pick up and confirms it to the user rather
   *    than navigating into a route that does not exist.
   *  - The private highlight export. The first slice downloaded the memory's originals
   *    straight from the browser; the server slice replaced that with a durable, cancellable
   *    export job, so this panel now starts a run, follows its progress, offers to cancel it
   *    and downloads the finished archive. The run is the same one the Activity page (FL-104)
   *    lists, which is why the state lives on the server and not in this component.
   *
   * FL-33 cleanup: the below-the-fold gallery and the selection bar are now the Frameleaf ones.
   * `ResultsView` draws the memory's assets in the Frameleaf grid and mounts FL-32's selection
   * bar over the same library session, so the bulk actions here are the ones offered everywhere
   * instead of a hand-assembled list; hiding an asset from a memory stays the memory manager's own
   * call, which is what the delete and archive entries reported into before.
   */
  import { goto } from '$app/navigation';
  import { shortcuts } from '$lib/actions/shortcut';
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import ShareSheet from '$lib/components/frameleaf/ShareSheet.svelte';
  import Status from '$lib/components/frameleaf/Status.svelte';
  import {
    MEMORY_TITLE_MS,
    memoryLowerThird,
    memoryMotion,
    memoryMotionStyle,
    memoryPhotoMs,
    memorySlideClass,
    memoryTitleCard,
  } from '$lib/frameleaf/memory-engine';
  import {
    exportProgress,
    formatLocalDateRange,
    isEventStory,
    isExportActive,
    latestExport,
    memoryStoryKind,
  } from '$lib/frameleaf/memory-stories';
  import { prefersReducedMotion } from '$lib/frameleaf/motion';
  import ResultsAssetViewer from '$lib/components/frameleaf/ResultsAssetViewer.svelte';
  import ResultsView from '$lib/components/frameleaf/ResultsView.svelte';
  import { namedArchiveName } from '$lib/frameleaf/archive-name';
  import { writeStudioHandoff } from '$lib/frameleaf/studio-handoff';
  import { librarySession } from '$lib/frameleaf/library-session.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { memoryManager } from '$lib/managers/memory-manager.svelte';
  import type { TimelineAsset, Viewport } from '$lib/managers/timeline-manager/types';
  import { Route } from '$lib/route';
  import { locale } from '$lib/stores/preferences.store';
  import { downloadBlob, getAssetMediaUrl, handlePromiseError, memoryLaneTitle } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import { navigateToAsset } from '$lib/utils/asset-utils';
  import { fromISODateTimeUTC, toTimelineAsset } from '$lib/utils/timeline-util';
  import {
    AssetMediaSize,
    AssetTypeEnum,
    AssetVisibility,
    MemoryExportStatus,
    cancelMemoryExport,
    createMemoryExport,
    downloadMemoryExport,
    getAssetInfo,
    getMemoryExport,
    getMemoryExports,
    type MemoryExportResponseDto,
  } from '@immich/sdk';
  import {
    Icon,
    IconButton as ImmichIconButton,
    Text,
    themeManager,
    toastManager,
    Theme as AppTheme,
  } from '@immich/ui';
  import {
    mdiChevronDown,
    mdiChevronLeft,
    mdiChevronRight,
    mdiChevronUp,
    mdiClose,
    mdiDownload,
    mdiExportVariant,
    mdiHeart,
    mdiHeartOutline,
    mdiImageMinusOutline,
    mdiImageSearch,
    mdiMovieEditOutline,
    mdiPause,
    mdiPlay,
    mdiRepeat,
    mdiSkipNext,
    mdiShareVariantOutline,
    mdiStopCircleOutline,
    mdiVolumeHigh,
    mdiVolumeOff,
  } from '@mdi/js';
  import { DateTime } from 'luxon';
  import 'media-chrome/media-mute-button';
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { Attachment } from 'svelte/attachments';
  import { on } from 'svelte/events';
  import { Tween } from 'svelte/motion';
  import MemoryPhotoViewer from '$lib/components/frameleaf/MemoryPhotoViewer.svelte';
  import MemoryVideoViewer from '$lib/components/frameleaf/MemoryVideoViewer.svelte';

  /** how often the player asks the server for the export run's current state */
  const EXPORT_POLL_MS = 1500;

  let memoryGallery: HTMLElement | undefined = $state();
  let memoryWrapper: HTMLElement | undefined = $state();
  let galleryInView = $state(false);
  let galleryFirstLoad = $state(true);
  let playerInitialized = $state(false);
  let paused = $state(false);
  let shareOpen = $state(false);
  let status = $state('');
  const current = $derived(memoryManager.current);
  const currentAssetId = $derived(current?.asset.id);
  // where the asset sits in its memory, for the progress bar and counter
  const assetIndex = $derived(current ? current.memory.assets.findIndex(({ id }) => id === currentAssetId) : -1);
  /** FL-45: the memory's own title, so its gallery download is not just another generic zip. Dated,
   * since a person is likely to open the same memory again on a later day. */
  const memoryDownloadFileName = $derived(
    current
      ? namedArchiveName($memoryLaneTitle(current.memory), $t('frameleaf_archive_name_memory'), { withDate: true })
      : undefined,
  );
  // The Memories engine: the same move, crossfade and Reduce Motion rule as the viewer's Memories slideshow.
  const reducedMotion = $derived(prefersReducedMotion());
  const photoMs = $derived(memoryPhotoMs(authManager.preferences.memories.duration));
  const slideClass = $derived(`fmp-photo ${memorySlideClass({ reducedMotion, paused })}`);
  const slideStyle = $derived(
    memoryMotionStyle(memoryMotion(currentAssetId, { reducedMotion, durationMs: photoMs + 1000 })) ?? '',
  );
  const memorySubtitle = $derived.by(() => {
    if (!current) {
      return '';
    }
    if (isEventStory(current.memory)) {
      return formatLocalDateRange(current.memory.data.startDate, current.memory.data.endDate, $locale);
    }
    const first = current.memory.assets[0];
    return first ? fromISODateTimeUTC(first.localDateTime).toLocaleString(DateTime.DATE_FULL, { locale: $locale }) : '';
  });
  const titleCard = $derived(
    current
      ? memoryTitleCard({
          kind: memoryStoryKind(current.memory),
          title: $memoryLaneTitle(current.memory),
          subtitle: memorySubtitle,
          count: current.memory.assets.length,
        })
      : undefined,
  );
  const currentMemoryAsset = $derived(current && assetIndex >= 0 ? current.memory.assets[assetIndex] : undefined);
  const currentDay = $derived(
    currentMemoryAsset
      ? fromISODateTimeUTC(currentMemoryAsset.localDateTime).toLocaleString(DateTime.DATE_FULL, { locale: $locale })
      : '',
  );
  /**
   * The title card opens every memory before its first item (MemoryPlayer.jsx:124-160, index -1):
   * it shows whenever the memory changes to its first item, Previous from the first item returns
   * to it, and it stays for MEMORY_TITLE_MS of playing time (the timer holds while paused) or
   * until Play or Next.
   */
  let titleCardFor = $state<string | undefined>();
  let titleCardMemoryId: string | undefined;
  let titleCardTimer: ReturnType<typeof setTimeout> | undefined;
  let titleCardRemaining = MEMORY_TITLE_MS;
  let titleCardStartedAt = 0;
  /**
   * The end card closes a memory after its last item (MemoryPlayer.jsx:403-446, `ended`): "That
   * was …" with Play again, the next memory and Back to memories, instead of running straight on
   * into the next memory. Previous returns to the last item.
   */
  let endCardFor = $state<string | undefined>();
  const atLastItem = $derived(current ? assetIndex === current.memory.assets.length - 1 : false);
  /** MemoryPlayer.jsx:339-341: the cover behind the title and end cards; never a Locked item. */
  const titleCover = $derived(current?.memory.assets.find((asset) => asset.visibility !== AssetVisibility.Locked));
  const currentMemoryAssetFull = $derived.by(async () =>
    currentAssetId ? await getAssetInfo({ ...authManager.params, id: currentAssetId }) : undefined,
  );
  let currentTimelineAssets = $derived(current?.memory.assets ?? []);
  /** The memory's assets as the Frameleaf grid reads them. */
  let galleryAssets = $derived(currentTimelineAssets.map((asset) => toTimelineAsset(asset)));

  let viewerHeight = $state(0);

  const viewport: Viewport = $state({ width: 0, height: 0 });
  let progressBarController: Tween<number> | undefined = $state(undefined);
  let videoPlayer: HTMLVideoElement | undefined = $state();
  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');

  // The city is on the full asset only; the lower third shows the memory's title until it arrives.
  let currentCity = $state<string | undefined>();
  $effect(() => {
    const pending = currentMemoryAssetFull;
    let stale = false;
    currentCity = undefined;
    pending
      .then((asset) => {
        if (!stale) {
          currentCity = asset?.exifInfo?.city ?? undefined;
        }
      })
      .catch(() => {
        // no city: the lower third keeps the memory's title
      });
    return () => {
      stale = true;
    };
  });
  const lowerThird = $derived(
    current
      ? memoryLowerThird(
          { city: currentCity },
          { fallbackTitle: $memoryLaneTitle(current.memory), day: currentDay, video: current.asset.isVideo },
        )
      : null,
  );
  let videoMuted = $state(true);
  $effect(() => {
    const player = videoPlayer;
    if (!player) {
      return;
    }
    videoMuted = player.muted;
    return on(player, 'volumechange', () => (videoMuted = player.muted));
  });

  const handleNavigate = async (href: string | undefined, options?: { replaceState?: boolean }) => {
    if (assetViewerManager.isViewing || !href) {
      return;
    }

    await goto(href, { noScroll: true, keepFocus: true, ...options });
  };

  const setProgressDuration = (asset: TimelineAsset) => {
    progressBarController = new Tween<number>(0, {
      duration: (from: number, to: number) =>
        to
          ? (asset.isVideo ? asset.duration! : memoryPhotoMs(authManager.preferences.memories.duration)) * (to - from)
          : 0,
    });
  };

  const handleEscape = async () => goto(memoryManager.memoriesHref);
  const handleSelectAll = () => librarySession.selectAll((current?.memory.assets ?? []).map((asset) => asset.id));

  const handleAction = async (callingContext: string, action: 'reset' | 'pause' | 'play') => {
    // on the end card, play starts the memory again (MemoryPlayer.jsx:193-200)
    if (endCardFor && action === 'play') {
      playAgain();
      return;
    }
    // on the title card, play and pause run its timer rather than an item
    if (titleCardFor) {
      if (action === 'pause') {
        paused = true;
        holdTitleCardTimer();
      } else if (action === 'play') {
        paused = false;
        runTitleCardTimer();
      }
      return;
    }
    if (!progressBarController) {
      return;
    }

    switch (action) {
      case 'play': {
        try {
          paused = false;
          await videoPlayer?.play();
          await progressBarController.set(1);
        } catch (error) {
          // this may happen if browser blocks auto-play of the video on first page load. This can either be a setting
          // or just default in certain browsers on page load without any DOM interaction by user.
          console.error(`handleAction[${callingContext}] videoPlayer play problem: ${error}`);
          paused = true;
          await progressBarController.set(0);
        }
        break;
      }

      case 'pause': {
        paused = true;
        videoPlayer?.pause();
        await progressBarController.set(progressBarController.current);
        break;
      }

      case 'reset': {
        paused = false;
        videoPlayer?.pause();
        await progressBarController.set(0);
        break;
      }
    }
  };

  const handleProgress = async (progress: number) => {
    if (!progressBarController) {
      return;
    }

    if (progress === 1 && !paused) {
      if (atLastItem) {
        showEndCard();
      } else if (current?.nextHref) {
        await handleNavigate(current.nextHref, { replaceState: true });
      } else {
        await handleAction('handleProgressLast', 'pause');
      }
    }
  };

  const toProgressPercentage = (index: number) => {
    if (!progressBarController || assetIndex === -1) {
      return 0;
    }
    if (index < assetIndex) {
      return 100;
    }
    if (index > assetIndex) {
      return 0;
    }
    return progressBarController.current * 100;
  };

  const handleHideAssets = (ids: string[]) => handlePromiseError(memoryManager.hideAssets(ids));

  const handleGalleryScrollsIntoView = () => {
    galleryInView = true;
    handlePromiseError(handleAction('galleryInView', 'pause'));
  };

  const handleGalleryScrollsOutOfView = () => {
    galleryInView = false;
    if (!galleryFirstLoad && videoPlayer?.checkVisibility()) {
      handlePromiseError(handleAction('galleryOutOfView', 'play'));
    }
    galleryFirstLoad = false;
  };

  const galleryObserver: Attachment<HTMLElement> = (element) => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          handleGalleryScrollsIntoView();
        } else {
          handleGalleryScrollsOutOfView();
        }
      },
      { rootMargin: '0px 0px -200px 0px' },
    );

    observer.observe(element);
    return () => observer.disconnect();
  };

  const initCurrent = () => {
    if (current) {
      setProgressDuration(current.asset);
    }
    playerInitialized = false;
    initPlayer();
  };

  const resetAndPlay = () => {
    if (titleCardFor || endCardFor) {
      return;
    }
    handlePromiseError(handleAction('resetAndPlay', 'reset'));
    handlePromiseError(handleAction('resetAndPlay', 'play'));
  };

  function runTitleCardTimer() {
    if (titleCardTimer || !titleCardFor) {
      return;
    }
    titleCardStartedAt = performance.now();
    titleCardTimer = setTimeout(dismissTitleCard, titleCardRemaining);
  }

  function holdTitleCardTimer() {
    if (!titleCardTimer) {
      return;
    }
    clearTimeout(titleCardTimer);
    titleCardTimer = undefined;
    titleCardRemaining = Math.max(0, titleCardRemaining - (performance.now() - titleCardStartedAt));
  }

  const showTitleCard = () => {
    if (!current) {
      return;
    }
    clearTimeout(titleCardTimer);
    titleCardTimer = undefined;
    titleCardRemaining = MEMORY_TITLE_MS;
    titleCardFor = current.memory.id;
    videoPlayer?.pause();
    handlePromiseError(progressBarController?.set(0) ?? Promise.resolve());
    if (!paused && !galleryInView && !assetViewerManager.isViewing) {
      runTitleCardTimer();
    }
  };

  function dismissTitleCard() {
    clearTimeout(titleCardTimer);
    titleCardTimer = undefined;
    if (!titleCardFor) {
      return;
    }
    titleCardFor = undefined;
    if (!paused && !galleryInView && !assetViewerManager.isViewing) {
      resetAndPlay();
    }
  }

  const playFromTitleCard = () => {
    paused = false;
    dismissTitleCard();
  };

  // A new memory opened at its first item starts on its title card (MemoryPlayer.jsx:124-130).
  $effect(() => {
    const memoryId = current?.memory.id;
    if (memoryId === titleCardMemoryId) {
      return;
    }
    titleCardMemoryId = memoryId;
    const atFirst = assetIndex === 0;
    untrack(() => {
      clearTimeout(titleCardTimer);
      titleCardTimer = undefined;
      titleCardFor = undefined;
      endCardFor = undefined;
      if (memoryId && atFirst) {
        showTitleCard();
      }
    });
  });

  /** Previous from the first item returns to the title card (MemoryPlayer.jsx:560-565). */
  const goPrevious = () => {
    if (assetViewerManager.isViewing) {
      return;
    }
    if (endCardFor) {
      endCardFor = undefined;
      return;
    }
    if (current && assetIndex === 0 && !titleCardFor) {
      showTitleCard();
      return;
    }
    handlePromiseError(handleNavigate(current?.previousHref));
  };

  /** Next from the title card goes on to the first item. */
  const goNext = () => {
    if (assetViewerManager.isViewing) {
      return;
    }
    if (titleCardFor) {
      dismissTitleCard();
      return;
    }
    if (endCardFor) {
      handlePromiseError(handleNavigate(current?.nextMemory?.href));
      return;
    }
    if (atLastItem) {
      showEndCard();
      return;
    }
    handlePromiseError(handleNavigate(current?.nextHref));
  };

  /** data-initial-focus (MemoryPlayer.jsx:343, 414): the card's main action takes focus when it appears. */
  const focusOnShow = (button: HTMLButtonElement) => {
    if (!assetViewerManager.isViewing) {
      button.focus({ preventScroll: true });
    }
  };

  function showEndCard() {
    if (!current) {
      return;
    }
    handlePromiseError(handleAction('endCard', 'pause'));
    endCardFor = current.memory.id;
  }

  function playAgain() {
    const first = current?.memory.assets[0];
    endCardFor = undefined;
    paused = false;
    if (!first) {
      return;
    }
    if (first.id === currentAssetId) {
      resetAndPlay();
      return;
    }
    handlePromiseError(handleNavigate(current?.getAssetHref(first.id)));
  }

  // Moving to another item (the gallery, the progress segments) leaves the end card.
  let endCardAssetId: string | undefined;
  $effect(() => {
    const assetId = currentAssetId;
    if (assetId === endCardAssetId) {
      return;
    }
    endCardAssetId = assetId;
    untrack(() => (endCardFor = undefined));
  });

  $effect(() => () => clearTimeout(titleCardTimer));

  const initPlayer = () => {
    const isVideo = current && current.asset.isVideo;
    const isVideoAssetButPlayerHasNotLoadedYet = isVideo && !videoPlayer;
    if (playerInitialized || isVideoAssetButPlayerHasNotLoadedYet) {
      return;
    }
    if (assetViewerManager.isViewing) {
      handlePromiseError(handleAction('initPlayer[AssetViewOpen]', 'pause'));
    } else if (isVideo) {
      resetAndPlay();
    }
    playerInitialized = true;
  };

  $effect(() => {
    void currentAssetId;
    untrack(initCurrent);
  });

  $effect(() => {
    if (current) {
      return;
    }

    handlePromiseError(goto(memoryManager.memoriesHref, { replaceState: true, noScroll: true }));
  });

  $effect(() => {
    if (progressBarController) {
      handlePromiseError(handleProgress(progressBarController.current));
    }
  });

  $effect(() => {
    if (videoPlayer) {
      initPlayer();
    }
  });

  const openShare = () => {
    handlePromiseError(handleAction('openShare', 'pause'));
    shareOpen = true;
  };

  /**
   * Private highlight export (FL-62 server slice).
   *
   * The export is a durable, cancellable job on the server, not a browser download: the
   * request returns a run row, the worker writes an owner-private archive, and this panel
   * follows the same run state the Activity page (FL-104) reads. That is what survives a
   * reload, a closed tab and a worker restart — a `fetch` that dies with the page could not.
   *
   * The panel never invents progress. `assetCount`/`processedAssets` come from the run, an
   * `error` is shown as the server reported it, and polling stops the moment the run
   * reaches a terminal state.
   */
  let exportRun = $state<MemoryExportResponseDto | undefined>();
  let exportBusy = $state(false);
  let exportTimer: ReturnType<typeof setTimeout> | undefined;

  const exportActive = $derived(!!exportRun && isExportActive(exportRun.status));
  const exportPercent = $derived(exportRun ? Math.round(exportProgress(exportRun) * 100) : 0);

  const stopPolling = () => {
    if (!exportTimer) {
      return;
    }

    clearTimeout(exportTimer);
    exportTimer = undefined;
  };

  const pollExport = async () => {
    if (!exportRun) {
      return;
    }
    try {
      exportRun = await getMemoryExport({ id: exportRun.id });
    } catch (error) {
      // the run is gone (deleted, or its memory was), so there is nothing left to follow
      handleError(error, $t('frameleaf_memories_export_failed'));
      exportRun = undefined;
      stopPolling();
      return;
    }

    if (exportRun && isExportActive(exportRun.status)) {
      exportTimer = setTimeout(() => void pollExport(), EXPORT_POLL_MS);
    } else {
      stopPolling();
    }
  };

  // Pick up an export that is already running for this memory — started here before a
  // reload, or from another tab — instead of offering to start a second one.
  $effect(() => {
    const memoryId = current?.memory.id;
    stopPolling();
    exportRun = undefined;
    if (!memoryId) {
      return;
    }

    // navigating to the next memory while this request is in flight must not leave the
    // previous memory's run showing under the new one
    let stale = false;

    void (async () => {
      try {
        const runs = await getMemoryExports({ memoryId });
        if (stale) {
          return;
        }
        const existing = latestExport(runs, memoryId);
        if (existing) {
          exportRun = existing;
          if (isExportActive(existing.status)) {
            exportTimer = setTimeout(() => void pollExport(), EXPORT_POLL_MS);
          }
        }
      } catch {
        // an unreachable export list must not take the player down with it
      }
    })();

    return () => {
      stale = true;
      stopPolling();
    };
  });

  const startExport = async () => {
    if (!current || exportBusy) {
      return;
    }
    exportBusy = true;
    try {
      exportRun = await createMemoryExport({ id: current.memory.id, memoryExportCreateDto: {} });
      status = $t('frameleaf_memories_export_started');
      if (isExportActive(exportRun.status)) {
        stopPolling();
        exportTimer = setTimeout(() => void pollExport(), EXPORT_POLL_MS);
      }
    } catch (error) {
      handleError(error, $t('frameleaf_memories_export_failed'));
    } finally {
      exportBusy = false;
    }
  };

  const cancelExport = async () => {
    if (!exportRun || exportBusy) {
      return;
    }
    exportBusy = true;
    try {
      exportRun = await cancelMemoryExport({ id: exportRun.id });
      status = $t('frameleaf_memories_export_cancelled');
      if (!isExportActive(exportRun.status)) {
        stopPolling();
      }
    } catch (error) {
      handleError(error, $t('frameleaf_memories_export_failed'));
    } finally {
      exportBusy = false;
    }
  };

  const saveExport = async () => {
    if (!exportRun?.isDownloadable || exportBusy) {
      return;
    }
    exportBusy = true;
    try {
      const blob = await downloadMemoryExport({ id: exportRun.id });
      downloadBlob(blob, `${exportRun.title}.zip`);
    } catch (error) {
      handleError(error, $t('frameleaf_memories_export_failed'));
    } finally {
      exportBusy = false;
    }
  };

  const makeMovie = () => {
    if (!current) {
      return;
    }
    const assetIds = current.memory.assets.map((asset) => asset.id);
    writeStudioHandoff({
      source: 'memory',
      sourceId: current.memory.id,
      title: $memoryLaneTitle(current.memory),
      assetIds,
    });
    const message = $t('frameleaf_memories_make_movie_queued', { values: { count: assetIds.length } });
    status = message;
    toastManager.primary(message);
  };
</script>

<svelte:document
  use:shortcuts={assetViewerManager.isViewing
    ? []
    : [
        { shortcut: { key: 'ArrowRight' }, onShortcut: goNext },
        { shortcut: { key: 'd' }, onShortcut: goNext },
        { shortcut: { key: 'ArrowLeft' }, onShortcut: goPrevious },
        { shortcut: { key: 'a' }, onShortcut: goPrevious },
        { shortcut: { key: 'Escape' }, onShortcut: () => handleEscape() },
      ]}
/>

<section
  id="memory-viewer"
  data-sveltekit-noscroll
  class="frameleaf fmp"
  data-theme={appTheme}
  bind:this={memoryWrapper}
  bind:clientHeight={viewport.height}
  bind:clientWidth={viewport.width}
>
  {#if current}
    <Status message={status} />
    <header class="fmp-header">
      <div class="fmp-header-title">
        <IconButton label={$t('close')} onclick={() => goto(memoryManager.memoriesHref)}>
          <Icon icon={mdiClose} size="22" />
        </IconButton>
        <p>{$memoryLaneTitle(current.memory)}</p>
      </div>

      <div class="fmp-progress" role="group" aria-label={$t('memories')}>
        <IconButton
          label={endCardFor ? $t('frameleaf_memories_play_again') : paused ? $t('play_memories') : $t('pause_memories')}
          onclick={() => handlePromiseError(handleAction('PlayPauseButtonClick', paused ? 'play' : 'pause'))}
        >
          <Icon icon={endCardFor ? mdiRepeat : paused ? mdiPlay : mdiPause} size="20" />
        </IconButton>

        {#each current.memory.assets as asset, index (asset.id)}
          <a class="fmp-segment" href={current.getAssetHref(asset.id)} aria-label={$t('view')}>
            <span class="fmp-segment-track"></span>
            <span class="fmp-segment-fill" style:width={`${toProgressPercentage(index)}%`}></span>
          </a>
        {/each}

        <Text size="small" class="fl-tabular">
          {$t('x_of_total', {
            values: {
              x: (assetIndex + 1).toLocaleString($locale),
              total: current.memory.assets.length.toLocaleString($locale),
            },
          })}
        </Text>

        {#if currentTimelineAssets.some((asset) => asset.type === AssetTypeEnum.Video)}
          <media-mute-button
            mediacontroller={videoPlayer ? 'memory-video' : ''}
            disabled={!videoPlayer}
            class="rounded-full bg-transparent outline-offset-2 outline-dark focus-visible:outline-2"
            style="--media-focus-box-shadow: none;"
          >
            <!-- media-chrome assigns these by their `slot` attribute; that has to land on the
                 real DOM node, so this uses the immich-ui button (which forwards unknown
                 attributes) rather than the Frameleaf one, which does not. -->
            <ImmichIconButton
              slot="off"
              disabled={!videoPlayer}
              shape="round"
              variant="ghost"
              color="secondary"
              aria-label={$t('unmute_memories')}
              icon={mdiVolumeOff}
              onclick={() => {}}
            />
            <ImmichIconButton
              slot="high"
              disabled={!videoPlayer}
              shape="round"
              variant="ghost"
              color="secondary"
              aria-label={$t('mute_memories')}
              icon={mdiVolumeHigh}
              onclick={() => {}}
            />
          </media-mute-button>
        {/if}
      </div>
    </header>

    {#if galleryInView}
      <div class="fmp-scroll-up visible">
        <IconButton label={$t('hide_gallery')} onclick={() => memoryWrapper?.scrollIntoView({ behavior: 'smooth' })}>
          <Icon icon={mdiChevronUp} size="20" />
        </IconButton>
      </div>
    {/if}

    <!-- STAGE -->
    <section class="fmp-stage-outer" bind:clientHeight={viewerHeight}>
      <div class="fmp-stage-row">
        <!-- PREVIOUS MEMORY -->
        <div class="fmp-adjacent" class:has-target={!!current.previousMemory}>
          {#if current.previousMemory}
            <a class="fmp-adjacent-link" href={current.previousMemory.href}>
              <img
                src={getAssetMediaUrl({ id: current.previousMemory.assetId, size: AssetMediaSize.Preview })}
                alt={$t('previous_memory')}
                draggable="false"
              />
              <div class="fmp-adjacent-copy">
                <p class="fmp-adjacent-overline">{$t('previous')}</p>
                <p class="fmp-adjacent-title">{current.previousMemory.title}</p>
              </div>
            </a>
          {/if}
        </div>

        <!-- CURRENT MEMORY -->
        <div class="fmp-main">
          <div class="fmp-main-inner">
            {#key current.asset.id}
              {#if current.asset.isVideo}
                <MemoryVideoViewer asset={current.asset} bind:videoPlayer />
              {:else}
                <!-- memories.css:7-15: a dimmed, blurred copy of the photo fills the frame behind it. -->
                <div
                  class="fmp-backdrop"
                  style:background-image={`url("${getAssetMediaUrl({ id: current.asset.id, size: AssetMediaSize.Preview })}")`}
                  aria-hidden="true"
                ></div>
                <MemoryPhotoViewer
                  asset={current.asset}
                  onImageLoad={resetAndPlay}
                  motionClass={slideClass}
                  motionStyle={slideStyle}
                />
              {/if}
            {/key}

            {#if titleCard && titleCardFor === current.memory.id}
              <!-- MemoryPlayer.jsx:338-363, memories.css:44-75 -->
              <section class="fmp-title-card" aria-label={titleCard.title}>
                {#if titleCover}
                  <img
                    class="fmp-title-bg"
                    src={getAssetMediaUrl({ id: titleCover.id, size: AssetMediaSize.Preview })}
                    alt=""
                    draggable="false"
                  />
                {/if}
                <div class="fmp-title-copy">
                  <span class="fmp-overline">{$t(titleCard.overlineKey)}</span>
                  <h2>{titleCard.title}</h2>
                  {#if titleCard.subtitle}
                    <p>{titleCard.subtitle}</p>
                  {/if}
                  <p class="fmp-title-count">
                    {$t('frameleaf_memories_item_count', { values: { count: titleCard.count } })}
                  </p>
                  <button type="button" class="fmp-play-large" onclick={playFromTitleCard} {@attach focusOnShow}>
                    <Icon icon={mdiPlay} size="22" aria-hidden="true" />
                    {$t('frameleaf_memories_play')}
                  </button>
                </div>
              </section>
            {/if}

            {#if titleCard && endCardFor === current.memory.id}
              <!-- MemoryPlayer.jsx:403-446, memories.css:44-75 -->
              <section class="fmp-title-card fmp-end-card" aria-label={titleCard.title}>
                {#if titleCover}
                  <img
                    class="fmp-title-bg"
                    src={getAssetMediaUrl({ id: titleCover.id, size: AssetMediaSize.Preview })}
                    alt=""
                    draggable="false"
                  />
                {/if}
                <div class="fmp-title-copy">
                  <span class="fmp-overline">
                    {titleCard.count > 0
                      ? $t('frameleaf_memories_end_overline')
                      : $t('frameleaf_memories_end_overline_empty')}
                  </span>
                  <h2>{titleCard.title}</h2>
                  {#if titleCard.subtitle}
                    <p>{titleCard.subtitle}</p>
                  {/if}
                  <div class="fmp-end-actions">
                    <button
                      type="button"
                      class="fmp-play-large"
                      onclick={playAgain}
                      disabled={titleCard.count === 0}
                      {@attach focusOnShow}
                    >
                      <Icon icon={mdiRepeat} size="20" aria-hidden="true" />
                      {$t('frameleaf_memories_play_again')}
                    </button>
                    {#if current.nextMemory}
                      {@const next = current.nextMemory}
                      <button
                        type="button"
                        class="fmp-secondary"
                        onclick={() => handlePromiseError(handleNavigate(next.href))}
                      >
                        <Icon icon={mdiSkipNext} size="20" aria-hidden="true" />
                        {$t('frameleaf_memories_next_memory', { values: { title: next.title } })}
                      </button>
                    {/if}
                    <button type="button" class="fmp-secondary" onclick={() => void goto(memoryManager.memoriesHref)}>
                      {$t('frameleaf_memories_back_to_memories')}
                    </button>
                  </div>
                </div>
              </section>
            {/if}

            <div class="fmp-overlay" class:hidden={galleryInView}>
              <div class="fmp-overlay-top">
                <!-- FL-83 (MPY-3): the heart favorites the item being shown; the memory's own
                     saved flag is set from the index card. -->
                <IconButton
                  label={current.asset.isFavorite
                    ? $t('frameleaf_memories_unfavorite_item')
                    : $t('frameleaf_memories_favorite_item')}
                  pressed={current.asset.isFavorite}
                  onclick={() =>
                    void memoryManager
                      .toggleCurrentAssetFavorite()
                      .catch((error) => handleError(error, $t('errors.something_went_wrong')))}
                >
                  <Icon icon={current.asset.isFavorite ? mdiHeart : mdiHeartOutline} size="20" />
                </IconButton>
                <IconButton label={$t('share')} onclick={openShare}>
                  <Icon icon={mdiShareVariantOutline} size="20" />
                </IconButton>
                <!-- A direct action rather than a dropdown: .fmp-main-inner clips overflow to
                     contain the Ken Burns zoom, which would also clip an open popup menu
                     positioned near this corner. Removal is undoable from its toast (FL-83
                     MPY-1); removing the whole memory belongs to the index (MPY-2). -->
                <IconButton
                  label={$t('remove_photo_from_memory')}
                  onclick={() =>
                    void memoryManager
                      .removeCurrentAsset()
                      .catch((error) => handleError(error, $t('errors.something_went_wrong')))}
                >
                  <Icon icon={mdiImageMinusOutline} size="20" />
                </IconButton>
              </div>

              <div class="fmp-overlay-bottom">
                {#await currentMemoryAssetFull then asset}
                  {#if asset}
                    <IconButton
                      label={$t('view_in_timeline')}
                      href={Route.photos({ at: asset.stack?.primaryAssetId ?? asset.id })}
                    >
                      <Icon icon={mdiImageSearch} size="20" />
                    </IconButton>
                  {/if}
                {/await}
                {#if exportActive}
                  <span
                    class="fmp-export"
                    role="status"
                    aria-live="polite"
                    aria-label={$t('frameleaf_memories_export_progress', {
                      values: { done: exportRun?.processedAssets ?? 0, total: exportRun?.assetCount ?? 0 },
                    })}
                  >
                    <span class="fmp-export-bar" aria-hidden="true">
                      <span class="fmp-export-fill" style:width={`${exportPercent}%`}></span>
                    </span>
                    <span class="fmp-export-text">
                      {exportRun?.status === MemoryExportStatus.Cancelling
                        ? $t('frameleaf_memories_export_cancelling')
                        : $t('frameleaf_memories_export_progress', {
                            values: { done: exportRun?.processedAssets ?? 0, total: exportRun?.assetCount ?? 0 },
                          })}
                    </span>
                  </span>
                  <IconButton label={$t('frameleaf_memories_export_cancel')} onclick={() => void cancelExport()}>
                    <Icon icon={mdiStopCircleOutline} size="20" />
                  </IconButton>
                {:else if exportRun?.isDownloadable}
                  <IconButton label={$t('frameleaf_memories_export_download')} onclick={() => void saveExport()}>
                    <Icon icon={mdiDownload} size="20" />
                  </IconButton>
                {:else}
                  <IconButton label={$t('frameleaf_memories_export')} onclick={() => void startExport()}>
                    <Icon icon={mdiExportVariant} size="20" />
                  </IconButton>
                {/if}
                <button type="button" class="fmp-studio" onclick={makeMovie}>
                  <Icon icon={mdiMovieEditOutline} size="18" aria-hidden="true" />
                  {$t('frameleaf_memories_make_movie')}
                </button>
              </div>
              {#if exportRun?.status === MemoryExportStatus.Failed}
                <p class="fmp-export-error" role="alert">
                  {exportRun.error ?? $t('frameleaf_memories_export_failed')}
                </p>
              {/if}
            </div>

            {#if current.previousHref || (assetIndex === 0 && titleCardFor !== current.memory.id) || endCardFor === current.memory.id}
              <div class="fmp-nav prev">
                <IconButton label={$t('previous_memory')} onclick={goPrevious}>
                  <Icon icon={mdiChevronLeft} size="28" />
                </IconButton>
              </div>
            {/if}

            {#if current.nextHref || titleCardFor === current.memory.id || (atLastItem && endCardFor !== current.memory.id)}
              <div class="fmp-nav next">
                <IconButton label={$t('next_memory')} onclick={goNext}>
                  <Icon icon={mdiChevronRight} size="28" />
                </IconButton>
              </div>
            {/if}

            {#if titleCardFor !== current.memory.id && endCardFor !== current.memory.id && lowerThird}
              <!-- MemoryPlayer.jsx:434-458, memories.css:77-104: the place over the day. -->
              {#key current.asset.id}
                <div class="fmp-lower-third">
                  <strong>{lowerThird.place}</strong>
                  <span>
                    {lowerThird.day}{#if lowerThird.video && videoMuted}
                      <span aria-hidden="true"> · </span>{$t('frameleaf_memories_video_muted')}{/if}
                  </span>
                </div>
              {/key}
            {/if}
          </div>
        </div>

        <!-- NEXT MEMORY -->
        <div class="fmp-adjacent" class:has-target={!!current.nextMemory}>
          {#if current.nextMemory}
            <a class="fmp-adjacent-link" href={current.nextMemory.href}>
              <img
                src={getAssetMediaUrl({ id: current.nextMemory.assetId, size: AssetMediaSize.Preview })}
                alt={$t('next_memory')}
                draggable="false"
              />
              <div class="fmp-adjacent-copy">
                <p class="fmp-adjacent-overline">{$t('up_next')}</p>
                <p class="fmp-adjacent-title">{current.nextMemory.title}</p>
              </div>
            </a>
          {/if}
        </div>
      </div>
    </section>
  {/if}
</section>

{#if current}
  <!-- GALLERY VIEWER -->
  <section class="frameleaf fmp-gallery-section" data-theme={appTheme}>
    <div class="fmp-scroll-down" class:visible={!galleryInView}>
      <IconButton label={$t('show_gallery')} onclick={() => memoryGallery?.scrollIntoView({ behavior: 'smooth' })}>
        <Icon icon={mdiChevronDown} size="20" />
      </IconButton>
    </div>

    <div id="gallery-memory" {@attach galleryObserver} bind:this={memoryGallery}>
      <ResultsView
        assets={galleryAssets}
        downloadFileName={memoryDownloadFileName}
        onSelectAll={handleSelectAll}
        onRemoved={handleHideAssets}
        onOpen={(asset) => void navigateToAsset(asset)}
      />
    </div>
  </section>
{/if}

<ResultsAssetViewer
  assets={current?.viewerAssets ?? []}
  onRemove={(id) => handleHideAssets([id])}
  emptyRoute={memoryManager.memoriesHref}
/>

<ShareSheet bind:open={shareOpen} assetIds={currentTimelineAssets.map((asset) => asset.id)} />

<style>
  .fmp {
    display: block;
    width: 100%;
    color: var(--fl-viewer-text);
    background: var(--fl-viewer-canvas);
  }
  .fmp-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.75rem 1rem;
  }
  .fmp-header-title {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .fmp-header-title p {
    font-size: 1.0625rem;
  }
  .fmp-progress {
    display: flex;
    flex: 1;
    align-items: center;
    justify-content: flex-end;
    gap: 0.5rem;
    max-width: 40rem;
  }
  .fmp-segment {
    position: relative;
    flex: 1;
    min-width: 0.75rem;
    height: 0.5rem;
    padding-block: 0.25rem;
  }
  .fmp-segment-track {
    position: absolute;
    inset-inline-start: 0;
    top: 50%;
    width: 100%;
    height: 2px;
    background: var(--fl-viewer-border);
  }
  .fmp-segment-fill {
    position: absolute;
    inset-inline-start: 0;
    top: 50%;
    height: 2px;
    background: var(--fl-viewer-text);
  }
  .fmp-scroll-up,
  .fmp-scroll-down {
    display: flex;
    justify-content: center;
    padding-block: 0.5rem;
    opacity: 0;
    transition: opacity var(--fl-motion) var(--fl-ease);
  }
  .fmp-scroll-up.visible,
  .fmp-scroll-down.visible {
    opacity: 1;
  }
  .fmp-stage-outer {
    padding: 0.5rem 1rem 1.5rem;
  }
  .fmp-stage-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 1.5rem;
    height: calc(100vh - 14rem);
    min-height: 20rem;
  }
  .fmp-adjacent {
    /* Always occupies layout space when it has a target, even with nothing to show yet
       (opacity 0), so the stage does not reflow the moment an adjacent memory exists.
       Hidden entirely below the desktop breakpoint, where there is no room for it. */
    display: none;
    width: 18vw;
    height: 55%;
    border-radius: 1rem;
    opacity: 0.25;
    transition: opacity var(--fl-motion) var(--fl-ease);
  }
  .fmp-adjacent:hover {
    opacity: 0.7;
  }
  @media (min-width: 62rem) {
    .fmp-adjacent {
      display: block;
    }
    .fmp-adjacent:not(.has-target) {
      visibility: hidden;
    }
  }
  .fmp-adjacent-link {
    position: relative;
    display: block;
    width: 100%;
    height: 100%;
    border-radius: 1rem;
    overflow: hidden;
  }
  .fmp-adjacent-link img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .fmp-adjacent-copy {
    position: absolute;
    inset-inline-start: 1rem;
    inset-block-end: 1rem;
    color: #fff;
  }
  .fmp-adjacent-overline {
    margin: 0;
    font-size: var(--fl-font-micro);
    font-weight: 600;
    text-transform: uppercase;
    color: rgb(255 255 255 / 75%);
  }
  .fmp-adjacent-title {
    margin: 0;
    font-size: 1.125rem;
  }
  .fmp-main {
    position: relative;
    display: flex;
    place-content: center;
    place-items: center;
    width: 70vw;
    height: 100%;
    max-width: 64rem;
    border-radius: 1rem;
    background: #000;
    box-shadow: var(--fl-shadow-2);
  }
  .fmp-main-inner {
    position: relative;
    width: 100%;
    height: 100%;
    border-radius: 1rem;
    background: #000;
    overflow: hidden;
  }
  .fmp-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 0.5rem;
    transition: opacity var(--fl-motion) var(--fl-ease);
  }
  .fmp-overlay.hidden {
    opacity: 0;
    pointer-events: none;
  }
  .fmp-overlay-top {
    display: flex;
    align-self: flex-end;
    gap: 0.25rem;
  }
  /* Export progress. The bar is decorative — the accessible name on the wrapper carries the
     real numbers, and it is never animated beyond the width the server reported. */
  .fmp-export {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0.625rem;
    border-radius: 999px;
    color: #fff;
    background: rgb(0 0 0 / 45%);
    font-size: var(--fl-font-small);
    white-space: nowrap;
  }
  .fmp-export-bar {
    display: block;
    inline-size: 5rem;
    block-size: 0.25rem;
    border-radius: 999px;
    background: rgb(255 255 255 / 30%);
    overflow: hidden;
  }
  .fmp-export-fill {
    display: block;
    block-size: 100%;
    background: #fff;
    transition: inline-size 200ms linear;
  }
  @media (prefers-reduced-motion: reduce) {
    .fmp-export-fill {
      transition: none;
    }
  }
  .fmp-export-error {
    margin: 0.5rem 0 0;
    color: #fff;
    background: rgb(0 0 0 / 55%);
    border-radius: var(--fl-radius);
    padding: 0.375rem 0.625rem;
    font-size: var(--fl-font-small);
  }

  /* The overlay sits over an arbitrary photo or video frame, so every control gets its own
     translucent scrim rather than relying on the surrounding image for contrast. */
  .fmp-overlay-top :global(button),
  .fmp-overlay-top :global(a),
  .fmp-overlay-bottom :global(button:not(.fmp-studio)),
  .fmp-overlay-bottom :global(a),
  .fmp-nav :global(button) {
    color: #fff;
    background: rgb(0 0 0 / 35%);
    border-color: transparent;
  }
  .fmp-overlay-top :global(button:hover),
  .fmp-overlay-top :global(a:hover),
  .fmp-overlay-bottom :global(button:hover:not(.fmp-studio)),
  .fmp-overlay-bottom :global(a:hover),
  .fmp-nav :global(button:hover) {
    background: rgb(0 0 0 / 55%);
  }
  .fmp-overlay-top :global(button[aria-pressed='true']) {
    color: var(--fl-accent);
    background: rgb(0 0 0 / 55%);
  }
  .fmp-overlay-bottom {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  .fmp-studio {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.875rem;
    font-weight: 600;
    color: var(--fl-accent-text);
    background: var(--fl-accent);
    border: 0;
    border-radius: var(--fl-radius-pill);
  }
  .fmp-nav {
    position: absolute;
    /* above the title card, so Previous and Next stay reachable from it */
    z-index: 4;
    top: 50%;
    translate: 0 -50%;
  }
  .fmp-nav.prev {
    inset-inline-start: 1rem;
  }
  .fmp-nav.next {
    inset-inline-end: 1rem;
  }
  /* memories.css:7-15 */
  .fmp-backdrop {
    position: absolute;
    inset: -48px;
    background-size: cover;
    background-position: center;
    filter: blur(30px) brightness(0.5) saturate(1.15);
    transform: scale(1.08);
    animation: fmp-fade 900ms ease both;
  }
  /* memories.css:44-75 */
  .fmp-title-card {
    position: absolute;
    inset: 0;
    z-index: 3;
    display: grid;
    place-content: center;
    padding: 1.5rem;
    text-align: center;
    color: #fff;
    background: #000a;
    animation: fmp-fade 600ms ease both;
  }
  /* discovery.css:1225-1233 */
  .fmp-title-bg {
    position: absolute;
    inset: 0;
    z-index: -1;
    width: 100%;
    height: 100%;
    object-fit: cover;
    filter: blur(18px) brightness(0.45) saturate(0.9);
    transform: scale(1.1);
  }
  .fmp-title-copy {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    max-width: min(720px, 100%);
  }
  .fmp-overline {
    font-size: var(--fl-font-small);
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    opacity: 0.8;
  }
  .fmp-title-card h2 {
    margin: 0;
    font-size: clamp(32px, 6vw, 64px);
    font-weight: 700;
    letter-spacing: -0.02em;
    line-height: 1.05;
    text-wrap: balance;
  }
  .fmp-title-copy p {
    margin: 0;
    font-size: 18px;
    opacity: 0.8;
  }
  .fmp-title-copy .fmp-title-count {
    font-size: var(--fl-font-small);
    opacity: 0.65;
  }
  /* discovery.css:1272-1301 */
  .fmp-end-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
  }
  .fmp-secondary {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 44px;
    padding: 0 22px;
    margin-block-start: 0.75rem;
    color: var(--fl-viewer-text, #f1f1f2);
    background: #ffffff1f;
    border: 0;
    border-radius: var(--fl-radius-pill);
    font-weight: 500;
  }
  .fmp-secondary:hover {
    background: #ffffff2e;
  }
  .fmp-play-large {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    margin-block-start: 0.75rem;
    padding: 0.625rem 1.25rem;
    color: var(--fl-viewer-canvas, #08090b);
    background: #fff;
    border: 0;
    border-radius: var(--fl-radius-pill);
    font-weight: 600;
  }
  .fmp-play-large:disabled {
    opacity: 0.5;
    cursor: default;
  }
  /* memories.css:77-104, 124-133 */
  .fmp-lower-third {
    position: absolute;
    inset-inline-start: 32px;
    bottom: 28px;
    z-index: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-width: min(70%, 560px);
    color: #fff;
    text-shadow: 0 1px 12px #000a;
    pointer-events: none;
    animation: fmp-fade 1.2s 600ms ease both;
  }
  .fmp-lower-third strong {
    font-size: 24px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .fmp-lower-third > span {
    font-size: 15px;
    opacity: 0.85;
  }
  @media (max-width: 760px) {
    .fmp-lower-third {
      inset-inline-start: 18px;
      bottom: 20px;
    }
    .fmp-lower-third strong {
      font-size: 20px;
    }
  }
  .fmp-gallery-section {
    padding: 1rem;
    background: var(--fl-viewer-canvas);
  }

  /* memories.css:16-42: the photo crossfades in and, when motion is allowed, pans and zooms
     through the shared fl-ken-burns keyframes (tokens.css) with the engine's --kb-* values. */
  .fmp :global(.fmp-photo) {
    position: relative;
    transform-origin: center;
  }
  .fmp :global(.fmp-photo.fade) {
    animation: fmp-fade 900ms ease both;
  }
  .fmp :global(.fmp-photo.memories) {
    animation:
      fmp-fade 900ms ease both,
      fl-ken-burns var(--kb-duration, 6s) ease-in-out both;
  }
  .fmp :global(.fmp-photo.paused) {
    animation-play-state: paused;
  }
  @keyframes -global-fmp-fade {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
</style>
