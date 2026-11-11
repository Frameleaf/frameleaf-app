<script lang="ts">
  import type { Snippet } from 'svelte';
  import { libraryItemsFixture } from './library-items-fixture';
  let {
    header,
    onApplied,
  }: {
    header?: Snippet<[number | null, Snippet | undefined]>;
    onApplied?: (action: string, ids: string[]) => void;
  } = $props();
  libraryItemsFixture.onApplied = (action, ids) => onApplied?.(action, ids);
  export const changeDates = (ids: string[]) => libraryItemsFixture.changeDates?.(ids);
</script>

{@render header?.(null, undefined)}
