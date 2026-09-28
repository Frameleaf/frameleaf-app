<script lang="ts">
  /**
   * The on-photo "Live" badge (audit V-16), ported from `MediaViewer.jsx:1522-1543` and
   * `.mv-live-badge` (media-viewer.css:478-505): a pill in the photo's top-left corner that plays the
   * Live Photo's motion clip while a mouse hovers it, and toggles it on a tap or press. It drives the
   * existing `assetViewerManager.isPlayingMotionPhoto`, which swaps the still for the clip (the
   * `LiveVideoViewer` in `AssetViewer`), so it replaces the old Play/Stop motion photo toolbar buttons.
   */
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { Icon } from '@immich/ui';
  import { mdiMotionPlayOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  const playing = $derived(assetViewerManager.isPlayingMotionPhoto);
  const setPlaying = (value: boolean) => {
    assetViewerManager.isPlayingMotionPhoto = value;
  };
</script>

<button
  type="button"
  class="fl-live-badge"
  class:playing
  aria-pressed={playing}
  aria-label={playing ? $t('frameleaf_viewer_stop_live_clip') : $t('frameleaf_viewer_play_live_clip')}
  title={$t('frameleaf_viewer_live_badge_title')}
  data-testid="viewer-live-badge"
  onpointerenter={(event) => event.pointerType === 'mouse' && setPlaying(true)}
  onpointerleave={(event) => event.pointerType === 'mouse' && setPlaying(false)}
  onclick={() => setPlaying(!playing)}
>
  <Icon icon={mdiMotionPlayOutline} size="16" aria-hidden />
  {$t('frameleaf_viewer_kind_live')}
</button>

<style>
  .fl-live-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-height: 34px;
    padding: 6px 12px 6px 9px;
    border: 1px solid var(--fl-viewer-border);
    border-radius: var(--fl-radius-pill);
    background: color-mix(in srgb, var(--fl-viewer-panel) 82%, transparent);
    color: var(--fl-viewer-text);
    font: inherit;
    font-size: var(--fl-font-small);
    font-weight: 550;
    letter-spacing: 0.02em;
    cursor: pointer;
    pointer-events: auto;
    transition:
      background-color var(--fl-motion-fast, 150ms) var(--fl-ease, ease),
      color var(--fl-motion-fast, 150ms) var(--fl-ease, ease);
  }

  .fl-live-badge.playing,
  .fl-live-badge:hover {
    background: color-mix(in srgb, var(--fl-teal) 28%, var(--fl-viewer-panel));
    color: #fff;
  }

  @media (prefers-contrast: more), (prefers-reduced-transparency: reduce) {
    .fl-live-badge {
      background: var(--fl-viewer-panel);
    }
  }
</style>
