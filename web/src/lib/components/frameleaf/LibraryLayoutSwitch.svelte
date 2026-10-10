<script lang="ts" module>
  import type { LibraryLayout } from '$lib/frameleaf/library-session';
  import type { LibrarySessionStore } from '$lib/frameleaf/library-session.svelte';
  import type { Translations } from 'svelte-i18n';

  export const LAYOUT_ORDER: readonly LibraryLayout[] = ['timeline', 'browse', 'work'];
  export const LAYOUT_LABELS: Record<LibraryLayout, Translations> = {
    timeline: 'frameleaf_library_layout_timeline',
    browse: 'frameleaf_library_layout_browse',
    work: 'frameleaf_library_layout_work',
  };

  /**
   * Show a layout. As in the prototype the Timeline opens grouped by day rather than as one "All"
   * group. The new layout dissolves in where it is drawn (`LibraryTimeline`, `dissolveView`).
   */
  export const showLibraryLayout = (session: LibrarySessionStore, layout: LibraryLayout) => {
    session.setLayout(layout);
    if (layout === 'timeline' && session.state.grouping === 'all') {
      session.patchView({ grouping: 'days' });
    }
  };
</script>

<script lang="ts">
  /**
   * Timeline, Browse and Work (FL-33), in the collection header as the prototype places it
   * (`App.jsx` `.collection-header` renders `layoutSwitch` beside the title, not in the results
   * toolbar). Timeline precedes Browse and Work.
   *
   * S-18: the template's `.layout-switch` (styles.css:198-225, 392-399, 1482-1488) is a row of
   * text tabs; the current one reads in the text colour over a 2px underline. The Locked collection
   * offers the Timeline only (`App.jsx` `collection === "Locked" ? ["timeline"]`).
   *
   * The underline slides from the old tab to the new one (sliding-plate.ts). On phones the switch
   * is not drawn: the library's view menu carries the same three choices (`LibraryPhoneMenu`).
   */
  import { slidingPlate } from '$lib/components/timeline/sliding-plate';
  import { t } from 'svelte-i18n';

  let { session, layouts = LAYOUT_ORDER }: { session: LibrarySessionStore; layouts?: readonly LibraryLayout[] } =
    $props();

  const shown = $derived(LAYOUT_ORDER.filter((layout) => layouts.includes(layout)));
  // With a single layout on offer (Locked), that one is current whatever this device last chose.
  const current = $derived(shown.length === 1 ? shown[0] : session.layout);
</script>

<div
  class="fl-layouts"
  role="group"
  aria-label={$t('frameleaf_library_layout')}
  data-testid="frameleaf-layout-switch"
  use:slidingPlate={current}
>
  {#each shown as layout (layout)}
    <button
      type="button"
      class="fl-layout"
      class:fl-current={current === layout}
      aria-pressed={current === layout}
      onclick={() => {
        if (shown.length === 1) {
          return;
        }
        showLibraryLayout(session, layout);
      }}
    >
      {$t(LAYOUT_LABELS[layout])}
    </button>
  {/each}
</div>

<style>
  .fl-layouts {
    position: relative;
    display: flex;
    flex-shrink: 0;
    height: 38px;
    gap: 8px;
  }
  /* One underline that slides to the current tab; Reduce Motion makes it jump. */
  .fl-layouts::after {
    content: '';
    position: absolute;
    bottom: 0;
    left: 6px;
    width: calc(var(--plate-w, 12px) - 12px);
    height: 2px;
    border-radius: 2px;
    background: var(--fl-text);
    translate: var(--plate-x, 0) 0;
    opacity: 0;
  }
  .fl-layouts:global([data-plate-ready])::after {
    opacity: 1;
    transition:
      translate var(--fl-duration-pop) var(--fl-spring),
      width var(--fl-duration-pop) var(--fl-spring);
  }
  .fl-layouts:global([data-plate-ready]) .fl-current::after {
    opacity: 0;
  }
  .fl-layout {
    position: relative;
    padding: 0 15px;
    border: 0;
    background: transparent;
    color: var(--fl-muted);
    white-space: nowrap;
  }
  .fl-layout:hover {
    color: var(--fl-text);
  }
  .fl-current {
    color: var(--fl-text);
  }
  .fl-current::after {
    content: '';
    position: absolute;
    inset-inline: 6px;
    bottom: 0;
    height: 2px;
    border-radius: 2px;
    background: var(--fl-text);
  }
  @media (max-width: 700px) {
    .fl-layouts {
      gap: 0;
    }
    .fl-layout {
      padding: 0 8px;
      font-size: 12px;
    }
  }
</style>
