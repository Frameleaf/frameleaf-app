<script lang="ts">
  import { moments } from './video-moments.svelte';

  let { found = $bindable() }: { found?: number } = $props();
  $effect(() => {
    found = moments.found;
  });
</script>
