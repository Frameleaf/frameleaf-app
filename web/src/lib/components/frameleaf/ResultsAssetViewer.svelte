<script lang="ts">
  import { positionInList } from '$lib/frameleaf/viewer-position';
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
  import { afterNavigate, goto } from '$app/navigation';
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
  // V-12: "n of N" in the list the page holds.
  const position = $derived(
    assetViewerManager.asset
      ? positionInList(
          assets.map((asset) => asset.id),
          assetViewerManager.asset.id,
        )
      : null,
  );

  /**
   * How many history entries the viewer has added since it opened over this list (FL-50). Closing
   * goes back that many, so the list's own entry is where the viewer leaves off and Back from the
   * list returns to the page that opened it (Explore → results → viewer → close → Back → Explore).
   * A viewer reached by a link or a reload added nothing, so it closes by replacing its entry.
   */
  let viewerDepth = 0;
  afterNavigate((navigation) => {
    const { from, to, type } = navigation;
    if (!to?.params?.assetId) {
      viewerDepth = 0;
    } else if (navigation.type === 'popstate') {
      viewerDepth = Math.max(0, viewerDepth + (navigation.delta ?? 0));
    } else if ((type === 'goto' || type === 'link') && from?.route.id === to.route.id) {
      viewerDepth += 1;
    } else {
      viewerDepth = 0;
    }
  });

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

  const removalTarget = (action: Action) => {
    switch (action.type) {
      case AssetAction.ARCHIVE:
      case AssetAction.DELETE:
      case AssetAction.TRASH:
      case AssetAction.SET_VISIBILITY_LOCKED: {
        return action.asset;
      }
      // no default
    }
  };

  const handlePreAction = async (action: Action) => {
    const target = removalTarget(action);
    if (!target || assetViewerManager.asset?.id !== target.id) {
      return;
    }
    // Resolve the neighbor before the mutation's event can retire the current cursor.
    const nextAsset = cursor.nextAsset ?? cursor.previousAsset;
    if (nextAsset) {
      await navigateToAsset(nextAsset);
    } else {
      await goto(emptyRoute);
    }
  };

  const handleAction = (action: Action) => {
    const target = removalTarget(action);
    if (target) {
      onRemove?.(target.id);
    }
  };
</script>

{#if assetViewerManager.isViewing}
  <Portal target="body">
    {#await import('$lib/components/asset-viewer/AssetViewer.svelte') then { default: AssetViewer }}
      <AssetViewer
        {cursor}
        preAction={handlePreAction}
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
          // Closing the viewer is not a new place to go back to (FL-50): return to the list's own
          // entry, or replace the viewer's entry when it was the first one.
          if (viewerDepth > 0) {
            history.go(-viewerDepth);
            viewerDepth = 0;
            return;
          }
          handlePromiseError(navigate({ targetRoute: 'current', assetId: null }, { replaceState: true }));
        }}
        {filmstripAssets}
        {position}
        {album}
        {isShared}
        {activityPanel}
      />
    {/await}
  </Portal>
{/if}
