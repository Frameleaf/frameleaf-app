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
   * The panel itself is not drawn here. A library page docks the template's Filters panel beside its
   * photos (LIB-P1, `LibraryFilterPanel`) through `onOpenFilterPanel`; without a host panel the
   * search palette's Advanced view opens at the chosen section (`requestFilterPanel`).
   */
  import FilterChip from '$lib/components/frameleaf/FilterChip.svelte';
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import { SORT_OPTIONS } from '$lib/components/frameleaf/results-sort';
  import type { DiscoveryFilterSection } from '$lib/components/discovery/query';
  import { activeFilterFields, withoutDiscoveryFilters } from '$lib/components/discovery/query';
  import { pop } from '$lib/frameleaf/motion';
  import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
  import { resolveEntityName } from '$lib/frameleaf/filter-entity-names';
  import { describeFilterFields, filterFieldEntityIds } from '$lib/frameleaf/library-filters';
  import type { LibrarySessionStore } from '$lib/frameleaf/library-session.svelte';
  import type { LibrarySort } from '$lib/frameleaf/library-session';
  import {
    FILTER_PANEL_STATE_EVENT,
    requestFilterPanel,
    requestFilterPanelClose,
    type FilterPanelState,
  } from '$lib/frameleaf/search-shortcuts';
  import { getPerson, type PersonResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiAccountMultipleOutline,
    mdiCalendarRange,
    mdiCheck,
    mdiChevronDown,
    mdiDotsHorizontal,
    mdiEyeOutline,
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
    /** Grid or List (prototype "Grid view" / "List view"), in every layout (LIB-P7); undefined draws neither. */
    view?: 'grid' | 'list';
    onViewChange?: (view: 'grid' | 'list') => void;
    /** Open the "More library actions" dialog. */
    onMoreActions?: () => void;
    /** Extra controls (Work's file-name toggle, a page's own) supplied by the host. */
    children?: import('svelte').Snippet;
    /**
     * A page's own choices that narrow what is shown, drawn after the count at the start of the row
     * (the Locked view's reasons, LIB-P2).
     */
    leading?: import('svelte').Snippet;
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
    leading,
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

  let menuOpen = $state(false);
  let filterControl = $state<HTMLDivElement>();
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
  /** A pet chip names the one pet it narrows by ("Pet: Max"), as a people chip shows its person. */
  let chipPetNames = $state<Record<string, string | null>>({});
  const chipPetId = (chip: (typeof chips)[number]) => {
    const ids = chip.field === 'petIds' && !chip.negated ? filterFieldEntityIds(session.query, chip.field) : null;
    return ids?.length === 1 ? ids[0] : null;
  };
  $effect(() => {
    const chip = chips.find((chip) => chip.field === 'petIds');
    const id = chip ? chipPetId(chip) : null;
    if (!id || asked.has(id)) {
      return;
    }
    asked.add(id);
    const generation = faceGeneration;
    void resolveEntityName('pet', id).then((name) => {
      if (generation === faceGeneration) {
        chipPetNames = { ...chipPetNames, [id]: name };
      }
    });
  });
  onDestroy(
    onLibraryAccessChange(() => {
      faceGeneration++;
      asked.clear();
      chipFaces = {};
      chipPetNames = {};
    }),
  );

  /** FL-707 item 10: the View menu (Information panel). */
  let viewMenuOpen = $state(false);
  let viewControl = $state<HTMLElement>();
  const closeViewMenu = (focus = true) => {
    viewMenuOpen = false;
    if (focus) {
      viewControl?.querySelector<HTMLButtonElement>('.fl-view-button')?.focus();
    }
  };
  $effect(() => {
    if (!viewMenuOpen) {
      return;
    }
    viewControl?.querySelector<HTMLInputElement>('.fl-view-menu input')?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!viewControl?.contains(event.target as Node)) {
        closeViewMenu(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  });

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
    const petId = chipPetId(chip);
    const petName = petId ? chipPetNames[petId] : null;
    if (petName) {
      return $t('frameleaf_library_filter_pet', { values: { name: petName } });
    }
    const name = $t(chip.labelKey);
    const base = chip.negated ? $t('frameleaf_library_filter_not', { values: { name } }) : name;
    if (chip.count > 1) {
      return `${base} (${chip.count})`;
    }
    const detail = chip.detailText ? $t(chip.detailText.key, { values: chip.detailText.values }) : chip.detail;
    return detail ? `${base}: ${detail}` : base;
  };

  /** Prototype "Clear all": the search text and every filter. */
  const clearAll = () => session.setQuery({ ...withoutDiscoveryFilters(session.query), text: '' });

  $effect(() => {
    if (!menuOpen) {
      return;
    }
    menu?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    // Prototype App.jsx: dismiss without intercepting the next control's pointer/click.
    const onPointerDown = (event: PointerEvent) => {
      if (!filterControl?.contains(event.target as Node)) {
        closeMenu(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
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

    {#if leading}
      <div class="fl-toolbar-leading">{@render leading()}</div>
    {/if}

    <div class="fl-filter" bind:this={filterControl}>
      <button
        type="button"
        class="fl-filter-button"
        class:is-active={filterCount > 0}
        class:is-open={filterOpen}
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
          class="fl-filter-menu fl-pop"
          role="menu"
          out:pop
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
      {/if}
    </div>

    {#if onSlideshow}
      <button type="button" class="fl-tool" title={$t('slideshow')} disabled={count === 0} onclick={onSlideshow}>
        <Icon icon={mdiPlayBoxOutline} size="16" />
        {$t('slideshow')}
      </button>
    {/if}

    {#if inspectorOpen !== undefined && onToggleInspector}
      <!--
        FL-707 item 10: a labelled "View" menu in place of the unlabelled sliders icon, holding the
        Information panel switch. Thumbnail size stays in the floating bar (owner, 2026-10-30).
      -->
      <span class="fl-slot fl-slot-info">
        <span class="fl-view" bind:this={viewControl}>
          <button
            type="button"
            class="fl-tool fl-view-button"
            class:is-open={viewMenuOpen}
            aria-haspopup="true"
            aria-expanded={viewMenuOpen}
            title={$t('frameleaf_library_view_menu')}
            onclick={() => (viewMenuOpen = !viewMenuOpen)}
          >
            <Icon icon={mdiEyeOutline} size="16" aria-hidden />
            {$t('frameleaf_library_view')}
            <Icon icon={mdiChevronDown} size="16" aria-hidden />
          </button>
          {#if viewMenuOpen}
            <!-- Escape closes the menu and returns to View, as the filter menu does. -->
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <div
              class="fl-view-menu fl-pop"
              role="group"
              aria-label={$t('frameleaf_library_view_menu')}
              out:pop
              onkeydown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  closeViewMenu();
                }
              }}
            >
              <label class="fl-view-row">
                <span>{$t('frameleaf_library_information_panel')}</span>
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={$t(inspectorOpen ? 'frameleaf_work_inspector_hide' : 'frameleaf_work_inspector_show')}
                  checked={inspectorOpen}
                  onchange={onToggleInspector}
                />
              </label>
            </div>
          {/if}
        </span>
      </span>
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
          {#each SORT_OPTIONS.filter((item) => item.value !== 'quality' || sorts.includes('quality')) as option (option.value)}
            <!-- A sort this view's source cannot apply is listed, not offered. -->
            <option value={option.value} disabled={!sorts.includes(option.value)}>{$t(option.label)}</option>
          {/each}
        </select>
      </label>
    {/if}

    {#if view && onViewChange}
      <span class="fl-slot fl-slot-view">
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
      </span>
    {/if}

    {#if children}
      <span class="fl-slot fl-slot-extra">{@render children()}</span>
    {/if}

    {#if onMoreActions}
      <span class="fl-slot fl-slot-more">
        <IconButton label={$t('frameleaf_library_more_actions')} onclick={onMoreActions}>
          <Icon icon={mdiDotsHorizontal} size="18" aria-hidden />
        </IconButton>
      </span>
    {/if}
  </div>
</div>

<style>
  .fl-toolbar {
    display: grid;
    gap: var(--fl-space-3);
    /* The band spans the page (LIB-P4); its content sits in the page gutter, on the photos' edges. */
    padding: var(--fl-space-3) 0;
  }
  .fl-toolbar-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    /* Controls that wrap to a second line stay with the others at the end of the row. */
    justify-content: flex-end;
    gap: var(--fl-space-2);
  }
  /* Prototype `.result-count`: at the start of the row, the controls at its end. */
  .fl-result-count {
    margin-inline-end: auto;
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
    gap: var(--fl-space-2);
    padding: 0 11px;
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
  /* Template `<Button active={panel === "filters"}>`: pressed while its panel is open. */
  .fl-filter-button.is-open {
    background: var(--fl-raised);
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
    top: calc(100% + var(--fl-space-2));
    margin: 0;
    padding: 6px;
    list-style: none;
    min-width: 200px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-panel-radius);
    background: var(--fl-panel);
    box-shadow: var(--fl-shadow-2);
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
  /* Prototype `label.sort`. */
  .fl-sort {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-1);
    /* The border is the label's, so the label is the control height and the select fills it. */
    min-height: var(--fl-control-height);
    padding-inline-start: 11px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
    color: var(--fl-muted);
  }
  .fl-sort select {
    align-self: stretch;
    min-height: 0;
    border: 0;
    padding: 0 4px;
    background: transparent;
    color: var(--fl-text);
    font-size: var(--fl-font-small, 13px);
    width: auto;
  }
  @media (pointer: coarse) {
    .fl-sort {
      min-height: var(--fl-control-height-touch);
    }
  }
  /* Prototype `.active-filter-bar`. */
  .fl-chips {
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-3);
  }
  .fl-chip-list {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-2);
    min-width: 0;
  }
  .fl-chips-clear {
    flex-shrink: 0;
    /* Its text ends on the line of the last toolbar icon below it. */
    padding: 0 var(--fl-space-3);
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
  /*
   * A narrow library (the information panel open on a laptop): Slideshow is its icon, as it is on
   * phones, so the row of nine controls stays on one line at their full spacing.
   */
  @container fl-timeline (max-width: 860px) {
    .fl-tool {
      justify-content: center;
      min-width: var(--fl-control-height);
      padding: 0;
      font-size: 0;
      gap: 0;
    }
  }
  /* A page's own choices follow the count; the toolbar's controls stay at the end of the row. */
  .fl-result-count:has(+ .fl-toolbar-leading) {
    margin-inline-end: 0;
  }
  .fl-toolbar-leading {
    display: flex;
    min-width: 0;
    margin-inline-end: auto;
  }
  /* A slot only groups a control for the phone layout below; elsewhere its controls sit in the row. */
  .fl-slot {
    display: contents;
  }
  /* FL-707 item 10 (review-1030-library.css `.view-options`): View ▾ and its menu. */
  .fl-view {
    position: relative;
    display: inline-flex;
    align-items: stretch;
  }
  .fl-view-button {
    gap: 6px;
  }
  .fl-view-button.is-open {
    background: var(--fl-raised);
  }
  .fl-view-menu {
    position: absolute;
    z-index: 5;
    inset-inline-end: 0;
    top: calc(100% + var(--fl-space-2));
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-3);
    min-width: 260px;
    padding: 8px 12px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card, 12px);
    background: var(--fl-panel);
    box-shadow: var(--fl-shadow-2);
  }
  .fl-view-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-3);
    min-height: 36px;
    color: var(--fl-text);
    font-size: 13px;
    white-space: nowrap;
    cursor: pointer;
  }
  .fl-view-row input {
    width: 16px;
    height: 16px;
    accent-color: var(--fl-accent);
  }
  /*
   * Phones (LIB-P5, template `styles.css` `@media (max-width: 700px)` `.app .results-toolbar`): two
   * rows on a grid. The count, Filter, Slideshow and More on the first; Sort across the width with
   * Grid and List at its end on the second. Filter and Slideshow are their icons.
   */
  @media (max-width: 700px) {
    .fl-toolbar-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) repeat(3, var(--fl-control-height-touch, 44px));
      gap: var(--fl-space-3) var(--fl-space-2);
      align-items: center;
    }
    .fl-result-count {
      grid-row: 1;
      grid-column: 1;
      margin: 0;
    }
    .fl-filter {
      grid-row: 1;
      grid-column: 2;
    }
    .fl-tool {
      grid-row: 1;
      grid-column: 3;
    }
    .fl-slot-info {
      display: none;
    }
    .fl-slot-more {
      display: flex;
      grid-row: 1;
      grid-column: 4;
    }
    .fl-sort {
      grid-row: 2;
      grid-column: 1 / 3;
      min-width: 0;
    }
    .fl-sort select {
      flex: 1 1 auto;
      width: 100%;
      min-width: 0;
    }
    .fl-slot-view {
      display: flex;
      grid-row: 2;
      grid-column: 3 / 5;
      gap: var(--fl-space-2);
    }
    .fl-toolbar-leading {
      grid-row: 3;
      grid-column: 1 / -1;
      margin: 0;
    }
    /* A page's own controls (Locked's Lock): beside Sort where Grid and List are not offered. */
    .fl-slot-extra {
      display: flex;
      grid-row: 4;
      grid-column: 1 / -1;
      justify-content: flex-end;
      gap: var(--fl-space-2);
    }
    .fl-toolbar-row:not(:has(.fl-slot-view)) .fl-slot-extra {
      grid-row: 2;
      grid-column: 3 / 5;
    }
    /* Nothing of its own to show (Work's file-name toggle is not offered on phones): no empty row. */
    .fl-slot-extra:not(:has(> :global(:not(.fl-file-names-toggle)))) {
      display: none;
    }
    .fl-filter-button,
    .fl-tool {
      justify-content: center;
      min-width: var(--fl-control-height-touch, 44px);
      padding: 0;
      font-size: 0;
      gap: 0;
    }
    .fl-filter-button {
      position: relative;
      border-radius: var(--fl-radius);
      border-inline-end: 1px solid var(--fl-border);
    }
    .fl-filter-button .fl-filter-badge {
      position: absolute;
      top: 2px;
      inset-inline-end: 2px;
      font-size: var(--fl-font-micro, 11px);
    }
    .fl-filter-more {
      display: none;
    }
  }
</style>
