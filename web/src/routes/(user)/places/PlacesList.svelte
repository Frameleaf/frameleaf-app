<script lang="ts">
  import { buildCountryStateGroups } from '$lib/frameleaf/places';
  import { Route } from '$lib/route';
  import { PlacesGroupBy, type PlacesViewSettings } from '$lib/stores/preferences.store';
  import { normalizeSearchString } from '$lib/utils/string-utils';
  import { type AssetResponseDto } from '@immich/sdk';
  import { mdiChevronRight, mdiMapMarkerOff, mdiMapMarkerOutline } from '@mdi/js';
  import { groupBy } from 'lodash-es';
  import PlacesCardGroup from './PlacesCardGroup.svelte';

  import { isPlacesGroupCollapsed, togglePlacesGroupCollapsing, type PlacesGroup } from '$lib/utils/places-utils';
  import { Icon } from '@immich/ui';
  import { t } from 'svelte-i18n';

  interface Props {
    places?: AssetResponseDto[];
    searchQuery?: string;
    searchResultCount: number;
    userSettings: PlacesViewSettings;
    placesGroupIds?: string[];
  }

  let {
    places = $bindable([]),
    searchQuery = '',
    // eslint-disable-next-line no-useless-assignment
    searchResultCount = $bindable(0),
    userSettings,
    // eslint-disable-next-line no-useless-assignment
    placesGroupIds = $bindable([]),
  }: Props = $props();

  interface PlacesGroupOption {
    [option: string]: (places: AssetResponseDto[]) => PlacesGroup[];
  }

  const groupOptions: PlacesGroupOption = {
    /** No grouping */
    [PlacesGroupBy.None]: (places): PlacesGroup[] => {
      return [
        {
          id: $t('places'),
          name: $t('places'),
          places,
        },
      ];
    },

    /** Group by year */
    [PlacesGroupBy.Country]: (places): PlacesGroup[] => {
      const unknownCountry = $t('unknown_country');

      const groupedByCountry = groupBy(places, (place) => {
        return place.exifInfo?.country ?? unknownCountry;
      });

      const sortedByCountryName = Object.entries(groupedByCountry).sort(([a], [b]) => {
        // We make sure empty albums stay at the end of the list
        if (a === unknownCountry) {
          return 1;
        }
        return b === unknownCountry ? -1 : a.localeCompare(b);
      });

      return sortedByCountryName.map(([country, places]) => ({
        id: country,
        name: country,
        places,
      }));
    },
  };

  const filteredPlaces = $derived.by(() => {
    const searchQueryNormalized = normalizeSearchString(searchQuery);
    return searchQueryNormalized
      ? places.filter((place) => normalizeSearchString(place.exifInfo?.city ?? '').includes(searchQueryNormalized))
      : places;
  });

  const isCountryState = $derived(userSettings.groupBy === PlacesGroupBy.CountryState);
  const countryStateGroups = $derived(
    isCountryState
      ? buildCountryStateGroups(filteredPlaces, $t('unknown_country'), $t('frameleaf_places_unknown_state'))
      : [],
  );

  const groupingFunction = $derived(groupOptions[userSettings.groupBy] ?? groupOptions[PlacesGroupBy.None]);
  const groupedPlaces = $derived(isCountryState ? [] : groupingFunction(filteredPlaces));

  $effect(() => {
    searchResultCount = filteredPlaces.length;
  });

  $effect(() => {
    placesGroupIds = isCountryState ? countryStateGroups.map(({ id }) => id) : groupedPlaces.map(({ id }) => id);
  });
</script>

{#if places.length > 0}
  {#if isCountryState}
    <!-- Frameleaf (FL-51): country shelves, collapsible like the Country grouping, each with
         its states listed underneath and a "Show on map" link centred on that state. -->
    {#each countryStateGroups as countryGroup (countryGroup.id)}
      <div class="grid">
        <button
          type="button"
          onclick={() => togglePlacesGroupCollapsing(countryGroup.id)}
          class="my-2 w-fit pe-2 pt-2 dark:text-immich-dark-fg"
          aria-expanded={!isPlacesGroupCollapsed(userSettings, countryGroup.id)}
        >
          <Icon
            icon={mdiChevronRight}
            size="24"
            class="-mt-2.5 inline-block transition-all duration-250 {isPlacesGroupCollapsed(
              userSettings,
              countryGroup.id,
            )
              ? 'rotate-0'
              : 'rotate-90'}"
          />
          <span class="text-3xl font-bold text-black dark:text-white">{countryGroup.name}</span>
          <span class="ms-1.5">({$t('places_count', { values: { count: countryGroup.count } })})</span>
        </button>
        <hr class="dark:border-immich-dark-gray" />
      </div>

      {#if !isPlacesGroupCollapsed(userSettings, countryGroup.id)}
        {#each countryGroup.states as stateGroup (stateGroup.id)}
          <div class="mt-4 mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <h3 class="text-lg font-semibold text-black dark:text-white">{stateGroup.name}</h3>
            <span class="text-sm text-gray-500 dark:text-gray-400">
              ({$t('places_count', { values: { count: stateGroup.places.length } })})
            </span>
            {#if stateGroup.latitude !== null && stateGroup.longitude !== null}
              <a
                class="flex items-center gap-1 text-sm text-primary hover:underline"
                href={Route.map({ zoom: 6, lat: stateGroup.latitude, lng: stateGroup.longitude })}
              >
                <Icon icon={mdiMapMarkerOutline} size="16" />
                {$t('frameleaf_places_view_on_map')}
              </a>
            {/if}
          </div>
          <PlacesCardGroup places={stateGroup.places} />
        {/each}
      {/if}
    {/each}
  {:else if userSettings.groupBy === PlacesGroupBy.None}
    <PlacesCardGroup places={groupedPlaces[0].places} />
  {:else}
    {#each groupedPlaces as placeGroup (placeGroup.id)}
      <PlacesCardGroup places={placeGroup.places} group={placeGroup} />
    {/each}
  {/if}
{:else}
  <div class="flex min-h-[calc(66vh-11rem)] w-full place-content-center items-center dark:text-white">
    <div class="flex flex-col content-center items-center text-center">
      <Icon icon={mdiMapMarkerOff} size="3.5em" />
      <p class="mt-5 text-3xl font-medium">{$t('no_places')}</p>
    </div>
  </div>
{/if}
