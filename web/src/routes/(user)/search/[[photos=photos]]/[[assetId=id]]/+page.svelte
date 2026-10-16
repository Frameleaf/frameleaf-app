<script lang="ts">
  import { afterNavigate, goto } from '$app/navigation';
  import { page } from '$app/state';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import EmptyState from '$lib/components/frameleaf/EmptyState.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import Spinner from '$lib/components/frameleaf/Spinner.svelte';
  import SearchSaveDialog from '$lib/components/frameleaf/SearchSaveDialog.svelte';
  import ResultsAssetViewer from '$lib/components/frameleaf/ResultsAssetViewer.svelte';
  import ResultsView from '$lib/components/frameleaf/ResultsView.svelte';
  import VideoMomentResults from '$lib/components/frameleaf/VideoMomentResults.svelte';
  import SearchChip from '$lib/components/frameleaf/SearchChip.svelte';
  import SearchAsk from '$lib/components/frameleaf/SearchAsk.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import {
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
  import { LibrarySearchSession, type LibrarySearchQuery } from '$lib/frameleaf/library-search-session.svelte';
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
  import { withArchivePreference } from '$lib/frameleaf/search-palette';
  import { requestFilterPanel, SEARCH_SHORTCUT_EVENT } from '$lib/frameleaf/search-shortcuts';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { Route } from '$lib/route';
  import { lang, locale } from '$lib/stores/preferences.store';
  import { handlePromiseError } from '$lib/utils';
  import { navigateToAsset } from '$lib/utils/asset-utils';
  import { parseUtcDate } from '$lib/utils/date-time';
  import { handleError } from '$lib/utils/handle-error';
  import { isAlbumsRoute, isPeopleRoute } from '$lib/utils/navigation';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import {
    type AssetResponseDto,
    isHttpError,
    ImageEnrichmentFilter,
    type MetadataSearchDto,
    type SmartSearchDto,
  } from '@frameleaf/sdk';
  import { Icon, Theme as AppTheme, themeManager } from '@frameleaf/ui';
  import { mdiContentSaveOutline, mdiImageSearchOutline, mdiMagnify, mdiPencilOutline, mdiTuneVariant } from '@mdi/js';
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
  const isAskLoading = $derived(!hasSearchQuery && searchSession.loading);
  /** The results could not be loaded: the page says so with a retry, never "No matches". */
  let loadFailed = $state(false);
  let saving = $state(false);
  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
  /** What is loaded so far; "+" while there is more to load, since the search has no cheap total. */
  const hasMore = $derived(searchSession.nextPage !== null || searchSession.nextCursor !== null);

  // With Ask unavailable there is nothing on the empty search page to type into, so the search
  // palette opens by itself, and the page keeps a way back into it.
  onMount(() => {
    if (!hasSearchQuery && !showAskSearch && searchLocation.kind !== 'rejected') {
      void tick().then(openSearchPalette);
    }
  });

  // Endpoint and query identity share one request owner. Opening a result changes neither.
  /** ACCOUNT-P3: Search › "Include archived items", as the search palette applies it. */
  const includeArchived = $derived(authManager.authenticated && !!authManager.preferences.search?.includeArchived);
  const activeSearch = $derived.by((): LibrarySearchQuery | null => {
    if (hasSearchQuery) {
      const request = discoveryQuery
        ? structuredSearchRequest(withArchivePreference(toSearchDto(discoveryQuery), includeArchived), null)
        : terms.filter !== undefined || terms.orderBy !== undefined || terms.cursor !== undefined
          ? structuredSearchRequest(withArchivePreference(terms, includeArchived), null)
          : terms;
      const smart = ('query' in request || 'queryAssetId' in request) && smartSearchEnabled;
      // A flat request (a Places card, an Explore link) keeps asking for the timeline whatever the
      // preference says: it cannot say "timeline or archive", and no visibility at all could bring
      // back the hidden halves of live photos.
      return { kind: smart ? 'smart' : 'metadata', terms: request };
    }
    const query = askSearchQuery.trim();
    return query && canUseAskSearch ? { kind: 'ask', query } : null;
  });

  const activeSearchKey = $derived(JSON.stringify(activeSearch));
  $effect(() => {
    // Asset-only route navigation and equivalent query objects retain the collection and draft.
    const key = activeSearchKey;
    untrack(() => {
      const query = JSON.parse(key) as LibrarySearchQuery | null;
      searchSession.reset(query);
      askFailed = false;
      loadFailed = false;
      if (query?.kind === 'ask') {
        askQuery = query.query;
      }
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

  const onAssetDelete = (assetIds: string[]) => {
    const assetIdSet = new Set(assetIds);
    searchSession.assets = searchResultAssets.filter((asset: AssetResponseDto) => !assetIdSet.has(asset.id));
  };

  const handleSelectAll = () => librarySession.selectAll(searchResultAssets.map((asset) => asset.id));

  const timelineAssets = $derived(searchResultAssets.map((asset) => toTimelineAsset(asset)));

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
    const asking = activeSearch?.kind === 'ask';
    try {
      await searchSession.loadNextPage({ language: $lang });
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

  /** Clear all: back to the empty search page. */
  const clearSearch = () => {
    librarySession.clearSelection();
    void goto(Route.search());
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
    searchSession.reset({ kind: 'ask', query });
    handlePromiseError(loadNextPage());
  }

  function getHumanReadableDate(dateString: string) {
    const date = parseUtcDate(dateString).startOf('day');
    return date.toLocaleString(
      {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      },
      { locale: $locale },
    );
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
      const assetIdSet = new Set(assetIds);
      searchSession.assets = searchResultAssets.filter((asset) => !assetIdSet.has(asset.id));
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
      searchSession.reset({ kind: 'ask', query: normalizedQuery });
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
  <div class="search-page">
    {#if hasSearchQuery}
      <h1 class="fl-type-display search-title">{$t('frameleaf_search_results')}</h1>
      <!--
    The results toolbar, in the Library's order: how many, what narrows them (each chip opens the
    filters at its own section, Clear all removes them), then Filter and Save search.
  -->
      <div class="frameleaf search-toolbar" data-theme={appTheme}>
        <p class="search-count" role="status">
          {#if searchResultAssets.length > 0}
            {$t('frameleaf_search_results_count', {
              values: { count: searchResultAssets.length, more: hasMore ? 'yes' : 'no' },
            })}
          {/if}
        </p>
        <!-- SD-12: the results page's chips use the search palette's chip (SearchChip, search-palette.css .sp-token) -->
        <section
          id="search-chips"
          class="frameleaf search-chips"
          data-theme={appTheme}
          aria-label={$t('frameleaf_search_active_filters')}
        >
          {#each filterChips as chip (chip.field)}
            <SearchChip
              label={chip.label}
              removeLabel={$t('frameleaf_search_remove_filter', { values: { filter: chip.label } })}
              onRemove={() => removeFilterCondition(chip.field)}
              onOpen={discoveryQuery ? () => requestFilterPanel(filterSectionForField(chip.field)) : undefined}
            />
          {/each}
          {#if discoveryQuery}
            <!-- FL-48: the text, the similar-photo reference and the space are chips of their own. -->
            {#each discoveryContextChips(discoveryQuery) as chip (chip.key)}
              {@const label = chip.value ? `${$t(chip.labelKey)}: ${chip.value}` : $t(chip.labelKey)}
              <SearchChip
                {label}
                removeLabel={$t('frameleaf_search_remove_filter', { values: { filter: label } })}
                onRemove={() => removeContext(chip.key)}
              />
            {/each}
          {:else}
            {#each getObjectKeys(terms).filter((key) => key !== 'filter') as searchKey (searchKey)}
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
          <button type="button" class="search-clear" onclick={clearSearch}>{$t('clear_all')}</button>
        </section>
        <div class="search-actions">
          <button type="button" class="button" onclick={() => requestFilterPanel('all')}>
            <Icon icon={mdiTuneVariant} size="16" aria-hidden />
            {$t('frameleaf_search_results_filter')}
          </button>
          {#if discoveryQuery}
            <button type="button" class="button" onclick={() => (saving = true)}>
              <Icon icon={mdiContentSaveOutline} size="16" aria-hidden />
              {$t('frameleaf_search_save_search')}
            </button>
          {/if}
        </div>
      </div>
    {/if}

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
      {#if typeof terms.query === 'string' && terms.query.trim()}
        <!-- FL-59: timestamped moments inside the person's own videos, above the photo results. -->
        <VideoMomentResults query={terms.query} />
      {/if}
      {#if !hasSearchQuery && showAskSearch}
        <!-- FL-31: Ask about your photos, in the search palette's language (SearchAsk.svelte). -->
        <div class="mx-auto mt-24 flex w-full max-w-5xl flex-col gap-8 px-2 sm:px-6">
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
        <ResultsView
          assets={timelineAssets}
          downloadFileName={searchDownloadFileName}
          onEndReached={() => void loadNextPage()}
          onRemoved={onAssetDelete}
          onSelectAll={handleSelectAll}
          onOpen={(asset) => void navigateToAsset(asset)}
        />
      {:else if hasSearchQuery && loadFailed}
        <div class="frameleaf search-state" data-theme={appTheme}>
          <InlineError
            title={$t('frameleaf_search_results_failed_title')}
            message={$t('frameleaf_search_failed_hint')}
            onRetry={retrySearch}
          />
        </div>
      {:else if hasSearchQuery && !isLoading}
        <div class="frameleaf search-state" data-theme={appTheme}>
          <EmptyState
            icon={mdiImageSearchOutline}
            title={$t('frameleaf_search_results_empty_title')}
            message={$t('frameleaf_search_results_empty_body')}
            action={{ label: $t('frameleaf_search_results_edit'), icon: mdiPencilOutline, onClick: openSearchPalette }}
            secondaryAction={emptySecondary}
          />
        </div>
      {:else if !hasSearchQuery && !showAskSearch && searchLocation.kind !== 'rejected'}
        <!-- Never a blank page: without Ask, the way in is the search palette itself. -->
        <div class="frameleaf search-state" data-theme={appTheme}>
          <EmptyState
            icon={mdiMagnify}
            title={$t('frameleaf_search_title')}
            message={$t('frameleaf_search_results_start_body')}
            action={{ label: $t('search'), icon: mdiMagnify, onClick: openSearchPalette }}
          />
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
</UserPageLayout>

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
   * In the app frame (DISCOVERY-P5): with the page area's own 8px, the Library's 24px gutter (16px on
   * a phone), the title above the toolbar, and the results 12px under the toolbar.
   */
  .search-page {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-3);
    padding: var(--fl-space-6) var(--fl-space-4) var(--fl-space-12);
  }
  .search-title {
    margin: 0;
    color: var(--fl-text);
  }
  /* One row, left-aligned like the Library's: count, chips with Clear all, then the actions. */
  .search-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-2) var(--fl-space-3);
    background: transparent;
  }
  .search-count {
    margin: 0;
    color: var(--fl-muted);
    font: var(--fl-type-callout);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .search-count:empty {
    display: none;
  }
  .search-chips {
    display: flex;
    flex: 1;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-2);
    min-width: 0;
    background: transparent;
  }
  .search-clear {
    min-height: var(--fl-control-height-compact);
    padding: 0 var(--fl-space-2);
    border-radius: var(--fl-radius-control);
    color: var(--fl-muted);
    font: var(--fl-type-callout);
  }
  .search-clear:hover {
    color: var(--fl-text);
    background: var(--fl-raised);
  }
  .search-actions {
    display: flex;
    gap: var(--fl-space-2);
    margin-inline-start: auto;
  }
  @media (max-width: 767px) {
    .search-page {
      padding: var(--fl-space-2) var(--fl-space-2) var(--fl-space-8);
    }
    /* The size Tags, Places and People step down to on phones. */
    .search-title {
      font-size: var(--fl-font-title);
    }
  }
  /* On a phone the count and the actions share the first row and the chips take their own below. */
  @media (max-width: 640px) {
    .search-chips {
      order: 1;
      flex-basis: 100%;
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
    gap: var(--fl-space-1);
    background: transparent;
  }
</style>
