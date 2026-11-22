<script lang="ts">
  /**
   * FL-1019: make or change a place away from the map, from a photo's location or from Your places
   * (prototype `PlaceDialog`): a small picture of the circle with a scale, the name and the reach.
   * The pin is only moved on the map.
   */
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import NamedPlaceFields from '$lib/components/frameleaf/NamedPlaceFields.svelte';
  import {
    formatRadius,
    isPlaceNameTaken,
    PLACE_RADIUS_DEFAULT,
    PLACES_MAX,
    RADIUS_STEPS,
    radiusStep,
  } from '$lib/frameleaf/named-places';
  import { namedPlaces } from '$lib/frameleaf/named-places.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import type { UserPlaceResponseDto } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';

  interface Props {
    /** The place to change; without it a new one is made at `point`. */
    place?: UserPlaceResponseDto;
    point?: { latitude: number; longitude: number };
    /** The town the photo was taken in, for the sentence above the picture. */
    where?: string;
    onClose: (saved?: UserPlaceResponseDto) => void;
  }

  const { place, point, where, onClose }: Props = $props();

  // svelte-ignore state_referenced_locally
  let name = $state(place?.name ?? '');
  // svelte-ignore state_referenced_locally
  let radius = $state(place?.radiusMeters ?? PLACE_RADIUS_DEFAULT);
  let open = $state(true);
  let saving = $state(false);
  let error = $state<string>();
  let saved: UserPlaceResponseDto | undefined;

  const circle = $derived(16 + (radiusStep(radius) / RADIUS_STEPS) * 44);
  const words = $derived(formatRadius(radius, $locale));

  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || saving) {
      return;
    }
    if (isPlaceNameTaken(namedPlaces.places, trimmed, place?.id)) {
      error = $t('frameleaf_named_places_error_duplicate');
      return;
    }
    if (!place && namedPlaces.places.length >= PLACES_MAX) {
      error = $t('frameleaf_named_places_error_limit', { values: { count: PLACES_MAX } });
      return;
    }
    saving = true;
    error = undefined;
    try {
      if (place) {
        saved = await namedPlaces.update(place.id, { name: trimmed, radiusMeters: radius });
      } else if (point) {
        saved = await namedPlaces.create({ ...point, name: trimmed, radiusMeters: radius });
      }
      open = false;
    } catch {
      error = $t('frameleaf_named_places_error_save');
    } finally {
      saving = false;
    }
  };
</script>

<Dialog
  bind:open
  title={place ? $t('frameleaf_named_places_change_title') : $t('frameleaf_named_places_name_this')}
  closeLabel={$t('close')}
  onClosed={() => onClose(saved)}
>
  <form id="fl-named-place-form" class="np-dialog" onsubmit={(event) => void save(event)}>
    <p class="np-lead">
      {#if place}
        {$t('frameleaf_named_places_change_lead', { values: { name: place.name } })}
      {:else if where}
        {$t('frameleaf_named_places_new_lead', { values: { where } })}
      {:else}
        {$t('frameleaf_named_places_new_lead_no_town')}
      {/if}
    </p>
    <figure class="np-preview" aria-label={$t('frameleaf_named_places_preview', { values: { radius: words } })}>
      <svg viewBox="0 0 320 160" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        {#each [40, 120, 200, 280] as x (x)}<line class="grid" x1={x} y1="0" x2={x} y2="160" />{/each}
        {#each [40, 120] as y (y)}<line class="grid" x1="0" y1={y} x2="320" y2={y} />{/each}
        <polyline class="road" points="0,128 90,104 160,80 236,70 320,36" />
        <circle class="area" cx="160" cy="80" r={circle} />
        <circle class="dot" cx="160" cy="80" r="5" />
        <line class="scale" x1="16" y1="144" x2={16 + circle} y2="144" />
        <text x={24 + circle} y="148">{words}</text>
      </svg>
    </figure>
    <NamedPlaceFields bind:name bind:radius {error} initialFocus />
  </form>
  {#snippet actions()}
    <button type="button" class="button" onclick={() => (open = false)}>{$t('cancel')}</button>
    <button type="submit" form="fl-named-place-form" class="button primary" disabled={!name.trim() || saving}>
      {place ? $t('frameleaf_named_places_save_changes') : $t('frameleaf_named_places_save')}
    </button>
  {/snippet}
</Dialog>

<style>
  .np-dialog {
    display: grid;
    gap: var(--fl-space-4);
  }
  .np-lead {
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    line-height: 1.5;
  }
  .np-preview {
    height: 160px;
    margin: 0;
    overflow: hidden;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-canvas);
  }
  svg {
    display: block;
    width: 100%;
    height: 100%;
  }
  .grid {
    stroke: var(--fl-border);
  }
  .road {
    fill: none;
    stroke: var(--fl-muted);
    stroke-dasharray: 6 5;
    opacity: 0.5;
  }
  .area {
    fill: color-mix(in srgb, var(--fl-accent) 18%, transparent);
    stroke: var(--fl-accent);
    stroke-width: 2;
    stroke-dasharray: 6 5;
  }
  .dot {
    fill: var(--fl-accent);
    stroke: var(--fl-panel);
    stroke-width: 2;
  }
  .scale {
    stroke: var(--fl-text);
    stroke-width: 2;
  }
  text {
    fill: var(--fl-text);
    font-size: var(--fl-font-micro);
  }
</style>
