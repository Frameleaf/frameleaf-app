<script lang="ts">
  import { page } from '$app/state';
  /**
   * Utilities → Duplicate review (FL-61). The page is the prototype's fast duplicate review; the
   * review itself, its queue, decisions and undo live in `DuplicateReview`. This page owns the route:
   * its title, the Frameleaf theme, and the viewer a photo opens in, stepping through its own group.
   */
  import { goto } from '$app/navigation';
  import DuplicateReview from '$lib/components/frameleaf/DuplicateReview.svelte';
  import Portal from '$lib/elements/Portal.svelte';
  import type { ReviewGroup } from '$lib/frameleaf/duplicate-review';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { Route } from '$lib/route';
  import { handlePromiseError } from '$lib/utils';
  import { getNextAsset, getPreviousAsset } from '$lib/utils/asset-utils';
  import { handleError } from '$lib/utils/handle-error';
  import { navigate } from '$lib/utils/navigation';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import { getAssetInfo, type AssetResponseDto } from '@immich/sdk';
  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { UtilityData } from '$lib/frameleaf/utilities-load';
  type PageData = Extract<UtilityData, { tool: 'duplicates' }>;

  type Props = {
    data: PageData;
  };

  let { data }: Props = $props();

  /** The group the viewer steps through: the photos of the group the open photo came from. */
  let viewing = $state<AssetResponseDto[]>([]);

  const openAsset = async (asset: AssetResponseDto, group: ReviewGroup) => {
    viewing = group.assets;
    try {
      const info = await getAssetInfo({ ...authManager.params, id: asset.id });
      assetViewerManager.setAsset(info);
      await navigate({ targetRoute: 'current', assetId: info.id });
    } catch (error) {
      handleError(error, $t('errors.failed_to_load_asset'));
    }
  };

  const onRandom = async () => {
    if (viewing.length === 0) {
      return;
    }
    const asset = viewing[Math.floor(Math.random() * viewing.length)];
    const info = await getAssetInfo({ ...authManager.params, id: asset.id });
    assetViewerManager.setAsset(info);
    await navigate({ targetRoute: 'current', assetId: info.id });
    return { id: info.id };
  };

  const assetCursor = $derived({
    current: assetViewerManager.asset!,
    nextAsset: getNextAsset(viewing, assetViewerManager.asset),
    previousAsset: getPreviousAsset(viewing, assetViewerManager.asset),
  });

  onDestroy(() => assetViewerManager.showAssetViewer(false));
  $effect(() => {
    const id = page.url.searchParams.get('assetId');
    if (!id) {
      assetViewerManager.showAssetViewer(false);
      return;
    }
    let active = true;
    void getAssetInfo({ ...authManager.params, id })
      .then((asset) => {
        if (active) {
          assetViewerManager.setAsset(asset);
        }
      })
      .catch(() => {
        if (active) {
          assetViewerManager.showAssetViewer(false);
        }
      });
    return () => {
      active = false;
    };
  });
</script>

<div class="fl-duplicates-page">
  <DuplicateReview
    groups={data.groups}
    history={data.history}
    trashEnabled={featureFlagsManager.value.trash}
    keyboardPaused={assetViewerManager.isViewing}
    onOpen={(asset, group) => void openAsset(asset, group)}
    onOpenTrash={() => void goto(Route.trash())}
  />
</div>

{#if assetViewerManager.isViewing}
  {#await import('$lib/components/asset-viewer/AssetViewer.svelte') then { default: AssetViewer }}
    <Portal target="body">
      <AssetViewer
        cursor={assetCursor}
        filmstripAssets={viewing.map((asset) => toTimelineAsset(asset))}
        showNavigation={viewing.length > 1}
        {onRandom}
        onClose={() => {
          assetViewerManager.showAssetViewer(false);
          handlePromiseError(navigate({ targetRoute: 'current', assetId: null }));
        }}
        onAssetUpdate={(updatedAsset) => assetViewerManager.setAsset(updatedAsset)}
      />
    </Portal>
  {/await}
{/if}

<style>
  .fl-duplicates-page {
    padding: 4px 0 24px;
  }
</style>
