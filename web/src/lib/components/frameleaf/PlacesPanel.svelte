<script lang="ts">
  /**
   * Places (FL-51), a port of the prototype's `Places.jsx` and its `discovery.css` styles.
   *
   * Real data only: one representative photo per city from `GET /search/cities`, per-city counts of
   * photos and videos from `GET /search/cities/counts` (the same owners and privacy rules: Locked,
   * trashed and hidden items and the places of partners who hide their locations never count), and
   * the number of items with no place from the search statistics. Grouped by country and then
   * state (the default, remembered per device), or one grid of every place.
   *
   * A place card opens the search for that place; its map button opens the Map centred on it. A
   * state card shows its located cities on a small drawn map (the prototype's offline stylised base;
   * no tiles are fetched) and opens the search for the state; a country's "View all" opens the
   * search for the country.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { buildPlacesTree, filterPlacesTree, stateMapDots, type PlaceCity } from '$lib/frameleaf/places';
  import { Route } from '$lib/route';
  import { PlacesGroupBy, placesViewSettings } from '$lib/stores/preferences.store';
  import { getAssetMediaUrl } from '$lib/utils';
  import {
    collapseAllPlacesGroups,
    expandAllPlacesGroups,
    isPlacesGroupCollapsed,
    togglePlacesGroupCollapsing,
  } from '$lib/utils/places-utils';
  import { AssetMediaSize, type AssetResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import {
    mdiArrowCollapseAll,
    mdiArrowExpandAll,
    mdiChevronDown,
    mdiChevronRight,
    mdiEarth,
    mdiMagnify,
    mdiMapMarkerOutline,
    mdiMapOutline,
    mdiMapSearchOutline,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    places: AssetResponseDto[];
    /** photos and videos per city name */
    counts: Map<string, number>;
    /** timeline items with no place, or null when unknown */
    unplaced: number | null;
  }

  let { places, counts, unplaced }: Props = $props();

  let search = $state('');

  const MAP_WIDTH = 240;
  const MAP_HEIGHT = 180;

  const tree = $derived(
    buildPlacesTree(places, counts, {
      unknownCountry: $t('frameleaf_places_unknown_country'),
      unknownState: $t('frameleaf_places_unknown_state'),
    }),
  );
  const visible = $derived(filterPlacesTree(tree, search));
  const grouped = $derived($placesViewSettings.groupBy !== PlacesGroupBy.None);
  const groupIds = $derived(visible.countries.map((country) => country.id));
  const allCollapsed = $derived(
    groupIds.length > 0 && groupIds.every((id) => isPlacesGroupCollapsed($placesViewSettings, id)),
  );
  const visibleCount = $derived(
    grouped
      ? visible.countries.reduce(
          (sum, country) => sum + country.states.reduce((inner, state) => inner + state.cities.length, 0),
          0,
        )
      : visible.cities.length,
  );
  const summary = $derived(
    tree.cities.length === 0
      ? $t('frameleaf_places_subtitle_empty')
      : [
          $t('frameleaf_places_summary', {
            values: { places: tree.cities.length, items: tree.total },
          }),
          unplaced ? $t('frameleaf_places_unplaced', { values: { count: unplaced } }) : null,
        ]
          .filter(Boolean)
          .join(' · '),
  );

  const setGrouped = (value: boolean) =>
    placesViewSettings.update((settings) => ({
      ...settings,
      groupBy: value ? PlacesGroupBy.CountryState : PlacesGroupBy.None,
    }));

  const mapHref = (city: PlaceCity) =>
    city.latitude !== null && city.longitude !== null
      ? Route.map({ zoom: 11, lat: city.latitude, lng: city.longitude })
      : undefined;
</script>

{#snippet placeCard(city: PlaceCity)}
  {@const map = mapHref(city)}
  <!-- Places.jsx:11-45 -->
  <div class="dv-place">
    <a
      class="dv-place-main"
      href={Route.search(city.query)}
      aria-label={$t('frameleaf_places_card_label', { values: { name: city.name, count: city.count } })}
    >
      <img src={getAssetMediaUrl({ id: city.coverId, size: AssetMediaSize.Thumbnail })} alt="" loading="lazy" />
      <span class="dv-shade" aria-hidden="true"></span>
      <span class="dv-place-copy">
        <strong>{city.name}</strong>
        <small>{$t('frameleaf_places_items', { values: { count: city.count } })}</small>
      </span>
    </a>
    {#if map}
      <a
        class="dv-place-map"
        href={map}
        aria-label={$t('frameleaf_places_show_on_map', { values: { name: city.name } })}
        title={$t('frameleaf_places_view_on_map')}
      >
        <Icon icon={mdiMapOutline} size="16" />
      </a>
    {/if}
  </div>
{/snippet}

<main class="discovery dv-places" aria-label={$t('places')}>
  <header class="dv-header">
    <div>
      <h1>{$t('places')}</h1>
      <p>{summary}</p>
    </div>
    <div class="dv-header-actions">
      <label class="dv-search">
        <Icon icon={mdiMagnify} size="16" />
        <input
          type="search"
          placeholder={$t('frameleaf_places_find')}
          aria-label={$t('frameleaf_places_find')}
          bind:value={search}
        />
      </label>
      <Button pressed={grouped} onclick={() => setGrouped(!grouped)}>
        <Icon icon={mdiEarth} size="16" />
        {$t('frameleaf_places_group_by_country')}
      </Button>
      {#if grouped && groupIds.length > 0}
        <Button onclick={() => (allCollapsed ? expandAllPlacesGroups() : collapseAllPlacesGroups(groupIds))}>
          <Icon icon={allCollapsed ? mdiArrowExpandAll : mdiArrowCollapseAll} size="16" />
          {allCollapsed ? $t('expand_all') : $t('collapse_all')}
        </Button>
      {/if}
    </div>
  </header>

  {#if tree.cities.length === 0}
    <div class="dv-empty" role="status">
      <Icon icon={mdiMapMarkerOutline} size="30" />
      <strong>{$t('frameleaf_places_empty_title')}</strong>
      <p>{$t('frameleaf_places_empty_help')}</p>
    </div>
  {:else if visibleCount === 0}
    <div class="dv-empty" role="status">
      <Icon icon={mdiMapSearchOutline} size="30" />
      <strong>{$t('frameleaf_places_no_match_title', { values: { query: search.trim() } })}</strong>
      <p>{$t('frameleaf_places_no_match_help')}</p>
    </div>
  {:else if grouped}
    {#each visible.countries as country (country.id)}
      {@const open = !isPlacesGroupCollapsed($placesViewSettings, country.id)}
      <section class="dv-section dv-country" aria-label={country.name}>
        <div class="dv-section-heading">
          <h2>
            <button
              type="button"
              class="dv-group-toggle"
              aria-expanded={open}
              onclick={() => togglePlacesGroupCollapsing(country.id)}
            >
              <Icon icon={open ? mdiChevronDown : mdiChevronRight} size="18" />
              <span>{country.name}</span>
              <small>{$t('frameleaf_places_items', { values: { count: country.count } })}</small>
            </button>
          </h2>
          <a class="dv-link" href={Route.search(country.query)}>
            {$t('view_all')}
            <Icon icon={mdiChevronRight} size="16" />
          </a>
        </div>
        {#if open}
          {#each country.states as state (state.id)}
            {@const dots = stateMapDots(state.cities, MAP_WIDTH, MAP_HEIGHT)}
            <div class="dv-state">
              <div class="dv-state-map">
                <!-- Places.jsx:141-145: the prototype's offline stylised map of the state's places. -->
                <svg
                  class="dv-state-art"
                  viewBox="0 0 {MAP_WIDTH} {MAP_HEIGHT}"
                  preserveAspectRatio="xMidYMid slice"
                  aria-hidden="true"
                >
                  <defs>
                    <pattern id="dv-grid-{state.id}" width="24" height="24" patternUnits="userSpaceOnUse">
                      <path d="M 24 0 L 0 0 0 24" fill="none" class="dv-grid-line" />
                    </pattern>
                  </defs>
                  <rect width={MAP_WIDTH} height={MAP_HEIGHT} fill="url(#dv-grid-{state.id})" />
                  {#each dots as dot (dot.id)}
                    <circle cx={dot.x} cy={dot.y} r={dot.r} class="dv-dot" />
                  {/each}
                </svg>
                <a
                  class="dv-state-label"
                  href={Route.search(state.query)}
                  aria-label={$t('frameleaf_places_state_label', {
                    values: { name: state.name, count: state.count },
                  })}
                >
                  <strong>{state.name}</strong>
                  <small>
                    {$t('frameleaf_places_items', { values: { count: state.count } })} ·
                    {$t('frameleaf_places_place_count', { values: { count: state.cities.length } })}
                  </small>
                </a>
              </div>
              <div class="dv-place-grid">
                {#each state.cities as city (city.id)}
                  {@render placeCard(city)}
                {/each}
              </div>
            </div>
          {/each}
        {/if}
      </section>
    {/each}
  {:else}
    <section class="dv-section" aria-label={$t('frameleaf_places_all')}>
      <div class="dv-place-grid wide">
        {#each visible.cities as city (city.id)}
          {@render placeCard(city)}
        {/each}
      </div>
    </section>
  {/if}
</main>

<style>
  /* discovery.css (Places) */
  .discovery {
    width: 100%;
    max-width: 1400px;
    min-width: 0;
    margin: 0 auto;
    padding: 26px 30px 36px;
    box-sizing: border-box;
    color: var(--fl-text);
    font-size: var(--fl-font-size);
  }
  .discovery h1 {
    margin: 0;
    font-size: 26px;
    font-weight: 600;
    letter-spacing: -0.035em;
  }
  .discovery h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 580;
  }
  .discovery small {
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
  .discovery strong {
    font-weight: 560;
  }
  .dv-header {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 24px;
  }
  .dv-header p {
    margin: 8px 0 0;
    color: var(--fl-muted);
    font-size: 13px;
    line-height: 1.6;
  }
  .dv-header-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .dv-search {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 34px;
    padding: 0 10px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
    color: var(--fl-muted);
  }
  .dv-search input {
    min-width: 150px;
    padding: 6px 0;
    border: 0;
    background: none;
    color: var(--fl-text);
    font: inherit;
    font-size: var(--fl-font-small);
  }
  .dv-search input:focus-visible {
    outline: none;
  }
  .dv-search:focus-within {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
  .dv-section {
    min-width: 0;
    margin: 0 0 28px;
  }
  .dv-section-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 14px;
  }
  .dv-country .dv-section-heading h2 {
    font-size: 17px;
  }
  .dv-group-toggle {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 34px;
    padding: 4px 6px 4px 0;
    border: 0;
    border-radius: var(--fl-radius-control);
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .dv-group-toggle small {
    font-weight: 400;
  }
  .dv-group-toggle:hover {
    background: var(--fl-raised);
  }
  .dv-link {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 30px;
    padding: 5px 0 5px 8px;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .dv-link:hover {
    color: var(--fl-text);
  }
  .dv-empty {
    padding: 50px 12px;
    text-align: center;
    color: var(--fl-muted);
  }
  .dv-empty strong {
    display: block;
    margin-top: 14px;
    color: var(--fl-text);
    font-size: 15px;
  }
  .dv-empty p {
    max-width: 42ch;
    margin: 8px auto 0;
    font-size: 13px;
    line-height: 1.55;
  }
  .dv-state {
    display: grid;
    grid-template-columns: 240px minmax(0, 1fr);
    gap: 16px;
    margin-bottom: 20px;
  }
  .dv-state-map {
    position: relative;
    height: 180px;
    overflow: hidden;
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
  }
  .dv-state-art {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  .dv-grid-line {
    stroke: var(--fl-border);
    stroke-width: 1;
  }
  .dv-dot {
    fill: color-mix(in srgb, var(--fl-accent), transparent 30%);
    stroke: var(--fl-panel);
    stroke-width: 2;
  }
  .dv-state-label {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 26px 14px 12px;
    background: linear-gradient(180deg, transparent, color-mix(in srgb, var(--fl-panel) 92%, transparent) 55%);
    color: var(--fl-text);
    text-align: left;
  }
  .dv-state-label:hover strong {
    text-decoration: underline;
  }
  .dv-place-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
    gap: 14px;
  }
  .dv-place-grid.wide {
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  }
  .dv-place {
    position: relative;
    min-height: 180px;
    overflow: hidden;
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
  }
  .dv-place-main {
    position: absolute;
    inset: 0;
    color: #fff;
    background: var(--fl-raised);
  }
  .dv-place-main > img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    transition: transform var(--fl-motion-slow) var(--fl-ease);
  }
  .dv-place-main:hover > img {
    transform: scale(1.04);
  }
  .dv-shade {
    position: absolute;
    inset: 0;
    background: linear-gradient(180deg, transparent 30%, rgb(0 0 0 / 0.74));
    pointer-events: none;
  }
  .dv-place-copy {
    position: absolute;
    right: 16px;
    bottom: 14px;
    left: 16px;
  }
  .dv-place-copy strong,
  .dv-place-copy small {
    display: block;
  }
  .dv-place-copy strong {
    font-size: 15px;
  }
  .dv-place-copy small {
    margin-top: 4px;
    color: #e3e7e5;
  }
  .dv-place-map {
    position: absolute;
    top: 8px;
    right: 8px;
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: var(--fl-radius-control);
    background: rgb(0 0 0 / 0.55);
    color: #fff;
    opacity: 0;
    transition: opacity var(--fl-motion) var(--fl-ease);
  }
  .dv-place:hover .dv-place-map,
  .dv-place:focus-within .dv-place-map {
    opacity: 1;
  }
  @media (hover: none) {
    .dv-place-map {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dv-place-main:hover > img {
      transform: none;
    }
  }
  @media (max-width: 1000px) {
    .dv-state {
      grid-template-columns: 1fr;
    }
    .dv-state-map {
      height: 150px;
    }
  }
  @media (max-width: 700px) {
    .discovery {
      padding: 20px 16px 30px;
    }
    .dv-search input {
      min-width: 0;
    }
  }
</style>
