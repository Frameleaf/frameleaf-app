<script lang="ts">
  /** FL-999: one day of suggested places: the photos to tick, and a small map of where they would go. */
  import { DAY_PREVIEW, placeKey } from '$lib/frameleaf/location-history';
  import { locale } from '$lib/stores/preferences.store';
  import { getAssetMediaUrl } from '$lib/utils';
  import { AssetMediaSize, type LocationFillDayDto, type LocationFillProposalDto } from '@frameleaf/sdk';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';

  let {
    day,
    names,
    selected,
    readonly = false,
    onToggle,
  }: {
    day: LocationFillDayDto;
    names: Record<string, string>;
    selected: (id: string) => boolean;
    /** Only shown, as for the photos that could not be changed. */
    readonly?: boolean;
    onToggle?: (ids: string[], on: boolean) => void;
  } = $props();

  let expanded = $state(false);
  let figure = $state<HTMLElement>();
  let mapVisible = $state(false);

  const ids = $derived(day.proposals.map((proposal) => proposal.assetId));
  const all = $derived(ids.every((id) => selected(id)));
  const some = $derived(ids.some((id) => selected(id)));
  const shown = $derived(expanded ? day.proposals : day.proposals.slice(0, DAY_PREVIEW));
  const more = $derived(day.proposals.length - shown.length);
  const title = $derived(
    DateTime.fromISO(day.day, { locale: $locale }).toLocaleString({
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }),
  );
  const nameOf = (proposal: LocationFillProposalDto) =>
    names[placeKey(proposal)] ?? $t('frameleaf_location_history_place_unknown');
  const timeOf = (proposal: LocationFillProposalDto) =>
    DateTime.fromISO(proposal.localDateTime, { locale: $locale }).toLocaleString(DateTime.TIME_SIMPLE);
  const apart = (seconds: number) =>
    seconds < 60
      ? $t('frameleaf_location_history_gap_under')
      : $t('frameleaf_location_history_gap_minutes', { values: { count: Math.round(seconds / 60) } });
  const markers = $derived(
    day.proposals.map((proposal) => ({
      id: proposal.assetId,
      lat: proposal.latitude,
      lon: proposal.longitude,
      city: null,
      state: null,
      country: null,
    })),
  );

  // A browser allows only a few live maps, so a day draws its map only while it is on screen.
  $effect(() => {
    if (!figure || typeof IntersectionObserver === 'undefined') {
      return;
    }
    const observer = new IntersectionObserver(([entry]) => (mapVisible = entry.isIntersecting), {
      rootMargin: '200px',
    });
    observer.observe(figure);
    return () => observer.disconnect();
  });
</script>

<section class="day" aria-label={title}>
  <div class="head">
    {#if readonly}
      <span class="title"><strong>{title}</strong></span>
    {:else}
      <label>
        <input
          type="checkbox"
          checked={all}
          indeterminate={some && !all}
          aria-label={$t('frameleaf_location_history_day_select', { values: { day: title } })}
          onchange={() => onToggle?.(ids, !all)}
        />
        <span class="title">
          <strong>{title}</strong>
          <small
            >{$t('frameleaf_location_history_day_count', { values: { count: day.proposals.length } })} · {nameOf(
              day.proposals[0],
            )}</small
          >
        </span>
      </label>
    {/if}
  </div>
  <div class="body">
    <ul class="photos">
      {#each shown as proposal (proposal.assetId)}
        <li>
          <label class:is-on={!readonly && selected(proposal.assetId)}>
            <span class="photo">
              <img
                src={getAssetMediaUrl({ id: proposal.assetId, size: AssetMediaSize.Thumbnail })}
                alt=""
                loading="lazy"
              />
              {#if !readonly}
                <input
                  type="checkbox"
                  checked={selected(proposal.assetId)}
                  aria-label={$t('frameleaf_location_history_photo_add', {
                    values: { place: nameOf(proposal), time: timeOf(proposal) },
                  })}
                  onchange={() => onToggle?.([proposal.assetId], !selected(proposal.assetId))}
                />
              {/if}
            </span>
            <strong>{nameOf(proposal)}</strong>
            <small>{timeOf(proposal)}</small>
            <small>{apart(proposal.gapSeconds)}</small>
          </label>
        </li>
      {/each}
      {#if more > 0}
        <li class="more">
          <button type="button" onclick={() => (expanded = true)}>
            <strong>+{more}</strong>
            <small>{$t('frameleaf_location_history_more_day')}</small>
          </button>
        </li>
      {/if}
    </ul>
    <figure bind:this={figure}>
      <div class="map" inert>
        {#if mapVisible}
          {#await import('$lib/components/shared-components/map/Map.svelte') then { default: Map }}
            <Map mapMarkers={markers} simplified showSimpleControls={false} />
          {/await}
        {/if}
      </div>
      <figcaption>{$t('frameleaf_location_history_map_caption')}</figcaption>
    </figure>
  </div>
</section>

<style>
  .day {
    container-type: inline-size;
    border: 1px solid var(--fl-border);
    border-radius: 0.75rem;
    background: var(--fl-panel);
  }
  .head {
    padding: var(--fl-space-3) var(--fl-space-4);
    border-bottom: 1px solid var(--fl-border);
  }
  .head label {
    display: flex;
    gap: var(--fl-space-3);
    align-items: center;
    cursor: pointer;
  }
  .head input,
  .photo input {
    width: 1.25rem;
    height: 1.25rem;
    accent-color: var(--fl-accent);
  }
  .title {
    display: grid;
    gap: 0.125rem;
  }
  small {
    color: var(--fl-muted);
    font-size: 0.75rem;
  }
  .body {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 17.5rem;
    gap: var(--fl-space-4);
    padding: var(--fl-space-4);
  }
  .photos {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: var(--fl-space-3);
    align-content: start;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .photos label {
    display: grid;
    gap: 0.125rem;
    font-size: 0.8125rem;
    cursor: pointer;
  }
  .photo {
    position: relative;
    display: block;
    margin-bottom: var(--fl-space-2);
    border: 2px solid transparent;
    border-radius: 0.5rem;
    overflow: hidden;
  }
  .is-on .photo {
    border-color: var(--fl-accent);
  }
  .photo img {
    display: block;
    width: 100%;
    aspect-ratio: 4 / 3;
    object-fit: cover;
  }
  .photo input {
    position: absolute;
    top: var(--fl-space-2);
    left: var(--fl-space-2);
    margin: 0;
  }
  .photo input:focus-visible,
  .head input:focus-visible,
  .more button:focus-visible {
    outline: var(--fl-focus-ring);
  }
  .more button {
    display: grid;
    place-content: center;
    gap: 0.125rem;
    width: 100%;
    aspect-ratio: 4 / 3;
    border: 1px dashed var(--fl-border);
    border-radius: 0.5rem;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  figure {
    display: grid;
    gap: var(--fl-space-2);
    align-content: start;
    margin: 0;
  }
  .map {
    position: relative;
    height: 10.5rem;
    border-radius: 0.5rem;
    background: var(--fl-canvas);
    overflow: hidden;
    pointer-events: none;
  }
  figcaption {
    color: var(--fl-muted);
    font-size: 0.75rem;
  }
  @container (max-width: 48rem) {
    .body {
      grid-template-columns: minmax(0, 1fr);
    }
    .photos {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
</style>
