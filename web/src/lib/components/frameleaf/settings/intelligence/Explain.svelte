<script lang="ts">
  /** The sentence at the top of an Advanced section that explains its terms ("A “model” is…"). */
  import type { Snippet } from 'svelte';

  let { children }: { children: Snippet } = $props();
</script>

<p class="explain">{@render children()}</p>

<style>
  .explain {
    margin: var(--fl-space-2) 0 var(--fl-space-3);
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    line-height: 1.5;
  }
</style>
