<script lang="ts">
  /**
   * The results toolbar: the layout switch and the one Filter control.
   *
   * Ported for FL-33 from the results toolbar in `design/frameleaf/template/src/App.jsx`. The
   * September 22, 2026 revision replaced the in-page search filter row with this: one Filter
   * control carrying a badge while filters are active and a menu that deep-links into a section of
   * the filter panel, and chips that appear only while a filter is active and never restate the
   * destination the results are already shown under.
   *
   * The panel itself is not rebuilt here — `onOpenFilterPanel` hands the chosen section to the
   * existing filter panel, which keeps the full set of controls.
   */
  import FilterChip from '$lib/components/frameleaf/FilterChip.svelte';
  import type { DiscoveryFilterSection } from '$lib/components/discovery/query';
  import { DISCOVERY_FILTER_SECTIONS } from '$lib/components/discovery/query';
  import { describeFilterFields } from '$lib/frameleaf/library-filters';
  import type { LibrarySessionStore } from '$lib/frameleaf/library-session.svelte';
  import type { LibraryLayout } from '$lib/frameleaf/library-session';
  import { Icon } from '@immich/ui';
  import { mdiCheck, mdiFilterOutline, mdiViewComfyOutline, mdiViewDashboardOutline, mdiViewDayOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    session: LibrarySessionStore;
    /** Open the existing filter panel at a section. */
    onOpenFilterPanel?: (section: DiscoveryFilterSection) => void;
    /** Extra controls (sort, grouping, view) supplied by the host. */
    children?: import('svelte').Snippet;
  };

  let { session, onOpenFilterPanel, children }: Props = $props();

  // Timeline precedes Browse and Work.
  const LAYOUT_ORDER: LibraryLayout[] = ['timeline', 'browse', 'work'];
  const LAYOUT_LABELS: Record<LibraryLayout, string> = {
    timeline: 'frameleaf_library_layout_timeline',
    browse: 'frameleaf_library_layout_browse',
    work: 'frameleaf_library_layout_work',
  };
  const LAYOUT_ICONS: Record<LibraryLayout, string> = {
    timeline: mdiViewDayOutline,
    browse: mdiViewComfyOutline,
    work: mdiViewDashboardOutline,
  };
  const SECTION_LABELS: Record<DiscoveryFilterSection, string> = {
    people: 'people',
    date: 'date_and_time',
    places: 'places',
    media: 'media',
    tags: 'tags',
    all: 'frameleaf_library_filter_section_all',
  };

  let menuOpen = $state(false);
  let menuButton = $state<HTMLButtonElement>();

  const filterCount = $derived(session.filterCount);
  const activeSections = $derived(new Set(session.filterSections));
  const chips = $derived(describeFilterFields(session.query, session.chipFields));

  const closeMenu = (focus = true) => {
    menuOpen = false;
    if (focus) {
      menuButton?.focus();
    }
  };

  const chooseSection = (section: DiscoveryFilterSection) => {
    session.openFilterSection(section);
    onOpenFilterPanel?.(section);
    closeMenu();
  };

  const chipLabel = (chip: (typeof chips)[number]) => {
    const name = $t(chip.labelKey);
    const base = chip.negated ? $t('frameleaf_library_filter_not', { values: { name } }) : name;
    if (chip.count > 1) {
      return `${base} (${chip.count})`;
    }
    return chip.detail ? `${base}: ${chip.detail}` : base;
  };
</script>

<svelte:window
  onkeydown={(event) => {
    if (menuOpen && event.key === 'Escape') {
      closeMenu();
    }
  }}
/>

<div class="fl-toolbar" data-testid="frameleaf-results-toolbar">
  <div class="fl-toolbar-row">
    <div class="fl-layouts" role="group" aria-label={$t('frameleaf_library_layout')}>
      {#each LAYOUT_ORDER as layout (layout)}
        <button
          type="button"
          class="fl-layout"
          aria-pressed={session.layout === layout}
          onclick={() => session.setLayout(layout)}
        >
          <Icon icon={LAYOUT_ICONS[layout]} size="16" />
          {$t(LAYOUT_LABELS[layout])}
        </button>
      {/each}
    </div>

    <div class="fl-filter">
      <button
        type="button"
        class="fl-filter-button"
        class:is-active={filterCount > 0}
        bind:this={menuButton}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onclick={() => (menuOpen = !menuOpen)}
      >
        <Icon icon={mdiFilterOutline} size="16" />
        {$t('filter')}
        {#if filterCount > 0}
          <span class="fl-filter-badge" aria-hidden="true">{filterCount}</span>
          <span class="fl-sr">{$t('frameleaf_library_filters_active', { values: { count: filterCount } })}</span>
        {/if}
      </button>

      {#if menuOpen}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <ul class="fl-filter-menu" role="menu" aria-label={$t('filters')}>
          {#each DISCOVERY_FILTER_SECTIONS as section (section)}
            <li role="none">
              <button type="button" role="menuitem" onclick={() => chooseSection(section)}>
                <span class="fl-filter-menu-mark" aria-hidden="true">
                  {#if activeSections.has(section)}
                    <Icon icon={mdiCheck} size="14" />
                  {/if}
                </span>
                {$t(SECTION_LABELS[section])}
              </button>
            </li>
          {/each}
        </ul>
        <!-- Clicking anywhere else closes the menu without stealing the click's own target. -->
        <button
          type="button"
          class="fl-filter-scrim"
          tabindex="-1"
          aria-label={$t('close')}
          onclick={() => closeMenu(false)}
        ></button>
      {/if}
    </div>

    {@render children?.()}
  </div>

  {#if chips.length > 0}
    <!-- Chips exist only while a filter is active. -->
    <div class="fl-chips" data-testid="frameleaf-filter-chips">
      {#each chips as chip (chip.field)}
        <FilterChip
          label={chipLabel(chip)}
          removeLabel={$t('frameleaf_library_remove_filter', { values: { name: chipLabel(chip) } })}
          onRemove={() => session.removeFilter(chip.field)}
        />
      {/each}
      {#if chips.length > 1}
        <button type="button" class="fl-chips-clear" onclick={() => session.clearFilters()}>
          {$t('clear_all')}
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .fl-toolbar {
    display: grid;
    gap: 8px;
    padding: 8px 0;
  }
  .fl-toolbar-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .fl-layouts {
    display: inline-flex;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    overflow: hidden;
  }
  .fl-layout {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 0 10px;
    border: 0;
    background: transparent;
    color: var(--fl-muted);
    font-size: var(--fl-font-size, 14px);
  }
  .fl-layout[aria-pressed='true'] {
    background: var(--fl-raised);
    color: var(--fl-text);
    font-weight: 600;
  }
  .fl-filter {
    position: relative;
  }
  .fl-filter-button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 0 12px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: transparent;
    color: var(--fl-text);
    font-size: var(--fl-font-size, 14px);
  }
  .fl-filter-button.is-active {
    border-color: var(--fl-accent);
  }
  .fl-filter-badge {
    display: inline-grid;
    place-items: center;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: 999px;
    background: var(--fl-accent);
    color: var(--fl-accent-text);
    font-size: var(--fl-font-small, 12px);
    font-weight: 600;
  }
  .fl-filter-menu {
    position: absolute;
    z-index: 5;
    inset-inline-start: 0;
    top: calc(100% + 4px);
    margin: 0;
    padding: 4px;
    list-style: none;
    min-width: 200px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-panel-radius);
    background: var(--fl-panel);
    box-shadow: 0 8px 24px rgb(0 0 0 / 25%);
  }
  .fl-filter-menu button {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 0 8px;
    border: 0;
    border-radius: var(--fl-radius);
    background: transparent;
    color: var(--fl-text);
    text-align: start;
    font-size: var(--fl-font-size, 14px);
  }
  .fl-filter-menu button:hover {
    background: var(--fl-raised);
  }
  .fl-filter-menu-mark {
    display: inline-grid;
    place-items: center;
    width: 14px;
    color: var(--fl-accent);
  }
  .fl-filter-scrim {
    position: fixed;
    inset: 0;
    z-index: 4;
    min-height: 0;
    border: 0;
    background: transparent;
    cursor: default;
  }
  .fl-chips {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .fl-chips-clear {
    border: 0;
    background: transparent;
    color: var(--fl-muted);
    text-decoration: underline;
    font-size: var(--fl-font-small, 12px);
  }
  .fl-sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
