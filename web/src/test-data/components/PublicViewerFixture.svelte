<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { SharedLinkResponseDto } from '@frameleaf/sdk';
  import { publicViewState } from './public-view-state';
  let {
    children,
    sharedLink,
    title,
    onUpload,
    onSelectAll,
    options,
    timelineManager = $bindable(),
  }: {
    children?: Snippet;
    sharedLink?: SharedLinkResponseDto;
    title?: string;
    onUpload?: () => void;
    onSelectAll?: () => void;
    options?: { albumId?: string };
    timelineManager?: unknown;
  } = $props();
  $effect.pre(() => {
    if (options && !timelineManager) timelineManager = publicViewState.timeline;
  });
</script>

<div data-timeline-ready={!!timelineManager}>
  {#if sharedLink}
    <output data-testid="public-title">{title}</output>
    <button onclick={onUpload}>Upload</button>
    <button onclick={onSelectAll}>Select all</button>
  {/if}
  {#if options}<output data-testid="album-id">{options.albumId}</output>{/if}
  {@render children?.()}
</div>
