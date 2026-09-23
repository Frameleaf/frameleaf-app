<script lang="ts">
  import { isDefined } from '$lib';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import EmptyPlaceholder from '$lib/components/shared-components/EmptyPlaceholder.svelte';
  import LibraryView from '$lib/components/frameleaf/LibraryView.svelte';
  import { librarySession } from '$lib/frameleaf/library-session.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
  import GeolocationPointPickerModal from '$lib/modals/GeolocationPointPickerModal.svelte';
  import GeolocationUpdateConfirmModal from '$lib/modals/GeolocationUpdateConfirmModal.svelte';
  import type { LatLng } from '$lib/types';
  import { setQueryValue } from '$lib/utils/navigation';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import { AssetVisibility, getAssetInfo, updateAssets } from '@immich/sdk';
  import { Button, LoadingSpinner, modalManager, Text } from '@immich/ui';
  import { mdiMapMarkerMultipleOutline, mdiPencilOutline, mdiSelectRemove } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  type Props = {
    data: PageData;
  };

  let { data }: Props = $props();

  let isLoading = $state(false);
  let point = $state<LatLng>();
  const selection = $derived(librarySession.selection);
  let locationUpdated = $state(false);

  let timelineManager = $state<TimelineManager>() as TimelineManager;
  const options = {
    visibility: AssetVisibility.Timeline,
    withStacked: true,
    withPartners: true,
    withCoordinates: true,
  };

  const isOwnAsset = (asset: TimelineAsset) => asset.ownerId === authManager.user.id;

  /** The loaded asset behind a selected id, so ownership can be checked before anything is sent. */
  const findAsset = (id: string): TimelineAsset | null => {
    for (const month of timelineManager.months) {
      for (const day of month.timelineDays) {
        const match = day.viewerAssets.find((viewerAsset) => viewerAsset.id === id);
        if (match?.asset) {
          return match.asset;
        }
      }
    }
    return null;
  };

  const handleUpdate = async () => {
    if (!point) {
      return;
    }

    const ids = [...selection];

    const confirmed = await modalManager.show(GeolocationUpdateConfirmModal, {
      point,
      assetCount: ids.length,
    });

    if (!confirmed) {
      return;
    }

    // Only the signed-in user's own items can be moved; the rest of the selection is left alone.
    const owned = ids.filter((id) => {
      const asset = findAsset(id);
      return !asset || isOwnAsset(asset);
    });

    await updateAssets({
      assetBulkUpdateDto: {
        ids: owned,
        latitude: point.lat,
        longitude: point.lng,
      },
    });

    const updatedAssets = await Promise.all(
      ids.map(async (id) => {
        const updatedAsset = await getAssetInfo({ ...authManager.params, id });
        return toTimelineAsset(updatedAsset);
      }),
    );

    timelineManager.upsertAssets(updatedAssets);

    librarySession.clearSelection();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Shift') {
      event.preventDefault();
    }
    if (event.key === 'Escape' && selection.length > 0) {
      librarySession.clearSelection();
    }
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.key === 'Shift') {
      event.preventDefault();
    }
  };

  const handlePickPoint = async () => {
    const selected = await modalManager.show(GeolocationPointPickerModal, { point });
    if (!selected) {
      return;
    }

    point = selected;
  };
  type AssetPoint = { latitude: number; longitude: number };

  const hasGps = (asset: TimelineAsset | AssetPoint): asset is AssetPoint =>
    isDefined(asset.latitude) && isDefined(asset.longitude);

  /**
   * A plain click on an item that already has coordinates reads them into the picker rather than
   * selecting it — that is how this utility has always worked. Everything else falls through to
   * the timeline, which selects, because this page is a picking surface.
   */
  const handleTileClick = (asset: TimelineAsset) => {
    if (!hasGps(asset)) {
      return false;
    }
    locationUpdated = true;
    setTimeout(() => {
      locationUpdated = false;
    }, 1500);
    point = { lat: asset.latitude, lng: asset.longitude };
    void setQueryValue('at', asset.id);
    return true;
  };
</script>

<svelte:document onkeydown={onKeyDown} onkeyup={onKeyUp} />

<UserPageLayout title={data.meta.title} scrollbar={true}>
  {#snippet buttons()}
    <div class="flex place-items-center justify-end gap-2">
      <Text class="mr-4 hidden md:block" size="tiny" color="muted">{$t('geolocation_instruction_location')}</Text>
      <div class="flex place-content-center place-items-center rounded-2xl border bg-primary/10 px-2 py-1">
        <Text class="mr-5 ml-2 hidden font-mono md:inline-block" color="muted" size="tiny">
          {$t('selected_gps_coordinates')}
        </Text>
        <Text
          title="latitude, longitude"
          class="rounded-3xl px-2 py-1 font-mono text-sm text-primary transition-all duration-100 ease-in-out {locationUpdated
            ? 'scale-105 bg-primary/90 font-semibold text-light'
            : ''}"
        >
          {#if point}
            {point.lat.toFixed(3)}, {point.lng.toFixed(3)}
          {:else}
            {$t('none')}
          {/if}
        </Text>
      </div>

      <Button size="small" color="secondary" variant="ghost" leadingIcon={mdiPencilOutline} onclick={handlePickPoint}>
        <Text class="hidden sm:inline-block">{$t('location_picker_choose_on_map')}</Text>
      </Button>
      <Button
        leadingIcon={mdiSelectRemove}
        size="small"
        color="secondary"
        variant="ghost"
        disabled={selection.length === 0}
        onclick={() => librarySession.clearSelection()}
      >
        {$t('unselect_all')}
      </Button>
      <Button
        leadingIcon={mdiMapMarkerMultipleOutline}
        size="small"
        color="primary"
        disabled={selection.length === 0}
        onclick={() => handleUpdate()}
      >
        <Text class="hidden sm:inline-block">
          {$t('apply_count', { values: { count: selection.length } })}
        </Text>
      </Button>
    </div>
  {/snippet}

  {#if isLoading}
    <div class="flex size-full items-center justify-center">
      <LoadingSpinner size="giant" />
    </div>
  {/if}

  <LibraryView
    selectionMode
    noSelectionBar
    enableRouting
    syncUrl={false}
    bind:timelineManager
    {options}
    destination={{ kind: 'library' }}
    onTileClick={handleTileClick}
  >
    {#snippet tileOverlay(asset: TimelineAsset)}
      {#if !isOwnAsset(asset)}
        <span class="pointer-events-none absolute inset-0 rounded-sm bg-black/40"></span>
      {/if}
      {#if hasGps(asset)}
        <span class="absolute inset-e-3 bottom-1 rounded-xl bg-success px-4 py-1 text-xs text-black transition-colors">
          {asset.city || $t('gps')}
        </span>
      {:else}
        <span class="absolute inset-e-3 bottom-1 rounded-xl bg-danger px-4 py-1 text-xs text-light transition-colors">
          {$t('gps_missing')}
        </span>
      {/if}
    {/snippet}
    {#snippet empty()}
      <EmptyPlaceholder text={$t('no_assets_message')} onClick={() => {}} class="mx-auto mt-10" />
    {/snippet}
  </LibraryView>
</UserPageLayout>
