<script lang="ts">
  /**
   * The viewer footer (V-13), ported from `MediaViewer.jsx:1693-1797` and `media-viewer.css:750-830`:
   * playback on the left (Play/Pause slideshow, "n of N", slideshow settings, filmstrip), the key hint
   * in the middle, and the view controls on the right (video source, panorama, zoom, full screen).
   *
   * It only drives state that already exists: the slideshow through `slideshowStore` (the slideshow
   * itself is not changed here), its settings through the store's settings-open flag, the filmstrip
   * preference, the zoom of `assetViewerManager`, the panorama view and the video source.
   */
  import { isImageAsset, isPanorama, isVideoAsset } from '$lib/frameleaf/viewer-media';
  import { showFilmstrip } from '$lib/frameleaf/viewer-preferences';
  import type { ViewerPosition } from '$lib/frameleaf/viewer-position';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { canPlaySlideshow } from '$lib/services/asset.service';
  import { SlideshowState, slideshowStore } from '$lib/stores/slideshow.store';
  import type { AssetResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiCogOutline,
    mdiFilmstrip,
    mdiFullscreen,
    mdiFullscreenExit,
    mdiMagnifyMinusOutline,
    mdiMagnifyPlusOutline,
    mdiPanorama,
    mdiPanoramaVariantOutline,
    mdiPause,
    mdiPlay,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /** The wheel zoom's maximum (`PhotoViewer` keyboard steps share it). */
  const MAX_ZOOM = 10;
  const STEP = 1.25;

  interface Props {
    asset: AssetResponseDto;
    position?: ViewerPosition | null;
    canNavigateCollection: boolean;
    canShowFilmstrip: boolean;
    hasStack: boolean;
    /** The photo viewer is showing, so the zoom controls act on something. */
    zoomable: boolean;
    isPlayingOriginalVideo: boolean;
    setPlayOriginalVideo: (value: boolean) => void;
    fullscreen: boolean;
    onToggleFullscreen: () => void;
  }

  let {
    asset,
    position = null,
    canNavigateCollection,
    canShowFilmstrip,
    hasStack,
    zoomable,
    isPlayingOriginalVideo,
    setPlayOriginalVideo,
    fullscreen,
    onToggleFullscreen,
  }: Props = $props();

  const { slideshowState, settingsOpen } = slideshowStore;
  const playing = $derived($slideshowState === SlideshowState.PlaySlideshow);
  // The same gates as the menu's and the shared link's Play slideshow: never Locked, downloads on a link.
  const canPlay = $derived(canNavigateCollection && canPlaySlideshow(asset));
  const zoom = $derived(assetViewerManager.zoom);
  const lookingAround = $derived(!assetViewerManager.isPanoramaFlattened);
  const fullscreenEnabled = typeof document !== 'undefined' && !!document.fullscreenEnabled;

  const togglePlay = () => {
    assetViewerManager.animatedZoom(1);
    slideshowState.set(playing ? SlideshowState.PauseSlideshow : SlideshowState.PlaySlideshow);
  };

  const setZoom = (value: number) => assetViewerManager.animatedZoom(Math.min(MAX_ZOOM, Math.max(1, value)));
</script>

<footer class="fl-viewer-foot dark" data-testid="viewer-footer">
  <div class="fl-foot-group">
    <button
      type="button"
      class="fl-tool"
      aria-label={playing ? $t('frameleaf_viewer_pause_slideshow') : $t('frameleaf_viewer_play_slideshow')}
      title={playing ? $t('frameleaf_viewer_pause_slideshow_title') : $t('frameleaf_viewer_play_slideshow_title')}
      aria-pressed={playing}
      disabled={!canPlay && !playing}
      onclick={togglePlay}
    >
      <Icon icon={playing ? mdiPause : mdiPlay} size="21" aria-hidden />
    </button>
    {#if position}
      <span class="fl-position" aria-live="polite" data-testid="viewer-position">
        {$t('frameleaf_viewer_position', { values: { index: position.index + 1, total: position.total } })}
      </span>
    {/if}
    <!-- Phones reach the slideshow settings from the More menu; the footer keeps Play, the position and the filmstrip. -->
    <button
      type="button"
      class="fl-tool fl-wide-only"
      aria-label={$t('frameleaf_viewer_slideshow_settings')}
      title={$t('frameleaf_viewer_slideshow_settings')}
      data-slideshow-settings
      aria-expanded={$settingsOpen}
      class:active={$settingsOpen}
      onclick={(event) => slideshowStore.toggleSettings(event.currentTarget)}
    >
      <Icon icon={mdiCogOutline} size="21" aria-hidden />
    </button>
    <button
      type="button"
      class="fl-tool"
      aria-label={$showFilmstrip ? $t('frameleaf_viewer_hide_filmstrip') : $t('frameleaf_viewer_show_filmstrip')}
      title={$showFilmstrip ? $t('frameleaf_viewer_hide_filmstrip_title') : $t('frameleaf_viewer_show_filmstrip_title')}
      aria-pressed={$showFilmstrip}
      class:active={$showFilmstrip}
      disabled={!canShowFilmstrip}
      onclick={() => showFilmstrip.update((value) => !value)}
    >
      <Icon icon={mdiFilmstrip} size="21" aria-hidden />
    </button>
  </div>

  <span class="fl-key-hint" aria-hidden="true">
    {$t('frameleaf_viewer_hint_browse')}
    {#if hasStack}<span>·</span> {$t('frameleaf_viewer_hint_stack')}{/if}
    <span>·</span>
    {$t('frameleaf_viewer_hint_info')} <span>·</span>
    {$t('frameleaf_viewer_hint_close')}
  </span>

  <div class="fl-foot-group">
    {#if isVideoAsset(asset)}
      <div class="fl-segment" role="group" aria-label={$t('frameleaf_viewer_video_source')}>
        <button type="button" aria-pressed={isPlayingOriginalVideo} onclick={() => setPlayOriginalVideo(true)}>
          {$t('frameleaf_viewer_source_original')}
        </button>
        <button
          type="button"
          aria-pressed={!isPlayingOriginalVideo}
          title={$t('frameleaf_viewer_optimized_title')}
          onclick={() => setPlayOriginalVideo(false)}
        >
          {$t('frameleaf_viewer_source_optimized')}
        </button>
      </div>
    {/if}
    {#if isPanorama(asset) && isImageAsset(asset)}
      <button
        type="button"
        class="fl-tool"
        aria-label={lookingAround ? $t('frameleaf_viewer_fit_panorama') : $t('frameleaf_viewer_look_around_panorama')}
        title={lookingAround ? $t('frameleaf_viewer_fit_panorama') : $t('frameleaf_viewer_look_around_panorama')}
        aria-pressed={lookingAround}
        class:active={lookingAround}
        onclick={() => {
          assetViewerManager.resetZoomState();
          assetViewerManager.togglePanoramaView();
        }}
      >
        <Icon icon={lookingAround ? mdiPanoramaVariantOutline : mdiPanorama} size="21" aria-hidden />
      </button>
    {/if}
    {#if zoomable}
      <!-- Pinch and double-tap cover zoom on a phone, so these three stay off its footer. -->
      <span class="fl-zoom">
        <button
          type="button"
          class="fl-tool"
          aria-label={$t('frameleaf_viewer_zoom_out')}
          title={$t('frameleaf_viewer_zoom_out')}
          disabled={zoom <= 1}
          onclick={() => setZoom(zoom / STEP)}
        >
          <Icon icon={mdiMagnifyMinusOutline} size="21" aria-hidden />
        </button>
        <button type="button" class="fl-fit" title={$t('frameleaf_viewer_fit_title')} onclick={() => setZoom(1)}>
          {zoom <= 1
            ? $t('frameleaf_viewer_fit')
            : $t('frameleaf_viewer_percent_of_fit', { values: { percent: Math.round(zoom * 100) } })}
        </button>
        <button
          type="button"
          class="fl-tool"
          aria-label={$t('frameleaf_viewer_zoom_in')}
          title={$t('frameleaf_viewer_zoom_in')}
          disabled={zoom >= MAX_ZOOM}
          onclick={() => setZoom(zoom * STEP)}
        >
          <Icon icon={mdiMagnifyPlusOutline} size="21" aria-hidden />
        </button>
      </span>
    {/if}
    <!-- A browser that cannot go full screen (iPhone Safari) gets no button rather than a dead one. -->
    {#if fullscreenEnabled || fullscreen}
      <button
        type="button"
        class="fl-tool"
        aria-label={fullscreen ? $t('frameleaf_viewer_exit_fullscreen') : $t('frameleaf_viewer_enter_fullscreen')}
        title={fullscreen ? $t('frameleaf_viewer_exit_fullscreen') : $t('frameleaf_viewer_enter_fullscreen')}
        aria-pressed={fullscreen}
        onclick={onToggleFullscreen}
      >
        <Icon icon={fullscreen ? mdiFullscreenExit : mdiFullscreen} size="21" aria-hidden />
      </button>
    {/if}
  </div>
</footer>

<style>
  /* media-viewer.css:750-830, frosted as the header (apple-style.css:383-392). */
  .fl-viewer-foot {
    position: relative;
    isolation: isolate;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: 60px;
    padding: 8px max(18px, env(safe-area-inset-right)) max(8px, env(safe-area-inset-bottom))
      max(18px, env(safe-area-inset-left));
    overflow-x: auto;
    border-top: 1px solid var(--fl-viewer-border);
    color: var(--fl-viewer-text);
  }

  .fl-viewer-foot::before {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    background: color-mix(in srgb, var(--fl-viewer-panel) 60%, transparent);
    backdrop-filter: var(--fl-material-blur);
  }

  .fl-foot-group {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 4px;
  }

  .fl-tool {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    min-width: 38px;
    height: 38px;
    padding: 7px;
    border: 1px solid transparent;
    border-radius: var(--fl-radius-control);
    background: transparent;
    color: inherit;
    cursor: pointer;
  }

  .fl-tool:hover:not(:disabled),
  .fl-fit:hover {
    background: var(--fl-viewer-border);
  }

  .fl-tool.active {
    background: color-mix(in srgb, var(--fl-viewer-text) 12%, transparent);
  }

  .fl-tool:disabled {
    cursor: default;
    opacity: 0.4;
  }

  .fl-tool:focus-visible,
  .fl-fit:focus-visible,
  .fl-segment button:focus-visible {
    outline: 2px solid var(--fl-viewer-focus);
    outline-offset: var(--fl-focus-offset);
  }

  .fl-zoom {
    display: contents;
  }

  .fl-position {
    min-width: 58px;
    color: var(--fl-on-material-muted);
    font-size: var(--fl-font-small);
    font-variant-numeric: var(--fl-numeric);
    text-align: center;
  }

  .fl-key-hint {
    color: var(--fl-on-material-muted);
    font-size: var(--fl-font-micro);
    white-space: nowrap;
    word-spacing: 3px;
  }

  .fl-key-hint span {
    padding: 0 8px;
  }

  .fl-fit {
    min-width: 46px;
    height: 34px;
    padding: 5px 8px;
    border: 0;
    border-radius: var(--fl-radius-control);
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: var(--fl-font-micro);
    font-variant-numeric: var(--fl-numeric);
    cursor: pointer;
  }

  .fl-segment {
    display: inline-flex;
    margin-inline-end: 6px;
    padding: 3px;
    border: 1px solid var(--fl-viewer-border);
    border-radius: var(--fl-radius-control);
  }

  .fl-segment button {
    min-height: 28px;
    padding: 3px 10px;
    border: 0;
    border-radius: var(--fl-radius-sm);
    background: transparent;
    color: var(--fl-on-material-muted);
    font: inherit;
    font-size: var(--fl-font-micro);
    cursor: pointer;
  }

  .fl-segment button[aria-pressed='true'] {
    background: color-mix(in srgb, var(--fl-viewer-text) 14%, transparent);
    color: var(--fl-viewer-text);
  }

  @media (max-width: 760px) {
    .fl-viewer-foot {
      gap: 8px;
      padding-inline: max(10px, env(safe-area-inset-left)) max(10px, env(safe-area-inset-right));
    }

    .fl-key-hint {
      display: none;
    }
  }

  @media (max-width: 700px) {
    .fl-viewer-foot {
      overflow-x: visible;
    }

    .fl-tool {
      min-width: var(--fl-control-height);
      height: var(--fl-control-height);
    }

    /* One row that fits a 320px phone: Play, the position and the filmstrip, then what the item needs. */
    .fl-zoom,
    .fl-wide-only {
      display: none;
    }

    .fl-segment button {
      min-height: 36px;
    }
  }

  /* Touch: every footer control, the video source segment included, is a 44px target. */
  @media (pointer: coarse) {
    .fl-tool {
      min-width: var(--fl-control-height);
      height: var(--fl-control-height);
    }

    .fl-fit {
      height: var(--fl-control-height);
    }

    .fl-segment {
      padding: 0;
    }

    .fl-segment button {
      min-height: var(--fl-control-height);
      padding-inline: 12px;
      border-radius: var(--fl-radius-control);
    }
  }

  @media (prefers-contrast: more), (prefers-reduced-transparency: reduce) {
    .fl-viewer-foot::before {
      background: var(--fl-viewer-panel);
      backdrop-filter: none;
    }
  }
</style>
