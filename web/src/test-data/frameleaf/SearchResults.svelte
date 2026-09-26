<script lang="ts">
  import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
  let { assets, onEndReached }: { assets: TimelineAsset[]; onEndReached: () => void } = $props();
  let draft = $state('');
</script>

<label>Result draft<input bind:value={draft} /></label>
{#each assets as asset (asset.id)}<span data-testid="search-result">{asset.id}</span>{/each}
<button type="button" onclick={onEndReached}>Load more results</button>
