<script lang="ts">
  import { Icon } from '@frameleaf/ui';
  import { mdiAlertCircleOutline } from '@mdi/js';
  import type { Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * The library status bar (FL-33), ported from `footer.bottom-bar` in
   * `design/frameleaf/template/src/App.jsx` and apple-style.css "floating capsule toolbar".
   *
   * It only appears where photos are browsed (library, person and partner views, September 24
   * polish pass), and it says only what the page does not already show:
   *
   * - "128 of 4,210 items" while a filter narrows the view. Unfiltered, the count is in the results
   *   toolbar above the photos and is not repeated here.
   * - Selected items these results do not show, when there are any. The selected count itself is on
   *   the selection bar, which takes this bar's place while anything is selected.
   * - That this device could not keep the view. When it could, nothing is said.
   *
   * With none of those and no controls it is not drawn at all. Compare, Quick edit and Open in
   * Studio are not here; they live on the selection bar. On phones the tab bar replaces it.
   *
   * `controls` is the trailing slot for the Thumbnail size control (Packet 2i).
   */
  type Props = {
    /** Items these results show, when known. */
    count: number | null;
    /** Items in the whole scope (library, person, partner) before any filter, when known. */
    total?: number | null;
    /** Selected items these results do not show. */
    outside?: number;
    /** Whether the view state was kept on this device (`LibrarySessionStore.persist`). */
    saved: boolean;
    /** Steps aside while the selection bar is open. */
    hidden?: boolean;
    controls?: Snippet;
  };

  let { count, total = null, saved, hidden = false, outside = 0, controls }: Props = $props();

  const filtered = $derived(count !== null && total !== null && total !== count);
  const hasText = $derived(filtered || outside > 0 || !saved);
</script>

{#if hasText || controls}
  <footer
    class="fl-status-bar"
    class:is-hidden={hidden}
    aria-hidden={hidden}
    inert={hidden}
    data-testid="library-status-bar"
  >
    {#if filtered || outside > 0}
      <span class="fl-status-counts" aria-live="polite">
        {#if filtered}
          <!-- Keyed on the text, so a new count fades in rather than snapping. -->
          {#key `${count}/${total}`}
            <span class="fl-reveal">{$t('frameleaf_status_items_of', { values: { count, total } })}</span>
          {/key}
        {/if}
        {#if outside > 0}
          {#if filtered}<i aria-hidden="true"></i>{/if}
          {$t('frameleaf_status_selected_outside', { values: { count: outside } })}
        {/if}
      </span>
    {/if}
    {#if !saved}
      <span class="fl-status-saved" role="status" title={$t('frameleaf_status_not_saved_help')}>
        <Icon icon={mdiAlertCircleOutline} size="13" aria-hidden={true} />
        {$t('frameleaf_status_not_saved')}
      </span>
    {/if}
    {@render controls?.()}
  </footer>
{/if}

<style>
  /* apple-style.css: the library bar floats as a frosted capsule centred over the photos. */
  .fl-status-bar {
    position: fixed;
    left: calc(var(--fl-left, 0px) + 12px);
    right: calc(var(--fl-right, 0px) + 12px);
    bottom: max(18px, var(--fl-safe-bottom, 0px));
    z-index: 25;
    display: flex;
    align-items: center;
    gap: var(--fl-space-4);
    width: fit-content;
    max-width: calc(100vw - var(--fl-left, 0px) - var(--fl-right, 0px) - 24px);
    min-height: 52px;
    margin-inline: auto;
    padding: 4px 18px;
    border: 1px solid var(--fl-material-edge);
    border-radius: var(--fl-radius-capsule);
    background: var(--fl-material);
    -webkit-backdrop-filter: var(--fl-material-blur);
    backdrop-filter: var(--fl-material-blur);
    box-shadow: var(--fl-shadow-3);
    color: var(--fl-text);
    font-size: var(--fl-font-callout);
    transition:
      opacity var(--fl-duration-fade) var(--fl-ease),
      translate var(--fl-duration-dock) var(--fl-spring);
  }
  /* "#1 one toolbar": the library bar steps aside while the selection bar is open. */
  .fl-status-bar.is-hidden {
    opacity: 0;
    translate: 0 12px;
    pointer-events: none;
  }
  @media (prefers-contrast: more), (prefers-reduced-transparency: reduce) {
    .fl-status-bar {
      -webkit-backdrop-filter: none;
      backdrop-filter: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .fl-status-bar,
    .fl-status-bar.is-hidden {
      translate: none;
      transition: opacity var(--fl-duration-reduced) var(--fl-ease) !important;
    }
  }
  .fl-status-counts {
    color: var(--fl-on-material-muted);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .fl-status-counts i {
    margin: 0 12px;
    border-inline-start: 1px solid var(--fl-material-edge);
  }
  .fl-status-saved {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
    color: var(--fl-text);
    font-size: var(--fl-font-small);
    white-space: nowrap;
  }
  .fl-status-saved :global(svg) {
    color: var(--fl-warning);
  }
  /* On phones the tab bar replaces the library bar. */
  @media (max-width: 700px) {
    .fl-status-bar {
      display: none;
    }
  }
</style>
