<script lang="ts">
  import { moments } from './video-moments.svelte';

  let { onFound }: { onFound?: (count: number | undefined) => void } = $props();
  $effect(() => {
    onFound?.(moments.found);
  });
</script>
