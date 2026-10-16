<script lang="ts">
  import { managers } from './tag-timeline-state';
  import type TagLibrary from '$lib/components/frameleaf/tags/TagLibrary.svelte';
  import type { ComponentProps } from 'svelte';
  // The binding is read by the parent page.
  // eslint-disable-next-line no-useless-assignment
  let { node, timelineManager = $bindable() }: ComponentProps<typeof TagLibrary> = $props();
  $effect(() => {
    timelineManager = managers.get(node.id);
  });
</script>
