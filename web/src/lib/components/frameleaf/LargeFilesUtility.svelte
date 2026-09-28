<script lang="ts">
  import { page } from '$app/state';
  import type { Action } from '$lib/components/asset-viewer/actions/action';
  import LargeFilesReview from '$lib/components/frameleaf/LargeFilesReview.svelte';
  import { AssetAction } from '$lib/constants';
  import Portal from '$lib/elements/Portal.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { handlePromiseError } from '$lib/utils';
  import { getNextAsset, getPreviousAsset, navigateToAsset } from '$lib/utils/asset-utils';
  import { navigate } from '$lib/utils/navigation';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import { getAssetInfo, type AssetResponseDto } from '@immich/sdk';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { onDestroy } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import type { UtilityData } from '$lib/frameleaf/utilities-load';
  type PageData = Extract<UtilityData, { tool: 'large-files' }>;

  /**
   * Settings → Utilities → Large files (FL-47): the Frameleaf review from the design template.
   * `/utilities/large-files/photos/:id` keeps its URL contract: it opens the full viewer over the
   * largest items still in the library, and moving one to the trash there shows the next one.
   */
  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  const assets = $derived(data.assets);
  const trashed = new SvelteSet<string>();
  const removed = new SvelteSet<string>();

  /** What the viewer steps through: largest first, without what went to the trash or was deleted. */
  const inLibrary = $derived(assets.filter((asset) => !trashed.has(asset.id) && !removed.has(asset.id)));

  const onOpen = async (asset: AssetResponseDto) => {
    const info = await getAssetInfo({ ...authManager.params, id: asset.id });
    assetViewerManager.setAsset(info);
    await navigate({ targetRoute: 'current', assetId: asset.id });
  };

  const onRandom = async () => {
    if (inLibrary.length === 0) {
      return undefined;
    }
    const asset = inLibrary[Math.floor(Math.random() * inLibrary.length)];
    await onOpen(asset);
    return asset;
  };

  const assetCursor = $derived({
    current: assetViewerManager.asset!,
    nextAsset: getNextAsset(inLibrary, assetViewerManager.asset),
    previousAsset: getPreviousAsset(inLibrary, assetViewerManager.asset),
  });

  const preAction = async (payload: Action) => {
    // A permanent delete (trash turned off) moves on the same way.
    if (payload.type === AssetAction.TRASH || payload.type === AssetAction.DELETE) {
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      (await navigateToAsset(assetCursor.nextAsset)) ||
        (await navigateToAsset(assetCursor.previousAsset)) ||
        assetViewerManager.showAssetViewer(false);
    }
  };
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

<LargeFilesReview {assets} {trashed} {removed} onOpen={(asset) => void onOpen(asset)} />

{#if assetViewerManager.isViewing}
  {#await import('$lib/components/asset-viewer/AssetViewer.svelte') then { default: AssetViewer }}
    <Portal target="body">
      <AssetViewer
        cursor={assetCursor}
        filmstripAssets={inLibrary.map((asset) => toTimelineAsset(asset))}
        showNavigation={inLibrary.length > 1}
        {onRandom}
        {preAction}
        onClose={() => {
          assetViewerManager.showAssetViewer(false);
          handlePromiseError(navigate({ targetRoute: 'current', assetId: null }));
        }}
        onAssetUpdate={(updatedAsset) => {
          // assetCursor is derived from `assetViewerManager.asset`; push the refreshed asset into
          // the manager so the cursor recomputes and the viewer reflects the change.
          assetViewerManager.setAsset(updatedAsset);
        }}
      />
    </Portal>
  {/await}
{/if}
