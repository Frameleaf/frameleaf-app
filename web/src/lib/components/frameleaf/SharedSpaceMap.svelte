<script lang="ts">
  import Status from '$lib/components/frameleaf/Status.svelte';
  import { timeToLoadTheMap } from '$lib/constants';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { delay } from '$lib/utils/asset-utils';
  import { handleError } from '$lib/utils/handle-error';
  import { getAlbumMapMarkers, type AlbumResponseDto, type MapMarkerResponseDto } from '@immich/sdk';
  import { LoadingSpinner } from '@immich/ui';
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * Where this shared space's photos were taken (FL-55).
   *
   * This is the existing album map endpoint, unchanged: a space is an album, so
   * `GET /albums/{id}/map-marker` already answers exactly this question, and it
   * already answers it safely. The server applies the caller's hidden-content
   * options and the album access check, so the pins can only ever come from
   * items inside this space, and a shared link that is not allowed to see EXIF
   * gets nothing at all.
   *
   * Nothing on this panel is a second copy of the map: the production MapLibre
   * component and the configured tile source are the ones every other map in
   * the app uses, loaded on demand so a member who never opens Places does not
   * pay for it.
   */
  interface Props {
    space: AlbumResponseDto;
    /** Open an item from a pin. The space page owns navigation. */
    onSelect?: (assetIds: string[]) => void;
  }

  let { space, onSelect }: Props = $props();

  let markers = $state<MapMarkerResponseDto[]>([]);
  let loading = $state(true);
  let cancelable: AbortController | undefined;

  onMount(async () => {
    cancelable = new AbortController();
    try {
      markers = await getAlbumMapMarkers({ ...authManager.params, id: space.id }, { signal: cancelable.signal });
    } catch (error) {
      if (!cancelable.signal.aborted) {
        handleError(error, $t('errors.something_went_wrong'));
      }
    } finally {
      loading = false;
    }
  });

  onDestroy(() => cancelable?.abort());
</script>

<section class="space-map" aria-labelledby="frameleaf-space-map">
  <h2 id="frameleaf-space-map">{$t('frameleaf_spaces_places')}</h2>
  <p class="hint">{$t('frameleaf_spaces_places_hint')}</p>

  {#if loading}
    <Status message={$t('loading')} busy={true} />
  {:else if markers.length === 0}
    <p class="empty">{$t('frameleaf_spaces_places_empty')}</p>
  {:else}
    <div class="canvas">
      {#await import('$lib/components/shared-components/map/Map.svelte')}
        {#await delay(timeToLoadTheMap) then}
          <div class="spinner"><LoadingSpinner /></div>
        {/await}
      {:then { default: Map }}
        <Map
          clickable={false}
          mapMarkers={markers}
          onSelect={(assetIds: string[]) => onSelect?.(assetIds)}
          rounded
          autoFitBounds
        />
      {/await}
    </div>
  {/if}
</section>

<style>
  .space-map {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    color: var(--fl-text);
  }
  h2 {
    margin: 0;
    font-size: 1rem;
    font-weight: 700;
  }
  .hint,
  .empty {
    margin: 0;
    color: var(--fl-muted);
    font-size: 0.8125rem;
  }
  .canvas {
    height: min(60vh, 32rem);
    min-height: 18rem;
    width: 100%;
    overflow: hidden;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
  }
  .spinner {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
  }
</style>
