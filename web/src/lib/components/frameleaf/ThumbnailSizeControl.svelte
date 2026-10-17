<script lang="ts">
  /**
   * The status bar's Thumbnail size control (FL-33), ported from the template's library status bar
   * (`App.jsx` `.thumbnail-control`, `styles.css` 720-729). It sets the per-device size that scales
   * the Browse and Work grids and the Timeline's row height; pinch, Ctrl-scroll and + / − step the
   * same value.
   *
   * Above 1280px it is the slider. Below that the capsule has no room for one, so it becomes a
   * pair of − / + buttons rather than disappearing: zoom stays reachable on a laptop without
   * knowing the gesture. The buttons step through `animateWithin`, so the tiles slide to their new
   * size as they do for a pinch.
   *
   * The status bar belongs to the shell; this is the self-contained control it mounts.
   */
  import {
    stepThumbnailSize,
    THUMBNAIL_SIZE_MAX,
    THUMBNAIL_SIZE_MIN,
    THUMBNAIL_SIZE_STEP,
  } from '$lib/frameleaf/library-grid';
  import { libraryGridPreferences } from '$lib/frameleaf/library-grid-preferences.svelte';
  import { animateFlip } from '$lib/frameleaf/motion';
  import { Icon } from '@frameleaf/ui';
  import { mdiMinus, mdiPlus } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    preferences?: typeof libraryGridPreferences;
    /** The element whose tiles reflow when the size steps; they slide to their new boxes. */
    animateWithin?: () => Element | null | undefined;
  };
  let { preferences = libraryGridPreferences, animateWithin }: Props = $props();

  const step = (direction: 1 | -1) => {
    const next = stepThumbnailSize(preferences.thumbnailSize, direction);
    if (next !== preferences.thumbnailSize) {
      animateFlip(animateWithin?.(), () => (preferences.thumbnailSize = next));
    }
  };
</script>

<div class="fl-thumbnail-size" data-testid="frameleaf-thumbnail-size">
  <label class="fl-thumbnail-slider">
    {$t('frameleaf_library_thumbnail_size')}
    <input
      type="range"
      aria-label={$t('frameleaf_library_thumbnail_size')}
      min={THUMBNAIL_SIZE_MIN}
      max={THUMBNAIL_SIZE_MAX}
      step={THUMBNAIL_SIZE_STEP}
      value={preferences.thumbnailSize}
      oninput={(event) => (preferences.thumbnailSize = Number(event.currentTarget.value))}
    />
  </label>
  <div class="fl-thumbnail-steps" role="group" aria-label={$t('frameleaf_library_thumbnail_size')}>
    <button
      type="button"
      title={$t('frameleaf_library_thumbnail_smaller')}
      aria-label={$t('frameleaf_library_thumbnail_smaller')}
      disabled={preferences.thumbnailSize <= THUMBNAIL_SIZE_MIN}
      onclick={() => step(-1)}
    >
      <Icon icon={mdiMinus} size="18" aria-hidden />
    </button>
    <button
      type="button"
      title={$t('frameleaf_library_thumbnail_larger')}
      aria-label={$t('frameleaf_library_thumbnail_larger')}
      disabled={preferences.thumbnailSize >= THUMBNAIL_SIZE_MAX}
      onclick={() => step(1)}
    >
      <Icon icon={mdiPlus} size="18" aria-hidden />
    </button>
  </div>
</div>

<style>
  .fl-thumbnail-size {
    display: flex;
    align-items: center;
  }
  .fl-thumbnail-slider {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--fl-space-4);
    white-space: nowrap;
  }
  .fl-thumbnail-slider input {
    width: 130px;
    accent-color: var(--fl-accent);
  }
  .fl-thumbnail-steps {
    display: none;
    align-items: center;
    gap: var(--fl-space-half);
  }
  .fl-thumbnail-steps button {
    display: grid;
    place-items: center;
    min-width: var(--fl-control-height);
    min-height: var(--fl-control-height);
    border-radius: var(--fl-radius-control);
    color: var(--fl-text);
  }
  .fl-thumbnail-steps button:hover:not(:disabled) {
    background: color-mix(in srgb, var(--fl-text) 10%, transparent);
  }
  .fl-thumbnail-steps button:disabled {
    opacity: 0.4;
  }
  /* Template styles.css 1340 dropped the control below 1280px; the steps take its place. */
  @media (max-width: 1280px) {
    .fl-thumbnail-slider {
      display: none;
    }
    .fl-thumbnail-steps {
      display: flex;
    }
  }
</style>
