<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { landmarkKind } from '$lib/frameleaf/landmarks';
  import {
    allYourPlaceRows,
    cityNamesLanguage,
    cityRows,
    landmarkRows,
    MAP_SEARCH_DEBOUNCE_MS,
    mapSearchRowArea,
    yourPlaceRows,
    type MapSearchGroup,
    type MapSearchRow,
  } from '$lib/frameleaf/map-search';
  import type { MapArea } from '$lib/frameleaf/map-settings';
  import { searchPlaces, type SearchLandmarkResponseDto, type UserPlaceResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiCityVariantOutline,
    mdiClose,
    mdiKeyboardReturn,
    mdiLockOutline,
    mdiMagnify,
    mdiMapMarkerPlusOutline,
    mdiMapMarkerRadiusOutline,
    mdiMapSearchOutline,
  } from '@mdi/js';
  import { onDestroy, tick } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * FL-1027, prototype `MapSearch` (NamedPlaces.jsx): the search box at the map's top-left. The arrow
   * keys move through the groups as one list, Enter flies the map there, and the card that follows
   * offers the photos taken there. The caller leaves it off a map whose viewer does not own the places.
   */
  interface Props {
    places: readonly UserPlaceResponseDto[];
    landmarks: readonly SearchLandmarkResponseDto[];
    /** Items the map knows of in an area; undefined when it cannot say (a large or filtered library). */
    countIn?: (area: MapArea) => number | undefined;
    onFly: (row: MapSearchRow) => void;
    onShowPhotos: (area: MapArea) => void;
    onNameNew: () => void;
  }

  let { places, landmarks, countIn, onFly, onShowPhotos, onNameNew }: Props = $props();

  const uid = $props.id();
  const listId = `${uid}-list`;
  const optionId = (index: number) => `${uid}-option-${index}`;

  let root = $state<HTMLElement>();
  let input = $state<HTMLInputElement>();
  let query = $state('');
  let open = $state(false);
  let active = $state(0);
  let picked = $state.raw<MapSearchRow>();
  let cities = $state.raw<MapSearchRow[]>([]);
  let language = $state<string>();
  let searching = $state(false);
  let failed = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | undefined;
  let refocusing = false;

  const typed = $derived(query.trim());
  const groups = $derived.by(() => {
    if (!typed) {
      return [];
    }
    const found: { id: MapSearchGroup; rows: MapSearchRow[] }[] = [
      { id: 'yours', rows: yourPlaceRows(places, typed) },
      { id: 'landmarks', rows: landmarkRows(landmarks, typed) },
      { id: 'cities', rows: cities },
    ];
    let start = 0;
    return found
      .filter(({ rows }) => rows.length > 0)
      .map((group) => {
        const placed = { ...group, start };
        start += group.rows.length;
        return placed;
      });
  });
  const quick = $derived(typed ? [] : allYourPlaceRows(places));
  const options = $derived(typed ? groups.flatMap(({ rows }) => rows) : quick);
  const activeIndex = $derived(Math.min(active, options.length - 1));
  const activeOption = $derived(options.at(activeIndex));
  const nothingFound = $derived(!!typed && !searching && !failed && options.length === 0);
  // A place deleted while its card is up is gone from the card too.
  const card = $derived(
    picked?.group === 'yours' && places.every(({ id }) => `yours:${id}` !== picked?.id) ? undefined : picked,
  );
  const cardCount = $derived(card ? rowCount(card) : undefined);

  const groupTitles = $derived<Record<MapSearchGroup, string>>({
    yours: $t('frameleaf_named_places_yours'),
    landmarks: $t('frameleaf_map_search_landmarks'),
    cities: $t('frameleaf_map_search_cities'),
  });

  function rowCount(row: MapSearchRow) {
    return row.count ?? countIn?.(mapSearchRowArea(row));
  }

  const rowIcon = (row: MapSearchRow) => {
    if (row.group === 'landmarks') {
      return landmarkKind(row.kind ?? 'landmark').icon;
    }
    return row.group === 'yours' ? mdiMapMarkerRadiusOutline : mdiCityVariantOutline;
  };

  /** The name a language has for itself ("Deutsch"), or its tag. */
  const languageName = (tag: string) => {
    try {
      return new Intl.DisplayNames([tag], { type: 'language' }).of(tag) ?? tag;
    } catch {
      return tag;
    }
  };

  const cancelSearch = () => {
    clearTimeout(timer);
    timer = undefined;
    request?.abort();
    request = undefined;
    searching = false;
  };

  const search = async (name: string) => {
    request?.abort();
    const controller = new AbortController();
    request = controller;
    searching = true;
    failed = false;
    try {
      const found = (await searchPlaces({ name }, { signal: controller.signal })) ?? [];
      if (request === controller) {
        cities = cityRows(found);
        language = cityNamesLanguage(found);
      }
    } catch {
      if (request === controller) {
        failed = true;
      }
    } finally {
      if (request === controller) {
        request = undefined;
        searching = false;
      }
    }
  };

  const setQuery = (value: string) => {
    cancelSearch();
    query = value;
    active = 0;
    picked = undefined;
    cities = [];
    language = undefined;
    failed = false;
    const name = value.trim();
    if (name) {
      searching = true;
      timer = setTimeout(() => void search(name), MAP_SEARCH_DEBOUNCE_MS);
    }
  };

  const pick = (row: MapSearchRow) => {
    cancelSearch();
    picked = row;
    query = row.name;
    open = false;
    onFly(row);
  };

  const clear = () => {
    setQuery('');
    open = true;
    input?.focus();
  };

  const moveActive = async (step: number) => {
    active = (activeIndex + step + options.length) % options.length;
    await tick();
    root?.querySelector('[role="option"][aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  };

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      // Closes the list first and clears on the next press; with neither to do, the map's sheets get it.
      if (open) {
        event.stopPropagation();
        open = false;
        // Back in the box without the focus reopening the list just closed.
        refocusing = true;
        input?.focus();
        refocusing = false;
      } else if (query) {
        event.stopPropagation();
        setQuery('');
      }
      return;
    }
    if (event.target !== input) {
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        open = true;
      } else if (options.length > 0) {
        void moveActive(event.key === 'ArrowDown' ? 1 : -1);
      }
    } else if (event.key === 'Enter' && open && activeOption) {
      event.preventDefault();
      pick(activeOption);
    }
  };

  const closeIfOutside = (event: Event) => {
    if (open && root && !root.contains(event.target as Node)) {
      open = false;
    }
  };

  onDestroy(cancelSearch);
</script>

<svelte:document onpointerdown={closeIfOutside} onfocusin={closeIfOutside} />

{#snippet option(row: MapSearchRow, index: number)}
  {@const count = rowCount(row)}
  <!-- The keyboard stays in the box (aria-activedescendant), so a row only needs the pointer. -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    id={optionId(index)}
    class="row"
    class:active={index === activeIndex}
    role="option"
    tabindex="-1"
    aria-selected={index === activeIndex}
    onpointerenter={() => (active = index)}
    onmousedown={(event) => event.preventDefault()}
    onclick={() => pick(row)}
  >
    <span class="row-icon"><Icon icon={rowIcon(row)} size="18" /></span>
    <span class="copy">
      <strong>{row.name}</strong>
      <small>{row.where ?? $t('frameleaf_named_places_your_place')}</small>
    </span>
    {#if count}
      <small class="count">{$t('frameleaf_map_items', { values: { count } })}</small>
    {/if}
    {#if index === activeIndex}
      <kbd aria-hidden="true"><Icon icon={mdiKeyboardReturn} size="12" /></kbd>
    {/if}
  </div>
{/snippet}

{#snippet heading(id: MapSearchGroup, headingId: string)}
  <div id={headingId} class="group-title" role="presentation">
    {groupTitles[id]}
    {#if id === 'yours'}
      <span role="img" title={$t('frameleaf_named_places_only_you')} aria-label={$t('frameleaf_named_places_only_you')}>
        <Icon icon={mdiLockOutline} size="12" />
      </span>
    {/if}
  </div>
{/snippet}

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div bind:this={root} class="map-search" role="search" onkeydown={onKeydown}>
  <label class="box">
    <Icon icon={mdiMagnify} size="18" />
    <input
      bind:this={input}
      type="text"
      role="combobox"
      autocomplete="off"
      spellcheck="false"
      aria-label={$t('frameleaf_map_search_label')}
      aria-expanded={open}
      aria-controls={listId}
      aria-autocomplete="list"
      aria-activedescendant={open && activeOption ? optionId(activeIndex) : undefined}
      placeholder={$t('frameleaf_map_search_label')}
      value={query}
      oninput={(event) => {
        open = true;
        setQuery(event.currentTarget.value);
      }}
      onfocus={() => {
        if (!picked && !refocusing) {
          open = true;
        }
      }}
    />
    {#if query}
      <button type="button" class="clear" aria-label={$t('frameleaf_map_search_clear')} onclick={clear}>
        <Icon icon={mdiClose} size="16" />
      </button>
    {/if}
  </label>

  <span class="sr-only" role="status">
    {#if open && typed && !searching && options.length > 0}
      {$t('frameleaf_map_search_found', { values: { count: options.length } })}
    {/if}
  </span>

  {#if open}
    <div class="panel">
      {#if nothingFound}
        <div class="none" role="status">
          <Icon icon={mdiMapSearchOutline} size="26" />
          <strong>{$t('frameleaf_map_search_none_title', { values: { query: typed } })}</strong>
          <p>{$t('frameleaf_map_search_none_help')}</p>
          <Button
            onclick={() => {
              open = false;
              onNameNew();
            }}
          >
            <Icon icon={mdiMapMarkerPlusOutline} size="18" />
            {$t('frameleaf_named_places_name_this')}
          </Button>
        </div>
      {:else}
        <div id={listId} role="listbox" aria-label={$t('frameleaf_map_search_results')}>
          {#if typed}
            {#each groups as group (group.id)}
              <div class="group" role="group" aria-labelledby="{uid}-{group.id}">
                {@render heading(group.id, `${uid}-${group.id}`)}
                {#each group.rows as row, offset (row.id)}
                  {@render option(row, group.start + offset)}
                {/each}
              </div>
            {/each}
          {:else if quick.length > 0}
            <div class="group" role="group" aria-labelledby="{uid}-yours">
              {@render heading('yours', `${uid}-yours`)}
              {#each quick as row, index (row.id)}
                {@render option(row, index)}
              {/each}
            </div>
          {/if}
        </div>
        {#if !typed}
          <p class="hint" class:ruled={quick.length > 0}>{$t('frameleaf_map_search_hint')}</p>
        {:else if searching && options.length === 0}
          <p class="hint" role="status">{$t('frameleaf_map_search_searching')}</p>
        {/if}
        {#if failed}
          <div class="failed" role="alert">
            <span>{$t('frameleaf_map_search_failed')}</span>
            <Button onclick={() => void search(typed)}>{$t('frameleaf_map_try_again')}</Button>
          </div>
        {/if}
      {/if}
      <footer>
        <span class="keys" aria-hidden="true">
          <span><kbd>↑</kbd> <kbd>↓</kbd> {$t('frameleaf_map_search_key_move')}</span>
          <span><kbd><Icon icon={mdiKeyboardReturn} size="12" /></kbd> {$t('frameleaf_map_search_key_go')}</span>
          <span><kbd>esc</kbd> {$t('frameleaf_map_search_key_close')}</span>
        </span>
        {#if language}
          <span>{$t('frameleaf_map_search_names_in', { values: { language: languageName(language) } })}</span>
        {/if}
      </footer>
    </div>
  {:else if card}
    <div class="picked" role="status">
      <span class="row-icon"><Icon icon={rowIcon(card)} size="18" /></span>
      <span class="copy">
        <strong>{card.name}</strong>
        <small>{card.where ?? $t('frameleaf_named_places_your_place')}</small>
      </span>
      <div class="picked-foot">
        <span>
          {#if cardCount === 0}
            {$t('frameleaf_map_search_no_items')}
          {:else if cardCount !== undefined}
            {$t('frameleaf_map_search_items_here', { values: { count: cardCount } })}
          {/if}
        </span>
        <Button variant="primary" disabled={cardCount === 0} onclick={() => onShowPhotos(mapSearchRowArea(card))}>
          {$t('frameleaf_map_search_show_photos')}
        </Button>
      </div>
    </div>
  {/if}
</div>

<style>
  .map-search {
    position: relative;
    display: grid;
    gap: var(--fl-space-2);
    width: 100%;
  }
  .box {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
    min-height: 44px;
    margin: 0;
    padding: 0 var(--fl-space-2) 0 var(--fl-space-3);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
    box-shadow: var(--fl-shadow-1);
    color: var(--fl-muted);
    cursor: text;
  }
  .box:focus-within {
    outline: 2px solid var(--fl-accent);
    outline-offset: -2px;
  }
  .box input {
    flex: 1;
    min-width: 0;
    padding: 0;
    border: 0;
    background: none;
    color: var(--fl-text);
    font: inherit;
    font-size: var(--fl-font-size);
  }
  .box input:focus,
  .box input:focus-visible {
    outline: none;
    box-shadow: none;
  }
  .clear {
    display: grid;
    flex: none;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    color: var(--fl-muted);
  }
  .clear:hover {
    background: var(--fl-raised);
    color: var(--fl-text);
  }
  .panel {
    position: absolute;
    z-index: 5;
    top: 52px;
    right: 0;
    left: 0;
    max-height: min(60vh, 460px);
    overflow: auto;
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
    box-shadow: var(--fl-shadow-2);
  }
  .group {
    padding: var(--fl-space-2);
  }
  .group + .group {
    border-top: 1px solid var(--fl-border);
  }
  .group-title {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: var(--fl-space-2) var(--fl-space-2) 6px;
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .row {
    display: grid;
    grid-template-columns: 32px minmax(0, 1fr) auto auto;
    align-items: center;
    gap: var(--fl-space-3);
    min-height: 48px;
    padding: 6px var(--fl-space-2);
    border-radius: var(--fl-radius-sm);
    cursor: pointer;
  }
  .row.active {
    background: var(--fl-raised);
  }
  .row-icon {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: var(--fl-radius-sm);
    color: var(--fl-accent);
    background: color-mix(in srgb, var(--fl-accent) 13%, transparent);
  }
  .copy {
    display: grid;
    gap: 2px;
    min-width: 0;
  }
  .copy strong {
    overflow: hidden;
    font-size: var(--fl-font-small);
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .copy small,
  .count {
    overflow: hidden;
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  kbd {
    display: inline-grid;
    place-items: center;
    min-width: 20px;
    height: 20px;
    padding: 0 4px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-xs);
    background: var(--fl-raised);
    color: var(--fl-muted);
    font-family: inherit;
    font-size: var(--fl-font-micro);
  }
  .hint {
    margin: 0;
    padding: var(--fl-space-3) var(--fl-space-4) var(--fl-space-4);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  .hint.ruled {
    padding-top: var(--fl-space-4);
    border-top: 1px solid var(--fl-border);
  }
  .failed {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-3);
    padding: var(--fl-space-3) var(--fl-space-4);
    border-top: 1px solid var(--fl-border);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-2) var(--fl-space-4);
    padding: var(--fl-space-3) var(--fl-space-4);
    border-top: 1px solid var(--fl-border);
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
  }
  .keys,
  .keys span {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .keys {
    gap: var(--fl-space-3);
  }
  .none {
    display: grid;
    justify-items: center;
    gap: var(--fl-space-2);
    padding: var(--fl-space-6) var(--fl-space-6) var(--fl-space-5);
    color: var(--fl-muted);
    text-align: center;
  }
  .none strong {
    margin-top: 4px;
    color: var(--fl-text);
    font-size: var(--fl-font-size);
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .none p {
    max-width: 34ch;
    margin: 0 0 var(--fl-space-2);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  .picked {
    display: grid;
    grid-template-columns: 32px minmax(0, 1fr);
    align-items: center;
    gap: var(--fl-space-3);
    padding: var(--fl-space-3);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
    box-shadow: var(--fl-shadow-1);
  }
  .picked-foot {
    display: flex;
    grid-column: 1 / -1;
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-3);
    padding-top: var(--fl-space-3);
    border-top: 1px solid var(--fl-border);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  @media (max-width: 640px) {
    footer {
      display: none;
    }
  }
</style>
