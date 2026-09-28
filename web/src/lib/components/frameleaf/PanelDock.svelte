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
  .fl-panel-dock {
    position: fixed;
    inset-block-end: 1.25rem;
    inset-inline-end: 1.25rem;
    z-index: 60;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.75rem;
    pointer-events: none;
  }
  @media (max-width: 640px) {
    .fl-panel-dock {
      inset-inline: 0.75rem;
      align-items: stretch;
    }
  }
</style>
