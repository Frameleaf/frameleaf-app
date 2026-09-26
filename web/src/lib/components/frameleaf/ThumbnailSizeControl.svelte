<script lang="ts">
  /**
   * The status bar's Thumbnail size control (FL-33), ported from the template's library status bar
   * (`App.jsx` `.thumbnail-control`, `styles.css` 720-729). It sets the per-device size that scales
   * the Browse and Work grids and the Timeline's row height; pinch, Ctrl-scroll and + / − step the
   * same value.
   *
   * The status bar belongs to the shell; this is the self-contained control it mounts.
   */
  import { THUMBNAIL_SIZE_MAX, THUMBNAIL_SIZE_MIN, THUMBNAIL_SIZE_STEP } from '$lib/frameleaf/library-grid';
  import { libraryGridPreferences } from '$lib/frameleaf/library-grid-preferences.svelte';
  import { t } from 'svelte-i18n';

  type Props = { preferences?: typeof libraryGridPreferences };
  let { preferences = libraryGridPreferences }: Props = $props();
</script>

<label class="fl-thumbnail-size" data-testid="frameleaf-thumbnail-size">
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

<style>
  .fl-thumbnail-size {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 16px;
    white-space: nowrap;
  }
  .fl-thumbnail-size input {
    width: 130px;
    accent-color: var(--fl-accent);
  }
  /* Template styles.css 1340: the status bar drops the control below 1280px. */
  @media (max-width: 1280px) {
    .fl-thumbnail-size {
      display: none;
    }
  }
</style>
