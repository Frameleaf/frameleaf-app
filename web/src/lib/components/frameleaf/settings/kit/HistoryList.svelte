<script lang="ts">
  /** A plain list of what happened, newest first (see HistoryRow). */
  import type { Snippet } from 'svelte';

  let { children }: { children: Snippet } = $props();
</script>

<ul class="kit-history">{@render children()}</ul>

<style>
  .kit-history {
    margin: 0;
    padding: 0;
    list-style: none;
  }
</style>
