<script lang="ts">
  import type { Snippet } from 'svelte';
  let {
    label,
    toggleLabel,
    collapsed = $bindable(false),
    children,
  }: {
    label: string;
    toggleLabel: string;
    collapsed?: boolean;
    children: Snippet<[boolean]>;
  } = $props();
</script>

<nav aria-label={label} class:collapsed>
  <button type="button" aria-label={toggleLabel} aria-expanded={!collapsed} onclick={() => (collapsed = !collapsed)}>
    <span aria-hidden="true">{collapsed ? '»' : '«'}</span>
  </button>
  {@render children(collapsed)}
</nav>

<style>
  nav {
    background: var(--fl-panel);
    border-inline-end: 1px solid var(--fl-border);
    width: 15rem;
    max-width: 100%;
    padding: 0.5rem;
  }
  nav.collapsed {
    width: 4rem;
  }
  button {
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    min-width: 44px;
  }
</style>
