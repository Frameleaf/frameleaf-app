<script lang="ts">
  /**
   * The information panel's inline location edit (FL-36).
   *
   * Ported from the location row and `LocationDialog` in
   * `design/frameleaf/template/src/MediaViewer.jsx`. The edit is the template's "Edit location"
   * dialog (`ViewerLocationDialog`, audit V-24: place names, coordinates and a pin map), and the
   * write is `updateAsset`. The row adds the design's second line (the coordinates) and
   * the OpenStreetMap deep link beneath it.
   *
   * A failed save reports in place: retry replays the same change, a stale asset is reloaded
   * instead of rewritten, and a rejected or forbidden point is stated without a retry.
   */
  import ViewerInlineEditError from '$lib/components/frameleaf/ViewerInlineEditError.svelte';
  import { coordinateLabel, coordinatesOf, locationLabel, osmLink } from '$lib/frameleaf/info-panel';
  import { classifyInlineEditError, inlineEditRecovery, type InlineEditFailure } from '$lib/frameleaf/inline-edit';
  import ViewerLocationDialog from '$lib/components/frameleaf/ViewerLocationDialog.svelte';
  import { locationPatch } from '$lib/frameleaf/viewer-location';
  import { handlePromiseError } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import { getAssetInfo, updateAsset, type AssetResponseDto } from '@immich/sdk';
  import { Icon, modalManager } from '@immich/ui';
  import { mdiMapMarkerOutline, mdiOpenInNew, mdiPencil } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type LocationChange = Exclude<ReturnType<typeof locationPatch>, 'invalid' | null>;

  type Props = {
    isOwner: boolean;
    asset: AssetResponseDto;
    /** Lets the viewer take the updated asset, so the change is not stranded in the panel. */
    onAssetRefresh?: (asset: AssetResponseDto) => void;
  };

  let { isOwner, asset = $bindable(), onAssetRefresh }: Props = $props();

  let failure = $state<InlineEditFailure | null>(null);
  let isSaving = $state(false);
  /** The last change the person saved, so a retryable failure can replay exactly that change. */
  let pending = $state<LocationChange | null>(null);

  const point = $derived(coordinatesOf(asset.exifInfo));
  const place = $derived(locationLabel(asset.exifInfo));
  const coordinates = $derived(coordinateLabel(point));
  const mapLink = $derived(osmLink(point));

  const fail = (error: unknown, change: LocationChange | null) => {
    failure = classifyInlineEditError(error);
    pending = change;
  };

  const save = async (change: LocationChange) => {
    isSaving = true;
    try {
      asset = await updateAsset({ id: asset.id, updateAssetDto: change });
      failure = null;
      pending = null;
      onAssetRefresh?.(asset);
    } catch (error) {
      fail(error, change);
      handleError(error, $t('errors.unable_to_change_location'));
    } finally {
      isSaving = false;
    }
  };

  // V-24: the template's "Edit location" dialog, which saves through `updateAsset` itself.
  const onAction = async () => {
    const updated = await modalManager.show(ViewerLocationDialog, {
      asset,
      onError: (error: unknown, change: ReturnType<typeof locationPatch>) =>
        fail(error, change && change !== 'invalid' ? change : null),
    });
    if (!updated) {
      return;
    }
    asset = updated;
    failure = null;
    pending = null;
    onAssetRefresh?.(asset);
  };

  const reload = async () => {
    try {
      asset = await getAssetInfo({ id: asset.id });
      failure = null;
      pending = null;
      onAssetRefresh?.(asset);
    } catch (error) {
      handleError(error, $t('frameleaf_info_error_reload_failed'));
    }
  };
</script>

<div data-testid="frameleaf-info-location">
  {#if place || coordinates}
    <button
      type="button"
      class="flex w-full place-items-start justify-between gap-4 py-4 text-start"
      onclick={isOwner ? onAction : undefined}
      title={isOwner ? $t('edit_location') : ''}
      class:hover:text-primary={isOwner}
    >
      <div class="flex gap-4">
        <div><Icon icon={mdiMapMarkerOutline} size="24" /></div>

        <div class="min-w-0">
          <p>{place ?? $t('frameleaf_info_no_location')}</p>
          {#if coordinates}
            <p class="text-sm text-gray-500 dark:text-gray-400">{coordinates}</p>
          {/if}
        </div>
      </div>

      {#if isOwner}
        <div>
          <Icon icon={mdiPencil} size="20" />
        </div>
      {/if}
    </button>

    {#if mapLink}
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve this is an external link -->
      <a
        href={mapLink}
        target="_blank"
        rel="noopener noreferrer"
        class="ms-10 inline-flex items-center gap-1 text-sm hover:text-primary"
      >
        <Icon icon={mdiOpenInNew} size="15" aria-hidden />
        {$t('open_in_openstreetmap')}
      </a>
    {/if}
  {:else if isOwner}
    <button
      type="button"
      class="flex w-full place-items-start justify-between gap-4 rounded-lg py-4 text-start hover:text-primary"
      onclick={onAction}
      title={$t('add_location')}
    >
      <div class="flex gap-4">
        <div><Icon icon={mdiMapMarkerOutline} size="24" /></div>
        <p>{$t('add_a_location')}</p>
      </div>
      <div class="p-1 focus:outline-none">
        <Icon icon={mdiPencil} size="20" />
      </div>
    </button>
  {/if}

  {#if failure}
    <ViewerInlineEditError
      {failure}
      busy={isSaving}
      onRetry={inlineEditRecovery(failure) === 'retry' && pending
        ? () => handlePromiseError(save(pending!))
        : undefined}
      onReload={inlineEditRecovery(failure) === 'reload' ? () => handlePromiseError(reload()) : undefined}
    />
  {/if}
</div>
