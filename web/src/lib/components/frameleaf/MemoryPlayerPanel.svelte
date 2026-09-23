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
   *  - Ken Burns pan/zoom motion on photos (`MemoryPhotoViewer`'s new `motionClass` prop),
   *    cycling through three variants and disabled under `prefers-reduced-motion`.
   *  - Share, which the legacy viewer had commented out entirely; it now opens the shared
   *    `ShareSheet` with the memory's current asset ids.
   *  - "Make a movie in Studio", which did not exist before this story. Studio itself has
   *    not landed yet (see `$lib/frameleaf/studio-handoff.ts` for the full contract), so
   *    this queues the asset list for Studio to pick up and confirms it to the user rather
   *    than navigating into a route that does not exist.
   *
   * The floating selection bar and the below-the-fold `GalleryViewer` are shared,
   * already-Frameleaf-agnostic components reused across the app; this story restyles the
   * chrome it owns (header, stage, controls) and leaves those two as-is.
   */
  import { goto } from '$app/navigation';
  import { shortcuts } from '$lib/actions/shortcut';
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import ShareSheet from '$lib/components/frameleaf/ShareSheet.svelte';
  import Status from '$lib/components/frameleaf/Status.svelte';
  import ButtonContextMenu from '$lib/components/shared-components/context-menu/ButtonContextMenu.svelte';
  import GalleryViewer from '$lib/components/shared-components/gallery-viewer/GalleryViewer.svelte';
  import ArchiveAction from '$lib/components/timeline/actions/ArchiveAction.svelte';
  import ChangeDate from '$lib/components/timeline/actions/ChangeDateAction.svelte';
  import ChangeDescription from '$lib/components/timeline/actions/ChangeDescriptionAction.svelte';
  import ChangeLocation from '$lib/components/timeline/actions/ChangeLocationAction.svelte';
  import CreateSharedLink from '$lib/components/timeline/actions/CreateSharedLinkAction.svelte';
  import DeleteAssets from '$lib/components/timeline/actions/DeleteAssetsAction.svelte';
  import DownloadAction from '$lib/components/timeline/actions/DownloadAction.svelte';
  import FavoriteAction from '$lib/components/timeline/actions/FavoriteAction.svelte';
  import MarkNsfwAction from '$lib/components/timeline/actions/MarkNsfwAction.svelte';
  import TagAction from '$lib/components/timeline/actions/TagAction.svelte';
  import AssetSelectControlBar from '$lib/components/timeline/AssetSelectControlBar.svelte';
  import { writeStudioHandoff } from '$lib/frameleaf/studio-handoff';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { memoryManager } from '$lib/managers/memory-manager.svelte';
  import type { TimelineAsset, Viewport } from '$lib/managers/timeline-manager/types';
  import { Route } from '$lib/route';
  import { getAssetBulkActions } from '$lib/services/asset.service';
  import { locale } from '$lib/stores/preferences.store';
  import { downloadArchive } from '$lib/utils/asset-utils';
  import { getAssetMediaUrl, handlePromiseError, memoryLaneTitle } from '$lib/utils';
  import { fromISODateTimeUTC, toTimelineAsset } from '$lib/utils/timeline-util';
  import { AssetMediaSize, AssetTypeEnum, getAssetInfo } from '@immich/sdk';
  import {
    ActionButton,
    Icon,
    IconButton as ImmichIconButton,
    Text,
    themeManager,
    toastManager,
    Theme as AppTheme,
  } from '@immich/ui';
  import {
    mdiCardsOutline,
    mdiChevronDown,
    mdiChevronLeft,
    mdiChevronRight,
    mdiChevronUp,
    mdiClose,
    mdiDotsVertical,
    mdiDownload,
    mdiHeart,
    mdiHeartOutline,
    mdiImageMinusOutline,
    mdiImageSearch,
    mdiMovieEditOutline,
    mdiPause,
    mdiPlay,
    mdiSelectAll,
    mdiShareVariantOutline,
    mdiVolumeHigh,
    mdiVolumeOff,
  } from '@mdi/js';
  import { DateTime } from 'luxon';
  import 'media-chrome/media-mute-button';
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { Attachment } from 'svelte/attachments';
  import { Tween } from 'svelte/motion';
  import MemoryPhotoViewer from '$lib/components/frameleaf/MemoryPhotoViewer.svelte';
  import MemoryVideoViewer from '$lib/components/frameleaf/MemoryVideoViewer.svelte';

  const KEN_BURNS_CLASSES = ['fmp-kb-a', 'fmp-kb-b', 'fmp-kb-c'];

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
  // where the asset sits in its memory, for the progress bar, counter and Ken Burns cycle
  const assetIndex = $derived(current ? current.memory.assets.findIndex(({ id }) => id === currentAssetId) : -1);
  const kenBurnsClass = $derived(KEN_BURNS_CLASSES[Math.max(0, assetIndex) % KEN_BURNS_CLASSES.length]);
  const currentMemoryAssetFull = $derived.by(async () =>
    currentAssetId ? await getAssetInfo({ ...authManager.params, id: currentAssetId }) : undefined,
  );
  let currentTimelineAssets = $derived(current?.memory.assets ?? []);

  let viewerHeight = $state(0);

  const viewport: Viewport = $state({ width: 0, height: 0 });
  // need to include padding in the viewport for gallery
  const galleryViewport: Viewport = $derived({ height: viewport.height, width: viewport.width - 32 });
  let progressBarController: Tween<number> | undefined = $state(undefined);
  let videoPlayer: HTMLVideoElement | undefined = $state();
  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');

  const handleNavigate = async (href: string | undefined, options?: { replaceState?: boolean }) => {
    if (assetViewerManager.isViewing || !href) {
      return;
    }

    await goto(href, { noScroll: true, keepFocus: true, ...options });
  };

  const setProgressDuration = (asset: TimelineAsset) => {
    progressBarController = new Tween<number>(0, {
      duration: (from: number, to: number) =>
        to ? (asset.isVideo ? asset.duration! : authManager.preferences.memories.duration * 1000) * (to - from) : 0,
    });
  };

  const handleEscape = async () => goto(memoryManager.memoriesHref);
  const handleSelectAll = () =>
    assetMultiSelectManager.selectAssets(current?.memory.assets.map((a) => toTimelineAsset(a)) || []);

  const handleAction = async (callingContext: string, action: 'reset' | 'pause' | 'play') => {
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
      if (current?.nextHref) {
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
    handlePromiseError(handleAction('resetAndPlay', 'reset'));
    handlePromiseError(handleAction('resetAndPlay', 'play'));
  };

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
   * Private highlight export: a client-side download of this memory's own assets through
   * the existing archive-download endpoint, exactly like an album or shared-link download.
   * There is no separate export job or rendering step - the "export" is the zip itself.
   */
  const downloadMemory = () => {
    if (!current) {
      return;
    }
    handlePromiseError(
      downloadArchive($memoryLaneTitle(current.memory), { assetIds: current.memory.assets.map((asset) => asset.id) }),
    );
  };

  const makeMovie = () => {
    if (!current) {
      return;
    }
    const assetIds = current.memory.assets.map((asset) => asset.id);
    writeStudioHandoff({ source: 'memory', sourceId: current.memory.id, title: $memoryLaneTitle(current.memory), assetIds });
    const message = $t('frameleaf_memories_make_movie_queued', { values: { count: assetIds.length } });
    status = message;
    toastManager.primary(message);
  };
</script>

<svelte:document
  use:shortcuts={assetViewerManager.isViewing
    ? []
    : [
        { shortcut: { key: 'ArrowRight' }, onShortcut: () => handleNavigate(current?.nextHref) },
        { shortcut: { key: 'd' }, onShortcut: () => handleNavigate(current?.nextHref) },
        { shortcut: { key: 'ArrowLeft' }, onShortcut: () => handleNavigate(current?.previousHref) },
        { shortcut: { key: 'a' }, onShortcut: () => handleNavigate(current?.previousHref) },
        { shortcut: { key: 'Escape' }, onShortcut: () => handleEscape() },
      ]}
/>

{#if assetMultiSelectManager.selectionActive}
  <div class="dark frameleaf sticky top-0 z-1" data-theme={appTheme}>
    <AssetSelectControlBar>
      {@const Actions = getAssetBulkActions($t)}
      <CreateSharedLink />
      <IconButton label={$t('select_all')} onclick={handleSelectAll}>
        <Icon icon={mdiSelectAll} size={20} />
      </IconButton>

      <ActionButton action={Actions.AddToAlbum} />

      <FavoriteAction removeFavorite={assetMultiSelectManager.isAllFavorite} />

      <ButtonContextMenu icon={mdiDotsVertical} title={$t('menu')}>
        <DownloadAction menuItem />
        <ChangeDate menuItem />
        <ChangeDescription menuItem />
        <ChangeLocation menuItem />
        <ArchiveAction menuItem unarchive={assetMultiSelectManager.isAllArchived} onArchive={handleHideAssets} />
        {#if assetMultiSelectManager.ownedAssets.length > 0}
          <MarkNsfwAction menuItem />
          <MarkNsfwAction menuItem markSafe />
        {/if}
        {#if authManager.preferences.tags.enabled && assetMultiSelectManager.isAllUserOwned}
          <TagAction menuItem />
        {/if}
        <DeleteAssets menuItem onAssetDelete={handleHideAssets} />
      </ButtonContextMenu>
    </AssetSelectControlBar>
  </div>
{/if}

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
          <Icon icon={mdiClose} size={22} />
        </IconButton>
        <p>{$memoryLaneTitle(current.memory)}</p>
      </div>

      <div class="fmp-progress" role="group" aria-label={$t('memories')}>
        <IconButton
          label={paused ? $t('play_memories') : $t('pause_memories')}
          onclick={() => handlePromiseError(handleAction('PlayPauseButtonClick', paused ? 'play' : 'pause'))}
        >
          <Icon icon={paused ? mdiPlay : mdiPause} size={20} />
        </IconButton>

        {#each current.memory.assets as asset, index (asset.id)}
          <a class="fmp-segment" href={current.getAssetHref(asset.id)} aria-label={$t('view')}>
            <span class="fmp-segment-track"></span>
            <span class="fmp-segment-fill" style:width={`${toProgressPercentage(index)}%`}></span>
          </a>
        {/each}

        <Text size="small">
          {$t('x_of_total', {
            values: { x: (assetIndex + 1).toLocaleString($locale), total: current.memory.assets.length.toLocaleString($locale) },
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
          <Icon icon={mdiChevronUp} size={20} />
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
                <MemoryPhotoViewer
                  asset={current.asset}
                  onImageLoad={resetAndPlay}
                  motionClass={paused ? '' : kenBurnsClass}
                  motionStyle={`animation-duration: ${authManager.preferences.memories.duration}s`}
                />
              {/if}
            {/key}

            <div class="fmp-overlay" class:hidden={galleryInView}>
              <div class="fmp-overlay-top">
                <IconButton
                  label={current.memory.isSaved ? $t('unfavorite') : $t('favorite')}
                  pressed={current.memory.isSaved}
                  onclick={() => memoryManager.toggleCurrentMemorySaved()}
                >
                  <Icon icon={current.memory.isSaved ? mdiHeart : mdiHeartOutline} size={20} />
                </IconButton>
                <IconButton label={$t('share')} onclick={openShare}>
                  <Icon icon={mdiShareVariantOutline} size={20} />
                </IconButton>
                <!-- Two direct actions rather than a dropdown: .fmp-main-inner clips overflow
                     to contain the Ken Burns zoom, which would also clip an open popup menu
                     positioned near this corner. -->
                <IconButton label={$t('remove_photo_from_memory')} onclick={() => memoryManager.deleteCurrentAsset()}>
                  <Icon icon={mdiImageMinusOutline} size={20} />
                </IconButton>
                <IconButton label={$t('remove_memory')} onclick={() => memoryManager.deleteCurrentMemory()}>
                  <Icon icon={mdiCardsOutline} size={20} />
                </IconButton>
              </div>

              <div class="fmp-overlay-bottom">
                {#await currentMemoryAssetFull then asset}
                  {#if asset}
                    <IconButton label={$t('view_in_timeline')} href={Route.photos({ at: asset.stack?.primaryAssetId ?? asset.id })}>
                      <Icon icon={mdiImageSearch} size={20} />
                    </IconButton>
                  {/if}
                {/await}
                <IconButton label={$t('download')} onclick={downloadMemory}>
                  <Icon icon={mdiDownload} size={20} />
                </IconButton>
                <button type="button" class="fmp-studio" onclick={makeMovie}>
                  <Icon icon={mdiMovieEditOutline} size={18} aria-hidden="true" />
                  {$t('frameleaf_memories_make_movie')}
                </button>
              </div>
            </div>

            {#if current.previousHref}
              <div class="fmp-nav prev">
                <IconButton label={$t('previous_memory')} onclick={() => handleNavigate(current?.previousHref)}>
                  <Icon icon={mdiChevronLeft} size={28} />
                </IconButton>
              </div>
            {/if}

            {#if current.nextHref}
              <div class="fmp-nav next">
                <IconButton label={$t('next_memory')} onclick={() => handleNavigate(current?.nextHref)}>
                  <Icon icon={mdiChevronRight} size={28} />
                </IconButton>
              </div>
            {/if}

            <div class="fmp-meta">
              <p>
                {fromISODateTimeUTC(current.memory.assets[0].localDateTime).toLocaleString(DateTime.DATE_FULL, { locale: $locale })}
              </p>
              <p>
                {#await currentMemoryAssetFull then asset}
                  {asset?.exifInfo?.city || ''}
                  {asset?.exifInfo?.country || ''}
                {/await}
              </p>
            </div>
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
        <Icon icon={mdiChevronDown} size={20} />
      </IconButton>
    </div>

    <div id="gallery-memory" {@attach galleryObserver} bind:this={memoryGallery}>
      <GalleryViewer
        assets={currentTimelineAssets}
        viewerAssets={current.viewerAssets}
        viewport={galleryViewport}
        assetInteraction={assetMultiSelectManager}
        slidingWindowOffset={viewerHeight}
        arrowNavigation={false}
      />
    </div>
  </section>
{/if}

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
    top: 50%;
    translate: 0 -50%;
  }
  .fmp-nav.prev {
    inset-inline-start: 1rem;
  }
  .fmp-nav.next {
    inset-inline-end: 1rem;
  }
  .fmp-meta {
    position: absolute;
    inset-inline-start: 2rem;
    top: 1rem;
    font-size: var(--fl-font-small);
    font-weight: 500;
    color: #fff;
    text-shadow: 0 1px 3px rgb(0 0 0 / 60%);
  }
  .fmp-meta p {
    margin: 0;
  }
  .fmp-gallery-section {
    padding: 1rem;
    background: var(--fl-viewer-canvas);
  }

  /* Ken Burns: a slow pan/zoom while a photo is on screen. Disabled entirely under
     prefers-reduced-motion so the presentation never relies on parallax motion. */
  :global(.fmp-kb-a) {
    animation: fmp-kb-zoom-in 6s ease-out forwards;
  }
  :global(.fmp-kb-b) {
    animation: fmp-kb-zoom-out 6s ease-out forwards;
  }
  :global(.fmp-kb-c) {
    animation: fmp-kb-pan 6s ease-out forwards;
  }
  @keyframes fmp-kb-zoom-in {
    from {
      transform: scale(1);
    }
    to {
      transform: scale(1.08);
    }
  }
  @keyframes fmp-kb-zoom-out {
    from {
      transform: scale(1.08);
    }
    to {
      transform: scale(1);
    }
  }
  @keyframes fmp-kb-pan {
    from {
      transform: scale(1.06) translateX(-1%);
    }
    to {
      transform: scale(1.06) translateX(1%);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    :global(.fmp-kb-a),
    :global(.fmp-kb-b),
    :global(.fmp-kb-c) {
      animation: none;
    }
  }
</style>
