<script lang="ts">
  import VideoRemoteViewer from '$lib/components/asset-viewer/VideoRemoteViewer.svelte';
  import { assetViewerFadeDuration } from '$lib/constants';
  import { bindMediaSession, MEDIA_SESSION_ARTIST } from '$lib/frameleaf/media-session';
  import { videoSeek } from '$lib/frameleaf/video-seek.svelte';
  import '$lib/frameleaf/tokens.css';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { castManager } from '$lib/managers/cast-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { mediaCapabilitiesManager } from '$lib/managers/media-capabilities-manager.svelte';
  import { getAssetActions } from '$lib/services/asset.service';
  import { autoPlayVideo, lang, loopVideo as loopVideoPreference, videoQuality } from '$lib/stores/preferences.store';
  import { SlideshowState, slideshowStore } from '$lib/stores/slideshow.store';
  import { getAssetHlsSessionUrl, getAssetHlsUrl, getAssetMediaUrl, getAssetPlaybackUrl, isEnabled } from '$lib/utils';
  import { AssetMediaSize, AssetVisibility, type AssetResponseDto } from '@immich/sdk';
  import { Icon, LoadingSpinner, shortcuts } from '@immich/ui';
  import {
    mdiCheck,
    mdiChevronLeft,
    mdiChevronRight,
    mdiFullscreen,
    mdiFullscreenExit,
    mdiPause,
    mdiPlay,
    mdiTune,
    mdiVolumeHigh,
    mdiVolumeLow,
    mdiVolumeMedium,
    mdiVolumeMute,
  } from '@mdi/js';
  import 'hls-video-element';
  import type HlsVideoElement from 'hls-video-element';
  import Hls, {
    AbrController,
    Events,
    type ErrorData,
    type FragLoadedData,
    type FragLoadingData,
    type HlsConfig,
  } from 'hls.js';
  import 'media-chrome/media-control-bar';
  import 'media-chrome/media-controller';
  import 'media-chrome/media-fullscreen-button';
  import 'media-chrome/media-mute-button';
  import 'media-chrome/media-play-button';
  import 'media-chrome/media-playback-rate-button';
  import 'media-chrome/media-time-display';
  import 'media-chrome/media-volume-range';
  import 'media-chrome/menu/media-playback-rate-menu';
  import 'media-chrome/menu/media-rendition-menu';
  import 'media-chrome/menu/media-settings-menu';
  import 'media-chrome/menu/media-settings-menu-button';
  import 'media-chrome/menu/media-settings-menu-item';
  import { onDestroy, onMount, untrack } from 'svelte';
  import { useSwipe, type SwipeCustomEvent } from 'svelte-gestures';
  import { t } from 'svelte-i18n';
  import { fade } from 'svelte/transition';
  import './immich-time-range';

  interface Props {
    asset: AssetResponseDto;
    assetId: string;
    loopVideo: boolean;
    cacheKey: string | null;
    playOriginalVideo: boolean;
    extendedControls?: boolean;
    onPreviousAsset?: () => void;
    onNextAsset?: () => void;
    onVideoEnded?: () => void;
    onVideoStarted?: () => void;
    onClose?: () => void;
  }

  let {
    asset,
    assetId,
    loopVideo,
    cacheKey,
    playOriginalVideo,
    extendedControls = false,
    onPreviousAsset = () => {},
    onNextAsset = () => {},
    onVideoEnded = () => {},
    onVideoStarted = () => {},
    onClose = () => {},
  }: Props = $props();

  let videoPlayer: HTMLVideoElement | undefined = $state();
  let isLoading = $state(true);
  let hasLoadedMetadata = $state(false);
  let playbackFailed = $state(false);
  let retryCount = $state(0);
  let playbackController: AbortController | undefined;
  const useHls = $derived(featureFlagsManager.value.realtimeTranscoding && !playOriginalVideo);
  let assetFileUrl = $derived.by(() => {
    if (useHls) {
      return getAssetHlsUrl(assetId);
    }

    if (playOriginalVideo) {
      return getAssetMediaUrl({ id: assetId, size: AssetMediaSize.Original, cacheKey });
    }

    return getAssetPlaybackUrl({ id: assetId, cacheKey });
  });
  const aspectRatio = $derived(asset.width && asset.height ? `${asset.width} / ${asset.height}` : undefined);
  let showVideo = $state(false);
  let hasFocused = $state(false);
  const Actions = $derived(getAssetActions($t, asset));
  const canEditVideo = $derived(isEnabled(Actions.Edit));
  const editVideoLabel = $derived($t('editor_video_edit'));
  let activeSession: { assetId: string; id: string } | undefined;
  let rebuildCount = 0;

  const MAX_REBUILDS = 1;
  const SESSION_ID_REGEX = /\/video\/stream\/([0-9a-f-]{36})\//;

  // hls.js can abandon fetching an in-flight fragment if it thinks it'll take too long, in which case
  // it emergency switches to a different variant. This extends the delay even further due to
  // cold starting another transcode, so let the fragment finish and have steady ABR decide the next level.
  //
  // It can also emergency switch between fragments: while a switch's first segment is still loading,
  // it can run out of buffer and drop to a lower level for just one segment before continuing at the switched quality.
  // This can cause multiple redundant transcoding restarts when it occurs.
  // Hold the committed level until its first fragment lands, then resume normal ABR.
  class NoAbandonAbrController extends AbrController {
    private switchTarget = -1;

    protected override onFragLoading(_event: Events.FRAG_LOADING, data: FragLoadingData) {
      if (data.frag.sn === 'initSegment') {
        this.switchTarget = data.frag.level;
      }
    }

    protected override onFragLoaded(event: Events.FRAG_LOADED, data: FragLoadedData) {
      if (data.frag.sn !== 'initSegment') {
        this.switchTarget = -1;
      }
      super.onFragLoaded(event, data);
    }

    override get nextAutoLevel(): number {
      const level = super.nextAutoLevel;
      const target = this.hls.levels[this.switchTarget];
      // Hold the committed level, but only while hls.js still considers it healthy.
      if (target && level < this.switchTarget && target.loadError === 0 && target.fragmentError === 0) {
        return this.switchTarget;
      }
      return level;
    }

    override set nextAutoLevel(level: number) {
      super.nextAutoLevel = level;
    }
  }

  const hlsConfig: Partial<HlsConfig> = {
    abrController: NoAbandonAbrController,
    highBufferWatchdogPeriod: 10,
    detectStallWithCurrentTimeMs: 10_000,
    maxBufferHole: 0.5,
    maxBufferLength: 30,
    maxMaxBufferLength: 60,
    fragLoadPolicy: {
      default: {
        maxTimeToFirstByteMs: 30_000,
        maxLoadTimeMs: 60_000,
        timeoutRetry: { maxNumRetry: 5, retryDelayMs: 100, maxRetryDelayMs: 0 },
        errorRetry: { maxNumRetry: 3, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
      },
    },
    useMediaCapabilities: false,
    xhrSetup: (xhr: XMLHttpRequest, url: string) => {
      const authenticatedUrl = new URL(url, location.origin);
      for (const [key, value] of Object.entries(authManager.params)) {
        if (value) {
          authenticatedUrl.searchParams.set(key, value as string);
        }
      }
      xhr.open('GET', authenticatedUrl.href);
    },
  };

  // hls-video-element exposes media-tracks' rendition list, but its types don't declare it.
  type RenditionList = {
    selectedIndex: number;
    getRenditionById(id: string): { width: number; height: number } | null;
  };
  const getRenditions = (el: HlsVideoElement) => (el as unknown as { videoRenditions: RenditionList }).videoRenditions;

  const shortSide = (level: { width: number; height: number }) => Math.min(level.width, level.height);

  // The highest level at or under the pinned short side, else the lowest; undefined when on auto.
  const pickPinnedLevel = (levels: { width: number; height: number }[], quality: 'auto' | number) => {
    // A corrupt stored value would otherwise pin everything to the lowest level.
    if (typeof quality !== 'number' || !Number.isFinite(quality) || quality <= 0 || levels.length === 0) {
      return;
    }
    const index = levels.findLastIndex((level) => shortSide(level) <= quality);
    return Math.max(index, 0);
  };

  // Remember only the viewer's own pick from the quality menu, not hls-video-element's
  // error downgrades, which also move the selected rendition. The menu sends "auto" for Auto.
  const onRenditionRequest = (event: Event) => {
    const rendition = isHlsElement(videoPlayer)
      ? getRenditions(videoPlayer).getRenditionById((event as CustomEvent<string>).detail)
      : null;
    videoQuality.set(rendition ? shortSide(rendition) : 'auto');
  };

  const releaseSession = () => {
    const session = activeSession;
    if (!session) {
      return;
    }
    activeSession = undefined;
    const url = getAssetHlsSessionUrl(session.assetId, session.id);
    void fetch(url, { method: 'DELETE' }).catch(() => console.warn('Failed to release HLS session', session));
  };

  const isHlsElement = (el: HTMLVideoElement | undefined): el is HlsVideoElement => {
    return el?.tagName === 'HLS-VIDEO';
  };

  const wireHlsListeners = (el: HlsVideoElement, assetId: string, signal: AbortSignal, resumeTime?: number) => {
    const api = el.api;
    if (!api || signal.aborted) {
      return;
    }

    // This is a hack to make the rendition menu use `api.currentLevel` instead of `api.nextLevel`.
    // `api.nextLevel` makes the player request the next segment followed by the current segment.
    // That backward request causes the server to restart transcoding for no reason.
    Object.defineProperty(api, 'nextLevel', {
      configurable: true,
      get: () => api.currentLevel,
      set: (level: number) => {
        api.currentLevel = level;
      },
    });

    let disposed = false;
    const onManifestParsed = async () => {
      if (disposed) {
        return;
      }
      // Defer hls.js's first fragment load until we filter out suboptimal variants
      api.stopLoad();
      const id = api.levels[0]?.url[0]?.match(SESSION_ID_REGEX)?.[1];
      if (id) {
        activeSession = { assetId, id };
      }

      const keep = await mediaCapabilitiesManager.efficientLevels(api.levels);
      if (disposed) {
        return;
      }
      for (let i = api.levels.length - 1; i >= 0; i--) {
        if (!keep.has(i)) {
          api.removeLevel(i);
        }
      }

      const pinned = pickPinnedLevel(api.levels, $videoQuality);
      if (pinned !== undefined) {
        // Selecting the rendition keeps the quality menu in sync; its change event pins hls.js to
        // the level. Let that event land while loading is still stopped so nothing gets flushed.
        getRenditions(el).selectedIndex = pinned;
        await Promise.resolve();
        if (disposed) {
          return;
        }
        api.startLevel = pinned;
      }

      api.startLoad(resumeTime);
    };

    const onFragmentLoaded = () => (rebuildCount = 0);
    const onError = (_: Events.ERROR, data: ErrorData) => {
      if (disposed) {
        return;
      }
      // 404 on a fragment can mean the server-side session has expired. Refetch
      // master for a new session, but give up if it still 404s.
      if (
        !data.fatal ||
        data.details !== Hls.ErrorDetails.FRAG_LOAD_ERROR ||
        data.response?.code !== 404 ||
        rebuildCount++ >= MAX_REBUILDS
      ) {
        console.error('HLS error', JSON.stringify(data));
        if (data.fatal) {
          handlePlaybackError();
        }
        return;
      }
      console.warn('Error loading segment, starting new session');
      dispose();
      releaseSession();
      resumeTime = el.currentTime;
      el.load();
      // wireHlsListeners must run after el.api is repopulated.
      queueMicrotask(() => wireHlsListeners(el, assetId, signal, resumeTime));
    };
    const dispose = () => {
      disposed = true;
      // off only compares callback identity; it never invokes the async listener.
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      api.off(Hls.Events.MANIFEST_PARSED, onManifestParsed);
      api.off(Hls.Events.FRAG_LOADED, onFragmentLoaded);
      api.off(Hls.Events.ERROR, onError);
      api.stopLoad();
      signal.removeEventListener('abort', dispose);
    };
    signal.addEventListener('abort', dispose, { once: true });
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    api.on(Hls.Events.MANIFEST_PARSED, onManifestParsed);
    api.on(Hls.Events.FRAG_LOADED, onFragmentLoaded);
    api.on(Hls.Events.ERROR, onError);
  };

  onMount(() => {
    showVideo = true;
  });

  // FL-59: a moment chosen in the moments panel or in moment search starts the video there.
  $effect(() => {
    if (!hasLoadedMetadata || !videoPlayer || videoSeek.pending?.assetId !== assetId) {
      return;
    }
    const seconds = videoSeek.take(assetId);
    if (seconds !== null) {
      videoPlayer.currentTime = Number.isFinite(videoPlayer.duration)
        ? Math.min(seconds, videoPlayer.duration)
        : seconds;
    }
  });

  $effect(() => {
    // Retry reloads the selected source without changing its mode or URL.
    void retryCount;
    const el = videoPlayer;
    const url = assetFileUrl;
    const id = assetId;
    const controller = new AbortController();
    playbackController = controller;
    hasLoadedMetadata = false;
    playbackFailed = false;
    isLoading = true;
    if (el && url) {
      hasFocused = false;
      rebuildCount = 0;
      if (isHlsElement(el)) {
        el.config = hlsConfig;
        if (el.getAttribute('src') === url) {
          el.load();
        } else {
          el.src = url;
        }
        queueMicrotask(() => wireHlsListeners(el, id, controller.signal));
      } else {
        el.load();
      }
    }
    return () => {
      controller.abort();
      el?.pause();
      if (isHlsElement(el)) {
        el.src = '';
      }
      releaseSession();
    };
  });

  const handlePlaybackError = (event?: Event) => {
    if (event && event.currentTarget !== videoPlayer) {
      return;
    }
    playbackFailed = true;
    isLoading = false;
    videoPlayer?.pause();
    if (isHlsElement(videoPlayer)) {
      videoPlayer.api?.stopLoad();
    }
  };

  const onPagehide = (event: PageTransitionEvent) => {
    if (!event.persisted) {
      releaseSession();
    }
  };

  $effect(() => {
    window.addEventListener('pagehide', onPagehide);
    return () => window.removeEventListener('pagehide', onPagehide);
  });

  // FL-36 (MediaViewer.jsx:886-923): media keys and the lock screen control the open video. A
  // running slideshow owns the session itself (SlideshowBar), so this steps aside then.
  const { slideshowState } = slideshowStore;
  $effect(() => {
    const player = videoPlayer;
    if (!player || !extendedControls || $slideshowState !== SlideshowState.None) {
      return;
    }
    return bindMediaSession({
      // a Locked video never reaches the lock screen or the OS media controls
      locked: asset.visibility === AssetVisibility.Locked,
      title: asset.originalFileName,
      artist: MEDIA_SESSION_ARTIST,
      album: asset.exifInfo?.city ?? undefined,
      artwork: getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Preview, cacheKey }),
      controls: {
        play: () => void player.play().catch(() => {}),
        pause: () => player.pause(),
        previous: onPreviousAsset,
        next: onNextAsset,
      },
    });
  });

  // FL-36 (MediaViewer.jsx:422-460, 898-903): pausing or resuming a slideshow (its button, Space
  // or the media keys) pauses or resumes the video on screen, and so does opening and closing the
  // slideshow settings, which hold the slideshow without pausing it.
  const { settingsOpen: slideshowSettingsOpen } = slideshowStore;
  const slideshowHeld = (state: SlideshowState, settingsOpen: boolean) =>
    state === SlideshowState.PauseSlideshow || (state === SlideshowState.PlaySlideshow && settingsOpen);
  let previousHeld = untrack(() => slideshowHeld($slideshowState, $slideshowSettingsOpen));
  $effect(() => {
    const held = slideshowHeld($slideshowState, $slideshowSettingsOpen);
    const resumable = $slideshowState === SlideshowState.PlaySlideshow;
    const player = videoPlayer;
    untrack(() => {
      const wasHeld = previousHeld;
      previousHeld = held;
      if (!player || held === wasHeld) {
        return;
      }
      if (held) {
        player.pause();
      } else if (resumable) {
        player.play().catch(() => {});
      }
    });
  });

  onDestroy(() => {
    if (videoPlayer) {
      videoPlayer.src = '';
    }
  });

  const handleCanPlay = async (video: HTMLVideoElement) => {
    if (playbackFailed || video !== videoPlayer) {
      return;
    }
    const signal = playbackController?.signal;
    try {
      if (!video.paused) {
        await video.play();
        if (!signal?.aborted && video === videoPlayer && !playbackFailed) {
          onVideoStarted();
        }
      }
    } catch (error) {
      if (!signal?.aborted && error instanceof DOMException && error.name === 'NotAllowedError') {
        await tryForceMutedPlay(video);
        return;
      }

      // auto-play failed
    } finally {
      if (!signal?.aborted && video === videoPlayer) {
        isLoading = false;
      }
    }
  };

  const tryForceMutedPlay = async (video: HTMLVideoElement) => {
    if (video.muted) {
      return;
    }

    try {
      video.muted = true;
      await handleCanPlay(video);
    } catch {
      // muted auto-play failed
    }
  };

  const onSwipe = (event: SwipeCustomEvent) => {
    if (event.detail.direction === 'left') {
      onNextAsset();
    } else if (event.detail.direction === 'right') {
      onPreviousAsset();
    }
  };

  const openVideoEditor = () => {
    videoPlayer?.pause();
    Actions.Edit.onAction(Actions.Edit);
  };

  $effect(() => {
    if (assetViewerManager.isFaceEditMode) {
      videoPlayer?.pause();
    }
  });

  // The time is only refreshed on HLS fragment decode by default,
  // so manually emit events on seek to update it immediately.
  const onSeeking = (event: Event) => event.currentTarget?.dispatchEvent(new Event('timeupdate'));
</script>

<svelte:body
  use:shortcuts={[
    {
      shortcut: { key: ' ' },
      onShortcut: () => (videoPlayer?.paused ? videoPlayer?.play() : videoPlayer?.pause()),
    },
    {
      shortcut: { shift: true, key: 'ArrowLeft' },
      onShortcut: () =>
        videoPlayer ? (videoPlayer.currentTime = Math.max(videoPlayer.currentTime - 0.4, 0)) : undefined,
    },
    {
      shortcut: { shift: true, key: 'ArrowRight' },
      onShortcut: () =>
        videoPlayer
          ? (videoPlayer.currentTime = Math.min(videoPlayer.currentTime + 0.4, videoPlayer.duration))
          : undefined,
    },
  ]}
/>

{#if showVideo}
  <div
    transition:fade={{ duration: assetViewerFadeDuration }}
    class="flex h-full place-content-center place-items-center select-none"
  >
    {#if castManager.isCasting}
      <div class="h-full place-content-center place-items-center">
        <VideoRemoteViewer
          poster={getAssetMediaUrl({ id: assetId, size: AssetMediaSize.Preview, cacheKey })}
          {onVideoStarted}
          {onVideoEnded}
          {assetFileUrl}
        />
      </div>
    {:else}
      <!-- dir=ltr based on https://github.com/videojs/video.js/issues/949 -->
      <media-controller
        dir="ltr"
        lang={$lang}
        nohotkeys
        class="dark h-full max-w-full"
        style:aspect-ratio={aspectRatio}
        defaultduration={asset.duration! / 1000}
        onmediarenditionrequest={onRenditionRequest}
      >
        {#if useHls}
          <hls-video
            bind:this={videoPlayer}
            slot="media"
            loop={$loopVideoPreference && loopVideo}
            autoplay={$autoPlayVideo}
            disablePictureInPicture
            playsinline
            {...useSwipe(onSwipe)}
            class="h-full object-contain"
            oncanplay={(e: Event) => handleCanPlay(e.currentTarget as HTMLVideoElement)}
            onerror={handlePlaybackError}
            onloadedmetadata={() => (hasLoadedMetadata = true)}
            onended={onVideoEnded}
            onseeking={onSeeking}
            onplaying={(e: Event) => {
              if (hasFocused) {
                return;
              }

              (e.currentTarget as HTMLElement).focus();
              hasFocused = true;
            }}
            onclose={onClose}
            poster={getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Preview, cacheKey })}
          ></hls-video>
        {:else}
          <video
            bind:this={videoPlayer}
            slot="media"
            src={assetFileUrl}
            loop={$loopVideoPreference && loopVideo}
            autoplay={$autoPlayVideo}
            disablePictureInPicture
            playsinline
            {...useSwipe(onSwipe)}
            class="h-full object-contain"
            oncanplay={(e) => handleCanPlay(e.currentTarget)}
            onerror={handlePlaybackError}
            onloadedmetadata={() => (hasLoadedMetadata = true)}
            onended={onVideoEnded}
            onseeking={onSeeking}
            onplaying={(e) => {
              if (hasFocused) {
                return;
              }

              e.currentTarget.focus();
              hasFocused = true;
            }}
            onclose={onClose}
            poster={getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Preview, cacheKey })}
          ></video>
        {/if}

        {#if extendedControls}
          <media-settings-menu hidden anchor="auto" class="min-w-3xs rounded-xl border border-light-300 shadow-sm">
            <Icon slot="checked-indicator" icon={mdiCheck} class="m-2" />
            <media-settings-menu-item class="mx-1 rounded-lg p-1 ps-2">
              {$t('media_chrome.playback_rate')}
              <Icon slot="suffix" icon={mdiChevronRight} class="m-2" />
              <media-playback-rate-menu slot="submenu" hidden rates="0.5 1 1.5 2">
                <Icon slot="back-icon" icon={mdiChevronLeft} class="m-2" />
                <span slot="title">{$t('media_chrome.playback_rate')}</span>
              </media-playback-rate-menu>
            </media-settings-menu-item>
            {#if useHls}
              <media-settings-menu-item class="mx-1 rounded-lg p-1 ps-2">
                {$t('video_quality')}
                <Icon slot="suffix" icon={mdiChevronRight} class="m-2" />
                <media-rendition-menu slot="submenu" hidden>
                  <Icon slot="back-icon" icon={mdiChevronLeft} class="m-2" />
                  <span slot="title">{$t('video_quality')}</span>
                </media-rendition-menu>
              </media-settings-menu-item>
            {/if}
          </media-settings-menu>
        {/if}

        <div class="flex h-32 w-full flex-col justify-end bg-linear-to-b to-black/80 px-4">
          <media-control-bar part="bottom" class="flex h-10 w-full gap-2">
            <media-play-button class="shrink-0 rounded-full p-2 outline-none">
              <Icon slot="play" icon={mdiPlay} />
              <Icon slot="pause" icon={mdiPause} />
            </media-play-button>
            <media-time-display showduration class="rounded-lg p-2 outline-none"></media-time-display>

            <span class="grow"></span>

            <div
              class="volume-wrapper shrink-0 rounded-full bg-light-100/0 transition-colors duration-400 hover:bg-light-100"
            >
              <media-volume-range class="h-full bg-none outline-none"></media-volume-range>
              <media-mute-button class="bg-none p-2 outline-none">
                <Icon slot="off" icon={mdiVolumeMute} />
                <Icon slot="low" icon={mdiVolumeLow} />
                <Icon slot="medium" icon={mdiVolumeMedium} />
                <Icon slot="high" icon={mdiVolumeHigh} />
              </media-mute-button>
            </div>

            {#if extendedControls}
              {#if canEditVideo}
                <button
                  type="button"
                  class="video-editor-button shrink-0 rounded-full p-2 outline-none"
                  aria-label={editVideoLabel}
                  title={editVideoLabel}
                  onclick={openVideoEditor}
                >
                  <Icon icon={mdiTune} />
                </button>
              {/if}
              <media-fullscreen-button class="shrink-0 rounded-full p-2 outline-none">
                <Icon slot="enter" icon={mdiFullscreen} />
                <Icon slot="exit" icon={mdiFullscreenExit} />
              </media-fullscreen-button>
              <media-settings-menu-button class="shrink-0 rounded-full p-2 outline-none"></media-settings-menu-button>
            {/if}
          </media-control-bar>
          <immich-time-range class="h-8 w-full rounded-lg px-2 pb-3 outline-none"></immich-time-range>
        </div>
      </media-controller>

      {#if playbackFailed}
        <div class="frameleaf playback-error" data-theme="dark" role="alert">
          <span>{$t('errors.failed_to_load_asset')}</span>
          <button type="button" class="playback-retry" onclick={() => retryCount++}>
            {$t('retry')}
          </button>
        </div>
      {:else if isLoading}
        <div role="status" aria-label={$t('loading')} class="absolute flex place-content-center place-items-center">
          <LoadingSpinner />
        </div>
      {/if}
    {/if}
  </div>
{/if}

<style>
  /* MediaViewer.jsx / media-viewer.css: the prototype's viewer message bar. */
  .playback-error {
    position: absolute;
    bottom: 70px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 7;
    display: flex;
    align-items: center;
    gap: 12px;
    max-width: min(650px, calc(100% - 36px));
    padding: 5px 8px 5px 14px;
    background: color-mix(in srgb, var(--fl-warning) 18%, var(--fl-viewer-panel));
    color: var(--fl-viewer-text);
    border: 1px solid color-mix(in srgb, var(--fl-warning) 45%, transparent);
    border-radius: var(--fl-radius-card);
    font-size: var(--fl-font-small);
    box-shadow: var(--fl-shadow-2);
  }

  .playback-retry {
    flex-shrink: 0;
    min-width: 38px;
    height: 38px;
    padding: 7px;
    border: 1px solid transparent;
    border-radius: var(--fl-radius-control);
    background: transparent;
    color: var(--fl-viewer-text);
    cursor: pointer;
    font: inherit;
  }

  .playback-retry:hover {
    background: #ffffff12;
  }

  .playback-retry:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }

  media-controller {
    --media-control-background: none;
    --media-control-hover-background: var(--immich-ui-light-100);
    --media-focus-box-shadow: 0 0 0 2px var(--immich-ui-dark);
    --media-font-family: var(--font-sans);
    --media-font-size: var(--text-base);
    --media-font-weight: var(--font-weight-medium);
    --media-menu-border-radius: var(--radius-xl);
    --media-menu-gap: var(--spacing);
    --media-menu-item-hover-background: var(--immich-ui-light-200);
    --media-menu-item-icon-height: 1em;
    --media-menu-item-indicator-height: 1em;
    --media-primary-color: var(--immich-ui-dark);
    --media-time-range-buffered-color: var(--immich-ui-dark-400);
    --media-time-range-hover-bottom: 0;
    --media-time-range-hover-height: 100%;
    --media-range-thumb-box-shadow: none;
    --media-range-thumb-opacity: 0;
    --media-range-thumb-transition: opacity 0.15s ease;
    --media-range-track-border-radius: 2px;
    --media-range-track-height: 3.5px;
    --media-range-padding: 0;
    --media-settings-menu-background: var(--immich-ui-light-100);
    --media-text-content-height: var(--text-base--line-height);
    --media-tooltip-arrow-display: none;
    --media-tooltip-border-radius: var(--radius-lg);
    --media-tooltip-background-color: var(--immich-ui-light-200);
    --media-tooltip-distance: 8px;
    --media-tooltip-padding: calc(var(--spacing) * 2) calc(var(--spacing) * 3.5);
  }

  media-time-display {
    font-variant-numeric: tabular-nums;
  }

  immich-time-range,
  media-volume-range {
    --media-control-hover-background: none;
  }

  immich-time-range:hover,
  media-volume-range:hover {
    --media-range-thumb-opacity: 1;
  }

  *::part(tooltip) {
    --media-font-size: var(--text-xs);
    --media-text-content-height: var(--text-xs--line-height);
    color: white;
  }

  *[mediavolumeunavailable] {
    --media-volume-range-display: none;
  }

  .volume-wrapper {
    --media-control-hover-background: none;
  }

  .video-editor-button {
    color: var(--media-primary-color);
    background: none;
  }

  .video-editor-button:hover,
  .video-editor-button:focus-visible {
    background: var(--media-control-hover-background);
  }

  .video-editor-button:focus-visible {
    box-shadow: var(--media-focus-box-shadow);
  }

  media-volume-range:has(+ media-mute-button) {
    padding: 0;
    margin: 0;
    width: 0;
    overflow: hidden;
    transition: width 0.4s ease-out;
  }

  /* Expand volume control in all relevant states */
  .volume-wrapper:hover > media-volume-range,
  media-volume-range:has(+ media-mute-button:hover),
  media-volume-range:has(+ media-mute-button:focus),
  media-volume-range:has(+ media-mute-button:focus-within),
  media-volume-range:hover,
  media-volume-range:focus,
  media-volume-range:focus-within {
    padding: 0 calc(var(--spacing) * 2);
    margin-left: calc(var(--spacing) * 2);
    width: 70px;
  }
</style>
