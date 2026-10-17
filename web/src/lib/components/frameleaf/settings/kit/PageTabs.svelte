<script lang="ts" module>
  export type PageTab = { id: string; label: string; href: string };
</script>

<script lang="ts">
  /**
   * The pages of one settings area, side by side under its heading. They are links, so each page
   * has an address, Back works, and the row needs no keyboard contract of its own.
   */
  let { label, tabs, current }: { label: string; tabs: PageTab[]; current: string } = $props();
</script>

<nav class="kit-tabs" aria-label={label}>
  {#each tabs as tab (tab.id)}
    <a href={tab.href} aria-current={tab.id === current ? 'page' : undefined}>{tab.label}</a>
  {/each}
</nav>

<style>
  .kit-tabs {
    display: inline-flex;
    justify-self: start;
    gap: var(--fl-space-1);
    padding: var(--fl-space-1);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  a {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 36px;
    padding: 0 var(--fl-space-4);
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    text-decoration: none;
    border-radius: var(--fl-radius-control);
    transition:
      background-color var(--fl-motion-fast) var(--fl-ease),
      color var(--fl-motion-fast) var(--fl-ease);
  }
  a:hover {
    color: var(--fl-text);
  }
  a[aria-current='page'] {
    color: var(--fl-text);
    font-weight: 600;
    background: var(--fl-panel);
    box-shadow: var(--fl-shadow-1);
  }
  a:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  @container kit (max-width: 620px) {
    .kit-tabs {
      display: flex;
      justify-self: stretch;
    }
    a {
      flex: 1;
      min-height: var(--fl-control-height);
      padding: 0 var(--fl-space-2);
    }
  }
  @media (pointer: coarse) {
    a {
      min-height: var(--fl-control-height);
    }
  }
</style>
