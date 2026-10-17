<script lang="ts">
  /**
   * The library's docked Filters panel (LIB-P1), as the template opens it beside the photos
   * (`App.jsx` `panel === "filters"` → `FilterPanel.jsx`, styles.css `.filter-panel`): 318px at the
   * page's end edge, the grid updating beside it as each choice is made.
   *
   * The controls are the one Frameleaf `FilterPanel`; this loads what it lists (people, pets, tags,
   * albums, places, cameras) and the live counts beside each choice for the search the page stands
   * for, and docks it. The host decides what a change does (`onChange`). On phones the panel lies
   * over the photos from the end edge rather than squeezing them.
   */
  import FilterPanel from '$lib/components/frameleaf/FilterPanel.svelte';
  import SearchSaveDialog from '$lib/components/frameleaf/SearchSaveDialog.svelte';
  import type { DiscoveryFilterSection, DiscoveryQuery } from '$lib/components/discovery/query';
  import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
  import {
    emptyFilterPanelOptions,
    loadEnrichmentCounts,
    loadFilterPanelOptions,
    loadPaletteFacets,
  } from '$lib/frameleaf/search-options';
  import { paletteSearchBody, type PaletteFacets } from '$lib/frameleaf/search-palette';
  import { ImageEnrichmentFilter } from '@frameleaf/sdk';
  import { onDestroy } from 'svelte';

  type Props = {
    /** The query the controls show and edit: the page's session query. */
    query: DiscoveryQuery;
    /** The same narrowed to the page's own scope, which the counts beside each choice are for. */
    countQuery: DiscoveryQuery;
    section?: DiscoveryFilterSection;
    /** Already translated, e.g. "18 matching". */
    matchingLabel?: string;
    /** Already translated name of what is filtered, e.g. "Library". */
    scopeLabel?: string;
    /** How many items match, for "Save search" (a smart album collects them). */
    count?: number | null;
    onChange: (query: DiscoveryQuery) => void;
    onClose: () => void;
  };

  let {
    query,
    countQuery,
    section = 'people',
    matchingLabel,
    scopeLabel,
    count = null,
    onChange,
    onClose,
  }: Props = $props();

  /** The template's "Save preset": the search this page and its filters stand for, saved or as a smart album. */
  let saving = $state(false);

  const ENRICHMENT = Object.values(ImageEnrichmentFilter);
  const COUNT_DEBOUNCE_MS = 250;

  let options = $state.raw(emptyFilterPanelOptions());
  let facets = $state.raw<PaletteFacets>({});
  let enrichmentCounts = $state.raw<Partial<Record<ImageEnrichmentFilter, number>>>({});
  /** Bumped when access changes (locked, unlocked, another account): everything is asked again. */
  let generation = $state(0);

  $effect(() => {
    void generation;
    const controller = new AbortController();
    loadFilterPanelOptions(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          options = result;
        }
      })
      .catch(() => {
        // Aborted: the panel closed or access changed.
      });
    return () => controller.abort();
  });

  const countKey = $derived(JSON.stringify(paletteSearchBody(countQuery)));
  $effect(() => {
    const key = countKey;
    void generation;
    const controller = new AbortController();
    const { signal } = controller;
    const timer = setTimeout(() => {
      const body = JSON.parse(key);
      loadPaletteFacets(body, signal)
        .then((result) => !signal.aborted && (facets = result))
        .catch(() => !signal.aborted && (facets = {}));
      loadEnrichmentCounts(body, ENRICHMENT, signal)
        .then((result) => !signal.aborted && (enrichmentCounts = result))
        .catch(() => !signal.aborted && (enrichmentCounts = {}));
    }, COUNT_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  });

  onDestroy(
    onLibraryAccessChange(() => {
      options = emptyFilterPanelOptions();
      facets = {};
      enrichmentCounts = {};
      generation++;
    }),
  );
</script>

<!-- Escape inside the panel closes it, unless a list inside it used the key first. -->
<div
  class="fl-library-filters"
  data-testid="library-filter-panel"
  role="presentation"
  onkeydown={(event) => {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  }}
>
  <FilterPanel
    {query}
    {options}
    {section}
    {matchingLabel}
    {scopeLabel}
    {facets}
    {enrichmentCounts}
    {onChange}
    {onClose}
    onSave={() => (saving = true)}
  />
</div>

{#if saving}
  <SearchSaveDialog bind:open={saving} query={countQuery} defaultName={scopeLabel} {count} />
{/if}

<style>
  /* Template styles.css `.filter-panel`: 318px, a hairline at its start edge, sliding in. */
  .fl-library-filters {
    display: flex;
    flex: 0 0 318px;
    flex-direction: column;
    width: 318px;
    min-height: 0;
    border-inline-start: 1px solid var(--fl-border);
    background: var(--fl-panel);
    animation: fl-filters-in var(--fl-duration-pop, 240ms) var(--fl-ease, ease);
  }
  .fl-library-filters > :global(.filter-panel) {
    flex: 1 1 auto;
    min-height: 0;
  }
  /* The panel's own parts at the template's insets (18px), its list scrolling between them. */
  .fl-library-filters :global(.filter-panel > header) {
    padding: var(--fl-space-4) 18px;
    border-bottom: 1px solid var(--fl-border);
  }
  .fl-library-filters :global(.filter-panel > .scroll) {
    flex: 1 1 auto;
    padding: 0 18px;
  }
  .fl-library-filters :global(.filter-panel > footer) {
    padding: var(--fl-space-3);
  }
  /* Template `.date-range`: From and Through side by side. */
  .fl-library-filters :global(.filter-panel .dates) {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--fl-space-2);
  }
  .fl-library-filters :global(.filter-panel .dates input) {
    min-width: 0;
  }
  @keyframes fl-filters-in {
    from {
      opacity: 0;
      translate: 24px 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .fl-library-filters {
      animation-name: fl-filters-fade;
    }
  }
  @keyframes fl-filters-fade {
    from {
      opacity: 0;
    }
  }
  /* Phones: over the photos from the end edge, leaving a strip of them in view, as the template draws it. */
  @media (max-width: 700px) {
    .fl-library-filters {
      position: absolute;
      inset-block: 0;
      inset-inline-end: 0;
      z-index: 6;
      width: min(318px, calc(100% - 48px));
      box-shadow: var(--fl-shadow-3);
    }
  }
</style>
