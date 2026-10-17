<script lang="ts">
  import type { Snippet } from 'svelte';
  import { getMapLibreStubMap } from './map-libre-stub';

  // eslint-disable-next-line no-useless-assignment
  let { map = $bindable(undefined), children }: { map?: unknown; children?: Snippet<[{ map: unknown }]> } = $props();
  map = getMapLibreStubMap();
</script>

{@render children?.({ map })}
