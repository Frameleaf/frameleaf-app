<script lang="ts">
  import { formatLuxon } from '$lib/frameleaf/date-format';
  import { afterNavigate, goto } from '$app/navigation';
  import { page } from '$app/state';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import EmptyState from '$lib/components/frameleaf/EmptyState.svelte';
  import FilterChip from '$lib/components/frameleaf/FilterChip.svelte';
  import LibraryLayoutSwitch, {
    LAYOUT_HINTS,
    showLibraryLayout,
  } from '$lib/components/frameleaf/LibraryLayoutSwitch.svelte';
  import LibraryStatusBar from '$lib/components/frameleaf/LibraryStatusBar.svelte';
  import LibraryWorkInspector from '$lib/components/frameleaf/LibraryWorkInspector.svelte';
  import ResultsToolbar from '$lib/components/frameleaf/ResultsToolbar.svelte';
  import ThumbnailSizeControl from '$lib/components/frameleaf/ThumbnailSizeControl.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import Spinner from '$lib/components/frameleaf/Spinner.svelte';
  import SearchSaveDialog from '$lib/components/frameleaf/SearchSaveDialog.svelte';
  import ResultsAssetViewer from '$lib/components/frameleaf/ResultsAssetViewer.svelte';
  import ResultsView from '$lib/components/frameleaf/ResultsView.svelte';
  import SpokenWordsResults from '$lib/components/frameleaf/SpokenWordsResults.svelte';
  import VideoMomentResults from '$lib/components/frameleaf/VideoMomentResults.svelte';
  import SearchChip from '$lib/components/frameleaf/SearchChip.svelte';
  import AssistantModeSwitch from '$lib/components/frameleaf/AssistantModeSwitch.svelte';
  import AssistantSearch from '$lib/components/frameleaf/AssistantSearch.svelte';
  import SearchAsk from '$lib/components/frameleaf/SearchAsk.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import {
    activeFilterFields,
    DISCOVERY_QUERY_PARAMETER,
    discoveryUrl,
    emptyDiscoveryQuery,
    filterSectionForField,
    isEmptyDiscoverySearch,
    readSearchParameters,
    structuredSearchRequest,
    toSearchDto,
    withoutDiscoveryFilter,
    type DiscoveryQuery,
  } from '$lib/components/discovery/query';
  import { QueryParameter } from '$lib/constants';
  import { brandedArchiveName, namedEntitySegments } from '$lib/frameleaf/archive-name';
  import type { SearchAskProblem } from '$lib/frameleaf/search-ask';
  import { forgetEntityNames, resolveEntityName, resolveEntityNames } from '$lib/frameleaf/filter-entity-names';
  import SearchByTextNotice from '$lib/components/frameleaf/SearchByTextNotice.svelte';
  import { LibrarySearchSession, type LibrarySearchQuery } from '$lib/frameleaf/library-search-session.svelte';
  import type { LibrarySort } from '$lib/frameleaf/library-session';
  import { librarySession } from '$lib/frameleaf/library-session.svelte';
  import {
    discoveryContextChips,
    entityNameKey,
    FILTER_ENTITY_FALLBACK_KEYS,
    FILTER_ENTITY_FIELDS,
    filterEntityIds,
    withoutDiscoveryContext,
    withoutFilterField,
    type SearchContextKey,
  } from '$lib/frameleaf/search-chips';
  import { describeFilterChips } from '$lib/frameleaf/search-filters';
  import { searchSplit } from '$lib/frameleaf/search-results';
  import { withArchivePreference } from '$lib/frameleaf/search-palette';
  import { requestFilterPanel, SEARCH_SHORTCUT_EVENT } from '$lib/frameleaf/search-shortcuts';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { mediaQueryManager } from '$lib/stores/media-query-manager.svelte';
  import { Route } from '$lib/route';
  import { lang, locale } from '$lib/stores/preferences.store';
  import { SlideshowState, slideshowStore } from '$lib/stores/slideshow.store';
  import { handlePromiseError } from '$lib/utils';
  import { navigateToAsset } from '$lib/utils/asset-utils';
  import { parseUtcDate } from '$lib/utils/date-time';
  import { handleError } from '$lib/utils/handle-error';
  import { isAlbumsRoute, isPeopleRoute } from '$lib/utils/navigation';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
  import {
    AssetOrder,
    type AssetResponseDto,
    isHttpError,
    ImageEnrichmentFilter,
    updateMyPreferences,
    SearchOrderField,
    type MetadataSearchDto,
    type SmartSearchDto,
  } from '@frameleaf/sdk';
  import { Icon, Theme as AppTheme, themeManager } from '@frameleaf/ui';
  import { mdiContentSaveOutline, mdiImageSearchOutline, mdiMagnify } from '@mdi/js';
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  const ASK_QUERY_PARAMETER = 'ask';
  /** The shape of a first page of results while it loads. */
  const SKELETON_TILES = Array.from({ length: 18 }, (_, index) => index);
  /** Opens the search palette (the one search entry) from the page. */
  const openSearchPalette = () => dispatchEvent(new CustomEvent(SEARCH_SHORTCUT_EVENT));

  // The viewer pushes its own history state, which causes weird behavior for history.back().
  // To prevent that we store the previous page manually and navigate back to that.
  let previousRoute = $state<string>(Route.explore());

  const searchSession = new LibrarySearchSession();
  let scrollRestoreGeneration = 0;
  onDestroy(() => {
    scrollRestoreGeneration++;
    searchSession.destroy();
  });
  const searchResultAssets = $derived(searchSession.assets);
  const isLoading = $derived(searchSession.loading);
  let askQuery = $state('');
  const askResponse = $derived(searchSession.askResponse);
  const assistantResponse = $derived(searchSession.assistantResponse);
  /**
   * DISCOVERY-P5: the results scroll inside the app frame (the layout's page area), not the window.
   * Where they were is kept, so coming back from an item lands on the same row.
   */
  let scroller: HTMLElement | undefined;
  let scrollYHistory = 0;
  const followScroll = (node: HTMLElement) => {
    scroller = node;
    const onScroll = () => {
      if (node.scrollTop) {
        scrollYHistory = node.scrollTop;
      }
    };
    node.addEventListener('scroll', onScroll, { passive: true });
    return {
      destroy: () => {
        node.removeEventListener('scroll', onScroll);
        scroller = undefined;
      },
    };
  };

  type SearchTerms = MetadataSearchDto & Pick<SmartSearchDto, 'query' | 'queryAssetId'>;
  let searchQuery = $derived(page.url.searchParams.get(QueryParameter.QUERY));
  let discoveryParameter = $derived(page.url.searchParams.get(DISCOVERY_QUERY_PARAMETER));
  let askSearchQuery = $derived(page.url.searchParams.get(ASK_QUERY_PARAMETER) ?? '');
  let smartSearchEnabled = $derived(featureFlagsManager.value.smartSearch);
  /**
   * FL-48: what the page shows. A search from the search dialog arrives as the whole shared query
   * (`dq`), so every part of it — the space, the similar-photo reference, the text field — comes back
   * when the dialog is reopened here. A legacy `query` request (a Places card, an explore link) is kept
   * exactly as it was. A payload that cannot be read is reported instead of thrown.
   */
  let searchLocation = $derived(readSearchParameters(discoveryParameter, searchQuery));
  let discoveryQuery = $derived<DiscoveryQuery | undefined>(
    searchLocation.kind === 'discovery' && !isEmptyDiscoverySearch(searchLocation.query)
      ? searchLocation.query
      : undefined,
  );
  let terms = $derived<SearchTerms>(
    discoveryQuery
      ? toSearchDto(discoveryQuery)
      : searchLocation.kind === 'legacy'
        ? (searchLocation.terms as SearchTerms)
        : {},
  );
  let hasSearchQuery = $derived(discoveryQuery !== undefined || Object.keys(terms).length > 0);
  /**
   * FL-31: Ask answers through smart search under the server's `localFeatures.askSearch` settings. The
   * panel shows while search and smart search are on; when an administrator has turned Ask off it
   * says so instead of offering a field that cannot answer.
   */
  let showAskSearch = $derived(featureFlagsManager.value.search && featureFlagsManager.value.smartSearch);
  /** Set when the server answers that Ask is off although the flags said it was on (changed meanwhile). */
  let askTurnedOff = $state(false);
  let canUseAskSearch = $derived(showAskSearch && featureFlagsManager.value.askSearch && !askTurnedOff);
  let askFailed = $state(false);
  const askProblem = $derived<SearchAskProblem | undefined>(
    canUseAskSearch ? (askFailed ? 'failed' : undefined) : 'disabled',
  );
  /**
   * FL-918: the Library Assistant answers questions on servers that offer it (an older server has no
   * `assistant` feature and keeps Ask). Classic search is one tap away and remembered for the person
   * (Settings › Look & playback); the switch takes effect at once while the preference saves.
   */
  let assistantTurnedOff = $state(false);
  let classicChoice = $state<boolean>();
  const classicSearch = $derived(classicChoice ?? !!authManager.preferences?.search?.classic);
  const showAssistant = $derived(
    featureFlagsManager.value.search && !!featureFlagsManager.value.assistant && !assistantTurnedOff,
  );
  const useAssistant = $derived(showAssistant && !classicSearch);
  /** Saves run one after another, in the order the switch was pressed, so an older choice never lands last. */
  let classicSaves: Promise<void> = Promise.resolve();
  const setClassicSearch = (classic: boolean) => {
    if (classic && activeSearch?.kind === 'assistant') {
      void searchSession.reportSwitchBack();
    }
    classicChoice = classic;
    const isCurrent = authManager.captureSession();
    classicSaves = classicSaves.then(async () => {
      try {
        const preferences = await updateMyPreferences({ userPreferencesUpdateDto: { search: { classic } } });
        if (isCurrent()) {
          authManager.setPreferences(preferences);
        }
      } catch (error) {
        handleError(error, $t('frameleaf_assistant_switch_failed'));
      }
    });
    return classicSaves;
  };
  const isAskLoading = $derived(!hasSearchQuery && searchSession.loading);
  /** The results could not be loaded: the page says so with a retry, never "No matches". */
  let loadFailed = $state(false);
  let saving = $state(false);
  let moreActionsOpen = $state(false);
  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
  /** What is loaded so far; "+" while there is more to load, since the search has no cheap total. */
  const hasMore = $derived(searchSession.nextPage !== null || searchSession.nextCursor !== null);

  // With Ask unavailable there is nothing on the empty search page to type into, so the search
  // palette opens by itself, and the page keeps a way back into it.
  onMount(() => {
    if (!hasSearchQuery && !showAskSearch && !useAssistant && searchLocation.kind !== 'rejected') {
      void tick().then(openSearchPalette);
    }
  });

  /**
   * Sort (owner 2026-11-05, prototype `.results-toolbar`): a search is the Library narrowed by it, so
   * it keeps the Library's Sort where the server can order the results. A metadata search orders by
   * capture date or rating; a smart search is ranked by relevance, which no date order can describe,
   * so it shows no Sort control rather than one that does nothing.
   */
  const SEARCH_ORDERS: Partial<Record<LibrarySort, { field: SearchOrderField; direction: AssetOrder }>> = {
    'captured-desc': { field: SearchOrderField.FileCreatedAt, direction: AssetOrder.Desc },
    'captured-asc': { field: SearchOrderField.FileCreatedAt, direction: AssetOrder.Asc },
    rating: { field: SearchOrderField.Rating, direction: AssetOrder.Desc },
  };
  const SEARCH_SORTS = Object.keys(SEARCH_ORDERS) as LibrarySort[];
  const searchSort = $derived<LibrarySort>(
    SEARCH_SORTS.includes(librarySession.state.sort) ? librarySession.state.sort : 'captured-desc',
  );

  // Endpoint and query identity share one request owner. Opening a result changes neither.
  /** ACCOUNT-P3: Search › "Include archived items", as the search palette applies it. */
  const includeArchived = $derived(authManager.authenticated && !!authManager.preferences.search?.includeArchived);
  const activeSearch = $derived.by((): LibrarySearchQuery | null => {
    if (discoveryQuery?.mode === 'speech') {
      return null;
    }
    if (hasSearchQuery) {
      const request = discoveryQuery
        ? structuredSearchRequest(withArchivePreference(toSearchDto(discoveryQuery), includeArchived), null)
        : terms.filter !== undefined || terms.orderBy !== undefined || terms.cursor !== undefined
          ? structuredSearchRequest(withArchivePreference(terms, includeArchived), null)
          : terms;
      // FL-1403: a search by meaning stays one whatever the server offers. The session answers it by
      // text when Visual search is off or refuses; sent to the metadata endpoint as it is, its text
      // would be ignored and the whole library shown.
      const smart = 'query' in request || 'queryAssetId' in request;
      // A flat request (a Places card, an Explore link) keeps asking for the timeline whatever the
      // preference says: it cannot say "timeline or archive", and no visibility at all could bring
      // back the hidden halves of live photos. Only the structured shape carries an order.
      const ordered = !smart && 'filter' in request ? { ...request, orderBy: SEARCH_ORDERS[searchSort] } : request;
      return { kind: smart ? 'smart' : 'metadata', terms: ordered };
    }
    const query = askSearchQuery.trim();
    if (query && useAssistant) {
      return { kind: 'assistant', query };
    }
    return query && canUseAskSearch ? { kind: 'ask', query } : null;
  });

  const activeSearchKey = $derived(JSON.stringify(activeSearch));
  /** The question last taken from the address: a mode switch keeps what the person has typed since. */
  let addressQuestion: string | undefined;
  $effect(() => {
    // Asset-only route navigation and equivalent query objects retain the collection and draft.
    const key = activeSearchKey;
    // FL-1403: a search by meaning starts again when the server begins or stops offering it.
    void (activeSearch?.kind === 'smart' && smartSearchEnabled);
    untrack(() => {
      const query = JSON.parse(key) as LibrarySearchQuery | null;
      searchSession.reset(query);
      askFailed = false;
      loadFailed = false;
      if ((query?.kind === 'ask' || query?.kind === 'assistant') && query.query !== addressQuestion) {
        askQuery = query.query;
      }
      addressQuestion = query?.kind === 'ask' || query?.kind === 'assistant' ? query.query : undefined;
      handlePromiseError(loadNextPage());
    });
  });

  afterNavigate(({ from }) => {
    const owner = ++scrollRestoreGeneration;
    // Prevent setting previousRoute to the current page.
    if (from?.url && from.route.id !== page.route.id) {
      previousRoute = from.url.href;
    }
    const route = from?.route?.id;

    if (isPeopleRoute(route)) {
      previousRoute = Route.photos();
    }

    if (isAlbumsRoute(route)) {
      previousRoute = Route.explore();
    }

    tick()
      .then(() => {
        if (owner === scrollRestoreGeneration) {
          scroller?.scrollTo(0, scrollYHistory);
        }
      })
      .catch(() => {
        // do nothing
      });
  });

  const onAssetDelete = (assetIds: string[]) => searchSession.removeAssets(assetIds);

  const handleSelectAll = () => librarySession.selectAll(searchResultAssets.map((asset) => asset.id));

  const timelineAssets = $derived(searchResultAssets.map((asset) => toTimelineAsset(asset)));
  /** FL-1393: close matches first, looser ones under their own heading; null for one undivided grid. */
  const split = $derived(searchSplit(timelineAssets, searchSession.closeMatches));

  /**
   * FL-45: a short, sanitized summary of what was searched for, so a search download is not just
   * another generic "frameleaf" zip. Prefers the free-text query (typed search or Ask) over a
   * structured term, since it is what the person actually typed; falls back to the first
   * human-readable structured term when the search was built entirely from filters (e.g. from a
   * Places card, which searches by `city` with no free text).
   */
  const searchDownloadText = $derived.by(() => {
    const asked = askResponse ? askQuery.trim() : '';
    if (asked) {
      return asked;
    }
    const typed = typeof terms.query === 'string' ? terms.query.trim() : '';
    if (typed) {
      return typed;
    }
    const textLikeKeys: (keyof SearchTerms)[] = ['originalFileName', 'city', 'country', 'state', 'make', 'model'];
    for (const key of textLikeKeys) {
      const value = terms[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
    return undefined;
  });

  /**
   * FL-45 owner decision (September 22, 2026): a search filtered by person, pet or tag ids names the
   * download after their actual names wherever they can be resolved, instead of leaving the
   * download generic. Kept separate from `searchDownloadText` above (which is synchronous) because
   * resolving a name needs a lookup (`getPerson`/`getTagById`, the same calls `getPersonName`/
   * `getTagNames` below already make for the filter-chip row) — cached and never blocking: a
   * failed or disallowed lookup just leaves that id out rather than failing the download.
   */
  let resolvedFilterNameSegments = $state<string[]>([]);

  /**
   * FL-58: the pets a search is narrowed *to* — the flat `petIds` list, or the positive (`any`/`all`)
   * groups of a structured `filter.petIds` from the search dialog. An excluded pet (`none`) is not a
   * description of the download, so it is never a naming source.
   */
  const searchedIds = (searchTerms: SearchTerms, field: 'personIds' | 'petIds' | 'tagIds'): string[] => {
    const flat = searchTerms[field];
    if (Array.isArray(flat)) {
      return flat;
    }
    // FL-48: a search from the search dialog narrows people and tags inside its structured filter too
    const condition = searchTerms.filter?.[field];
    return [...new Set([...(condition?.any ?? []), ...(condition?.all ?? [])])];
  };

  $effect(() => {
    const personIds = searchedIds(terms, 'personIds');
    const petIds = searchedIds(terms, 'petIds');
    const tagIds = searchedIds(terms, 'tagIds');
    if (personIds.length === 0 && petIds.length === 0 && tagIds.length === 0) {
      resolvedFilterNameSegments = [];
      return;
    }
    let cancelled = false;
    const andMoreLabel = (remaining: number) =>
      $t('frameleaf_archive_name_and_n_more', { values: { count: remaining } });
    handlePromiseError(
      (async () => {
        const personSegments =
          personIds.length > 0
            ? namedEntitySegments(await resolveEntityNames('person', personIds), personIds.length, andMoreLabel)
            : [];
        // A hidden or unnamed pet resolves to null and is never written into the filename
        const petSegments =
          petIds.length > 0
            ? namedEntitySegments(await resolveEntityNames('pet', petIds), petIds.length, andMoreLabel)
            : [];
        const tagSegments =
          tagIds.length > 0
            ? namedEntitySegments(await resolveEntityNames('tag', tagIds), tagIds.length, andMoreLabel)
            : [];
        if (!cancelled) {
          resolvedFilterNameSegments = [...personSegments, ...petSegments, ...tagSegments];
        }
      })(),
    );
    return () => {
      cancelled = true;
    };
  });

  /**
   * FL-49: a structured `filter` (a search from the search dialog) draws one chip per condition, in
   * the search dialog's wording, instead of one raw chip for the whole object. Names come from the
   * cached, access-checked `filter-entity-names` lookups; until one answers the chip shows an
   * ellipsis, and a name that cannot be read (hidden, unnamed, gone, not allowed) falls back to a
   * generic word, so the chip is always there to remove.
   */
  let filterEntityNames = $state<Record<string, string | null>>({});
  /**
   * FL-37: bumped when a person is renamed, hidden or merged away, so the person chips re-read the
   * name (a hidden person's chip falls back to the generic label, as a fresh lookup would).
   */
  let personNamesVersion = $state(0);

  /**
   * The query the chips describe. FL-48: for a search from the dialog it is the shared query itself,
   * not the request derived from it, so a shared space and the default visibility and trash
   * conditions the request adds are never drawn as conditions the person set.
   */
  const chipQuery = $derived<DiscoveryQuery | undefined>(
    discoveryQuery ?? (terms.filter ? { ...emptyDiscoveryQuery(), filter: terms.filter } : undefined),
  );

  $effect(() => {
    void personNamesVersion;
    const groups = filterEntityIds(chipQuery?.filter);
    if (groups.length === 0) {
      return;
    }
    let cancelled = false;
    handlePromiseError(
      (async () => {
        const entries = await Promise.all(
          groups.flatMap(({ field, kind, ids }) =>
            ids.map(async (id) => [entityNameKey(field, id), await resolveEntityName(kind, id)] as const),
          ),
        );
        if (!cancelled) {
          filterEntityNames = { ...filterEntityNames, ...Object.fromEntries(entries) };
        }
      })(),
    );
    return () => {
      cancelled = true;
    };
  });

  const filterChips = $derived(
    chipQuery
      ? describeFilterChips($t, chipQuery, {
          locale: $locale,
          nameFor: (field, id) => {
            const kind = FILTER_ENTITY_FIELDS[field];
            if (!kind) {
              return undefined;
            }
            const key = entityNameKey(field, id);
            if (!Object.hasOwn(filterEntityNames, key)) {
              return '…';
            }
            return filterEntityNames[key] ?? $t(FILTER_ENTITY_FALLBACK_KEYS[kind]);
          },
        })
      : [],
  );

  const searchDownloadFileName = $derived(
    brandedArchiveName($t('frameleaf_archive_name_search'), [searchDownloadText, ...resolvedFilterNameSegments], {
      withDate: true,
    }),
  );

  const updateAsset = (updated: AssetResponseDto) => {
    const index = searchResultAssets.findIndex((asset) => asset.id === updated.id);
    if (index !== -1) {
      searchResultAssets[index] = updated;
    }
  };

  // eslint-disable-next-line svelte/valid-prop-names-in-kit-pages
  export const loadNextPage = async () => {
    const asking = activeSearch?.kind === 'ask' || activeSearch?.kind === 'assistant';
    const assisting = activeSearch?.kind === 'assistant';
    try {
      await searchSession.loadNextPage({
        language: $lang,
        smartSearch: smartSearchEnabled,
        isCurrent: authManager.captureSession(),
      });
    } catch (error) {
      if (!asking) {
        // A first page that fails is the page's own state (with Try again); a later page that fails
        // leaves the results in place and says so in passing.
        if (searchResultAssets.length === 0) {
          loadFailed = true;
        } else {
          handleError(error, $t('loading_search_results_failed'));
        }
        return;
      }
      // FL-918: an administrator turned the assistant off meanwhile; the page goes back to Ask.
      if (assisting && isHttpError(error) && error.status === 400 && /turned off/i.test(error.data?.message ?? '')) {
        assistantTurnedOff = true;
        return;
      }
      // FL-31: Ask shows its own error state; a server that has Ask turned off answers 400.
      if (isHttpError(error) && error.status === 400 && /not enabled/i.test(error.data?.message ?? '')) {
        askTurnedOff = true;
        return;
      }
      askFailed = true;
    }
  };

  const retrySearch = () => {
    loadFailed = false;
    searchSession.reset(JSON.parse(activeSearchKey) as LibrarySearchQuery | null);
    handlePromiseError(loadNextPage());
  };

  /** Clear all, and "Clear search and filters": the search narrowed the Library, so back to all of it (App.jsx). */
  const clearSearch = () => {
    librarySession.clearSelection();
    void goto(Route.photos());
  };

  /**
   * FL-1393 (prototype `searchTitle`): a search for words is titled with them ("Results for “lake”"),
   * and the words leave the chip row. A spoken-words search keeps its chip, which says what kind it is.
   */
  const titleText = $derived(
    discoveryQuery
      ? discoveryQuery.mode === 'speech'
        ? ''
        : discoveryQuery.text.trim()
      : typeof terms.query === 'string'
        ? terms.query.trim()
        : '',
  );
  /** The chips beside the filters: every part of a search from the dialog but the words in the title. */
  const contextChips = $derived(
    discoveryQuery ? discoveryContextChips(discoveryQuery).filter((chip) => !(titleText && chip.key === 'text')) : [],
  );
  /**
   * FL-1457 (N4): a search by meaning that fell back to text says so with a chip ("All text: lake"), which explains
   * the Filter badge's count of the words and removes them as Clear search does.
   */
  const textFallbackChip = $derived(
    searchSession.textFallback && titleText ? `${$t('frameleaf_search_mode_all_text')}: ${titleText}` : '',
  );
  /** An old-style link's own fields, each a chip, again without the words in the title. */
  const legacyKeys = $derived(
    discoveryQuery ? [] : getObjectKeys(terms).filter((key) => key !== 'filter' && !(titleText && key === 'query')),
  );
  /** Clear search: the same search without its words; with nothing else narrowing it, the whole Library. */
  const clearSearchText = () => {
    if (discoveryQuery) {
      const rest = withoutDiscoveryContext(discoveryQuery, 'text');
      if (isEmptyDiscoverySearch(rest)) {
        clearSearch();
        return;
      }
      librarySession.clearSelection();
      void goto(discoveryUrl(rest));
      return;
    }
    const rest = { ...terms };
    delete rest.query;
    if (Object.keys(rest).length === 0) {
      clearSearch();
      return;
    }
    librarySession.clearSelection();
    void goto(Route.search(rest));
  };

  /** How many things narrow the results, for the Filter badge (the Library counts the search text too). */
  const chipCount = $derived(
    filterChips.length +
      (discoveryQuery
        ? discoveryContextChips(discoveryQuery).length
        : getObjectKeys(terms).filter((key) => key !== 'filter').length),
  );

  /** The search is ranked (smart search), so no date order applies to it. */
  const ranked = $derived(activeSearch?.kind === 'smart');
  /** The Library's layouts (LibraryView): List is Browse's and Work's rows, never the Timeline's. */
  const listView = $derived(librarySession.layout !== 'timeline' && librarySession.state.view === 'list');
  const changeView = (view: 'grid' | 'list') => {
    if (view === 'list' && librarySession.layout === 'timeline') {
      showLibraryLayout(librarySession, 'browse');
    }
    librarySession.patchView({ view });
  };
  /** LibraryView's information panel: Work opens it beside the results above 1000px. */
  const canShowInfoPanel = $derived(!mediaQueryManager.maxMd);
  let inspectorOpen = $state(untrack(() => librarySession.layout === 'work' && mediaQueryManager.wideInspector));
  let inspectorLayout: string | undefined;
  $effect(() => {
    const layout = librarySession.layout;
    if (inspectorLayout !== undefined && layout !== inspectorLayout) {
      inspectorOpen = layout === 'work' && untrack(() => mediaQueryManager.wideInspector);
    }
    inspectorLayout = layout;
  });
  const showInfoPanel = $derived(canShowInfoPanel && inspectorOpen && hasSearchQuery && timelineAssets.length > 0);
  /** The item the panel describes: the last selected, the one in focus, or the first result (prototype). */
  const inspectedAsset = $derived.by(() => {
    const id = librarySession.selection.at(-1) ?? librarySession.session.scrollAnchor;
    return (id ? timelineAssets.find((asset) => asset.id === id) : undefined) ?? timelineAssets[0] ?? null;
  });
  /**
   * Work with the panel beside the results (FL-1117): a click shows the item in the panel and a
   * second click on it opens it; every other layout opens on one click.
   */
  let workClickedId: string | undefined;
  const openResult = (asset: TimelineAsset) => {
    if (librarySession.layout === 'work' && showInfoPanel && workClickedId !== asset.id) {
      workClickedId = asset.id;
      librarySession.setScrollAnchor(asset.id);
      return;
    }
    void navigateToAsset(asset);
  };
  /**
   * FL-1457 (FL-1391 B1, LibraryView `tabsInToolbar`): with 960px of results area the layout tabs sit in the toolbar,
   * where each tab's tooltip says what it is for; a narrower one keeps them on their own row with the hint.
   */
  const TABS_IN_TOOLBAR = 960;
  let pageWidth = $state(0);
  let gridWidth = $state(0);
  const tabsInToolbar = $derived((showInfoPanel && gridWidth ? gridWidth : pageWidth) >= TABS_IN_TOOLBAR);
  /** The Library's Filter badge: the search text and every condition, as the chips show them. */
  const unappliedFields = $derived(['text', ...activeFilterFields(librarySession.query)]);

  /** The Library's Slideshow (LibraryView `startSlideshow`): from the first result, in the viewer. */
  const startSlideshow = async () => {
    const first = timelineAssets[0];
    if (!first) {
      return;
    }
    await navigateToAsset(first);
    slideshowStore.slideshowState.set(SlideshowState.PlaySlideshow);
  };

  /** The same search without the album or shared space it was started in. */
  const widerQuery = $derived.by((): DiscoveryQuery | undefined => {
    if (!discoveryQuery) {
      return undefined;
    }
    if (discoveryQuery.spaceId) {
      return withoutDiscoveryContext(discoveryQuery, 'spaceId');
    }
    return discoveryQuery.filter.albumIds ? withoutDiscoveryFilter(discoveryQuery, 'albumIds') : undefined;
  });
  /** The same words without any filter, when the search has both. */
  const unfilteredQuery = $derived(
    discoveryQuery?.text.trim() && filterChips.length > 0
      ? { ...discoveryQuery, filter: {}, imageEnrichment: undefined }
      : undefined,
  );
  /**
   * FL-1412 (M13): the search answered and nothing matches, so the page is its empty state. The title
   * and the chips stay (what was asked, each condition removable); the layout tabs, the results toolbar
   * and the Thumbnail size bar have nothing to arrange.
   */
  const noMatches = $derived(
    hasSearchQuery && discoveryQuery?.mode !== 'speech' && !isLoading && !loadFailed && searchResultAssets.length === 0,
  );
  /**
   * FL-1457 (prototype EmptyState.jsx, "Search, no matches"): words ask for fewer words, and for clearing the filters
   * only when the page has some; a search of filters alone keeps the Library's words.
   */
  const emptyMessageKey = $derived(
    titleText
      ? contextChips.length + filterChips.length + legacyKeys.length > 0
        ? 'frameleaf_search_empty_fewer_words_or_filters'
        : 'frameleaf_search_empty_fewer_words'
      : 'frameleaf_library_empty_filtered_message',
  );
  let momentsFound = $state<number | undefined>(0);
  /** FL-1457: the moments strip is still asking, so the page waits before calling the search empty. */
  const momentsPending = $derived(
    momentsFound === undefined && typeof terms.query === 'string' && !!terms.query.trim(),
  );
  const emptyClear = $derived({ label: $t('frameleaf_library_empty_filtered_clear'), onClick: clearSearch });
  const emptySecondary = $derived(
    widerQuery
      ? {
          label: $t('frameleaf_search_results_entire_library'),
          onClick: () => void goto(discoverySearchUrl(widerQuery)),
        }
      : unfilteredQuery
        ? {
            label: $t('frameleaf_search_results_remove_filters'),
            onClick: () => void goto(discoverySearchUrl(unfilteredQuery)),
          }
        : undefined,
  );

  function retryAsk() {
    const query = askSearchQuery.trim();
    if (!query) {
      return;
    }
    askFailed = false;
    searchSession.reset({ kind: useAssistant ? 'assistant' : 'ask', query });
    handlePromiseError(loadNextPage());
  }

  function getHumanReadableDate(dateString: string) {
    const date = parseUtcDate(dateString).startOf('day');
    return formatLuxon(date, { year: 'numeric', month: 'long', day: 'numeric' }, $locale);
  }

  function getHumanReadableSearchKey(key: keyof SearchTerms): string {
    const keyMap: Partial<Record<keyof SearchTerms, string>> = {
      takenAfter: $t('start_date'),
      takenBefore: $t('end_date'),
      visibility: $t('in_archive'),
      isFavorite: $t('favorite'),
      isNotInAlbum: $t('not_in_any_album'),
      type: $t('media_type'),
      query: $t('search'),
      city: $t('city'),
      country: $t('country'),
      state: $t('state'),
      make: $t('camera_brand'),
      model: $t('camera_model'),
      lensModel: $t('lens_model'),
      personIds: $t('people'),
      petIds: $t('frameleaf_pets_title'),
      tagIds: $t('tags'),
      originalFileName: $t('file_name_text'),
      originalPath: $t('full_path_or_folder'),
      description: $t('description'),
      queryAssetId: $t('frameleaf_search_bridge_similar_photo'),
      ocr: $t('frameleaf_search_mode_ocr'),
      imageEnrichment: $t('frameleaf_search_enrichment'),
    };
    return keyMap[key] || key;
  }

  function getHumanReadableImageEnrichmentFilter(filter: string) {
    switch (filter) {
      case ImageEnrichmentFilter.Nsfw: {
        return $t('image_enrichment_filter_nsfw');
      }
      case ImageEnrichmentFilter.NsfwReview: {
        return $t('image_enrichment_filter_nsfw_review');
      }
      case ImageEnrichmentFilter.NsfwReviewed: {
        return $t('image_enrichment_filter_nsfw_reviewed');
      }
      case ImageEnrichmentFilter.NsfwOverridden: {
        return $t('image_enrichment_filter_nsfw_overridden');
      }
      case ImageEnrichmentFilter.ImageDescriptionFailed: {
        return $t('image_enrichment_filter_description_failed');
      }
      case ImageEnrichmentFilter.NsfwDetectionFailed: {
        return $t('image_enrichment_filter_nsfw_failed');
      }
      case ImageEnrichmentFilter.MissingImageDescription: {
        return $t('image_enrichment_filter_missing_description');
      }
      case ImageEnrichmentFilter.MissingNsfwDetection: {
        return $t('image_enrichment_filter_missing_nsfw');
      }
      default: {
        return filter;
      }
    }
  }

  async function getPersonName(personIds: string[]) {
    const names = await resolveEntityNames('person', personIds);
    return names.map((name) => name ?? $t('no_name')).join(', ');
  }

  async function getPetNames(petIds: string[]) {
    const names = await resolveEntityNames('pet', petIds);
    return names.map((name) => name ?? $t('frameleaf_pets_unnamed')).join(', ');
  }

  async function getTagNames(tagIds: string[] | null) {
    if (tagIds === null) {
      return $t('untagged');
    }
    const names = await resolveEntityNames('tag', tagIds);
    return names.map((name) => name ?? $t('tags')).join(', ');
  }

  const refreshPersonNames = (ids: string[]) => {
    forgetEntityNames('person', ids);
    personNamesVersion++;
  };
  const onPersonUpdate = ({ id }: { id: string }) => refreshPersonNames([id]);
  const onPersonFacesChange = ({ removedPersonIds = [] }: { removedPersonIds?: string[] }) => {
    if (removedPersonIds.length > 0) {
      refreshPersonNames(removedPersonIds);
    }
  };

  const onAlbumAddAssets = ({ assetIds }: { assetIds: string[] }) => {
    librarySession.clearSelection();

    if (terms.isNotInAlbum || terms.filter?.hasAlbums?.eq === false) {
      searchSession.removeAssets(assetIds);
    }
  };

  function getObjectKeys<T extends object>(obj: T): (keyof T)[] {
    return Object.keys(obj) as (keyof T)[];
  }

  function removeFilter(key: keyof SearchTerms) {
    const nextTerms = { ...terms };
    delete nextTerms[key];
    librarySession.clearSelection();
    void goto(Route.search(nextTerms));
  }

  /** FL-49: remove one condition of the structured filter, keeping the rest of the search. */
  function removeFilterCondition(field: string) {
    librarySession.clearSelection();
    if (discoveryQuery) {
      void goto(discoverySearchUrl(withoutDiscoveryFilter(discoveryQuery, field)));
      return;
    }
    void goto(Route.search(withoutFilterField(terms, field)));
  }

  /** FL-48: remove the text, the similar-photo reference or the space, keeping everything else. */
  function removeContext(key: SearchContextKey) {
    if (!discoveryQuery) {
      return;
    }
    librarySession.clearSelection();
    void goto(discoverySearchUrl(withoutDiscoveryContext(discoveryQuery, key)));
  }

  /** The results page for a query; one that no longer narrows anything is the plain search page. */
  const discoverySearchUrl = (query: DiscoveryQuery) =>
    isEmptyDiscoverySearch(query) ? Route.search() : discoveryUrl(query);

  async function updateAskSearchUrl(query: string) {
    const normalizedQuery = query.trim();
    if (!normalizedQuery || isAskLoading) {
      return;
    }

    const url = new URL(page.url.href);
    url.searchParams.delete(QueryParameter.QUERY);
    url.searchParams.delete(DISCOVERY_QUERY_PARAMETER);
    url.searchParams.set(ASK_QUERY_PARAMETER, normalizedQuery);

    if (url.href === page.url.href) {
      searchSession.reset({ kind: useAssistant ? 'assistant' : 'ask', query: normalizedQuery });
      await loadNextPage();
      return;
    }

    await goto(url, { reset: false });
  }

  async function loadNextAskPage() {
    await loadNextPage();
  }
</script>

<OnEvents {onAlbumAddAssets} {onPersonUpdate} {onPersonFacesChange} />

<!--
  DISCOVERY-P5: the results stay inside the app frame, as the prototype shows them in the library:
  the top bar with its search entry (which reads this search back from the address), the rail and,
  on a phone, the tab bar. The Frameleaf selection bar floats over the results.
-->
<UserPageLayout use={[followScroll]}>
  <div class="search-page" bind:clientWidth={pageWidth}>
    {#if hasSearchQuery}
      <!--
        Owner 2026-11-05 (prototype App.jsx): a search is the Library narrowed by it, not a page of
        its own. The Library's header, then the active-filter bar (the search and every condition as a
        chip, Clear all at the end), then the results toolbar over the grid.
      -->
      <header class="search-head">
        {#if titleText}
          <!-- FL-1393: a search for words is titled with what was asked, Clear search beside it. -->
          <h1 class="search-title">{$t('frameleaf_search_results_for', { values: { query: titleText } })}</h1>
          <button type="button" class="search-clear-text" onclick={clearSearchText}>
            {$t('frameleaf_search_results_clear')}
          </button>
        {:else}
          <h1 class="search-title">{$t('library')}</h1>
        {/if}
      </header>
      <!-- FL-707 P2/12 (LibraryView `.fl-library-layouts`): the layout tabs and what each is for. -->
      {#if !noMatches && !tabsInToolbar}
        <div class="frameleaf search-layouts" data-theme={appTheme}>
          <p class="search-layout-hint">{$t(LAYOUT_HINTS[librarySession.layout])}</p>
          <LibraryLayoutSwitch session={librarySession} />
        </div>
      {/if}
      <!-- Prototype `.active-filter-bar`; the Library's chips (FilterChip); an old-style link keeps the palette's SearchChip. -->
      {#if contextChips.length + filterChips.length + legacyKeys.length > 0 || textFallbackChip}
        <section
          id="search-chips"
          class="frameleaf search-chips"
          data-theme={appTheme}
          aria-label={$t('frameleaf_search_active_filters')}
        >
          <div class="search-chip-list">
            {#if textFallbackChip}
              <FilterChip
                label={textFallbackChip}
                removeLabel={$t('frameleaf_search_remove_filter', { values: { filter: textFallbackChip } })}
                onRemove={clearSearchText}
              />
            {/if}
            {#if discoveryQuery}
              <!-- FL-48: the similar-photo reference and the space are chips of their own, and so are the
                 words of a spoken-words search; other words are the page's title (FL-1393). -->
              {#each contextChips as chip (chip.key)}
                <!-- Prototype: the search text is its own words beside the magnifier ("lake"). -->
                {@const label =
                  chip.key === 'text' && discoveryQuery.mode !== 'speech' && chip.value
                    ? chip.value
                    : chip.value
                      ? `${$t(chip.labelKey)}: ${chip.value}`
                      : $t(chip.labelKey)}
                <FilterChip
                  {label}
                  icon={chip.key === 'text' ? mdiMagnify : undefined}
                  removeLabel={$t('frameleaf_search_remove_filter', { values: { filter: label } })}
                  onRemove={() => removeContext(chip.key)}
                />
              {/each}
            {/if}
            {#each filterChips as chip (chip.field)}
              <FilterChip
                label={chip.label}
                removeLabel={$t('frameleaf_search_remove_filter', { values: { filter: chip.label } })}
                onRemove={() => removeFilterCondition(chip.field)}
                onOpen={discoveryQuery ? () => requestFilterPanel(filterSectionForField(chip.field)) : undefined}
              />
            {/each}
            {#if !discoveryQuery}
              {#each legacyKeys as searchKey (searchKey)}
                {@const value = terms[searchKey]}
                {@const name = getHumanReadableSearchKey(searchKey as keyof SearchTerms)}
                <SearchChip
                  removeLabel={$t('frameleaf_search_remove_filter', { values: { filter: name } })}
                  onRemove={() => removeFilter(searchKey as keyof SearchTerms)}
                >
                  {name}{#if value !== true && searchKey !== 'queryAssetId'}:
                    {#if (searchKey === 'takenAfter' || searchKey === 'takenBefore') && typeof value === 'string'}
                      {getHumanReadableDate(value)}
                    {:else if searchKey === 'personIds' && Array.isArray(value)}
                      {#key personNamesVersion}
                        {#await getPersonName(value) then personName}
                          {personName}
                        {/await}
                      {/key}
                    {:else if searchKey === 'petIds' && Array.isArray(value)}
                      {#await getPetNames(value) then petNames}
                        {petNames}
                      {/await}
                    {:else if searchKey === 'tagIds' && (Array.isArray(value) || value === null)}
                      {#await getTagNames(value) then tagNames}
                        {tagNames}
                      {/await}
                    {:else if searchKey === 'rating'}
                      {$t('rating_count', { values: { count: value ?? 0 } })}
                    {:else if searchKey === 'imageEnrichment' && typeof value === 'string'}
                      {getHumanReadableImageEnrichmentFilter(value)}
                    {:else if value === null || value === ''}
                      {$t('unknown')}
                    {:else}
                      {value}
                    {/if}
                  {/if}
                </SearchChip>
              {/each}
            {/if}
          </div>
          <button type="button" class="search-clear" onclick={clearSearch}>{$t('clear_all')}</button>
        </section>
      {/if}
      <!-- Prototype `.results-toolbar`: the Library's own toolbar (LibraryView), over this search. -->
      {#if !noMatches}
        <div class="frameleaf search-toolbar" data-theme={appTheme}>
          <ResultsToolbar
            session={librarySession}
            activeCount={chipCount}
            {unappliedFields}
            onOpenFilterPanel={(section) => requestFilterPanel(section)}
            onSlideshow={discoveryQuery?.mode === 'speech' || timelineAssets.length === 0
              ? undefined
              : () => handlePromiseError(startSlideshow())}
            inspectorOpen={canShowInfoPanel ? inspectorOpen : undefined}
            onToggleInspector={() => (inspectorOpen = !inspectorOpen)}
            sorts={ranked || discoveryQuery?.mode === 'speech' ? undefined : SEARCH_SORTS}
            sort={searchSort}
            onSortChange={(sort) => librarySession.patchView({ sort })}
            view={listView ? 'list' : 'grid'}
            onViewChange={changeView}
            onMoreActions={() => (moreActionsOpen = true)}
            count={hasMore || isLoading || loadFailed ? null : searchResultAssets.length}
            leading={hasMore ? loadedCount : undefined}
            start={tabsInToolbar ? toolbarTabs : undefined}
          >
            {#if discoveryQuery && discoveryQuery.mode !== 'speech'}
              <button type="button" class="search-tool" onclick={() => (saving = true)}>
                <Icon icon={mdiContentSaveOutline} size="16" aria-hidden />
                <span class="search-tool-label">{$t('frameleaf_search_save_search')}</span>
              </button>
            {/if}
          </ResultsToolbar>
        </div>
      {/if}
    {/if}

    <!-- FL-1393 (prototype `.search-section`): close matches first, the looser ones under their own heading. -->
    {#snippet bestHeading()}
      <h2 class="search-section">{$t('frameleaf_search_results_best')} <small>{split?.best.length}</small></h2>
    {/snippet}
    {#snippet moreHeading()}
      <h2 class="search-section">
        {$t('frameleaf_search_results_more')}
        <small>{$t('frameleaf_search_results_looser', { values: { count: split?.rest.length ?? 0 } })}</small>
      </h2>
    {/snippet}

    {#snippet toolbarTabs()}
      <LibraryLayoutSwitch session={librarySession} />
    {/snippet}

    {#snippet loadedCount()}
      <!-- More results are still to load: the count says so ("48+ items"). -->
      <p class="search-count" role="status">
        {$t('frameleaf_search_results_count', { values: { count: searchResultAssets.length, more: 'yes' } })}
      </p>
    {/snippet}

    <section id="search-content" class="search-content">
      {#if searchLocation.kind === 'rejected'}
        <!-- FL-48: a damaged or newer search link fails safely and says why, instead of erroring. -->
        <p class="mx-auto mt-24 max-w-3xl px-6 text-center text-sm text-(--fl-muted)" role="status">
          {$t(
            searchLocation.problem === 'unsupported-version'
              ? 'frameleaf_search_bridge_link_newer'
              : 'frameleaf_search_bridge_link_damaged',
          )}
        </p>
      {/if}
      {#if hasSearchQuery && searchSession.textFallback}
        <SearchByTextNotice />
      {/if}
      {#if typeof terms.query === 'string' && terms.query.trim()}
        <!-- FL-59: timestamped moments inside the person's own videos, above the photo results. -->
        <VideoMomentResults query={terms.query} assets={searchResultAssets} bind:found={momentsFound} />
      {/if}
      {#if discoveryQuery?.mode === 'speech'}
        <SpokenWordsResults query={discoveryQuery} />
      {:else if !hasSearchQuery && useAssistant}
        <!-- FL-918: the Library Assistant search beta (AssistantSearch.svelte, prototype FL-799). -->
        <div class="mt-16 flex w-full flex-col px-4 pb-16 sm:px-6">
          <AssistantSearch
            bind:query={askQuery}
            response={assistantResponse}
            loading={isAskLoading}
            problem={askFailed ? 'failed' : undefined}
            onAsk={(query) => handlePromiseError(updateAskSearchUrl(query))}
            onRetry={retryAsk}
            onClassic={() => handlePromiseError(setClassicSearch(true))}
            onOpen={(asset) => void navigateToAsset(asset)}
          />
        </div>
      {:else if !hasSearchQuery && showAskSearch}
        <!-- FL-31: Ask about your photos, in the search palette's language (SearchAsk.svelte). -->
        <div class="mx-auto mt-24 flex w-full max-w-5xl flex-col gap-8 px-2 sm:px-6">
          {#if showAssistant}
            <div class="flex justify-end">
              <AssistantModeSwitch classic onChange={(classic) => handlePromiseError(setClassicSearch(classic))} />
            </div>
          {/if}
          <SearchAsk
            bind:query={askQuery}
            response={askResponse}
            loading={isAskLoading}
            problem={askProblem}
            matches={searchResultAssets.length}
            onAsk={(query) => handlePromiseError(updateAskSearchUrl(query))}
            onRetry={retryAsk}
          />

          {#if askResponse && searchResultAssets.length > 0}
            <ResultsView
              assets={timelineAssets}
              downloadFileName={searchDownloadFileName}
              onEndReached={() => void loadNextAskPage()}
              onRemoved={onAssetDelete}
              onSelectAll={handleSelectAll}
              onOpen={(asset) => void navigateToAsset(asset)}
            />
          {/if}
        </div>
      {:else if hasSearchQuery && searchResultAssets.length > 0}
        <div class="search-body">
          <div class="search-grid" bind:clientWidth={gridWidth}>
            <ResultsView
              assets={timelineAssets}
              sections={split
                ? [
                    { assets: split.best, header: bestHeading },
                    { assets: split.rest, header: moreHeading },
                  ]
                : undefined}
              layout={listView ? 'list' : undefined}
              downloadFileName={searchDownloadFileName}
              onEndReached={() => void loadNextPage()}
              onRemoved={onAssetDelete}
              onSelectAll={handleSelectAll}
              onOpen={openResult}
            />
          </div>
          {#if showInfoPanel}
            <aside
              class="frameleaf search-panel"
              data-theme={appTheme}
              aria-label={$t('frameleaf_work_inspector_title')}
            >
              <LibraryWorkInspector
                asset={inspectedAsset}
                selectedCount={librarySession.selection.length}
                onOpen={(asset) => void navigateToAsset(asset)}
                onClose={() => (inspectorOpen = false)}
              />
            </aside>
          {/if}
        </div>
      {:else if hasSearchQuery && loadFailed}
        <div class="frameleaf search-state" data-theme={appTheme}>
          <InlineError
            title={$t('frameleaf_search_results_failed_title')}
            message={$t('frameleaf_search_failed_hint')}
            onRetry={retrySearch}
          />
        </div>
      {:else if hasSearchQuery && !isLoading && momentsPending}
        <!-- FL-1457: photos answered with nothing, moments in videos have not answered yet. -->
      {:else if hasSearchQuery && !isLoading && (momentsFound ?? 0) > 0 && typeof terms.query === 'string' && terms.query.trim()}
        <!-- FL-1457 (N2): only moments in videos matched; the strip above stays, with one quiet line under it. -->
        <p class="frameleaf search-moments-only" data-theme={appTheme} role="status">
          {$t('frameleaf_search_moments_only', { values: { query: titleText, count: momentsFound } })}
        </p>
      {:else if hasSearchQuery && !isLoading}
        <!-- The Library's filtered empty state (App.jsx "No matching media"), with the way out of the
             album or space the search started in, or past its filters, when there is one. -->
        <div class="frameleaf search-state" data-theme={appTheme}>
          <!-- FL-1412 (M13): clearing is the one action; a search that began in an album or under filters
               leads with the wider search and keeps clearing beside it. -->
          <EmptyState
            icon={mdiImageSearchOutline}
            title={$t('frameleaf_library_empty_filtered_title')}
            message={$t(emptyMessageKey)}
            action={emptySecondary ?? emptyClear}
            secondaryAction={emptySecondary ? emptyClear : undefined}
          />
        </div>
      {:else if !hasSearchQuery && !showAskSearch && (showAssistant || searchLocation.kind !== 'rejected')}
        <div class="frameleaf search-state" data-theme={appTheme}>
          {#if showAssistant}
            <AssistantModeSwitch classic onChange={(classic) => handlePromiseError(setClassicSearch(classic))} />
          {/if}
          {#if searchLocation.kind !== 'rejected'}
            <EmptyState
              icon={mdiMagnify}
              title={$t('frameleaf_search_title')}
              message={$t('frameleaf_search_results_start_body')}
              action={{ label: $t('search'), icon: mdiMagnify, onClick: openSearchPalette }}
            />
          {/if}
        </div>
      {/if}

      {#if isLoading && hasSearchQuery && searchResultAssets.length === 0}
        <!-- The first page is on its way: the grid's shape rather than a spinner. -->
        <div class="frameleaf search-skeleton" data-theme={appTheme} aria-busy="true">
          <span class="sr-only">{$t('loading')}</span>
          {#each SKELETON_TILES as tile (tile)}
            <Skeleton variant="tile" />
          {/each}
        </div>
      {:else if isLoading && searchResultAssets.length > 0}
        <div class="frameleaf search-more" data-theme={appTheme}>
          <Spinner size="xl" />
        </div>
      {/if}
    </section>
  </div>
  {#if hasSearchQuery && discoveryQuery?.mode !== 'speech' && !noMatches}
    <!-- The Library's status capsule (App.jsx footer): the count, the selection and Thumbnail size. -->
    <div class="frameleaf search-status" data-theme={appTheme}>
      <LibraryStatusBar
        count={searchResultAssets.length}
        more={hasMore}
        selected={librarySession.selection.length}
        saved
        hidden={librarySession.selection.length > 0}
      >
        {#snippet controls()}
          <ThumbnailSizeControl />
        {/snippet}
      </LibraryStatusBar>
    </div>
  {/if}
</UserPageLayout>

{#if moreActionsOpen}
  <!-- LibraryView's "More library actions" sheet: on a phone the one-line toolbar leaves these here. -->
  <div class="frameleaf search-dialogs" data-theme={appTheme}>
    <Dialog bind:open={moreActionsOpen} title={$t('frameleaf_library_view_actions_title')} closeLabel={$t('close')}>
      <div class="search-action-list">
        <Button
          disabled={timelineAssets.length === 0}
          onclick={() => {
            moreActionsOpen = false;
            handleSelectAll();
          }}
        >
          {$t('frameleaf_library_select_all_matching_count', { values: { count: timelineAssets.length } })}
        </Button>
        {#if discoveryQuery?.mode !== 'speech'}
          <Button
            disabled={timelineAssets.length === 0}
            onclick={() => {
              moreActionsOpen = false;
              handlePromiseError(startSlideshow());
            }}
          >
            {$t('slideshow')}
          </Button>
        {/if}
        <Button
          onclick={() => {
            moreActionsOpen = false;
            changeView(listView ? 'grid' : 'list');
          }}
        >
          {$t(listView ? 'frameleaf_library_grid_view' : 'frameleaf_library_list_view')}
        </Button>
        {#if canShowInfoPanel}
          <Button
            onclick={() => {
              moreActionsOpen = false;
              inspectorOpen = !inspectorOpen;
            }}
          >
            {$t(inspectorOpen ? 'frameleaf_work_inspector_hide' : 'frameleaf_work_inspector_show')}
          </Button>
        {/if}
        {#if discoveryQuery && discoveryQuery.mode !== 'speech'}
          <Button
            onclick={() => {
              moreActionsOpen = false;
              saving = true;
            }}
          >
            {$t('frameleaf_search_save_search')}
          </Button>
        {/if}
      </div>
    </Dialog>
  </div>
{/if}

{#if discoveryQuery}
  <div class="frameleaf search-dialogs" data-theme={appTheme}>
    <SearchSaveDialog bind:open={saving} query={discoveryQuery} defaultName={discoveryQuery.text.trim()} />
  </div>
{/if}

<ResultsAssetViewer
  assets={searchResultAssets}
  onAssetChange={updateAsset}
  onRemove={(id) => onAssetDelete([id])}
  emptyRoute={previousRoute}
/>

<style>
  /*
   * The Library's frame (LibraryView `.fl-library-header`, `.fl-library-toolbar`): the page area's
   * 8px plus 16px make the 24px gutter (8px plus 8px on a phone), and the header's hairline and the
   * toolbar's band run edge to edge across the page area.
   */
  .search-page {
    --search-bleed: calc(-1 * (var(--fl-page-inline, var(--fl-space-4)) + var(--fl-space-2)));
    display: flex;
    flex-direction: column;
    padding: 0 var(--fl-page-inline, var(--fl-space-4)) var(--fl-space-12);
  }
  .search-head,
  .search-layouts,
  .search-chips {
    position: relative;
  }
  /* Prototype `h1.search-title`: the title, and Clear search on its baseline. */
  .search-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--fl-space-1) var(--fl-space-4);
    padding: calc(var(--fl-page-top) - var(--fl-space-2)) 0 var(--fl-space-3);
  }
  .search-clear-text {
    flex-shrink: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--fl-accent);
    font-size: 14px;
    white-space: nowrap;
  }
  .search-clear-text:hover {
    text-decoration: underline;
  }
  /* Prototype `.search-section`: a heading over each part of the results, its count beside it. */
  .search-section {
    display: flex;
    align-items: baseline;
    gap: var(--fl-space-2);
    margin: 0;
    padding: var(--fl-space-5) 0 var(--fl-space-3);
    color: var(--fl-text);
    font-size: 17px;
    font-weight: 600;
  }
  .search-section small {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    font-weight: 400;
  }
  .search-head::after,
  .search-layouts::after,
  .search-chips::after {
    content: '';
    position: absolute;
    bottom: 0;
    inset-inline: var(--search-bleed);
    border-bottom: 1px solid var(--fl-border);
    pointer-events: none;
  }
  /* The Library's title (`.fl-library-title`). */
  .search-title {
    min-width: 0;
    margin: 0;
    overflow-wrap: anywhere;
    color: var(--fl-text);
    font-size: 30px;
    font-weight: 700;
    letter-spacing: -0.02em;
    line-height: 1.15;
  }
  /* LibraryView `.fl-library-layouts`: the hint at the start, the layout tabs at the end. */
  .search-layouts {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-4);
    padding-block: var(--fl-space-2);
    background: transparent;
  }
  .search-layout-hint {
    min-width: 0;
    margin: 0;
    overflow: hidden;
    color: var(--fl-muted);
    font-size: 13px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .search-layouts > :global(.fl-layouts) {
    margin-inline-start: auto;
  }
  /* Prototype `.active-filter-bar`: the chips at the start, Clear all at the end. */
  .search-chips {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-3);
    min-height: calc(var(--fl-control-height) + var(--fl-space-4));
    padding-block: var(--fl-space-2);
    background: transparent;
  }
  .search-chip-list {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-2);
    min-width: 0;
  }
  .search-clear {
    flex-shrink: 0;
    min-height: var(--fl-control-height);
    padding: 0 var(--fl-space-3);
    border: 0;
    border-radius: var(--fl-radius-control);
    background: transparent;
    color: var(--fl-accent);
    font-size: var(--fl-font-small);
    white-space: nowrap;
  }
  .search-clear:hover {
    background: var(--fl-raised);
  }
  /* Prototype `.results-toolbar` on the Library's frosted band, which stays while the grid scrolls. */
  .search-toolbar {
    position: sticky;
    top: 0;
    z-index: 5;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-2) var(--fl-space-3);
    background: transparent;
  }
  .search-toolbar > :global(*) {
    flex: 1 1 auto;
    min-width: 0;
  }
  .search-toolbar::before {
    content: '';
    position: absolute;
    inset-block: 0;
    inset-inline: var(--search-bleed);
    z-index: -1;
    border-bottom: 1px solid var(--fl-material-edge);
    background: var(--fl-material);
    -webkit-backdrop-filter: var(--fl-material-blur);
    backdrop-filter: var(--fl-material-blur);
  }
  .search-count {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  /* ResultsToolbar `.fl-filter-button` / `.fl-tool`. */
  .search-tool {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-2);
    min-height: var(--fl-control-height);
    padding: 0 var(--fl-space-3);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: transparent;
    color: var(--fl-text);
    font-size: var(--fl-font-size, 14px);
  }
  .search-tool:hover:not(:disabled) {
    background: var(--fl-raised);
  }
  .search-tool:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  /* The grid starts under the band, at the photo gutter. */
  .search-content {
    padding-top: var(--fl-space-half);
  }
  /* FL-1457 (N2, review-1111.css `.fl1456-quiet`): one muted line, 12px under the moments strip. */
  .search-moments-only {
    margin: var(--fl-space-3) 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    background: transparent;
  }
  /* LibraryView `.fl-library-body`: the results, and Work's information panel beside them. */
  .search-body {
    display: flex;
    align-items: flex-start;
    gap: var(--fl-space-4);
  }
  .search-grid {
    flex: 1 1 auto;
    min-width: 0;
  }
  /* LibraryView `.fl-library-panel`, kept in view while the results scroll. */
  .search-panel {
    position: sticky;
    top: calc(var(--fl-control-height) + var(--fl-space-6));
    flex: 0 0 320px;
    max-height: calc(100vh - 12rem);
    overflow-y: auto;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-panel);
  }
  .search-status {
    background: transparent;
  }
  .search-action-list {
    display: grid;
    gap: var(--fl-space-2);
  }
  @media (max-width: 767px) {
    .search-page {
      padding-bottom: var(--fl-space-8);
    }
    /* LibraryView: on a phone the tabs start at the gutter, without the hint. */
    .search-layout-hint {
      display: none;
    }
    .search-layouts > :global(.fl-layouts) {
      margin-inline-start: 0;
    }
    /* The one-line phone toolbar (ResultsToolbar): Save search is in the "…" sheet, as Slideshow is. */
    .search-tool {
      display: none;
    }
  }
  @media (pointer: coarse) {
    .search-tool,
    .search-clear,
    .search-clear-text {
      min-height: var(--fl-control-height-touch);
    }
  }
  .search-state,
  .search-more,
  .search-dialogs {
    background: transparent;
  }
  .search-state {
    display: grid;
    min-height: calc(66vh - 11rem);
    place-content: center;
  }
  .search-more {
    display: flex;
    justify-content: center;
    padding: var(--fl-space-8) 0;
  }
  .search-skeleton {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr));
    gap: var(--fl-space-half);
    background: transparent;
  }
</style>
