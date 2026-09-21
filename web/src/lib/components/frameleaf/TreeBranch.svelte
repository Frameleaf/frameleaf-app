<script lang="ts">
  import type { Snippet } from 'svelte';
  let { label, open = $bindable(false), children }: { label: string; open?: boolean; children: Snippet } = $props();
</script>

<details bind:open>
  <summary>{label}</summary>
  <div>{@render children()}</div>
</details>

<style>
  summary {
    align-content: center;
    padding: 0.25rem 0.5rem;
    border-radius: var(--fl-radius);
  }
  div {
    padding-inline-start: 1rem;
    border-inline-start: 1px solid var(--fl-border);
  }
</style>
