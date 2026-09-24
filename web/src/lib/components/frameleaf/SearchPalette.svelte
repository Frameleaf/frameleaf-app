<script lang="ts">
  import { goto } from '$app/navigation';
  import FilterPanel from '$lib/components/frameleaf/FilterPanel.svelte';
  import PersonAvatar from '$lib/components/frameleaf/PersonAvatar.svelte';
  import SearchPaletteSide from '$lib/components/frameleaf/SearchPaletteSide.svelte';
  import {
    DISCOVERY_QUERY_PARAMETER,
    discoveryUrl,
    emptyDiscoveryQuery,
    isEmptyDiscoverySearch,
    withDiscoveryEnrichment,
    withDiscoveryFacet,
    withoutDiscoveryFilter,
    type DiscoveryFilterSection,
    type DiscoveryQuery,
  } from '$lib/components/discovery/query';
  import { isCommandQuery, navigationCommands, searchCommands, type CommandItem } from '$lib/frameleaf/command-palette';
  import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
  import { prefersReducedMotion } from '$lib/frameleaf/motion';
  import { describeFilterChips } from '$lib/frameleaf/search-filters';
  import {
    emptyFilterPanelOptions,
    loadEnrichmentCounts,
    loadFilterPanelOptions,
    loadPaletteCount,
    loadPaletteFacets,
    loadPaletteHistogram,
    loadPaletteResults,
    loadPaletteYears,
    type PaletteCount,
  } from '$lib/frameleaf/search-options';
  import {
    buildPaletteCatalog,
    commitCompletedTokens,
    compilePaletteQuery,
    formatScopeCount,
    fromSavedSearch,
    isSmartBody,
    narrowToBar,
    operatorToken,
    PALETTE_ENRICHMENT_FILTERS,
    PALETTE_MODES,
    paletteScopeOf,
    paletteSearchBody,
    parseSearchInput,
    readPaletteState,
    rememberRecentSearch,
    removeSavedSearch,
    SAVED_SEARCH_NAME_LIMIT,
    SEARCH_OPERATORS,
    suggestSearchTokens,
    tokenLabel,
    toSavedSearch,
    upsertSavedSearch,
    withoutPaletteScope,
    withoutTokensForFields,
    withPaletteScope,
    type HistogramUnit,
    type PaletteFacets,
    type PaletteMode,
    type PaletteSearch,
    type PaletteSuggestion,
  } from '$lib/frameleaf/search-palette';
  import '$lib/frameleaf/tokens.css';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { searchStore } from '$lib/stores/search.svelte';
  import { getAssetMediaUrl, handlePromiseError } from '$lib/utils';
  import {
    AssetMediaSize,
    AssetTypeEnum,
    getMyPreferences,
    ImageEnrichmentFilter,
    updateMyPreferences,
    type AssetResponseDto,
    type SavedSearch,
    type SearchHistogramBucketDto,
  } from '@immich/sdk';
  import { Icon, Theme as AppTheme, themeManager } from '@immich/ui';
  import {
    mdiAccountOutline,
    mdiArrowRight,
    mdiBookmarkOutline,
    mdiCalendarRange,
    mdiCameraOutline,
    mdiChevronDown,
    mdiClose,
    mdiContentSaveOutline,
    mdiFolderOutline,
    mdiHeartOutline,
    mdiHelpCircleOutline,
    mdiHistory,
    mdiImageMultipleOutline,
    mdiImageSearchOutline,
    mdiMagnify,
    mdiMapMarker,
    mdiPlayCircleOutline,
    mdiPoundBox,
    mdiTagOutline,
    mdiTextBoxOutline,
    mdiTextRecognition,
    mdiTuneVariant,
  } from '@mdi/js';
  import { onDestroy, untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * The Spotlight-style search palette (FL-49), ported from `design/frameleaf/template/src/SearchPalette.jsx`,
   * `search-palette.mjs` and `search-palette.css` (September 24, 2026 Apple-style refinements).
   *
   * One glass panel: typed operators that become removable chips, typeahead suggestions with counts,
   * live results with a preview, a date histogram that narrows on click, facet refinement, scope counts
   * for the current collection and the entire library, the enrichment quick filters, "Go to" results
   * from the shared command index (a leading ">" hands off to the command palette), recent and saved
   * searches, and an Advanced view that embeds the filter panel. Every count, facet, bar and result is
   * a real, access-scoped server answer for the same structured body the results page sends; nothing is
   * computed from sample data, and answers are dropped whenever the session's access changes, so a count
   * never outlives a lock.
   *
   * Production differences, each for a real contract rather than taste:
   * - The prototype's "Understood" chips come from its sample phrase resolver. Production smart search
   *   interprets text on the server, so that row shows the non-typed filters the search carries instead.
   * - The prototype's note "Sample library…" is replaced by a note in smart mode that facets and the
   *   histogram describe the filters smart search ranks within (their endpoints take no smart text).
   * - "Save search" stores the search in the account's `savedSearches` preference (owner decision,
   *   FL-146) instead of the prototype's local Smart album / snapshot / preset dialog.
   */

  let {
    query: initialQuery,
    commandIndex = [],
    section,
    unsupported = [],
    onClose,
    onCommand,
    onOpenPalette,
  }: {
    query: DiscoveryQuery;
    commandIndex?: CommandItem[];
    /** The filter-panel section a Filter control deep-linked into: opens the Advanced view there. */
    section?: DiscoveryFilterSection;
    /**
     * FL-48: fields of the page's current (legacy) search that the query cannot carry. The palette says
     * so, and submitting without an edit keeps that search rather than a narrower one.
     */
    unsupported?: string[];
    onClose: () => void;
    onCommand?: (command: CommandItem) => void;
    onOpenPalette?: (text: string) => void;
  } = $props();

  const TOP_HITS = 12;
  const INPUT_DEFER_MS = 120;
  const REMOTE_DEBOUNCE_MS = 200;
  const ADVANCED_KEY = 'frameleaf.search.advanced';
  const QUICK_ENRICHMENT = PALETTE_ENRICHMENT_FILTERS.map((item) => item.value);
  const ALL_ENRICHMENT = Object.values(ImageEnrichmentFilter);

  const MODE_ICONS = {
    smart: mdiImageSearchOutline,
    all: mdiMagnify,
    file: mdiImageMultipleOutline,
    description: mdiTextBoxOutline,
    ocr: mdiTextRecognition,
    path: mdiFolderOutline,
  };
  const SUGGESTION_ICONS = {
    person: mdiAccountOutline,
    place: mdiMapMarker,
    tag: mdiTagOutline,
    camera: mdiCameraOutline,
    year: mdiCalendarRange,
    type: mdiImageMultipleOutline,
    is: mdiHeartOutline,
    operator: mdiPoundBox,
  };

  const smartEnabled = $derived(featureFlagsManager.value.smartSearch);
  const modes = $derived(PALETTE_MODES.filter((entry) => entry.value !== 'smart' || smartEnabled));
  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
  const reducedMotion = prefersReducedMotion();
  const listId = $props.id();

  /* ---------------------------------------------------------------------- */
  /* State                                                                   */
  /* ---------------------------------------------------------------------- */

  const opened = untrack(() => readPaletteState(initialQuery));
  /** The collection the page stands for; "Entire library" searches without it. */
  const scope = paletteScopeOf(opened.base);

  let dialog = $state<HTMLDialogElement>();
  let input = $state<HTMLInputElement>();
  let resultsList = $state<HTMLElement>();
  /** Everything the search carries besides the typed text: the scope and graphical picks. */
  let base = $state.raw<DiscoveryQuery>(opened.base);
  let tokens = $state<string[]>([]);
  let text = $state(opened.input);
  // A fresh search starts in smart search, as the prototype's `searchBy` defaults to "semantic"
  let mode = $state<PaletteMode>(
    !opened.input && untrack(() => featureFlagsManager.value.smartSearch) ? 'smart' : opened.mode,
  );
  let scopeChoice = $state<'current' | 'library'>('current');
  let active = $state(-1);
  let modeMenu = $state(false);
  let help = $state(false);
  let saving = $state(false);
  let saveName = $state('');
  let saveError = $state(false);
  // Graphical filters for people who would rather pick than type; remembered per device
  let advanced = $state(readAdvanced() || !!section);

  let options = $state.raw(emptyFilterPanelOptions());
  let catalogFacets = $state.raw<PaletteFacets>({});
  let catalogYears = $state.raw<SearchHistogramBucketDto[]>([]);
  let facets = $state.raw<PaletteFacets>({});
  let histogram = $state.raw<{ unit: HistogramUnit; buckets: SearchHistogramBucketDto[] }>({
    unit: 'month',
    buckets: [],
  });
  let results = $state.raw<AssetResponseDto[]>([]);
  let counts = $state<{ current: PaletteCount | null; library: PaletteCount | null }>({ current: null, library: null });
  let enrichmentCounts = $state.raw<Partial<Record<ImageEnrichmentFilter, number>>>({});
  let loading = $state(false);
  let savedSearches = $state.raw<SavedSearch[]>([]);
  let preferencesRevision = $state<string | undefined>();
  /** Bumped on every access change: everything loaded before it is dropped and loaded again. */
  let generation = $state(0);

  function readAdvanced() {
    try {
      return localStorage.getItem(ADVANCED_KEY) === '1';
    } catch {
      return false;
    }
  }

  const toggleAdvanced = () => {
    advanced = !advanced;
    try {
      localStorage.setItem(ADVANCED_KEY, advanced ? '1' : '0');
    } catch {
      // A per-device convenience only
    }
  };

  /* ---------------------------------------------------------------------- */
  /* Derived search                                                          */
  /* ---------------------------------------------------------------------- */

  const liveInput = $derived([...tokens, text].join(' ').trim());
  // Large libraries: typing stays responsive while the result work trails behind (useDeferredValue)
  let deferredInput = $state(untrack(() => liveInput));
  $effect(() => {
    const value = liveInput;
    const timer = setTimeout(() => (deferredInput = value), INPUT_DEFER_MS);
    return () => clearTimeout(timer);
  });

  const catalog = $derived(buildPaletteCatalog(options, catalogFacets, catalogYears));
  const parsed = $derived(parseSearchInput(deferredInput, catalog));

  const compileFor = (target: DiscoveryQuery) =>
    compilePaletteQuery(target, parsed, mode) ??
    // "All text" cannot be ANDed with a filter's own `or` inside the server's branch limit; the file
    // name is searched instead of widening or dropping the filter
    compilePaletteQuery(target, parsed, 'originalFileName')!;

  const currentQuery = $derived(compileFor(base));
  const libraryQuery = $derived(compileFor(withoutPaletteScope(base, scope)));
  const next = $derived(scopeChoice === 'library' ? libraryQuery : currentQuery);

  const body = $derived(paletteSearchBody(next));
  const smart = $derived(smartEnabled && isSmartBody(body));
  const typing = $derived(text.trim().length > 0 || tokens.length > 0);
  const pending = $derived(deferredInput !== liveInput || loading);

  const selectedCount = $derived(scopeChoice === 'library' ? counts.library : counts.current);
  const otherCount = $derived(scopeChoice === 'library' ? counts.current : counts.library);

  const chips = $derived(parseSearchInput(tokens.join(' '), catalog).tokens);
  const suggestions = $derived<PaletteSuggestion[]>(text.trim() ? suggestSearchTokens(text, catalog, 6) : []);
  // "Go to" reuses the shared command index; a filter being typed ("person:…") is not a destination
  const destinations = $derived(
    text.trim().length >= 2 && !isCommandQuery(text) && !/\S:/.test(text)
      ? searchCommands(navigationCommands(commandIndex), text, 4)
      : [],
  );

  const EXAMPLES: PaletteSearch[] = [
    { input: $t('frameleaf_search_example_smart'), mode: 'smart', query: emptyDiscoveryQuery() },
    { input: $t('frameleaf_search_example_video'), mode: 'smart', query: emptyDiscoveryQuery() },
    { input: $t('frameleaf_search_example_ocr'), mode: 'ocr', query: emptyDiscoveryQuery() },
  ];
  const recent = $derived(searchStore.recentSearches.slice(0, 5));
  const idleSearches = $derived(
    (recent.length > 0 ? recent : EXAMPLES.filter((item) => item.mode !== 'smart' || smartEnabled)).slice(0, 5),
  );
  const saved = $derived(
    savedSearches.flatMap((item) => {
      const search = fromSavedSearch(item);
      return search ? [{ name: item.name, search }] : [];
    }),
  );

  type Entry =
    | { kind: 'suggestion'; item: PaletteSuggestion }
    | { kind: 'asset'; item: AssetResponseDto }
    | { kind: 'destination'; item: CommandItem }
    | { kind: 'recent'; item: PaletteSearch }
    | { kind: 'saved'; item: { name: string; search: PaletteSearch } };

  // One flat list drives arrow-key navigation across every section
  const items = $derived<Entry[]>([
    ...suggestions.map((item) => ({ kind: 'suggestion' as const, item })),
    ...(typing ? results.slice(0, TOP_HITS).map((item) => ({ kind: 'asset' as const, item })) : []),
    ...destinations.map((item) => ({ kind: 'destination' as const, item })),
    ...(typing ? [] : idleSearches.map((item) => ({ kind: 'recent' as const, item }))),
    ...(typing ? [] : saved.map((item) => ({ kind: 'saved' as const, item }))),
  ]);
  const indexOf = (entry: Entry) => items.indexOf(entry);
  const activeEntry = $derived(active >= 0 ? items[active] : undefined);
  const previewAsset = $derived(
    activeEntry?.kind === 'asset' ? activeEntry.item : typing ? (results[0] ?? undefined) : undefined,
  );

  $effect(() => {
    // Any change to what is searched starts the list over, as `setActive(-1)` in the prototype
    void deferredInput;
    void scopeChoice;
    void mode;
    active = -1;
  });

  $effect(() => {
    void active;
    resultsList?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  });

  const modeEntry = $derived(PALETTE_MODES.find((entry) => entry.value === mode) ?? PALETTE_MODES[0]);
  const placeholder = $derived(
    tokens.length > 0
      ? $t('frameleaf_search_placeholder_more')
      : mode === 'smart'
        ? $t('frameleaf_search_placeholder_smart')
        : mode === 'ocr'
          ? $t('frameleaf_search_placeholder_ocr')
          : $t('frameleaf_search_placeholder_mode', { values: { mode: $t(modeEntry.labelKey).toLowerCase() } }),
  );

  /** Scope labels: the collection's own name where the vocabulary has it. */
  const scopeLabel = $derived.by(() => {
    if (!scope) {
      return $t('library');
    }
    if (scope.kind === 'pet') {
      return options.pets.find((pet) => pet.id === scope.id)?.name || $t('frameleaf_pets_title');
    }
    const album = options.albums.find((item) => item.value === scope.id)?.label;
    return album || $t(scope.kind === 'space' ? 'frameleaf_search_kind_space' : 'album');
  });

  /** The non-typed filters the search carries, shown so nothing narrows the search out of sight. */
  const baseChips = $derived.by(() => {
    const scopeless = withoutPaletteScope(next, scope);
    const typed = new Set(parsed.tokens.flatMap((token) => token.fields as string[]));
    return describeFilterChips($t, scopeless, {
      nameFor: (field, id) => {
        if (field === 'personIds') {
          return options.people.find((person) => person.id === id)?.name || undefined;
        }
        if (field === 'petIds') {
          const pet = options.pets.find((item) => item.id === id);
          return pet ? pet.name || $t('frameleaf_pets_unnamed') : undefined;
        }
        const list = field === 'tagIds' ? options.tags : field === 'albumIds' ? options.albums : [];
        return list.find((item) => item.value === id)?.label;
      },
    }).filter((chip) => !typed.has(chip.field) && chip.field !== 'or');
  });

  /* ---------------------------------------------------------------------- */
  /* Loading                                                                 */
  /* ---------------------------------------------------------------------- */

  const isAbort = (error: unknown, signal: AbortSignal) =>
    signal.aborted || (error instanceof DOMException && error.name === 'AbortError');

  let optionsController: AbortController | undefined;
  let catalogController: AbortController | undefined;
  let remoteController: AbortController | undefined;
  let remoteTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    void generation;
    untrack(() => {
      optionsController?.abort();
      const controller = new AbortController();
      optionsController = controller;
      void loadFilterPanelOptions(controller.signal)
        .then((result) => {
          if (controller.signal.aborted) {
            return;
          }

          options = result;
          // Operators in a reopened search resolve once the vocabulary they name has arrived
          if (tokens.length === 0 && text) {
            restoreInput(text);
          }
        })
        .catch(() => {
          // Aborted: the palette closed or access changed
        });
      void getMyPreferences({ signal: controller.signal })
        .then((preferences) => {
          if (controller.signal.aborted) {
            return;
          }

          savedSearches = preferences.savedSearches ?? [];
          preferencesRevision = preferences.revision;
        })
        .catch(() => {
          // Saved searches are optional; the palette works without them
        });
    });
  });

  // Typeahead counts: the collection (or library) as a whole, not narrowed by what is typed
  const catalogBody = $derived(
    paletteSearchBody(
      scopeChoice === 'library' ? emptyDiscoveryQuery() : withPaletteScope(emptyDiscoveryQuery(), scope),
    ),
  );
  const catalogKey = $derived(JSON.stringify([catalogBody, generation]));
  $effect(() => {
    void catalogKey;
    untrack(() => {
      catalogController?.abort();
      const controller = new AbortController();
      catalogController = controller;
      const { signal } = controller;
      void loadPaletteFacets(catalogBody, signal, 100)
        .then((result) => !signal.aborted && (catalogFacets = result))
        .catch(() => !signal.aborted && (catalogFacets = {}));
      void loadPaletteYears(catalogBody, signal)
        .then((result) => !signal.aborted && (catalogYears = result))
        .catch(() => !signal.aborted && (catalogYears = []));
    });
  });

  const remoteKey = $derived(
    JSON.stringify([
      paletteSearchBody(currentQuery),
      paletteSearchBody(libraryQuery),
      scopeChoice,
      smartEnabled,
      typing,
      advanced,
      generation,
    ]),
  );

  $effect(() => {
    void remoteKey;
    untrack(() => {
      remoteController?.abort();
      clearTimeout(remoteTimer);
      const controller = new AbortController();
      remoteController = controller;
      loading = true;
      remoteTimer = setTimeout(() => runRemote(controller.signal), REMOTE_DEBOUNCE_MS);
    });
  });

  const runRemote = (signal: AbortSignal) => {
    const currentBody = paletteSearchBody(currentQuery);
    const libraryBody = paletteSearchBody(libraryQuery);
    const searchBody = scopeChoice === 'library' ? libraryBody : currentBody;
    const smartFor = (target: typeof searchBody) => smartEnabled && isSmartBody(target);
    const settle = <T,>(work: Promise<T>, apply: (value: T | null) => void) =>
      work
        .then((value) => !signal.aborted && apply(value))
        .catch((error: unknown) => {
          if (!isAbort(error, signal)) {
            apply(null);
          }
        });

    const tasks = [
      settle(loadPaletteCount(currentBody, smartFor(currentBody), signal), (value) => {
        counts.current = value;
        if (!scope) {
          counts.library = value;
        }
      }),
      scope
        ? settle(loadPaletteCount(libraryBody, smartFor(libraryBody), signal), (value) => (counts.library = value))
        : Promise.resolve(),
      settle(loadPaletteFacets(searchBody, signal), (value) => (facets = value ?? {})),
      settle(
        loadPaletteHistogram(searchBody, signal),
        (value) => (histogram = value ?? { unit: 'month', buckets: [] }),
      ),
      settle(
        loadEnrichmentCounts(searchBody, advanced ? ALL_ENRICHMENT : QUICK_ENRICHMENT, signal),
        (value) => (enrichmentCounts = value ?? {}),
      ),
      typing
        ? settle(
            loadPaletteResults(searchBody, smartFor(searchBody), TOP_HITS, signal),
            (value) => (results = value ?? []),
          )
        : Promise.resolve((results = [])),
    ];
    void Promise.all(tasks).finally(() => {
      if (!signal.aborted) {
        loading = false;
      }
    });
  };

  /** Access changed (locked, unlocked, another account): drop every answer and ask again. */
  const stopAccess = onLibraryAccessChange(() => {
    optionsController?.abort();
    catalogController?.abort();
    remoteController?.abort();
    options = emptyFilterPanelOptions();
    catalogFacets = {};
    catalogYears = [];
    facets = {};
    histogram = { unit: 'month', buckets: [] };
    results = [];
    counts = { current: null, library: null };
    enrichmentCounts = {};
    savedSearches = [];
    generation += 1;
  });

  onDestroy(() => {
    stopAccess();
    optionsController?.abort();
    catalogController?.abort();
    remoteController?.abort();
    clearTimeout(remoteTimer);
  });

  $effect(() => {
    if (!dialog || dialog.open) {
      return;
    }
    const previous = document.activeElement;
    dialog.showModal();
    input?.focus();
    // Shortcut handlers elsewhere stand down while the search surface has focus
    searchStore.isSearchEnabled = true;
    return () => {
      searchStore.isSearchEnabled = false;
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus({ preventScroll: true });
      }
    };
  });

  /* ---------------------------------------------------------------------- */
  /* Editing                                                                 */
  /* ---------------------------------------------------------------------- */

  /** Completed operators become chips as they are typed; ">" hands off to the command palette. */
  const onInput = (value: string, field?: HTMLInputElement) => {
    if (isCommandQuery(value) && onOpenPalette) {
      onOpenPalette(value);
      return;
    }
    const committed = commitCompletedTokens(value, catalog);
    if (committed.tokens.length > 0) {
      tokens = [...tokens, ...committed.tokens];
    }
    text = committed.rest;
    // The field is one-way bound: when a chip takes the typed token, the text left behind may equal
    // the previous state, which would leave the token visible in the field
    if (field && field.value !== text) {
      field.value = text;
    }
  };

  /** Restores a whole input (a recent or saved search): every resolvable operator becomes a chip. */
  const restoreInput = (value: string) => {
    const committed = commitCompletedTokens(`${value} `, catalog);
    tokens = committed.tokens;
    text = committed.rest.trimEnd();
  };

  const addToken = (raw: string) => {
    if (!tokens.includes(raw)) {
      tokens = [...tokens, raw];
    }
    input?.focus();
  };

  const removeToken = (index: number) => {
    tokens = tokens.filter((_, position) => position !== index);
    input?.focus();
  };

  const clearAll = () => {
    text = '';
    tokens = [];
    base = withPaletteScope({ ...emptyDiscoveryQuery(), mode: base.mode }, scope);
    input?.focus();
  };

  /**
   * A graphical pick in the Advanced view: the fields it changed replace any typed chip for them, so
   * the two never disagree (`setAdvancedCondition` in the prototype), and the scope stays unless the
   * library scope is chosen.
   */
  const onAdvancedChange = (changed: DiscoveryQuery) => {
    const before = next.filter as Record<string, unknown>;
    const after = changed.filter as Record<string, unknown>;
    const fields = new Set(
      [...Object.keys(before), ...Object.keys(after)].filter(
        (field) => field !== 'or' && JSON.stringify(before[field]) !== JSON.stringify(after[field]),
      ),
    );
    tokens = withoutTokensForFields(tokens, fields, catalog);
    let result = structuredClone(base);
    for (const field of fields) {
      result =
        after[field] === undefined
          ? withoutDiscoveryFilter(result, field)
          : { ...result, filter: { ...result.filter, [field]: after[field] } };
    }
    if (changed.imageEnrichment !== next.imageEnrichment) {
      result = withDiscoveryEnrichment(result, changed.imageEnrichment);
    }
    base = scopeChoice === 'current' ? withPaletteScope(result, scope) : result;
  };

  const toggleEnrichment = (value: ImageEnrichmentFilter) => {
    base = withDiscoveryEnrichment(base, base.imageEnrichment === value ? undefined : value);
  };

  const removeBaseChip = (field: string) => {
    base = withPaletteScope(withoutDiscoveryFilter(base, field), scopeChoice === 'current' ? scope : undefined);
  };

  const pickPerson = (id: string, name: string | undefined) => {
    if (name) {
      addToken(operatorToken('person', name));
    } else {
      // Unnamed people have no name to type, so they are picked as a filter instead
      base = withDiscoveryFacet(base, 'personIds', id);
    }
  };

  /* ---------------------------------------------------------------------- */
  /* Running                                                                 */
  /* ---------------------------------------------------------------------- */

  const snapshot = (): PaletteSearch => ({ input: liveInput, mode, query: base });

  const remember = () => {
    searchStore.recentSearches = rememberRecentSearch(searchStore.recentSearches, snapshot());
  };

  /** The query submitted now, compiled from the live input rather than the deferred one. */
  const submitted = () => {
    const live = parseSearchInput(liveInput, catalog);
    const target = scopeChoice === 'library' ? withoutPaletteScope(base, scope) : base;
    return compilePaletteQuery(target, live, mode) ?? compilePaletteQuery(target, live, 'originalFileName')!;
  };

  const run = () => {
    const query = submitted();
    // FL-48: until something is edited, "Show results" keeps the page's own (wider) search
    if (unsupported.length > 0 && JSON.stringify(query) === JSON.stringify(initialQuery)) {
      onClose();
      return;
    }
    remember();
    handlePromiseError(goto(isEmptyDiscoverySearch(query) ? '/search' : discoveryUrl(query)));
    onClose();
  };

  const openAsset = (asset: AssetResponseDto) => {
    remember();
    const parameters = new URLSearchParams({ [DISCOVERY_QUERY_PARAMETER]: JSON.stringify(submitted()) });
    handlePromiseError(goto(`/search/photos/${asset.id}?${parameters}`));
    onClose();
  };

  const restore = (search: PaletteSearch) => {
    base = $state.snapshot(search.query) as DiscoveryQuery;
    mode = search.mode === 'smart' && !smartEnabled ? 'originalFileName' : search.mode;
    restoreInput(search.input);
    input?.focus();
  };

  const activate = (entry: Entry | undefined) => {
    if (!entry) {
      run();
      return;
    }
    switch (entry.kind) {
      case 'suggestion': {
        if (entry.item.insert.endsWith(':')) {
          text = entry.item.insert;
        } else {
          onInput(entry.item.insert);
        }
        input?.focus();
        break;
      }
      case 'asset': {
        openAsset(entry.item);
        break;
      }
      case 'destination': {
        onCommand?.(entry.item);
        onClose();
        break;
      }
      case 'recent': {
        restore(entry.item);
        break;
      }
      case 'saved': {
        restore(entry.item.search);
        break;
      }
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (saving) {
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      active = Math.max(-1, Math.min(items.length - 1, active + step));
    } else if (event.key === 'Enter' && event.target === input) {
      event.preventDefault();
      if (event.metaKey || event.ctrlKey) {
        run();
      } else {
        activate(activeEntry);
      }
    } else if (event.key === 'Tab' && !event.shiftKey && suggestions.length > 0 && event.target === input) {
      event.preventDefault();
      const suggestion = activeEntry?.kind === 'suggestion' ? activeEntry.item : suggestions[0];
      activate({ kind: 'suggestion', item: suggestion });
    } else if (event.key === 'Backspace' && !text && tokens.length > 0 && event.target === input) {
      event.preventDefault();
      tokens = tokens.slice(0, -1);
    }
  };

  /* ---------------------------------------------------------------------- */
  /* Saved searches                                                          */
  /* ---------------------------------------------------------------------- */

  const writeSavedSearches = async (list: SavedSearch[]) => {
    saveError = false;
    try {
      const response = await updateMyPreferences({
        userPreferencesUpdateDto: { savedSearches: list, expectedRevision: preferencesRevision },
      });
      savedSearches = response.savedSearches ?? list;
      preferencesRevision = response.revision;
      return true;
    } catch {
      saveError = true;
      // Somebody else changed the preferences, or the save failed: load them again
      try {
        const preferences = await getMyPreferences();
        savedSearches = preferences.savedSearches ?? [];
        preferencesRevision = preferences.revision;
      } catch {
        // Keep what is shown
      }
      return false;
    }
  };

  const saveSearch = async () => {
    const name = saveName.trim();
    if (!name) {
      return;
    }
    if (await writeSavedSearches(upsertSavedSearch(savedSearches, toSavedSearch(name, snapshot())))) {
      saving = false;
      saveName = '';
      input?.focus();
    }
  };

  const deleteSavedSearch = (name: string) => void writeSavedSearches(removeSavedSearch(savedSearches, name));

  const selectedPeople = $derived(
    new Set([...(next.filter.personIds?.any ?? []), ...(next.filter.personIds?.all ?? [])]),
  );

  const idlePeople = $derived(
    [...catalog.people]
      .filter((person) => person.name)
      .sort((a, b) => (b.count ?? -1) - (a.count ?? -1) || a.name.localeCompare(b.name))
      .slice(0, 12)
      .map((entry) => options.people.find((person) => person.id === entry.id))
      .filter((person) => person !== undefined),
  );

  const thumbnail = (asset: AssetResponseDto, size = AssetMediaSize.Thumbnail) =>
    getAssetMediaUrl({ id: asset.id, size, cacheKey: asset.thumbhash });

  const matchesLabel = $derived(
    pending || !selectedCount
      ? $t('frameleaf_search_searching')
      : $t('frameleaf_search_palette_matches', {
          values: { count: selectedCount.total, capped: selectedCount.capped ? 'yes' : 'no' },
        }),
  );
</script>

<dialog
  bind:this={dialog}
  class="search-palette frameleaf"
  class:reduced-motion={reducedMotion}
  data-theme={appTheme}
  aria-label={$t('frameleaf_search_title')}
  oncancel={(event) => {
    event.preventDefault();
    if (modeMenu || help || saving) {
      modeMenu = false;
      help = false;
      saving = false;
      input?.focus();
    } else {
      onClose();
    }
  }}
  onclick={(event) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  }}
>
  <form
    onsubmit={(event) => {
      event.preventDefault();
      run();
    }}
  >
    <div class="sp-field">
      <Icon icon={mdiMagnify} size="22" aria-hidden={true} />
      <div class="sp-tokens">
        {#each chips as token, position (tokens[position])}
          <span class="sp-token" class:exclude={token.exclude}>
            {#if token.key === 'person'}
              <PersonAvatar
                person={options.people.find((person) => person.name.toLowerCase() === token.display.toLowerCase())}
                size={18}
              />
            {/if}
            {tokenLabel($t, token)}
            <button
              type="button"
              aria-label={$t('frameleaf_search_remove_filter', { values: { filter: tokenLabel($t, token) } })}
              onclick={() => removeToken(position)}
            >
              <Icon icon={mdiClose} size="12" aria-hidden={true} />
            </button>
          </span>
        {/each}
        <input
          bind:this={input}
          aria-label={$t('frameleaf_search_query')}
          role="combobox"
          aria-expanded="true"
          aria-controls="{listId}-results"
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${listId}-item-${active}` : undefined}
          autocomplete="off"
          spellcheck="false"
          value={text}
          {placeholder}
          oninput={(event) => onInput(event.currentTarget.value, event.currentTarget)}
          onkeydown={onKeyDown}
        />
      </div>
      {#if text || tokens.length > 0}
        <button type="button" class="sp-icon-button" aria-label={$t('frameleaf_search_clear')} onclick={clearAll}>
          <Icon icon={mdiClose} size="16" aria-hidden={true} />
        </button>
      {/if}
      <div class="sp-mode">
        <button
          type="button"
          aria-label={$t('frameleaf_search_mode_label', { values: { mode: $t(modeEntry.labelKey) } })}
          aria-haspopup="menu"
          aria-expanded={modeMenu}
          onclick={() => (modeMenu = !modeMenu)}
        >
          <Icon icon={MODE_ICONS[modeEntry.icon]} size="16" aria-hidden={true} />
          <span class="sp-button-label">{$t(modeEntry.labelKey)}</span>
          <Icon icon={mdiChevronDown} size="14" aria-hidden={true} />
        </button>
        {#if modeMenu}
          <div role="menu" class="sp-menu">
            {#each modes as entry (entry.value)}
              <button
                type="button"
                role="menuitemradio"
                aria-checked={mode === entry.value}
                onclick={() => {
                  mode = entry.value;
                  modeMenu = false;
                  input?.focus();
                }}
              >
                <Icon icon={MODE_ICONS[entry.icon]} size="16" aria-hidden={true} />
                {$t(entry.labelKey)}
              </button>
            {/each}
          </div>
        {/if}
      </div>
      <button
        type="button"
        class="sp-advanced-toggle"
        aria-label={$t('frameleaf_search_advanced_filters')}
        aria-pressed={advanced}
        onclick={toggleAdvanced}
      >
        <Icon icon={mdiTuneVariant} size="16" aria-hidden={true} />
        <span class="sp-button-label">{$t('frameleaf_search_advanced')}</span>
      </button>
      <button
        type="button"
        class="sp-icon-button"
        aria-label={$t('frameleaf_search_syntax')}
        aria-expanded={help}
        onclick={() => (help = !help)}
      >
        <Icon icon={mdiHelpCircleOutline} size="18" aria-hidden={true} />
      </button>
    </div>

    <div class="sp-bar">
      <div class="sp-scope" role="radiogroup" aria-label={$t('frameleaf_search_scope_label')}>
        {#each [{ value: 'current' as const, label: scopeLabel, count: counts.current }, { value: 'library' as const, label: $t('frameleaf_search_entire_library'), count: counts.library }] as option (option.value)}
          <button
            type="button"
            role="radio"
            aria-checked={scopeChoice === option.value}
            onclick={() => (scopeChoice = option.value)}
          >
            {option.label}
            <small>{formatScopeCount(option.count)}</small>
          </button>
        {/each}
      </div>
      {#if baseChips.length > 0}
        <div class="sp-understood" aria-label={$t('frameleaf_search_active_filters')}>
          <span>{$t('frameleaf_search_filters')}</span>
          {#each baseChips as chip (chip.field)}
            <button
              type="button"
              aria-label={$t('frameleaf_search_remove_filter', { values: { filter: chip.label } })}
              onclick={() => removeBaseChip(chip.field)}
            >
              {chip.label}
              <Icon icon={mdiClose} size="12" aria-hidden={true} />
            </button>
          {/each}
        </div>
      {/if}
      <span class="sp-status" aria-live="polite">{matchesLabel}</span>
    </div>

    {#if unsupported.length > 0}
      <p class="sp-note-row" role="note">{$t('frameleaf_search_bridge_unsupported')}</p>
    {/if}

    {#if help}
      <section class="sp-help" aria-label={$t('frameleaf_search_syntax')}>
        <p>{$t('frameleaf_search_syntax_intro')}</p>
        <div>
          {#each SEARCH_OPERATORS as operator (operator.key)}
            <button type="button" onclick={() => (text = `${text ? `${text} ` : ''}${operator.key}:`)}>
              <code>{operator.hint}</code>
              <span>{$t(operator.labelKey)}</span>
            </button>
          {/each}
          <button
            type="button"
            onclick={() => (text = `${text ? `${text} ` : ''}"${$t('frameleaf_search_exact_phrase')}"`)}
          >
            <code>"{$t('frameleaf_search_exact_phrase')}"</code>
            <span>{$t('frameleaf_search_phrase')}</span>
          </button>
          <button type="button" onclick={() => (text = `${text ? `${text} ` : ''}-`)}>
            <code>-{$t('frameleaf_search_word')}</code>
            <span>{$t('frameleaf_search_exclude_word')}</span>
          </button>
        </div>
      </section>
    {/if}

    {#if advanced}
      <div class="sp-advanced">
        <FilterPanel
          embedded
          query={next}
          {options}
          {section}
          {facets}
          {enrichmentCounts}
          onChange={onAdvancedChange}
        />
      </div>
    {/if}

    <div class="sp-body" hidden={advanced}>
      <div
        class="sp-results"
        id="{listId}-results"
        role="listbox"
        aria-label={$t('frameleaf_search_results')}
        bind:this={resultsList}
      >
        {#if suggestions.length > 0}
          <section>
            <h3>{$t('frameleaf_search_suggestions')}</h3>
            {#each items as entry (entry)}
              {#if entry.kind === 'suggestion'}
                {@const at = indexOf(entry)}
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <div
                  id="{listId}-item-{at}"
                  role="option"
                  tabindex="-1"
                  aria-selected={at === active}
                  class="sp-row"
                  class:active={at === active}
                  onmouseenter={() => (active = at)}
                  onclick={() => activate(entry)}
                >
                  {#if entry.item.kind === 'person'}
                    <PersonAvatar
                      person={options.people.find((person) => person.id === entry.item.personId)}
                      size={20}
                    />
                  {:else}
                    <Icon icon={SUGGESTION_ICONS[entry.item.kind]} size="16" aria-hidden={true} />
                  {/if}
                  <span>{entry.item.labelKey ? $t(entry.item.labelKey) : entry.item.label}</span>
                  <code>{entry.item.detail}</code>
                  {#if entry.item.count !== undefined}
                    <small>{entry.item.count.toLocaleString()}</small>
                  {/if}
                  {#if at === active}<kbd aria-hidden="true">⇥</kbd>{/if}
                </div>
              {/if}
            {/each}
          </section>
        {/if}

        {#if typing}
          <section>
            <h3>
              {$t('frameleaf_search_photos_and_videos')}
              {#if selectedCount && selectedCount.total > TOP_HITS}
                <button type="button" class="sp-link" onclick={run}>
                  {$t('frameleaf_search_show_all', { values: { count: formatScopeCount(selectedCount) } })}
                  <kbd aria-hidden="true">⌘⏎</kbd>
                </button>
              {/if}
            </h3>
            {#if results.length > 0}
              <div class="sp-hits">
                {#each items as entry (entry)}
                  {#if entry.kind === 'asset'}
                    {@const at = indexOf(entry)}
                    <!-- svelte-ignore a11y_click_events_have_key_events -->
                    <div
                      id="{listId}-item-{at}"
                      role="option"
                      tabindex="-1"
                      aria-selected={at === active}
                      aria-label={entry.item.originalFileName}
                      class="sp-hit"
                      class:active={at === active}
                      title={entry.item.originalFileName}
                      onmouseenter={() => (active = at)}
                      onclick={() => activate(entry)}
                    >
                      <img src={thumbnail(entry.item)} alt="" loading="lazy" />
                      {#if entry.item.type === AssetTypeEnum.Video}
                        <Icon icon={mdiPlayCircleOutline} size="16" aria-hidden={true} />
                      {/if}
                    </div>
                  {/if}
                {/each}
              </div>
            {:else if !pending}
              <p class="sp-empty">
                {scopeChoice === 'current'
                  ? $t('frameleaf_search_no_matches_in_scope', { values: { scope: scopeLabel } })
                  : $t('frameleaf_search_no_matches_in_library')}
                {#if scopeChoice === 'current' && scope && otherCount && otherCount.total > 0}
                  <button type="button" class="sp-link" onclick={() => (scopeChoice = 'library')}>
                    {$t('frameleaf_search_in_entire_library', { values: { count: formatScopeCount(otherCount) } })}
                  </button>
                {/if}
              </p>
            {/if}
          </section>
        {/if}

        {#if destinations.length > 0}
          <section>
            <h3>{$t('frameleaf_search_go_to')}</h3>
            {#each items as entry (entry)}
              {#if entry.kind === 'destination'}
                {@const at = indexOf(entry)}
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <div
                  id="{listId}-item-{at}"
                  role="option"
                  tabindex="-1"
                  aria-selected={at === active}
                  class="sp-row"
                  class:active={at === active}
                  onmouseenter={() => (active = at)}
                  onclick={() => activate(entry)}
                >
                  <Icon icon={entry.item.icon || mdiArrowRight} size="16" aria-hidden={true} />
                  <span>{entry.item.title}</span>
                  {#if entry.item.subtitle}<small>{entry.item.subtitle}</small>{/if}
                  <Icon icon={mdiArrowRight} size="14" aria-hidden={true} />
                </div>
              {/if}
            {/each}
          </section>
        {/if}

        {#if !typing}
          <section>
            <h3>{recent.length > 0 ? $t('recent_searches') : $t('frameleaf_search_try')}</h3>
            {#each items as entry (entry)}
              {#if entry.kind === 'recent'}
                {@const at = indexOf(entry)}
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <div
                  id="{listId}-item-{at}"
                  role="option"
                  tabindex="-1"
                  aria-selected={at === active}
                  class="sp-row"
                  class:active={at === active}
                  onmouseenter={() => (active = at)}
                  onclick={() => activate(entry)}
                >
                  <Icon icon={mdiHistory} size="16" aria-hidden={true} />
                  <span>{entry.item.input}</span>
                  <small>{$t(PALETTE_MODES.find((item) => item.value === entry.item.mode)?.labelKey ?? 'search')}</small
                  >
                </div>
              {/if}
            {/each}
          </section>
          {#if saved.length > 0}
            <section>
              <h3>{$t('frameleaf_search_saved_searches')}</h3>
              {#each items as entry (entry)}
                {#if entry.kind === 'saved'}
                  {@const at = indexOf(entry)}
                  <!-- svelte-ignore a11y_click_events_have_key_events -->
                  <div
                    id="{listId}-item-{at}"
                    role="option"
                    tabindex="-1"
                    aria-selected={at === active}
                    class="sp-row"
                    class:active={at === active}
                    onmouseenter={() => (active = at)}
                    onclick={() => activate(entry)}
                  >
                    <Icon icon={mdiBookmarkOutline} size="16" aria-hidden={true} />
                    <span>{entry.item.name}</span>
                    <small>{entry.item.search.input}</small>
                    <button
                      type="button"
                      class="sp-row-action"
                      aria-label={$t('frameleaf_search_delete_saved', { values: { name: entry.item.name } })}
                      onclick={(event) => {
                        event.stopPropagation();
                        deleteSavedSearch(entry.item.name);
                      }}
                    >
                      <Icon icon={mdiClose} size="14" aria-hidden={true} />
                    </button>
                  </div>
                {/if}
              {/each}
            </section>
          {/if}
          {#if idlePeople.length > 0}
            <section>
              <h3>{$t('people')}</h3>
              <div class="sp-people">
                {#each idlePeople as person (person.id)}
                  <button type="button" onclick={() => pickPerson(person.id, person.name)}>
                    <PersonAvatar {person} size={48} />
                    <span>{person.name}</span>
                  </button>
                {/each}
              </div>
            </section>
          {/if}
        {/if}
      </div>

      <SearchPaletteSide
        {previewAsset}
        {histogram}
        {typing}
        {facets}
        people={options.people}
        {selectedPeople}
        {tokens}
        enrichment={base.imageEnrichment}
        {enrichmentCounts}
        onNarrow={(bar) => (tokens = narrowToBar(tokens, bar))}
        onAddToken={addToken}
        onPickPerson={pickPerson}
        onToggleEnrichment={toggleEnrichment}
      />
    </div>

    {#if saving}
      <div class="sp-footer sp-save" role="group" aria-label={$t('frameleaf_search_save_search')}>
        <label>
          <span>{$t('name')}</span>
          <!-- svelte-ignore a11y_autofocus -->
          <input
            autofocus
            maxlength={SAVED_SEARCH_NAME_LIMIT}
            bind:value={saveName}
            onkeydown={(event) => {
              if (event.key !== 'Enter') {
                return;
              }

              event.preventDefault();
              void saveSearch();
            }}
          />
        </label>
        {#if saveError}
          <span class="sp-error" role="alert">{$t('frameleaf_search_save_failed')}</span>
        {/if}
        <button type="button" class="sp-secondary" onclick={() => (saving = false)}>{$t('cancel')}</button>
        <button type="button" class="sp-primary" disabled={!saveName.trim()} onclick={() => void saveSearch()}>
          {$t('save')}
        </button>
      </div>
    {:else}
      <footer class="sp-footer">
        <span class="sp-keys" aria-hidden="true">
          <kbd>↑</kbd><kbd>↓</kbd>
          {$t('frameleaf_search_key_move')}
          <kbd>⏎</kbd>
          {$t('frameleaf_search_key_open')}
          <kbd>⇥</kbd>
          {$t('frameleaf_search_key_complete')}
          <kbd>⌘⏎</kbd>
          {$t('frameleaf_search_key_all')}
          <kbd>esc</kbd>
          {$t('frameleaf_search_key_close')}
        </span>
        <span class="sp-note">{smart ? $t('frameleaf_search_smart_note') : ''}</span>
        <button
          type="button"
          class="sp-secondary"
          onclick={() => {
            saving = true;
            saveError = false;
            saveName = text.trim() || liveInput;
          }}
        >
          <Icon icon={mdiContentSaveOutline} size="16" aria-hidden={true} />
          {$t('frameleaf_search_save_search')}
        </button>
        <button type="submit" class="sp-primary">
          {selectedCount
            ? $t('frameleaf_search_show_count', {
                values: { count: selectedCount.total, label: formatScopeCount(selectedCount) },
              })
            : $t('frameleaf_search_show_results')}
        </button>
      </footer>
    {/if}
  </form>
</dialog>

<style>
  /* Spotlight-style glass panel anchored near the top of the window (search-palette.css). */
  .search-palette {
    --sp-glass: color-mix(in srgb, var(--fl-panel) 74%, transparent);
    --sp-edge: color-mix(in srgb, var(--fl-text) 14%, transparent);
    --sp-row: color-mix(in srgb, var(--fl-text) 8%, transparent);
    --sp-active: color-mix(in srgb, var(--fl-accent) 22%, transparent);
    width: min(980px, calc(100vw - 32px));
    max-width: none;
    max-height: min(760px, calc(100dvh - 12vh - 24px));
    margin: 10vh auto auto;
    padding: 0;
    overflow: hidden;
    color: var(--fl-text);
    background: var(--sp-glass);
    backdrop-filter: blur(40px) saturate(180%);
    border: 1px solid var(--sp-edge);
    border-radius: 20px;
    box-shadow:
      0 30px 120px #000a,
      inset 0 1px 0 #ffffff14;
    font-size: 13px;
    animation: sp-in 420ms var(--fl-spring) both;
  }
  @keyframes sp-in {
    from {
      opacity: 0;
      scale: 0.97;
    }
    to {
      opacity: 1;
      scale: 1;
    }
  }
  @keyframes sp-fade {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  .search-palette.reduced-motion {
    animation: sp-fade 150ms ease both;
  }
  @media (prefers-reduced-motion: reduce) {
    .search-palette {
      animation: sp-fade 150ms ease both;
    }
  }
  .search-palette::backdrop {
    background: #0005;
    backdrop-filter: blur(10px);
  }
  @supports (corner-shape: squircle) {
    .search-palette {
      corner-shape: squircle;
      border-radius: 36px;
    }
  }
  @media (prefers-contrast: more), (prefers-reduced-transparency: reduce) {
    .search-palette {
      --sp-glass: var(--fl-panel);
      backdrop-filter: none;
    }
    .search-palette::backdrop {
      background: rgb(0 0 0 / 67%);
      backdrop-filter: none;
    }
  }
  .search-palette form {
    display: flex;
    flex-direction: column;
    max-height: inherit;
  }
  .search-palette button {
    font: inherit;
    color: inherit;
    cursor: pointer;
  }
  .search-palette h3 {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 0 0 6px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--fl-muted);
  }
  .search-palette kbd {
    display: inline-grid;
    place-items: center;
    min-width: 18px;
    height: 18px;
    padding: 0 4px;
    border-radius: 5px;
    background: var(--sp-row);
    border: 1px solid var(--sp-edge);
    font-size: 11px;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }
  .search-palette small,
  .search-palette code {
    color: var(--fl-muted);
    font-variant-numeric: tabular-nums;
  }
  .search-palette code {
    font:
      11px ui-monospace,
      SFMono-Regular,
      monospace;
  }

  /* field */
  .sp-field {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 14px 12px 18px;
    border-bottom: 1px solid var(--sp-edge);
    color: var(--fl-muted);
  }
  .sp-tokens {
    flex: 1;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .sp-tokens input {
    flex: 1;
    min-width: 180px;
    padding: 6px 0;
    border: 0;
    border-radius: 0;
    outline: 0;
    box-shadow: none;
    background: transparent;
    color: var(--fl-text);
    font-size: 21px;
    line-height: 1.2;
    letter-spacing: -0.01em;
  }
  .sp-token {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 4px 3px 8px;
    border-radius: 8px;
    background: var(--sp-active);
    color: var(--fl-text);
    font-size: 13px;
    font-weight: 500;
  }
  .sp-token.exclude {
    background: color-mix(in srgb, #ff453a 22%, transparent);
    text-decoration: line-through;
    text-decoration-color: #ff453a99;
  }
  .sp-token button,
  .sp-understood button {
    display: inline-grid;
    place-items: center;
    border: 0;
    background: transparent;
    padding: 2px;
    border-radius: 4px;
  }
  .sp-icon-button {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border: 0;
    border-radius: 8px;
    background: transparent;
  }
  .sp-icon-button:hover,
  .sp-mode > button:hover {
    background: var(--sp-row);
  }
  .sp-mode {
    position: relative;
  }
  .sp-mode > button {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 8px 0 10px;
    border: 1px solid var(--sp-edge);
    border-radius: 9px;
    background: transparent;
    white-space: nowrap;
  }
  .sp-menu {
    position: absolute;
    inset-inline-end: 0;
    top: calc(100% + 6px);
    z-index: 3;
    display: grid;
    min-width: 200px;
    padding: 6px;
    border: 1px solid var(--sp-edge);
    border-radius: 12px;
    background: color-mix(in srgb, var(--fl-panel) 92%, transparent);
    backdrop-filter: blur(30px);
    box-shadow: 0 16px 50px #0008;
  }
  .sp-menu button {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    text-align: start;
  }
  .sp-menu button:hover,
  .sp-menu button[aria-checked='true'] {
    background: var(--sp-active);
  }
  .sp-advanced-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 10px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    font-size: 13px;
    white-space: nowrap;
  }
  .sp-advanced-toggle:hover {
    background: var(--sp-row);
  }
  .sp-advanced-toggle[aria-pressed='true'] {
    border-color: color-mix(in srgb, var(--fl-accent), transparent 50%);
    background: color-mix(in srgb, var(--fl-accent), transparent 86%);
    color: var(--fl-text);
  }

  /* scope, filters, status */
  .sp-bar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px 14px;
    padding: 10px 18px;
    border-bottom: 1px solid var(--sp-edge);
  }
  .sp-scope {
    display: inline-flex;
    padding: 2px;
    border-radius: 9px;
    background: var(--sp-row);
  }
  .sp-scope button {
    display: flex;
    gap: 6px;
    align-items: baseline;
    padding: 4px 12px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--fl-muted);
  }
  .sp-scope button[aria-checked='true'] {
    background: var(--fl-raised);
    color: var(--fl-text);
    box-shadow: 0 1px 4px #0005;
  }
  .sp-understood {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .sp-understood > span {
    color: var(--fl-muted);
  }
  .sp-understood button {
    display: inline-flex;
    gap: 4px;
    padding: 3px 6px 3px 9px;
    border: 1px dashed var(--sp-edge);
    border-radius: 999px;
  }
  .sp-status {
    margin-inline-start: auto;
    color: var(--fl-muted);
    font-variant-numeric: tabular-nums;
  }
  .sp-note-row {
    margin: 0;
    padding: 8px 18px;
    font-size: 12px;
    color: var(--fl-muted);
    border-bottom: 1px solid var(--sp-edge);
  }

  /* syntax help */
  .sp-help {
    padding: 12px 18px 14px;
    border-bottom: 1px solid var(--sp-edge);
    background: var(--sp-row);
  }
  .sp-help p {
    margin: 0 0 8px;
    color: var(--fl-muted);
  }
  .sp-help > div {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 4px 12px;
  }
  .sp-help button {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    padding: 5px 8px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    text-align: start;
  }
  .sp-help button:hover {
    background: var(--sp-row);
  }
  .sp-help code {
    color: var(--fl-accent);
  }

  /* body */
  .sp-body {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 300px;
    min-height: 0;
    flex: 1;
  }
  .sp-body[hidden] {
    display: none;
  }
  .sp-results {
    overflow: auto;
    padding: 14px 18px;
    display: grid;
    align-content: start;
    gap: 18px;
  }
  .sp-row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 36px;
    padding: 6px 10px;
    border-radius: 8px;
    cursor: pointer;
  }
  .sp-row > span {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sp-row.active {
    background: var(--sp-active);
  }
  .sp-row-action {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border: 0;
    border-radius: 6px;
    background: transparent;
  }
  .sp-row-action:hover {
    background: var(--sp-row);
  }
  .sp-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 0;
    background: transparent;
    color: var(--fl-accent) !important;
    font-size: 12px;
    font-weight: 500;
    text-transform: none;
    letter-spacing: 0;
  }
  .sp-hits {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(92px, 1fr));
    gap: 6px;
  }
  .sp-hit {
    position: relative;
    aspect-ratio: 1;
    border-radius: 10px;
    overflow: hidden;
    cursor: pointer;
    outline: 2px solid transparent;
    outline-offset: 2px;
    transition: outline-color 120ms ease;
  }
  .sp-hit img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .sp-hit :global(svg) {
    position: absolute;
    right: 5px;
    bottom: 5px;
    color: #fff;
    filter: drop-shadow(0 1px 3px #000a);
  }
  .sp-hit.active {
    outline-color: var(--fl-accent);
  }
  .sp-empty {
    margin: 0;
    color: var(--fl-muted);
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: baseline;
  }
  .sp-people {
    display: flex;
    gap: 14px;
    flex-wrap: wrap;
  }
  .sp-people button {
    display: grid;
    justify-items: center;
    gap: 6px;
    border: 0;
    background: transparent;
    padding: 4px;
    border-radius: 10px;
  }
  .sp-people button:hover {
    background: var(--sp-row);
  }

  /* Advanced: the graphical filters from the original design (the panel lays itself out) */
  .sp-advanced {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  /* footer */
  .sp-footer {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px 10px 18px;
    border-top: 1px solid var(--sp-edge);
  }
  .sp-keys {
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--fl-muted);
    font-size: 12px;
    white-space: nowrap;
  }
  .sp-note {
    flex: 1;
    color: var(--fl-muted);
    font-size: 11px;
    text-align: end;
  }
  .sp-save label {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 10px;
  }
  .sp-save input {
    flex: 1;
    min-width: 0;
    min-height: 34px;
    padding: 0 10px;
    color: var(--fl-text);
    background: var(--sp-row);
    border: 1px solid var(--sp-edge);
    border-radius: 9px;
  }
  .sp-error {
    color: var(--fl-danger, #ff453a);
    font-size: 12px;
  }
  .sp-secondary,
  .sp-primary {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 34px;
    padding: 0 14px;
    border-radius: 10px;
    font-weight: 600;
    white-space: nowrap;
  }
  .sp-secondary {
    border: 1px solid var(--sp-edge);
    background: transparent;
  }
  .sp-primary {
    border: 0;
    background: var(--fl-accent);
    color: var(--fl-accent-text) !important;
  }
  .sp-primary:disabled {
    opacity: 0.5;
    cursor: default;
  }

  @media (max-width: 760px) {
    .search-palette {
      width: calc(100vw - 16px);
      margin-top: max(8px, env(safe-area-inset-top));
      max-height: calc(100dvh - 16px);
    }
    .sp-body {
      grid-template-columns: 1fr;
    }
    .sp-keys,
    .sp-note {
      display: none;
    }
    .sp-tokens input {
      font-size: 17px;
      min-width: 120px;
    }
    /* phones: mode and Advanced become icon buttons so the query keeps its room */
    .sp-field .sp-button-label {
      display: none;
    }
    .sp-advanced-toggle {
      width: 32px;
      padding: 0;
      justify-content: center;
    }
    .sp-mode > button {
      gap: 2px;
      padding: 0 8px;
    }
  }
</style>
