<script lang="ts">
  import type { Snippet } from 'svelte';
  import { albumLibraryFixture } from './album-library-fixture';
  // eslint-disable-next-line no-useless-assignment
  let {
    timelineManager = $bindable(),
    children,
    empty,
  }: { timelineManager?: unknown; children?: Snippet; empty?: Snippet } = $props();
  // eslint-disable-next-line no-useless-assignment
  timelineManager = albumLibraryFixture.manager;
</script>

{@render children?.()}
<!-- What the page gives the library to show when it has nothing (FL-1412). -->
{#if empty}<div data-testid="library-empty-slot">{@render empty()}</div>{/if}
