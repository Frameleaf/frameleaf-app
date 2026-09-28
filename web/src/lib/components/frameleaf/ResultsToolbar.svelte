<script lang="ts">
  /**
   * The results toolbar: the result count, the one Filter control, Slideshow, the information-panel
   * toggle, Sort, Grid/List and "More library actions". The layout switch lives in the collection
   * header, as in the prototype (`LibraryLayoutSwitch`).
   *
   * Ported from the results toolbar in `design/frameleaf/template/src/App.jsx` (`.results-toolbar`,
   * `.active-filter-bar`). The September 22, 2026 revision replaced the in-page search filter row
   * with this: one Filter control carrying a badge while filters are active, a separate chevron
   * ("Choose a filter") whose menu deep-links into a section of the filter panel, and chips that
   * appear only while a filter is active and never restate the destination the results are already
   * shown under. A chip's label opens the panel at its own section, and "Clear all" clears the
   * search text and every filter.
   *
   * The panel itself is not rebuilt here. Since September 24 it is the search palette's Advanced
   * view, so `onOpenFilterPanel` (or, without one, `requestFilterPanel`) hands it the chosen section.
   */
  import FilterChip from '$lib/components/frameleaf/FilterChip.svelte';
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import type { DiscoveryFilterSection } from '$lib/components/discovery/query';
  import { activeFilterFields, withoutDiscoveryFilters } from '$lib/components/discovery/query';
  import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
  import { describeFilterFields, filterFieldEntityIds } from '$lib/frameleaf/library-filters';
  import type { LibrarySessionStore } from '$lib/frameleaf/library-session.svelte';
  import type { LibrarySort } from '$lib/frameleaf/library-session';
  import {
    FILTER_PANEL_STATE_EVENT,
    requestFilterPanel,
    requestFilterPanelClose,
    type FilterPanelState,
  } from '$lib/frameleaf/search-shortcuts';
  import { getPerson, type PersonResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import {
    mdiAccountMultipleOutline,
    mdiCalendarRange,
    mdiCheck,
    mdiChevronDown,
    mdiDotsHorizontal,
    mdiFormatListBulleted,
    mdiMagnify,
    mdiMapMarker,
    mdiPlayBoxOutline,
    mdiSort,
    mdiTagOutline,
    mdiTuneVariant,
    mdiViewGridOutline,
  } from '@mdi/js';
  import { onDestroy } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  type Props = {
    session: LibrarySessionStore;
    /** Open the filter panel at a section. Without it the search palette's Advanced view opens. */
    onOpenFilterPanel?: (section: DiscoveryFilterSection) => void;
    /** A host's own filter panel is open; Filter then closes it (prototype Filter toggles the panel). */
    filterPanelOpen?: boolean;
    onCloseFilterPanel?: () => void;
    /** The number of results, or null while it is not known (prototype `.result-count`). */
    count?: number | null;
    /** Start the slideshow over these results. Without it, no Slideshow control is drawn. */
    onSlideshow?: () => void;
    /** Whether the information panel is shown; undefined draws no toggle. */
    inspectorOpen?: boolean;
    onToggleInspector?: () => void;
    /**
     * The sorts this view's source can apply. The toolbar lists the prototype's five; the ones the
     * source cannot order by are shown but not offered. Undefined draws no Sort control.
     */
    sorts?: readonly LibrarySort[];
    /**
     * The sort shown and a handler for a new one, where the page keeps its own (an album's personal
     * viewing sort, FL-31); by default the session's sort.
     */
    sort?: LibrarySort;
    onSortChange?: (sort: LibrarySort) => void;
    /**
     * Conditions the page's grid does not apply (and `text` for a search it cannot run). They get no
     * chip and no count here: a library page shows only what narrows its grid (review M3).
     */
    unappliedFields?: readonly string[];
    /** Grid or List (prototype "Grid view" / "List view"); undefined draws neither, as in the Timeline. */
    view?: 'grid' | 'list';
    onViewChange?: (view: 'grid' | 'list') => void;
    /** Open the "More library actions" dialog. */
    onMoreActions?: () => void;
    /** Extra controls (Work's file-name toggle, a page's own) supplied by the host. */
    children?: import('svelte').Snippet;
  };

  let {
    session,
    onOpenFilterPanel,
    filterPanelOpen,
    onCloseFilterPanel,
    count = null,
    onSlideshow,
    inspectorOpen,
    onToggleInspector,
    sorts,
    sort,
    onSortChange,
    unappliedFields = [],
    view,
    onViewChange,
    onMoreActions,
    children,
  }: Props = $props();

  /** The prototype's "Choose a filter" menu, in its order (`App.jsx`); Pets live under All filters. */
  const MENU_SECTIONS: DiscoveryFilterSection[] = ['people', 'date', 'places', 'media', 'tags', 'all'];
  const SECTION_LABELS: Record<DiscoveryFilterSection, Translations> = {
    people: 'people',
    pets: 'frameleaf_pets_title',
    date: 'date',
    places: 'places',
    media: 'media',
    tags: 'tags',
    all: 'frameleaf_library_filter_section_all',
  };
  // Prototype filter menu icons (`App.jsx` "Choose a filter").
  const SECTION_ICONS: Record<DiscoveryFilterSection, string> = {
    people: mdiAccountMultipleOutline,
    pets: mdiAccountMultipleOutline,
    date: mdiCalendarRange,
    places: mdiMapMarker,
    media: mdiPlayBoxOutline,
    tags: mdiTagOutline,
    all: mdiTuneVariant,
  };
  /** The prototype's five sorts, in its order (`App.jsx` "Sort assets"). */
  const SORT_OPTIONS: { value: LibrarySort; label: Translations }[] = [
    { value: 'captured-desc', label: 'frameleaf_library_sort_captured_newest' },
    { value: 'captured-asc', label: 'frameleaf_library_sort_captured_oldest' },
    { value: 'imported-desc', label: 'frameleaf_library_sort_added_newest' },
    { value: 'filename', label: 'frameleaf_library_sort_filename' },
    { value: 'rating', label: 'frameleaf_library_sort_rating' },
  ];

  let menuOpen = $state(false);
  let menuButton = $state<HTMLButtonElement>();
  let menu = $state<HTMLUListElement>();

  const text = $derived(unappliedFields.includes('text') ? '' : session.query.text.trim());
  const appliedFields = $derived(session.chipFields.filter((field) => !unappliedFields.includes(field)));
  /** The badge counts the search text as one more thing the results are narrowed by (prototype). */
  const filterCount = $derived(
    activeFilterFields(session.query).filter((field) => !unappliedFields.includes(field)).length + (text ? 1 : 0),
  );
  const activeSections = $derived(
    new Set(
      activeFilterFields(session.query)
        .filter((field) => !unappliedFields.includes(field))
        .map((field) => session.sectionForField(field)),
    ),
  );
  const chips = $derived(describeFilterFields(session.query, appliedFields));

  /**
   * FL-29: a people chip carries the person's real face (`App.jsx` chips, `SearchChip` in the palette),
   * with private-evidence handling. Only a single named, visible person is drawn, read through the
   * authorized person endpoint (a person the session may not see answers 403 and draws nothing); a
   * hidden person, a face whose thumbnail stops loading, and every face after a lock, a PIN reset or
   * an account change are dropped at once and never drawn from an earlier answer.
   */
  let chipFaces = $state<Record<string, PersonResponseDto | null>>({});
  const asked = new Set<string>();
  let faceGeneration = 0;
  const chipPersonId = (field: string) => {
    const ids = field === 'personIds' ? filterFieldEntityIds(session.query, field) : null;
    return ids?.length === 1 ? ids[0] : null;
  };
  $effect(() => {
    const id = chips.some((chip) => chip.field === 'personIds' && !chip.negated) ? chipPersonId('personIds') : null;
    if (!id || asked.has(id)) {
      return;
    }
    asked.add(id);
    const generation = faceGeneration;
    void getPerson({ id })
      .then((person) => {
        if (generation === faceGeneration && !person.isHidden) {
          chipFaces = { ...chipFaces, [id]: person };
        }
      })
      .catch(() => {
        // Not readable to this session: the chip keeps its name only.
      });
  });
  const faceFor = (chip: (typeof chips)[number]) => {
    const id = chip.field === 'personIds' && !chip.negated ? chipPersonId(chip.field) : null;
    return id ? (chipFaces[id] ?? undefined) : undefined;
  };
  const dropFace = (chip: (typeof chips)[number]) => {
    const id = chipPersonId(chip.field);
    if (id) {
      chipFaces = { ...chipFaces, [id]: null };
    }
  };
  onDestroy(
    onLibraryAccessChange(() => {
      faceGeneration++;
      asked.clear();
      chipFaces = {};
    }),
  );

  const closeMenu = (focus = true) => {
    menuOpen = false;
    if (focus) {
      menuButton?.focus();
    }
  };

  /** Whether the search palette's filters, opened from here, are showing. */
  let paletteFiltersOpen = $state(false);
  $effect(() => {
    const onState = (event: Event) => {
      paletteFiltersOpen = !!(event as CustomEvent<FilterPanelState>).detail?.open;
    };
    addEventListener(FILTER_PANEL_STATE_EVENT, onState);
    return () => removeEventListener(FILTER_PANEL_STATE_EVENT, onState);
  });
  const filterOpen = $derived(filterPanelOpen ?? paletteFiltersOpen);

  /** Prototype Filter: `panel === "filters" ? setPanel(null) : openFilters(filterSection || "people")`. */
  const toggleFilters = () => {
    if (!filterOpen) {
      openFilters(session.filterSection ?? 'people');
      return;
    }
    if (onCloseFilterPanel) {
      onCloseFilterPanel();
    } else {
      requestFilterPanelClose();
    }
  };

  /** Prototype `openFilters`: remember the section and open the panel there. */
  const openFilters = (section: DiscoveryFilterSection) => {
    session.openFilterSection(section);
    if (onOpenFilterPanel) {
      onOpenFilterPanel(section);
    } else {
      requestFilterPanel(section);
    }
  };

  const chooseSection = (section: DiscoveryFilterSection) => {
    closeMenu(false);
    openFilters(section);
  };

  const chipLabel = (chip: (typeof chips)[number]) => {
    const name = $t(chip.labelKey);
    const base = chip.negated ? $t('frameleaf_library_filter_not', { values: { name } }) : name;
    if (chip.count > 1) {
      return `${base} (${chip.count})`;
    }
    return chip.detail ? `${base}: ${chip.detail}` : base;
  };

  /** Prototype "Clear all": the search text and every filter. */
  const clearAll = () => session.setQuery({ ...withoutDiscoveryFilters(session.query), text: '' });

  $effect(() => {
    if (menuOpen) {
      menu?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    }
  });

  const menuKeydown = (event: KeyboardEvent) => {
    const items = [...(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const focusAt = (next: number) => items[(next + items.length) % items.length]?.focus();
    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        focusAt(index + 1);
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        focusAt(index - 1);
        break;
      }
      case 'Tab': {
        closeMenu(false);
        break;
      }
    }
  };
</script>

<svelte:window
  onkeydown={(event) => {
    if (!menuOpen || event.key !== 'Escape') {
      return;
    }
    event.preventDefault();
    closeMenu();
  }}
/>

<div class="fl-toolbar" data-testid="frameleaf-results-toolbar">
  {#if chips.length > 0 || text}
    <!-- Prototype `.active-filter-bar`: chips exist only while something narrows the results. -->
    <div class="fl-chips" data-testid="frameleaf-filter-chips">
      <div class="fl-chip-list">
        {#if text}
          <FilterChip
            icon={mdiMagnify}
            label={text}
            removeLabel={$t('frameleaf_library_remove_search_text')}
            onRemove={() => session.setQuery({ ...session.query, text: '' })}
          />
        {/if}
        {#each chips as chip (chip.field)}
          <FilterChip
            label={chipLabel(chip)}
            person={faceFor(chip)}
            onUnavailable={() => dropFace(chip)}
            removeLabel={$t('frameleaf_library_remove_filter', { values: { name: chipLabel(chip) } })}
            onOpen={() => openFilters(session.sectionForField(chip.field))}
            onRemove={() => session.removeFilter(chip.field)}
          />
        {/each}
      </div>
      <button type="button" class="fl-chips-clear" onclick={clearAll}>
        {$t('clear_all')}
      </button>
    </div>
  {/if}

  <div class="fl-toolbar-row">
    {#if count !== null}
      <span class="fl-result-count" aria-live="polite" data-testid="frameleaf-result-count">
        {$t('items_count', { values: { count } })}
      </span>
    {/if}
    <span class="fl-grow"></span>

    <div class="fl-filter">
      <button
        type="button"
        class="fl-filter-button"
        class:is-active={filterCount > 0}
        aria-expanded={filterOpen}
        onclick={toggleFilters}
      >
        <Icon icon={mdiTuneVariant} size="16" />
        {$t('filter')}
        {#if filterCount > 0}
          <span class="fl-filter-badge" aria-hidden="true">{filterCount}</span>
          <span class="fl-sr">{$t('frameleaf_library_filters_active', { values: { count: filterCount } })}</span>
        {/if}
      </button>
      <button
        type="button"
        class="fl-filter-more"
        bind:this={menuButton}
        aria-label={$t('frameleaf_library_choose_filter')}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onclick={() => (menuOpen = !menuOpen)}
      >
        <Icon icon={mdiChevronDown} size="16" />
      </button>

      {#if menuOpen}
        <ul
          class="fl-filter-menu"
          role="menu"
          aria-label={$t('frameleaf_library_choose_filter')}
          bind:this={menu}
          onkeydown={menuKeydown}
        >
          {#each MENU_SECTIONS as section (section)}
            <li role="none">
              <button type="button" role="menuitem" onclick={() => chooseSection(section)}>
                <Icon icon={SECTION_ICONS[section]} size="16" />
                <span class="fl-filter-menu-label">{$t(SECTION_LABELS[section])}</span>
                <span class="fl-filter-menu-mark" aria-hidden="true">
                  {#if activeSections.has(section)}
                    <Icon icon={mdiCheck} size="14" />
                  {/if}
                </span>
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

    {#if onSlideshow}
      <button type="button" class="fl-tool" disabled={count === 0} onclick={onSlideshow}>
        <Icon icon={mdiPlayBoxOutline} size="16" />
        {$t('slideshow')}
      </button>
    {/if}

    {#if inspectorOpen !== undefined && onToggleInspector}
      <IconButton
        label={$t(inspectorOpen ? 'frameleaf_work_inspector_hide' : 'frameleaf_work_inspector_show')}
        pressed={inspectorOpen}
        onclick={onToggleInspector}
      >
        <Icon icon={mdiTuneVariant} size="18" aria-hidden />
      </IconButton>
    {/if}

    {#if sorts}
      <label class="fl-sort">
        <Icon icon={mdiSort} size="16" aria-hidden />
        <select
          aria-label={$t('frameleaf_library_sort')}
          value={sort ?? session.state.sort}
          onchange={(event) => {
            const value = event.currentTarget.value as LibrarySort;
            if (onSortChange) {
              onSortChange(value);
            } else {
              session.patchView({ sort: value });
            }
          }}
        >
          {#each SORT_OPTIONS as option (option.value)}
            <!-- A sort this view's source cannot apply is listed, not offered. -->
            <option value={option.value} disabled={!sorts.includes(option.value)}>{$t(option.label)}</option>
          {/each}
        </select>
      </label>
    {/if}

    {#if view && onViewChange}
      <IconButton
        label={$t('frameleaf_library_grid_view')}
        pressed={view === 'grid'}
        onclick={() => onViewChange('grid')}
      >
        <Icon icon={mdiViewGridOutline} size="18" aria-hidden />
      </IconButton>
      <IconButton
        label={$t('frameleaf_library_list_view')}
        pressed={view === 'list'}
        onclick={() => onViewChange('list')}
      >
        <Icon icon={mdiFormatListBulleted} size="18" aria-hidden />
      </IconButton>
    {/if}

    {@render children?.()}

    {#if onMoreActions}
      <IconButton label={$t('frameleaf_library_more_actions')} onclick={onMoreActions}>
        <Icon icon={mdiDotsHorizontal} size="18" aria-hidden />
      </IconButton>
    {/if}
  </div>
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
    gap: 5px;
  }
  .fl-grow {
    flex: 1 1 auto;
  }
  /* Prototype `.result-count`. */
  .fl-result-count {
    margin-inline-start: 6px;
    color: var(--fl-muted);
    font-size: var(--fl-font-small, 12px);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  /* Prototype `.filter-control`: the Filter button and its chevron read as one split control. */
  .fl-filter {
    position: relative;
    display: inline-flex;
    align-items: stretch;
  }
  .fl-filter-button,
  .fl-filter-more,
  .fl-tool {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 0 10px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: transparent;
    color: var(--fl-text);
    font-size: var(--fl-font-size, 14px);
  }
  .fl-filter-button {
    border-start-end-radius: 0;
    border-end-end-radius: 0;
  }
  .fl-filter-more {
    min-width: 30px;
    padding: 0 4px;
    justify-content: center;
    border-inline-start: 0;
    border-start-start-radius: 0;
    border-end-start-radius: 0;
  }
  .fl-filter-button.is-active {
    border-color: var(--fl-accent);
  }
  .fl-tool:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .fl-filter-button:hover,
  .fl-filter-more:hover,
  .fl-tool:hover:not(:disabled) {
    background: var(--fl-raised);
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
    font-size: var(--fl-font-micro, 11px);
    font-weight: 600;
  }
  .fl-filter-menu {
    position: absolute;
    z-index: 5;
    inset-inline-start: 0;
    top: calc(100% + 6px);
    margin: 0;
    padding: 6px;
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
    gap: 10px;
    width: 100%;
    padding: 0 10px;
    border: 0;
    border-radius: var(--fl-radius);
    background: transparent;
    color: var(--fl-text);
    text-align: start;
    font-size: var(--fl-font-size, 14px);
  }
  .fl-filter-menu button:hover,
  .fl-filter-menu button:focus-visible {
    background: var(--fl-raised);
  }
  .fl-filter-menu-label {
    flex: 1 1 auto;
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
  /* Prototype `label.sort`. */
  .fl-sort {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding-inline-start: 9px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
    color: var(--fl-muted);
  }
  .fl-sort select {
    border: 0;
    padding: 0 4px;
    background: transparent;
    color: var(--fl-text);
    font-size: var(--fl-font-small, 13px);
    width: auto;
  }
  /* Prototype `.active-filter-bar`. */
  .fl-chips {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .fl-chip-list {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .fl-chips-clear {
    flex-shrink: 0;
    border: 0;
    background: transparent;
    color: var(--fl-accent);
    font-size: var(--fl-font-small, 12px);
    white-space: nowrap;
  }
  .fl-sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  /* Phones (prototype `@media (max-width: 700px)`): the Filter control is its icon and badge. */
  @media (max-width: 700px) {
    .fl-filter-button {
      font-size: 0;
      gap: 0;
      border-radius: var(--fl-radius);
      border-inline-end: 1px solid var(--fl-border);
    }
    .fl-filter-button .fl-filter-badge {
      font-size: var(--fl-font-micro, 11px);
    }
    .fl-filter-more {
      display: none;
    }
    .fl-tool {
      font-size: 0;
      gap: 0;
    }
  }
</style>
