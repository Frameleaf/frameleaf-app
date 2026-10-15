<script lang="ts" module>
  import type { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  export const managers = new Map<string, TimelineManager>();
</script>

<script lang="ts">
  import type TagLibrary from '$lib/components/frameleaf/tags/TagLibrary.svelte';
  import type { ComponentProps } from 'svelte';
  let { node, timelineManager = $bindable() }: ComponentProps<typeof TagLibrary> = $props();
  $effect(() => {
    timelineManager = managers.get(node.id);
  });
</script>
