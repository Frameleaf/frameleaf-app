<script lang="ts">
  import type { Snippet } from 'svelte';
  import { albumLibraryFixture } from './album-library-fixture';
  // eslint-disable-next-line no-useless-assignment
  let { timelineManager = $bindable(), children }: { timelineManager?: unknown; children?: Snippet } = $props();
  // eslint-disable-next-line no-useless-assignment
  timelineManager = albumLibraryFixture.manager;
</script>

{@render children?.()}
