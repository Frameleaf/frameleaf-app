<script lang="ts">
  /** The preview histogram (prototype `Histogram`), counted from the rendered preview's pixels. */
  import type { Histogram } from '$lib/frameleaf/raw-develop';
  import { t } from 'svelte-i18n';

  let { bins }: { bins: Histogram | null } = $props();
  const CHANNELS = [
    { channel: 'red', className: 'rde-hist-red' },
    { channel: 'green', className: 'rde-hist-green' },
    { channel: 'blue', className: 'rde-hist-blue' },
    { channel: 'luma', className: 'rde-hist-luma' },
  ] as const;
  const path = (counts: number[], max: number) =>
    `M0 70 ${counts.map((count, index) => `L${(index * 240) / (counts.length - 1)} ${68 - (count / Math.max(1, max)) * 60}`).join(' ')} L240 70Z`;
</script>

<svg class="rde-histogram" viewBox="0 0 240 70" role="img" aria-label={$t('frameleaf_develop_histogram')}>
  {#each [60, 120, 180] as x (x)}<path d={`M${x} 0V70`} class="rde-grid-line" />{/each}
  {#if bins}
    {#each CHANNELS as { channel, className } (channel)}<path
        class={className}
        d={path(bins[channel], bins.max)}
      />{/each}
  {/if}
</svg>
