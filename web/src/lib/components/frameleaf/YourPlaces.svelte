<script lang="ts">
  /**
   * FL-1019: Places › Your places (prototype `YourPlaces`): every named place, with its photos, the map,
   * Change and Delete. Counts come from the same search filter that finds the photos.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import NamedPlaceDialog from '$lib/components/frameleaf/NamedPlaceDialog.svelte';
  import { confirmFrameleaf } from '$lib/frameleaf/confirm';
  import { formatRadius, nearestTown } from '$lib/frameleaf/named-places';
  import { namedPlaces } from '$lib/frameleaf/named-places.svelte';
  import { Route } from '$lib/route';
  import { locale } from '$lib/stores/preferences.store';
  import { searchAssetStatistics, type UserPlaceResponseDto } from '@frameleaf/sdk';
  import { Icon, modalManager } from '@frameleaf/ui';
  import { mdiLockOutline, mdiMapMarkerPlusOutline, mdiMapMarkerRadiusOutline, mdiMapOutline } from '@mdi/js';
  import { onMount, untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  interface Props {
    /** The towns on the Places page, to say where each place is. */
    towns: { latitude: number | null; longitude: number | null; label: string }[];
  }

  const { towns }: Props = $props();

  let message = $state('');
  let failure = $state('');
  let retrying = $state(false);
  let counts = $state.raw<Record<string, number>>({});

  onMount(() => void namedPlaces.load());

  /** A few at a time: a person can have 200 places, and a count is only a hint beside the name. */
  const COUNT_READERS = 4;
  $effect(() => {
    const places = namedPlaces.places;
    void namedPlaces.revision;
    let stale = false;
    const queue = [...places];
    const read = async () => {
      for (let place = queue.shift(); place && !stale; place = queue.shift()) {
        const { id } = place;
        try {
          const result = await searchAssetStatistics({
            statisticsSearchDto: { filter: { namedPlaceIds: { any: [id] } } },
          });
          if (!stale && result) {
            counts = { ...untrack(() => counts), [id]: result.total };
          }
        } catch {
          // the row reads the same without its count
        }
      }
    };
    for (let reader = 0; reader < COUNT_READERS; reader++) {
      void read();
    }
    return () => {
      stale = true;
    };
  });

  const retry = async () => {
    retrying = true;
    await namedPlaces.load(true);
    retrying = false;
  };

  const change = async (place: UserPlaceResponseDto) => {
    const saved = await modalManager.show(NamedPlaceDialog, { place });
    if (saved) {
      failure = '';
      message = $t('frameleaf_named_places_saved', { values: { name: saved.name } });
    }
  };

  const remove = async (place: UserPlaceResponseDto) => {
    const confirmed = await confirmFrameleaf({
      title: $t('frameleaf_named_places_delete_title', { values: { name: place.name } }),
      prompt: $t('frameleaf_named_places_delete_body'),
      confirmText: $t('frameleaf_named_places_delete_confirm'),
      cancelText: $t('cancel'),
      danger: true,
    });
    if (!confirmed) {
      return;
    }
    try {
      await namedPlaces.remove(place.id);
      failure = '';
      message = $t('frameleaf_named_places_deleted', { values: { name: place.name } });
    } catch {
      message = '';
      failure = $t('frameleaf_named_places_error_delete');
    }
  };
</script>

<section class="np-yours" aria-labelledby="fl-your-places">
  <div class="np-head">
    <div>
      <h2 id="fl-your-places">{$t('frameleaf_named_places_yours')}</h2>
      <p class="np-private">
        <Icon icon={mdiLockOutline} size="16" aria-hidden={true} />
        {$t('frameleaf_named_places_only_you')}
      </p>
    </div>
    <a class="fl-control np-new" href={Route.mapNaming()}>
      <Icon icon={mdiMapMarkerPlusOutline} size="18" aria-hidden={true} />
      {$t('frameleaf_named_places_name_a_place')}
    </a>
  </div>

  {#if message}<p class="np-said" role="status">{message}</p>{/if}
  {#if failure}<p class="np-said np-failed" role="alert">{failure}</p>{/if}

  {#if namedPlaces.failed && !namedPlaces.loaded}
    <InlineError compact message={$t('frameleaf_named_places_error_load')} onRetry={retry} {retrying} />
  {:else if namedPlaces.places.length > 0}
    <ul class="np-list">
      {#each namedPlaces.places as place (place.id)}
        {@const town = nearestTown(towns, place)}
        {@const reach = $t('frameleaf_named_places_reaches', {
          values: { radius: formatRadius(place.radiusMeters, $locale) },
        })}
        <li>
          <a
            class="np-row-main"
            href={Route.search({ filter: { namedPlaceIds: { any: [place.id] } } })}
            aria-label={$t('frameleaf_named_places_show_photos', { values: { name: place.name } })}
          >
            <span class="np-row-icon"><Icon icon={mdiMapMarkerRadiusOutline} size="22" aria-hidden={true} /></span>
            <span class="np-row-copy">
              <strong>{place.name}</strong>
              <small>{town ? `${town} · ${reach}` : reach}</small>
            </span>
            {#if counts[place.id] !== undefined}
              <small class="np-row-count">
                {$t('frameleaf_places_items', { values: { count: counts[place.id] } })}
              </small>
            {/if}
          </a>
          <span class="np-row-actions">
            <a
              class="fl-control np-map"
              href={Route.map({ zoom: 14, lat: place.latitude, lng: place.longitude })}
              aria-label={$t('frameleaf_places_show_on_map', { values: { name: place.name } })}
              title={$t('frameleaf_places_view_on_map')}
            >
              <Icon icon={mdiMapOutline} size="18" aria-hidden={true} />
            </a>
            <Button
              label={$t('frameleaf_named_places_change_named', { values: { name: place.name } })}
              onclick={() => void change(place)}
            >
              {$t('frameleaf_named_places_change')}
            </Button>
            <Button
              label={$t('frameleaf_named_places_delete_named', { values: { name: place.name } })}
              onclick={() => void remove(place)}
            >
              {$t('delete')}
            </Button>
          </span>
        </li>
      {/each}
    </ul>
  {:else if namedPlaces.loaded}
    <div class="np-empty" role="status">
      <Icon icon={mdiMapMarkerRadiusOutline} size="28" aria-hidden={true} />
      <div>
        <strong>{$t('frameleaf_named_places_empty_title')}</strong>
        <p>{$t('frameleaf_named_places_empty_body')}</p>
      </div>
    </div>
  {/if}
</section>

<style>
  .np-yours {
    display: grid;
    gap: var(--fl-space-4);
    margin-bottom: var(--fl-space-6);
    padding-bottom: var(--fl-space-6);
    border-bottom: 1px solid var(--fl-border);
  }
  .np-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-3);
  }
  h2 {
    margin: 0 0 var(--fl-space-2);
    font-size: 15px;
    font-weight: 580;
  }
  .np-private {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .fl-control {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--fl-space-2);
    min-height: 36px;
    padding: 0 var(--fl-space-3);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
    color: var(--fl-text);
    font-size: var(--fl-font-callout);
    text-decoration: none;
  }
  .fl-control:hover {
    border-color: var(--fl-muted);
  }
  .np-map {
    width: 36px;
    padding: 0;
  }
  .np-said {
    padding: var(--fl-space-3) var(--fl-space-4);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
    font-size: var(--fl-font-callout);
  }
  .np-failed {
    color: var(--fl-danger);
  }
  .np-list {
    margin: 0;
    padding: 0;
    overflow: hidden;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
    list-style: none;
  }
  li {
    display: flex;
    align-items: center;
    gap: var(--fl-space-4);
    padding: var(--fl-space-3) var(--fl-space-4);
  }
  li + li {
    border-top: 1px solid var(--fl-border);
  }
  .np-row-main {
    flex: 1;
    display: grid;
    grid-template-columns: 44px minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--fl-space-4);
    min-width: 0;
    color: inherit;
    text-decoration: none;
  }
  .np-row-icon {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: var(--fl-radius-control);
    color: var(--fl-accent);
    background: color-mix(in srgb, var(--fl-accent) 13%, transparent);
  }
  .np-row-copy {
    display: grid;
    gap: var(--fl-space-1);
    min-width: 0;
  }
  .np-row-copy strong {
    overflow-wrap: anywhere;
    font-weight: 600;
  }
  .np-row-main:hover strong {
    text-decoration: underline;
  }
  small {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .np-row-actions {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
  }
  .np-empty {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    gap: var(--fl-space-4);
    padding: var(--fl-space-6);
    border: 1px dashed var(--fl-muted);
    border-radius: var(--fl-radius-card);
    color: var(--fl-muted);
  }
  .np-empty strong {
    display: block;
    color: var(--fl-text);
    font-weight: 600;
  }
  .np-empty p {
    max-width: 62ch;
    margin-top: var(--fl-space-1);
    font-size: var(--fl-font-callout);
    line-height: 1.5;
  }
  @media (max-width: 700px) {
    li {
      flex-wrap: wrap;
      gap: var(--fl-space-3);
    }
    .np-row-main {
      flex-basis: 100%;
    }
    .np-row-actions {
      padding-inline-start: 60px;
    }
  }
</style>
