<script lang="ts">
  import LibraryRail from '$lib/components/frameleaf/LibraryRail.svelte';
  import type { Snippet } from 'svelte';

  interface Props {
    // Optional extra content rendered inside the library rail, below the global
    // navigation and above the bottom info (storage/server status). Used by album
    // routes to surface the album tree without replacing the global nav.
    children?: Snippet;
  }

  let { children }: Props = $props();
</script>

<LibraryRail>{@render children?.()}</LibraryRail>
