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
  import LandmarkBadge from '$lib/components/frameleaf/LandmarkBadge.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import ViewerInlineEditError from '$lib/components/frameleaf/ViewerInlineEditError.svelte';
  import { coordinateLabel, coordinatesOf, locationLabel, osmLink } from '$lib/frameleaf/info-panel';
  import { classifyInlineEditError, inlineEditRecovery, type InlineEditFailure } from '$lib/frameleaf/inline-edit';
  import { landmarkHref, landmarkKind } from '$lib/frameleaf/landmarks';
  import { libraryReferenceUrl } from '$lib/frameleaf/library-reference';
  import ViewerLocationDialog from '$lib/components/frameleaf/ViewerLocationDialog.svelte';
  import { locationPatch } from '$lib/frameleaf/viewer-location';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { handlePromiseError } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import { dismissAssetLocationInsight, getAssetInfo, updateAsset, type AssetResponseDto } from '@frameleaf/sdk';
  import { Icon, modalManager } from '@frameleaf/ui';
  import { mdiMapMarkerOutline, mdiOpenInNew, mdiPencil } from '@mdi/js';
  import { onDestroy } from 'svelte';
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
  let isDismissing = $state(false);
  let dismissFailed = $state(false);
  /** The last change the person saved, so a retryable failure can replay exactly that change. */
  let pending = $state<LocationChange | null>(null);

  const point = $derived(coordinatesOf(asset.exifInfo));
  const place = $derived(locationLabel(asset.exifInfo));
  const coordinates = $derived(coordinateLabel(point));
  const mapLink = $derived(osmLink(point));
  // FL-354: the landmark the item was taken at; the server lists the best label first.
  const landmarks = $derived(
    (asset.landmarks ?? []).filter((item, index) => index === 0 || item.inference === 'visual').slice(0, 2),
  );
  const insight = $derived(point ? asset.locationInsight : undefined);
  const insightMapLink = $derived(libraryReferenceUrl(insight?.mapsUrl));
  const insightHeadingId = $props.id();

  let alive = true;
  let generation = 0;
  let previousAssetId: string | undefined;
  onDestroy(() => {
    alive = false;
  });
  $effect.pre(() => {
    if (asset.id === previousAssetId) {
      return;
    }
    previousAssetId = asset.id;
    generation++;
    failure = null;
    isSaving = false;
    pending = null;
    isDismissing = false;
    dismissFailed = false;
  });
  const captureView = () => {
    const owner = generation;
    const isCurrentSession = authManager.captureSession();
    return () => alive && owner === generation && isCurrentSession();
  };

  const fail = (error: unknown, change: LocationChange | null) => {
    failure = classifyInlineEditError(error);
    pending = change;
  };

  const dismissInsight = async () => {
    if (!isOwner || !insight || isDismissing) {
      return;
    }
    const isCurrent = captureView();
    isDismissing = true;
    try {
      await dismissAssetLocationInsight({ id: asset.id });
      if (isCurrent()) {
        asset = { ...asset, locationInsight: undefined };
        dismissFailed = false;
        onAssetRefresh?.(asset);
      }
    } catch {
      if (isCurrent()) {
        dismissFailed = true;
      }
    } finally {
      if (isCurrent()) {
        isDismissing = false;
      }
    }
  };

  const save = async (change: LocationChange) => {
    const isCurrent = captureView();
    isSaving = true;
    try {
      const updated = await updateAsset({ id: asset.id, updateAssetDto: change });
      if (!isCurrent()) {
        return;
      }
      asset = updated;
      failure = null;
      pending = null;
      onAssetRefresh?.(asset);
    } catch (error) {
      if (!isCurrent()) {
        return;
      }
      fail(error, change);
      handleError(error, $t('errors.unable_to_change_location'));
    } finally {
      if (isCurrent()) {
        isSaving = false;
      }
    }
  };

  // V-24: the template's "Edit location" dialog, which saves through `updateAsset` itself.
  const onAction = async () => {
    const isCurrent = captureView();
    const updated = await modalManager.show(ViewerLocationDialog, {
      asset,
      onError: (error: unknown, change: ReturnType<typeof locationPatch>) => {
        if (isCurrent()) {
          fail(error, change && change !== 'invalid' ? change : null);
        }
      },
    });
    if (!updated || !isCurrent()) {
      return;
    }
    asset = updated;
    failure = null;
    pending = null;
    onAssetRefresh?.(asset);
  };

  const reload = async () => {
    const isCurrent = captureView();
    try {
      const updated = await getAssetInfo({ id: asset.id });
      if (!isCurrent()) {
        return;
      }
      asset = updated;
      failure = null;
      pending = null;
      onAssetRefresh?.(asset);
    } catch (error) {
      if (isCurrent()) {
        handleError(error, $t('frameleaf_info_error_reload_failed'));
      }
    }
  };
</script>

<div data-testid="frameleaf-info-location">
  {#if place || coordinates || landmarks.length > 0}
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

    {#each landmarks as landmark (landmark.id)}
      <a
        href={landmarkHref(landmark.id)}
        class="flex items-center gap-4 pb-4 hover:text-primary"
        data-testid="frameleaf-info-landmark"
      >
        <LandmarkBadge {landmark} size={24} />
        <div class="min-w-0">
          <p>
            {$t(
              landmark.inference === 'visual'
                ? 'frameleaf_landmark_visual'
                : landmark.inference === 'temporal'
                  ? 'frameleaf_landmark_inferred_at'
                  : 'frameleaf_landmark_at',
              { values: { name: landmark.name } },
            )}
          </p>
          <p class="text-sm text-gray-500 dark:text-gray-400">
            {$t(
              landmark.inference === 'visual'
                ? 'frameleaf_landmark_inference_visual'
                : landmark.inference === 'temporal'
                  ? 'frameleaf_landmark_inference_temporal'
                  : landmarkKind(landmark.kind).labelKey,
            )}
          </p>
        </div>
      </a>
    {/each}

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

  {#if insight}
    <section class="suggestion" aria-labelledby={insightHeadingId}>
      <h4 id={insightHeadingId}>{$t('frameleaf_location_insight_title')}</h4>
      <span class="inferred" title={$t('frameleaf_location_insight_inference')}>
        {$t('frameleaf_location_insight_inferred')}
        <span class="sr-only">{$t('frameleaf_location_insight_inference')}</span>
      </span>
      <p>
        {$t(insight.relation === 'at' ? 'frameleaf_location_insight_at' : 'frameleaf_location_insight_near', {
          values: { name: insight.name },
        })}
      </p>
      {#if insight.address}<p class="muted">{insight.address}</p>{/if}
      {#if insightMapLink}
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve this is an external link -->
        <a href={insightMapLink} target="_blank" rel="noopener noreferrer" class="hover:text-primary">
          {$t('frameleaf_location_insight_open_maps')}
        </a>
      {/if}
      <p class="muted">Google Maps</p>
      {#each insight.attributions as attribution (attribution)}
        {@const href = libraryReferenceUrl(attribution.uri)}
        {#if href}
          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve this is an external link -->
          <a {href} target="_blank" rel="noopener noreferrer" class="muted hover:text-primary">
            {attribution.displayName}
          </a>
        {:else}<p class="muted">{attribution.displayName}</p>{/if}
      {/each}
      {#if isOwner}
        <div>
          <Button disabled={isDismissing} onclick={dismissInsight}>{$t('frameleaf_location_insight_dismiss')}</Button>
        </div>
        {#if dismissFailed}
          <InlineError
            message={$t('frameleaf_location_insight_dismiss_failed')}
            onRetry={dismissInsight}
            retrying={isDismissing}
            compact
          />
        {/if}
      {/if}
    </section>
  {/if}
</div>

<style>
  .suggestion {
    display: grid;
    justify-items: start;
    gap: var(--fl-space-2);
    margin-top: var(--fl-space-4);
    padding: var(--fl-space-4) 0;
    border-top: 1px solid var(--fl-border);
    font-size: var(--fl-font-callout);
    overflow-wrap: anywhere;
  }
  .suggestion h4 {
    font-weight: 600;
  }
  .muted,
  .inferred {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .inferred {
    text-decoration: underline dotted;
    text-underline-offset: 3px;
  }
</style>
