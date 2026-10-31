<script lang="ts">
  /**
   * A heading inside the viewer's More menu (FL-35).
   *
   * It is a presentational row in the menu's `<ul>`, so it is skipped by the menu's
   * roving focus and never announced as a choice. The caller only renders it when the
   * group it heads has at least one visible entry.
   */
  type Props = {
    text: string;
    /** Hairline above every group but the first. */
    divided?: boolean;
  };

  let { text, divided = false }: Props = $props();
</script>

<li role="presentation" class="fl-viewer-menu-label" class:divided>
  {text}
</li>

<style>
  /* .mv-menu-label and the hairline between groups (media-viewer.css:149-160). */
  .fl-viewer-menu-label {
    padding: 8px 12px 4px;
    color: var(--fl-viewer-muted);
    font-size: var(--fl-font-micro);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    user-select: none;
  }

  .fl-viewer-menu-label.divided {
    margin-top: 4px;
    padding-top: 12px;
    border-top: 1px solid var(--fl-viewer-border);
  }
</style>
