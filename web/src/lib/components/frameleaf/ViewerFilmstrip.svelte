<script lang="ts">
  /**
   * The viewer filmstrip (FL-35) — client only.
   *
   * It shows the neighbours the caller already holds in memory (a gallery's asset list, or
   * the timeline month around the open asset) and navigates through the caller's own
   * authorized navigation callback. It never fetches a list of its own, so it cannot widen
   * what the signed-in user may see.
   */
  import Thumbnail from '$lib/components/assets/thumbnail/Thumbnail.svelte';
  import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
  import { t } from 'svelte-i18n';

  type Props = {
    assets: TimelineAsset[];
    currentAssetId: string;
    onSelect: (asset: TimelineAsset) => void;
  };

  let { assets, currentAssetId, onSelect }: Props = $props();

  const thumbnailSize = 56;
  let strip = $state<HTMLElement>();

  // Keep the open item in view as the viewer moves through the collection.
  $effect(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    currentAssetId;
    strip?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  });
</script>

{#if assets.length > 1}
  <nav
    bind:this={strip}
    aria-label={$t('frameleaf_viewer_filmstrip')}
    data-testid="viewer-filmstrip"
    class="flex w-full gap-1 overflow-x-auto overflow-y-hidden p-2"
  >
    {#each assets as asset (asset.id)}
      {@const isCurrent = asset.id === currentAssetId}
      <div
        class={['shrink-0 rounded-sm', isCurrent && 'outline-2 outline-white']}
        aria-current={isCurrent ? 'true' : undefined}
      >
        <Thumbnail
          {asset}
          imageClass={isCurrent ? '' : 'brightness-70'}
          brokenAssetClass="text-xs"
          {thumbnailSize}
          onClick={() => !isCurrent && onSelect(asset)}
          readonly
          showStackedIcon={false}
          disableLinkMouseOver
        />
      </div>
    {/each}
  </nav>
{/if}
