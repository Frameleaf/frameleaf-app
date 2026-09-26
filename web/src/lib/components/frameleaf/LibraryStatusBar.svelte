<script lang="ts">
  import { Icon } from '@immich/ui';
  import { mdiAlertCircleOutline, mdiCheckCircle } from '@mdi/js';
  import type { Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * The library status bar (FL-33), ported from `footer.bottom-bar` in
   * `design/frameleaf/template/src/App.jsx` and apple-style.css "floating capsule toolbar".
   *
   * It only appears where photos are browsed (library, person and partner views, September 24
   * polish pass): how many items the view shows, how many are selected, and whether this device
   * kept the view. Compare, Quick edit and Open in Studio are not here; they live on the selection
   * bar, which takes this bar's place while anything is selected. On phones the tab bar replaces it.
   *
   * `controls` is the trailing slot for the Thumbnail size control (Packet 2i).
   */
  type Props = {
    /** Items these results show, when known. */
    count: number | null;
    /** Items in the whole scope (library, person, partner) before any filter, when known. */
    total?: number | null;
    selected: number;
    /** Selected items these results do not show. */
    outside?: number;
    /** Whether the view state was kept on this device (`LibrarySessionStore.persist`). */
    saved: boolean;
    /** Steps aside while the selection bar is open. */
    hidden?: boolean;
    controls?: Snippet;
  };

  let { count, total = null, selected, saved, hidden = false, outside = 0, controls }: Props = $props();
</script>

<footer
  class="fl-status-bar"
  class:is-hidden={hidden}
  aria-hidden={hidden}
  inert={hidden}
  data-testid="library-status-bar"
>
  <span class="fl-status-counts">
    {#if count !== null && total !== null && total !== count}
      {$t('frameleaf_status_items_of', { values: { count, total } })}
      <i aria-hidden="true"></i>
    {:else if (count ?? total) !== null}
      {$t('frameleaf_status_items', { values: { count: count ?? total } })}
      <i aria-hidden="true"></i>
    {/if}
    {$t('selected_count', { values: { count: selected } })}
    {#if outside > 0}
      {$t('frameleaf_status_outside', { values: { count: outside } })}
    {/if}
  </span>
  <span class="fl-status-saved" role="status" title={saved ? undefined : $t('frameleaf_status_not_saved_help')}>
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
    gap: 10px;
    width: fit-content;
    max-width: calc(100vw - var(--fl-left, 0px) - var(--fl-right, 0px) - 24px);
    min-height: 52px;
    margin-inline: auto;
    padding: 6px 18px;
    border: 1px solid var(--fl-material-edge);
    border-radius: 18px;
    background: var(--fl-material);
    -webkit-backdrop-filter: blur(28px) saturate(180%);
    backdrop-filter: blur(28px) saturate(180%);
    box-shadow: 0 10px 40px rgb(0 0 0 / 40%);
    color: var(--fl-text);
    font-size: 13px;
    transition:
      opacity 200ms ease,
      translate 420ms var(--fl-spring, ease);
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
      transition: opacity 150ms ease;
    }
  }
  .fl-status-counts {
    color: var(--fl-on-material-muted);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .fl-status-counts i {
    margin: 0 12px;
    border-left: 1px solid var(--fl-material-edge);
  }
  .fl-status-saved {
    display: flex;
    align-items: center;
    gap: 9px;
    margin: 0 0 0 16px;
    color: var(--fl-on-material-muted);
    font-size: 12px;
    white-space: nowrap;
  }
  @media (max-width: 1000px) {
    .fl-status-saved {
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
