<script lang="ts">
  import type { Snippet } from 'svelte';
  let { label, children }: { label: string; children: Snippet } = $props();
</script>

<section aria-label={label}>{@render children()}</section>

<style>
  section {
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-panel-radius);
    min-width: 0;
    padding: 1rem;
  }
</style>
