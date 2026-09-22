<script lang="ts">
  import { libraryLayouts, type LibraryLayout } from '$lib/frameleaf/library-layout';
  let {
    layout,
    collapsed,
    onchange,
    ontoggle,
  }: {
    layout: LibraryLayout;
    collapsed: boolean;
    onchange: (layout: LibraryLayout) => void;
    ontoggle: () => void;
  } = $props();
</script>

<div class="layout-controls">
  <div role="group" aria-label="Library layout">
    {#each libraryLayouts as choice (choice)}
      <button type="button" aria-pressed={layout === choice} onclick={() => onchange(choice)}>
        {choice === 'timeline' ? 'Timeline' : choice === 'browse' ? 'Browse' : 'Work'}
      </button>
    {/each}
  </div>
  {#if layout === 'work'}
    <button type="button" aria-expanded={!collapsed} aria-controls="library-work-inspector" onclick={ontoggle}>
      {collapsed ? 'Show inspector' : 'Hide inspector'}
    </button>
  {/if}
</div>

<style>
  .layout-controls {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.5rem;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--fl-border);
  }
  button {
    min-height: 44px;
    padding: 0.5rem 0.8rem;
    font-size: 0.8rem;
    color: var(--fl-muted);
    border-bottom: 2px solid transparent;
  }
  button[aria-pressed='true'] {
    color: var(--fl-text);
    border-color: var(--fl-accent);
  }
  button:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: -2px;
  }
</style>
