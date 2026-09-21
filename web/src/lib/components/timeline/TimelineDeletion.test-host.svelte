<script lang="ts">
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import type { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import TimelineAssetViewer from './TimelineAssetViewer.svelte';
  let { timelineManager }: { timelineManager: TimelineManager } = $props();
</script>

{#if assetViewerManager.isViewing}
  <TimelineAssetViewer {timelineManager} invisible={false} />
{/if}
