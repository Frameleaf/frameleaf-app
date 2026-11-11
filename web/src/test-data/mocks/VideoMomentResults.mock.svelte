<script lang="ts">
  import { moments } from './video-moments.svelte';

  let { found = $bindable(0) }: { query?: string; found?: number } = $props();
  $effect(() => {
    found = moments.found;
  });
</script>
