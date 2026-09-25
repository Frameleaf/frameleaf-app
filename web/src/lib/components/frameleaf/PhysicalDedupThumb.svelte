<script lang="ts">
  /**
   * Thumbnail of one asset in the physical deduplication preview (FL-71).
   *
   * The preview record carries an asset id, never pixels. When the server reports `canView`
   * the image is fetched through the ordinary `/assets/{id}/thumbnail` endpoint, which enforces
   * asset access on its own; otherwise a labelled placeholder stands in, so an administrator
   * never sees another account's photo just because it appears in an operational aggregate.
   *
   * A retained original that is no longer on disk (`unavailable`, FL-71 UT-24) is dimmed with the
   * template's "Unavailable" overlay (`PhysicalDedupManager.jsx` `Thumb`, `.pd-thumb-unavailable`).
   */
  import { getAssetMediaUrl } from '$lib/utils';
  import { AssetMediaSize, AssetTypeEnum } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiEyeOffOutline, mdiFileAlertOutline, mdiPlay } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let {
    assetId,
    type,
    canView,
    size = 'copy',
    unavailable = false,
  }: {
    assetId: string;
    type: AssetTypeEnum;
    canView: boolean;
    size?: 'retained' | 'copy' | 'cell';
    unavailable?: boolean;
  } = $props();

  const src = $derived(canView ? getAssetMediaUrl({ id: assetId, size: AssetMediaSize.Thumbnail }) : undefined);
</script>

<span class="thumb {size}" class:hidden-media={!canView} class:unavailable>
  {#if src}
    <img {src} alt="" loading="lazy" draggable="false" />
  {:else}
    <span class="placeholder">
      <Icon icon={mdiEyeOffOutline} size="1.125rem" aria-hidden={true} />
      <span>{$t('frameleaf_dedup_hidden_thumbnail')}</span>
    </span>
  {/if}
  {#if unavailable}
    <span class="unavailable-overlay">
      <Icon icon={mdiFileAlertOutline} size="1.125rem" aria-hidden={true} />
      <span>{$t('frameleaf_dedup_thumb_unavailable')}</span>
    </span>
  {/if}
  {#if type === AssetTypeEnum.Video}
    <span class="kind" aria-label={$t('frameleaf_dedup_video')}>
      <Icon icon={mdiPlay} size="0.875rem" aria-hidden={true} />
    </span>
  {/if}
</span>

<style>
  .thumb {
    position: relative;
    display: block;
    flex-shrink: 0;
    overflow: hidden;
    border-radius: 8px;
    background: var(--fl-raised);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--fl-text), transparent 90%);
  }
  .thumb.retained {
    width: 100%;
    aspect-ratio: 4 / 3;
    border-radius: var(--fl-radius-card);
  }
  .thumb.copy {
    width: 4.5rem;
    height: 4.5rem;
  }
  .thumb.cell {
    width: 2.75rem;
    height: 2.75rem;
    border-radius: var(--fl-radius-control);
  }
  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .placeholder {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    padding: 0.25rem;
    text-align: center;
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
    font-weight: 600;
  }
  .cell .placeholder span,
  .copy .placeholder span,
  .cell .unavailable-overlay span {
    display: none;
  }
  /* The template's `.pd-thumb.unavailable img` and `.pd-thumb-unavailable` (physical-dedup-manager.css). */
  .unavailable img {
    filter: grayscale(1) brightness(0.45);
  }
  .unavailable-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    color: #f3f5f6;
    font-size: var(--fl-font-micro);
    font-weight: 600;
    text-shadow: 0 1px 2px rgb(0 0 0 / 0.6);
  }
  .kind {
    position: absolute;
    inset-inline-start: 0.375rem;
    inset-block-end: 0.375rem;
    display: grid;
    place-items: center;
    width: 1.375rem;
    height: 1.375rem;
    border-radius: 50%;
    background: color-mix(in srgb, #0b0f12, transparent 30%);
    color: #fff;
  }
  .cell .kind {
    width: 1rem;
    height: 1rem;
    inset-inline-start: 0.125rem;
    inset-block-end: 0.125rem;
  }
</style>
