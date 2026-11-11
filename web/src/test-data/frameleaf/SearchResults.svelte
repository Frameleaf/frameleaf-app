<script lang="ts">
  import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
  import type { Snippet } from 'svelte';
  type Props = {
    assets: TimelineAsset[];
    sections?: { assets: TimelineAsset[]; header: Snippet }[];
    onEndReached: () => void;
  };
  let { assets, sections, onEndReached }: Props = $props();
  let draft = $state('');
</script>

<label>Result draft<input bind:value={draft} /></label>
{#if sections}
  {#each sections as section, index (index)}
    <div data-testid="search-section">
      {@render section.header()}
      {#each section.assets as asset (asset.id)}<span data-testid="search-result">{asset.id}</span>{/each}
    </div>
  {/each}
{:else}
  {#each assets as asset (asset.id)}<span data-testid="search-result">{asset.id}</span>{/each}
{/if}
<button type="button" onclick={onEndReached}>Load more results</button>
