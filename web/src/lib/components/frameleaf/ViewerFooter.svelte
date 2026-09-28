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
  import type { AssetResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
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
    <button
      type="button"
      class="fl-tool"
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
          {$t('frameleaf_viewer_play_original')}
        </button>
        <button
          type="button"
          aria-pressed={!isPlayingOriginalVideo}
          title={$t('frameleaf_viewer_encoded_rendition')}
          onclick={() => setPlayOriginalVideo(false)}
        >
          {$t('frameleaf_viewer_play_encoded')}
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
    {/if}
    <button
      type="button"
      class="fl-tool"
      aria-label={fullscreen ? $t('frameleaf_viewer_exit_fullscreen') : $t('frameleaf_viewer_enter_fullscreen')}
      title={fullscreen ? $t('frameleaf_viewer_exit_fullscreen') : $t('frameleaf_viewer_enter_fullscreen')}
      aria-pressed={fullscreen}
      disabled={!fullscreenEnabled}
      onclick={onToggleFullscreen}
    >
      <Icon icon={fullscreen ? mdiFullscreenExit : mdiFullscreen} size="21" aria-hidden />
    </button>
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
    border-top: 1px solid #ffffff14;
    color: #f1f1f2;
  }

  .fl-viewer-foot::before {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    background: #1c1c1e99;
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
    border-radius: var(--fl-radius-control, 9px);
    background: transparent;
    color: inherit;
    cursor: pointer;
  }

  .fl-tool:hover:not(:disabled),
  .fl-fit:hover {
    background: #ffffff14;
  }

  .fl-tool.active {
    background: #ffffff1f;
  }

  .fl-tool:disabled {
    cursor: default;
    opacity: 0.4;
  }

  .fl-tool:focus-visible,
  .fl-fit:focus-visible,
  .fl-segment button:focus-visible {
    outline: 2px solid var(--fl-viewer-focus, #a5d4ef);
    outline-offset: 2px;
  }

  .fl-position {
    min-width: 58px;
    color: #c7c7cc;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    text-align: center;
  }

  .fl-key-hint {
    color: #aeaeb2;
    font-size: 11px;
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
    border-radius: var(--fl-radius-control, 9px);
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
  }

  .fl-segment {
    display: inline-flex;
    margin-right: 6px;
    padding: 3px;
    border: 1px solid #ffffff14;
    border-radius: var(--fl-radius-control, 9px);
  }

  .fl-segment button {
    min-height: 28px;
    padding: 3px 10px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: #c7c7cc;
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .fl-segment button[aria-pressed='true'] {
    background: #ffffff24;
    color: #fff;
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
    .fl-tool {
      min-width: 44px;
      height: 44px;
    }
  }

  @media (prefers-contrast: more), (prefers-reduced-transparency: reduce) {
    .fl-viewer-foot::before {
      background: #1c1c1e;
      backdrop-filter: none;
    }
  }
</style>
