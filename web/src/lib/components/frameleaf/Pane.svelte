<script lang="ts">
  import type { Snippet } from 'svelte';
  let { label, children }: { label: string; children: Snippet } = $props();
</script>

<section aria-label={label}>{@render children()}</section>

<style>
  section {
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    /* The revision sets cards and panels at 10px. */
    border-radius: var(--fl-radius-card);
    min-width: 0;
    padding: 1rem;
  }
</style>
