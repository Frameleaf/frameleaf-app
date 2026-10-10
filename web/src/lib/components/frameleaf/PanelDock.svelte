<script lang="ts">
  import type { Snippet } from 'svelte';

  /**
   * Fixed bottom-end stack for the upload and download panels (FL-45), matching the
   * prototype's `PanelDock` in `design/frameleaf/template/src/UploadPanel.jsx`. The legacy
   * panels docked at opposite corners of the window; the prototype keeps both transfer
   * surfaces together, so this is the one place either panel needs to know where it lives.
   */
  let { children }: { children: Snippet } = $props();
</script>

<div class="fl-panel-dock">
  {@render children()}
</div>

<style>
  /*
   * The dock keeps clear of everything else that lives at the foot of the window: the phone tab
   * bar (`--fl-tabbar-height`, TabBar), the library's information panel (`--fl-dock-right`,
   * LibraryView; an open Studio drawer, StudioHost) and, while a selection is in progress, the
   * selection capsule, which it rises above. A page whose own chrome lives in the same corner
   * publishes `--fl-dock-clearance` on the document root, the height the dock has to rise above:
   * Studio does for its server preview and the comment field at the foot of the Review drawer.
   */
  .fl-panel-dock {
    --fl-dock-lift: 0rem;
    position: fixed;
    inset-block-end: calc(var(--fl-tabbar-height, 0px) + 1.25rem);
    inset-inline-end: calc(var(--fl-dock-right, 0px) + 1.25rem);
    z-index: var(--fl-z-dock);
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.75rem;
    pointer-events: none;
    translate: 0 calc(-1 * (var(--fl-dock-clearance, 0px) + var(--fl-dock-lift)));
    transition: translate var(--fl-duration-dock) var(--fl-spring);
  }
  :global(:root:has(.selection-bar.is-open)) .fl-panel-dock {
    --fl-dock-lift: 4rem;
  }
  @media (prefers-reduced-motion: reduce) {
    /* The dock takes its new place at once. */
    .fl-panel-dock {
      transition: none;
    }
  }
  @media (max-width: 700px) {
    .fl-panel-dock {
      /* `--fl-tabbar-height` already includes the gap above the bar. */
      inset-block-end: calc(var(--fl-tabbar-height, 0.75rem) + 0.25rem);
      inset-inline: 0.75rem;
      align-items: stretch;
    }
  }
</style>
