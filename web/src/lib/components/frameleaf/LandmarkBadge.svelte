<script lang="ts">
  /**
   * A landmark's badge (FL-355): its own brand icon in a circle filled with the icon's own background
   * colour, so the two read as one mark; or, when it has no brand icon (or `brand` is off, as on a
   * zoomed-out map), the icon for its kind on the accent colour.
   */
  import { landmarkIconUrl, landmarkKind } from '$lib/frameleaf/landmarks';
  import type { LandmarkIconDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';

  interface Props {
    landmark: { id: string; kind: string; icon?: LandmarkIconDto };
    /** Diameter in pixels. */
    size?: number;
    brand?: boolean;
  }

  let { landmark, size = 24, brand = true }: Props = $props();

  // A brand icon that fails to load (an older server, a pack without it) falls back to the kind icon.
  let failed = $state(false);
  const icon = $derived(brand && !failed ? landmark.icon : undefined);
</script>

{#if icon}
  <span
    class="lm-badge-brand"
    class:lm-tile={icon.tile}
    style="width: {size}px; height: {size}px; background: {icon.background}"
  >
    <img src={landmarkIconUrl(landmark.id)} alt="" loading="lazy" onerror={() => (failed = true)} />
  </span>
{:else}
  <span class="lm-badge-kind" style="width: {size}px; height: {size}px">
    <Icon icon={landmarkKind(landmark.kind).icon} size={String(Math.round(size * 0.62))} aria-hidden="true" />
  </span>
{/if}

<style>
  .lm-badge-brand,
  .lm-badge-kind {
    display: inline-grid;
    flex: none;
    place-items: center;
    overflow: hidden;
    border-radius: 50%;
  }
  .lm-badge-brand {
    box-shadow: 0 0 0 1px rgb(127 127 127 / 28%);
  }
  /* A mark on transparency is drawn small enough that the circle does not clip a square one's corners. */
  .lm-badge-brand img {
    width: 80%;
    height: 80%;
    object-fit: contain;
  }
  .lm-badge-brand.lm-tile img {
    width: 100%;
    height: 100%;
  }
  .lm-badge-kind {
    background: var(--fl-accent);
    color: var(--fl-accent-text);
  }
</style>
