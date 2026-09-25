<script lang="ts">
  import { afterNavigate, goto } from '$app/navigation';
  import { page } from '$app/state';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import ControlAppBar from '$lib/components/shared-components/ControlAppBar.svelte';
  import ResultsAssetViewer from '$lib/components/frameleaf/ResultsAssetViewer.svelte';
  import ResultsView from '$lib/components/frameleaf/ResultsView.svelte';
  import VideoMomentResults from '$lib/components/frameleaf/VideoMomentResults.svelte';
  import SearchChip from '$lib/components/frameleaf/SearchChip.svelte';
  import SearchEntry from '$lib/components/frameleaf/SearchEntry.svelte';
  import {
    DISCOVERY_QUERY_PARAMETER,
    discoverySearchRequest,
    discoveryUrl,
    emptyDiscoveryQuery,
    isEmptyDiscoverySearch,
    readSearchParameters,
    structuredSearchRequest,
    toSearchDto,
    withoutDiscoveryFilter,
    type DiscoveryQuery,
  } from '$lib/components/discovery/query';
  import { QueryParameter } from '$lib/constants';
  import { brandedArchiveName, namedEntitySegments } from '$lib/frameleaf/archive-name';
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
    getPerson,
    getPet,
    getTagById,
    ImageEnrichmentFilter,
    type MetadataSearchDto,
    type SmartSearchDto,
  } from '@immich/sdk';
  import { Button, Icon, LoadingSpinner, Theme as AppTheme, themeManager } from '@immich/ui';
  import {
    mdiAccountMultipleOutline,
    mdiArrowLeft,
    mdiCalendarHeart,
    mdiFileDocumentOutline,
    mdiImageAlbum,
    mdiImageOffOutline,
    mdiMapMarkerOutline,
  } from '@mdi/js';
  import { onDestroy, tick, untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  const ASK_QUERY_PARAMETER = 'ask';

  // The viewer pushes its own history state, which causes weird behavior for history.back().
  // To prevent that we store the previous page manually and navigate back to that.
  let previousRoute = $state<string>(Route.explore());

  const searchSession = new LibrarySearchSession();
  onDestroy(() => searchSession.destroy());
  const searchResultAssets = $derived(searchSession.assets);
  const isLoading = $derived(searchSession.loading);
  let askQuery = $state('');
  const askResponse = $derived(searchSession.askResponse);
  let scrollY = $state(0);
  let scrollYHistory = 0;

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
  let canUseAskSearch = $derived(featureFlagsManager.value.search && featureFlagsManager.value.smartSearch);
  const isAskLoading = $derived(!hasSearchQuery && searchSession.loading);

  // Endpoint and query identity share one request owner. Opening a result changes neither.
  const activeSearch = $derived.by((): LibrarySearchQuery | null => {
    if (hasSearchQuery) {
      const request = discoveryQuery
        ? discoverySearchRequest(discoveryQuery, null)
        : terms.filter !== undefined || terms.orderBy !== undefined || terms.cursor !== undefined
          ? structuredSearchRequest(terms, null)
          : terms;
      const smart = ('query' in request || 'queryAssetId' in request) && smartSearchEnabled;
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
      if (query?.kind === 'ask') {
        askQuery = query.query;
      }
      handlePromiseError(loadNextPage());
    });
  });

  $effect(() => {
    if (scrollY) {
      scrollYHistory = scrollY;
    }
  });

  afterNavigate(({ from }) => {
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
        window.scrollTo(0, scrollYHistory);
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
    try {
      await searchSession.loadNextPage({ language: $lang });
    } catch (error) {
      handleError(error, $t('loading_search_results_failed'));
    }
  };

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
      query: $t('context'),
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
      queryAssetId: $t('query_asset_id'),
      ocr: $t('ocr'),
      imageEnrichment: $t('image_enrichment'),
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
    const personNames = await Promise.all(
      personIds.map(async (personId) => {
        const person = await getPerson({ id: personId });

        if (person.name === '') {
          return $t('no_name');
        }

        return person.name;
      }),
    );

    return personNames.join(', ');
  }

  async function getPetNames(petIds: string[]) {
    const petNames = await Promise.all(
      petIds.map(async (petId) => {
        const pet = await getPet({ id: petId });
        return pet.name || $t('frameleaf_pets_unnamed');
      }),
    );

    return petNames.join(', ');
  }

  async function getTagNames(tagIds: string[] | null) {
    if (tagIds === null) {
      return $t('untagged');
    }
    const tagNames = await Promise.all(
      tagIds.map(async (tagId) => {
        const tag = await getTagById({ id: tagId });

        return tag.value;
      }),
    );

    return tagNames.join(', ');
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

    const url = new URL(page.url);
    url.searchParams.delete(QueryParameter.QUERY);
    url.searchParams.delete(DISCOVERY_QUERY_PARAMETER);
    url.searchParams.set(ASK_QUERY_PARAMETER, normalizedQuery);

    if (url.href === page.url.href) {
      searchSession.reset({ kind: 'ask', query: normalizedQuery });
      await loadNextPage();
      return;
    }

    await goto(url, { keepFocus: true, noScroll: true });
  }

  async function loadNextAskPage() {
    await loadNextPage();
  }

  function onAskSubmit(event: SubmitEvent) {
    event.preventDefault();
    handlePromiseError(updateAskSearchUrl(askQuery));
  }

  const suggestedSearches = [
    { icon: mdiAccountMultipleOutline, title: $t('people'), query: 'photos of Alice last summer' },
    { icon: mdiMapMarkerOutline, title: $t('places'), query: 'photos in Banff from April 2024' },
    { icon: mdiFileDocumentOutline, title: $t('documents'), query: 'receipts from last year' },
    { icon: mdiCalendarHeart, title: $t('memories'), query: 'favorite videos since 2020' },
    { icon: mdiImageAlbum, title: $t('albums'), query: 'screenshots from last month' },
  ];
</script>

<svelte:window bind:scrollY />

<OnEvents {onAlbumAddAssets} {onPersonUpdate} {onPersonFacesChange} />

{#if hasSearchQuery}
  <!-- SD-12: the results page's chips use the search palette's chip (SearchChip, search-palette.css .sp-token) -->
  <section
    id="search-chips"
    class="frameleaf search-chips"
    data-theme={themeManager.value === AppTheme.Dark ? 'dark' : 'light'}
    aria-label={$t('frameleaf_search_active_filters')}
  >
    {#each filterChips as chip (chip.field)}
      <SearchChip
        label={chip.label}
        removeLabel={$t('frameleaf_search_remove_filter', { values: { filter: chip.label } })}
        onRemove={() => removeFilterCondition(chip.field)}
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
          {name}{#if value !== true}:
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
  </section>
{/if}

<section class="m-4 mb-12 max-h-screen bg-immich-bg dark:bg-immich-dark-bg">
  <section id="search-content">
    {#if searchLocation.kind === 'rejected'}
      <!-- FL-48: a damaged or newer search link fails safely and says why, instead of erroring. -->
      <p class="mx-auto mt-24 max-w-3xl px-6 text-center text-sm text-gray-600 dark:text-gray-300" role="status">
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
    {#if !hasSearchQuery && canUseAskSearch}
      <div class="mx-auto mt-24 flex w-full max-w-5xl flex-col gap-8 px-6 text-gray-700 dark:text-gray-200">
        <form class="mx-auto flex w-full max-w-3xl gap-2" onsubmit={onAskSubmit}>
          <label for="ask-search-input" class="sr-only">{$t('search_your_photos')}</label>
          <input
            id="ask-search-input"
            type="search"
            class="h-12 min-w-0 flex-1 rounded-full border border-gray-300 bg-white px-5 text-base outline-none focus:border-immich-primary dark:border-gray-700 dark:bg-gray-900"
            bind:value={askQuery}
            disabled={isAskLoading}
            placeholder={$t('search_your_photos')}
          />
          <Button type="submit" disabled={isAskLoading || !askQuery.trim()}>
            {isAskLoading ? $t('searching') : $t('ask')}
          </Button>
        </form>

        {#if askResponse}
          <div
            class="rounded-lg border border-gray-200 bg-white p-4 text-sm shadow-sm dark:border-gray-800 dark:bg-gray-900"
          >
            <p class="font-medium">{askResponse.explanation}</p>
            {#if askResponse.warnings.length > 0}
              <p class="mt-2 text-gray-500 dark:text-gray-400">{askResponse.warnings.join(' ')}</p>
            {/if}
          </div>
        {/if}

        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {#each suggestedSearches as item (item.query)}
            <button
              type="button"
              disabled={isAskLoading}
              class="flex min-h-28 flex-col justify-between rounded-lg border border-gray-200 bg-white p-4 text-start shadow-sm transition hover:border-immich-primary hover:text-immich-primary dark:border-gray-800 dark:bg-gray-900 dark:hover:border-immich-dark-primary dark:hover:text-immich-dark-primary"
              onclick={() => {
                askQuery = item.query;
                handlePromiseError(updateAskSearchUrl(item.query));
              }}
            >
              <Icon icon={item.icon} size="1.7em" />
              <span class="text-base font-medium">{item.title}</span>
              <span class="text-sm text-gray-500 dark:text-gray-400">{item.query}</span>
            </button>
          {/each}
        </div>

        {#if askResponse && searchResultAssets.length > 0}
          <ResultsView
            assets={timelineAssets}
            downloadFileName={searchDownloadFileName}
            onEndReached={() => void loadNextAskPage()}
            onRemoved={onAssetDelete}
            onSelectAll={handleSelectAll}
            onOpen={(asset) => void navigateToAsset(asset)}
          />
        {:else if askResponse && !isAskLoading}
          <div class="flex min-h-56 w-full place-content-center items-center dark:text-white">
            <div class="flex flex-col content-center items-center text-center">
              <Icon icon={mdiImageOffOutline} size="3.5em" />
              <p class="mt-5 text-3xl font-medium">{$t('no_results')}</p>
              <p class="text-base font-normal">{$t('no_results_description')}</p>
            </div>
          </div>
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
    {:else if hasSearchQuery && !isLoading}
      <div class="flex min-h-[calc(66vh-11rem)] w-full place-content-center items-center dark:text-white">
        <div class="flex flex-col content-center items-center text-center">
          <Icon icon={mdiImageOffOutline} size="3.5em" />
          <p class="mt-5 text-3xl font-medium">{$t('no_results')}</p>
          <p class="text-base font-normal">{$t('no_results_description')}</p>
        </div>
      </div>
    {/if}

    {#if isLoading}
      <div class="flex items-center justify-center py-16">
        <LoadingSpinner size="giant" />
      </div>
    {/if}
  </section>

  <section>
    <!-- FL-33 cleanup: the legacy select bar is gone; the Frameleaf selection bar floats over the
         results, so the search entry stays available while a selection is being made. -->
    <div class="fixed inset-s-0 top-0 z-2 w-full">
      <ControlAppBar onClose={() => goto(previousRoute)} backIcon={mdiArrowLeft}>
        <div class="mx-auto w-full max-w-2xl pe-2">
          <!-- FL-49: the same single search entry as the top bar; it reads the current
               search from the URL, so reopening it resumes this query. -->
          <SearchEntry />
        </div>
      </ControlAppBar>
    </div>
  </section>
</section>

<ResultsAssetViewer
  assets={searchResultAssets}
  onAssetChange={updateAsset}
  onRemove={(id) => onAssetDelete([id])}
  emptyRoute={previousRoute}
/>

<style>
  .search-chips {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 6px;
    margin-top: 6rem;
    padding-inline: 1rem;
    background: transparent;
  }
</style>
