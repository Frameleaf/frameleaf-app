<script lang="ts">
  /**
   * The viewer over a flat, paged list of results (FL-33 cleanup).
   *
   * The legacy shared gallery grid carried its own viewer; retiring that grid would have taken the
   * viewer with it, so this is that wiring on its own: the cursor and the filmstrip come from the
   * list the page already holds, so the viewer can never reach an asset the grid would not open.
   */
  import type { Action } from '$lib/components/asset-viewer/actions/action';
  import type { AssetCursor } from '$lib/components/asset-viewer/AssetViewer.svelte';
  import { AssetAction } from '$lib/constants';
  import Portal from '$lib/elements/Portal.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { Route } from '$lib/route';
  import { handlePromiseError } from '$lib/utils';
  import { getNextAsset, getPreviousAsset, navigateToAsset } from '$lib/utils/asset-utils';
  import { handleError } from '$lib/utils/handle-error';
  import { navigate } from '$lib/utils/navigation';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import type { AlbumResponseDto, AssetResponseDto } from '@immich/sdk';
  import { goto } from '$app/navigation';
  import type { Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  let {
    /** The list the viewer navigates, in the order the page loaded it. */
    assets,
    /** Replace one entry after the viewer changed it. */
    onAssetChange,
    /** Drop entries the viewer removed (trash, delete, archive). */
    onRemove,
    /** Where to go when the list runs out. */
    emptyRoute = Route.photos(),
    /** The album or shared space the list belongs to, for likes, comments and album actions. */
    album,
    /** Whether the album has other members, so the viewer offers its conversation. */
    isShared = false,
    /** What the viewer's activity side panel shows for the open item (FL-55 shared spaces). */
    activityPanel,
  }: {
    assets: AssetResponseDto[];
    onAssetChange?: (asset: AssetResponseDto) => void;
    onRemove?: (id: string) => void;
    emptyRoute?: string;
    album?: AlbumResponseDto;
    isShared?: boolean;
    activityPanel?: Snippet<[AssetResponseDto]>;
  } = $props();

  const filmstripAssets = $derived(assets.map((asset) => toTimelineAsset(asset)));

  const cursor = $derived<AssetCursor>({
    current: assetViewerManager.asset!,
    nextAsset: getNextAsset(assets, assetViewerManager.asset),
    previousAsset: getPreviousAsset(assets, assetViewerManager.asset),
  });

  const handleRandom = async (): Promise<{ id: string } | undefined> => {
    if (assets.length === 0) {
      return;
    }
    try {
      const asset = assets[Math.floor(Math.random() * assets.length)];
      await navigateToAsset(asset);
      return asset;
    } catch (error) {
      handleError(error, $t('errors.cannot_navigate_next_asset'));
      return;
    }
  };

  const handleAction = async (action: Action) => {
    switch (action.type) {
      // Each of these leaves the list; an item moved to Locked leaves every list but Locked's own.
      case AssetAction.ARCHIVE:
      case AssetAction.DELETE:
      case AssetAction.TRASH:
      case AssetAction.SET_VISIBILITY_LOCKED: {
        const nextAsset = cursor.nextAsset ?? cursor.previousAsset;
        onRemove?.(action.asset.id);
        if (assets.length <= 1) {
          return await goto(emptyRoute);
        }
        if (nextAsset) {
          await navigateToAsset(nextAsset);
        }
        break;
      }
      // no default
    }
  };
</script>

{#if assetViewerManager.isViewing}
  <Portal target="body">
    {#await import('$lib/components/asset-viewer/AssetViewer.svelte') then { default: AssetViewer }}
      <AssetViewer
        {cursor}
        onAction={handleAction}
        onRandom={handleRandom}
        onAssetChange={(asset) => onAssetChange?.(asset)}
        onAssetUpdate={(asset) => {
          // The cursor is derived from the manager's asset, so the refreshed asset is pushed back
          // into it and the viewer redraws from the same source the page reads.
          onAssetChange?.(asset);
          assetViewerManager.setAsset(asset);
        }}
        onClose={() => {
          assetViewerManager.showAssetViewer(false);
          handlePromiseError(navigate({ targetRoute: 'current', assetId: null }));
        }}
        {filmstripAssets}
        {album}
        {isShared}
        {activityPanel}
      />
    {/await}
  </Portal>
{/if}
