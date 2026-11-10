<script lang="ts">
  /** Draws whatever grouping control LibraryTimeline hands its header (FL-1391 B1). */
  import LibraryTimeline from '$lib/components/frameleaf/LibraryTimeline.svelte';
  import type { ComponentProps } from 'svelte';

  let props: Omit<ComponentProps<typeof LibraryTimeline>, 'header'> = $props();
</script>

<LibraryTimeline {...props}>
  {#snippet header(groupingControl)}
    <div data-testid="header-slot">{@render groupingControl?.()}</div>
  {/snippet}
</LibraryTimeline>
