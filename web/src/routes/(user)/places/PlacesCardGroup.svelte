<script lang="ts">
  import { frameleafShell } from '$lib/frameleaf/rollout';
  import { Route } from '$lib/route';
  import { placesViewSettings } from '$lib/stores/preferences.store';
  import { getAssetMediaUrl } from '$lib/utils';
  import { type PlacesGroup, isPlacesGroupCollapsed, togglePlacesGroupCollapsing } from '$lib/utils/places-utils';
  import { AssetMediaSize, type AssetResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiChevronRight, mdiMapMarkerOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /** A city marker's coordinates, from the representative asset the places endpoint returns for it. */
  const cityLocation = (item: AssetResponseDto) => {
    const { latitude, longitude } = item.exifInfo ?? {};
    return typeof latitude === 'number' && typeof longitude === 'number' ? { latitude, longitude } : undefined;
  };

  interface Props {
    places: AssetResponseDto[];
    group?: PlacesGroup | undefined;
  }

  let { places, group = undefined }: Props = $props();

  let isCollapsed = $derived(!!group && isPlacesGroupCollapsed($placesViewSettings, group.id));
  let iconRotation = $derived(isCollapsed ? 'rotate-0' : 'rotate-90');
</script>

{#if group}
  <div class="grid">
    <button
      type="button"
      onclick={() => togglePlacesGroupCollapsing(group.id)}
      class="my-2 w-fit pe-2 pt-2 dark:text-immich-dark-fg"
      aria-expanded={!isCollapsed}
    >
      <Icon icon={mdiChevronRight} size="24" class="-mt-2.5 inline-block transition-all duration-250 {iconRotation}" />
      <span class="text-3xl font-bold text-black dark:text-white">{group.name}</span>
      <span class="ms-1.5">({$t('places_count', { values: { count: places.length } })})</span>
    </button>
    <hr class="dark:border-immich-dark-gray" />
  </div>
{/if}

<div class="mt-4">
  {#if !isCollapsed}
    <div class="flex flex-row flex-wrap gap-4">
      {#each places as item (item.id)}
        {@const city = item.exifInfo?.city}
        {@const location = cityLocation(item)}
        <div class="relative">
          <a class="relative block" href={Route.search({ city })} draggable="false">
            <div
              class="flex w-[calc((100vw-(72px+5rem))/2)] max-w-39 justify-center overflow-hidden rounded-xl brightness-75 filter"
            >
              <img
                src={getAssetMediaUrl({ id: item.id, size: AssetMediaSize.Thumbnail })}
                alt={city}
                class="size-39 object-cover"
                loading="lazy"
              />
            </div>
            <span
              class="absolute bottom-2 w-full px-1 text-center text-sm font-medium text-ellipsis text-white capitalize backdrop-blur-[1px] hover:cursor-pointer"
            >
              {city}
            </span>
          </a>
          {#if $frameleafShell && location}
            <!-- Frameleaf (FL-51): every place card links back to the real map, centred on
                 this city, matching `PlaceCard`'s onOpenMap button in the design template. -->
            <a
              class="absolute end-2 top-2 flex size-7 items-center justify-center rounded-full bg-black/60 text-white transition hover:bg-black/80"
              href={Route.map({ zoom: 11, lat: location.latitude, lng: location.longitude })}
              aria-label={$t('frameleaf_places_view_on_map') + (city ? `: ${city}` : '')}
              title={$t('frameleaf_places_view_on_map')}
            >
              <Icon icon={mdiMapMarkerOutline} size="16" />
            </a>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>
