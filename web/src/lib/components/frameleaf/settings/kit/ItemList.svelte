<script lang="ts">
  /** A list where every row has the same shape (see Item). */
  import type { Snippet } from 'svelte';

  let { children }: { children: Snippet } = $props();
</script>

<ul class="kit-items">{@render children()}</ul>

<style>
  .kit-items {
    margin: 0;
    padding: 0;
    list-style: none;
  }
</style>
