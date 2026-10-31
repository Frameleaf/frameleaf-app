<script lang="ts">
  import { Icon } from '@frameleaf/ui';
  import { mdiAlertCircleOutline, mdiCheckCircle } from '@mdi/js';
  import type { Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * The library status bar (FL-33), ported from `footer.bottom-bar` in
   * `design/frameleaf/template/src/App.jsx` and apple-style.css "floating capsule toolbar".
   *
   * It only appears where photos are browsed (library, person and partner views, September 24
   * polish pass). As in the template (LIB-P6) it says how many items the view shows ("128 of
   * 4,210 items" while a filter narrows it), how many are selected and how many of those these
   * results do not show, and whether this device kept the view ("Saved on this device"), then the
   * Thumbnail size control. Compare, Quick edit and Open in Studio are not here; they live on the
   * selection bar, which takes this bar's place while anything is selected. On phones the tab bar
   * replaces it.
   *
   * `controls` is the trailing slot for the Thumbnail size control (Packet 2i).
   */
  type Props = {
    /** Items these results show, when known. */
    count: number | null;
    /** Items in the whole scope (library, person, partner) before any filter, when known. */
    total?: number | null;
    /** Items selected in the session. */
    selected?: number;
    /** Selected items these results do not show. */
    outside?: number;
    /** Whether the view state was kept on this device (`LibrarySessionStore.persist`). */
    saved: boolean;
    /** Steps aside while the selection bar is open. */
    hidden?: boolean;
    controls?: Snippet;
  };

  let { count, total = null, selected = 0, saved, hidden = false, outside = 0, controls }: Props = $props();

  const filtered = $derived(count !== null && total !== null && total !== count);
  const shown = $derived(count ?? total);
</script>

<footer
  class="fl-status-bar"
  class:is-hidden={hidden}
  aria-hidden={hidden}
  inert={hidden}
  data-testid="library-status-bar"
>
  <span class="fl-status-counts" aria-live="polite">
    {#if shown !== null}
      <!-- Keyed on the text, so a new count fades in rather than snapping. -->
      {#key `${count}/${total}`}
        <span class="fl-reveal">
          {filtered
            ? $t('frameleaf_status_items_of', { values: { count, total } })
            : $t('frameleaf_status_items', { values: { count: shown } })}
        </span>
      {/key}
      <i aria-hidden="true"></i>
    {/if}
    {$t('selected_count', { values: { count: selected } })}
    {#if outside > 0}
      {$t('frameleaf_status_outside', { values: { count: outside } })}
    {/if}
  </span>
  <span
    class="fl-status-saved"
    class:is-unsaved={!saved}
    role="status"
    title={saved ? undefined : $t('frameleaf_status_not_saved_help')}
  >
    <Icon icon={saved ? mdiCheckCircle : mdiAlertCircleOutline} size="13" aria-hidden={true} />
    {saved ? $t('frameleaf_status_saved') : $t('frameleaf_status_not_saved')}
  </span>
  {@render controls?.()}
</footer>

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
  /* Template `.saved-label`: muted, with the teal check; a view this device could not keep warns. */
  .fl-status-saved {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
    color: var(--fl-on-material-muted);
    font-size: var(--fl-font-small);
    white-space: nowrap;
  }
  .fl-status-saved :global(svg) {
    color: var(--fl-teal);
  }
  .fl-status-saved.is-unsaved {
    color: var(--fl-text);
  }
  .fl-status-saved.is-unsaved :global(svg) {
    color: var(--fl-warning);
  }
  /* Template `@media (max-width: 1000px)`: a narrow window keeps the counts and the size control. */
  @media (max-width: 1000px) {
    .fl-status-saved:not(.is-unsaved) {
      display: none;
    }
  }
  /* On phones the tab bar replaces the library bar. */
  @media (max-width: 700px) {
    .fl-status-bar {
      display: none;
    }
  }
</style>
