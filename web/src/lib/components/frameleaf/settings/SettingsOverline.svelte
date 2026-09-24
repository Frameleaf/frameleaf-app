<script lang="ts">
  /**
   * The one overline every Command Center page heading uses (FL-71, FL-10): the template's
   * `.cc-overline` (command-center.css:190-196, 1600-1619). It names the area's group, or holds the
   * breadcrumb back to the area when a page inside it is open. Area pages, Library analytics and the
   * managers that carry their own heading (Users, Libraries, the Job manager, Utilities) all use it,
   * so there is a single overline style across settings.
   */
  import type { Snippet } from 'svelte';

  let { children }: { children: Snippet } = $props();
</script>

<p class="cc-overline">{@render children()}</p>

<style>
  /* Doubled so a manager's own heading paragraph styles never restyle it. */
  .cc-overline.cc-overline {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 8px;
    color: var(--fl-muted);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 1.3px;
    line-height: 1.4;
    text-transform: uppercase;
  }
  .cc-overline :global(button) {
    padding: 0;
    color: var(--fl-muted);
    background: none;
    border: 0;
    font: inherit;
    letter-spacing: inherit;
    text-transform: inherit;
    cursor: pointer;
  }
  .cc-overline :global(button:hover) {
    color: var(--fl-accent);
  }
  .cc-overline :global(button:focus-visible) {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
  .cc-overline :global(svg) {
    flex-shrink: 0;
    width: 14px;
    height: 14px;
  }
</style>
