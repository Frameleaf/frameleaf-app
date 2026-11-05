<script lang="ts">
  import type { AssetResponseDto } from '@frameleaf/sdk';

  // Stands in for `AssetViewer`: shows the item it is on and steps to the next one it was given.
  let {
    cursor,
    showNavigation,
    onNavigateToAsset,
  }: {
    cursor: { current: AssetResponseDto; nextAsset?: AssetResponseDto };
    showNavigation?: boolean;
    onNavigateToAsset: (asset: AssetResponseDto) => Promise<void>;
  } = $props();
</script>

<output data-testid="viewer-current">{cursor.current.id}</output>
{#if showNavigation && cursor.nextAsset}
  <button type="button" onclick={() => onNavigateToAsset(cursor.nextAsset!)}>Next</button>
{/if}
