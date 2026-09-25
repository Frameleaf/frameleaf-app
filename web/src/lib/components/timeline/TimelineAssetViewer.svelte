<script lang="ts">
  import { positionInTimeline } from '$lib/frameleaf/viewer-position';
  import type { Action } from '$lib/components/asset-viewer/actions/action';
  import type { AssetCursor } from '$lib/components/asset-viewer/AssetViewer.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import { AssetAction } from '$lib/constants';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { assetCacheManager } from '$lib/managers/AssetCacheManager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
  import { websocketEvents } from '$lib/stores/websocket';
  import { handlePromiseError } from '$lib/utils';
  import { updateStackedAssetInTimeline, updateUnstackedAssetInTimeline } from '$lib/utils/actions';
  import { navigateToAsset } from '$lib/utils/asset-utils';
  import { handleErrorAsync } from '$lib/utils/handle-error';
  import { navigate } from '$lib/utils/navigation';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import { type AlbumResponseDto, type AssetResponseDto, type PersonResponseDto, getAssetInfo } from '@immich/sdk';
  import { onDestroy, onMount, type Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  interface Props {
    timelineManager: TimelineManager;
    invisible: boolean;
    withStacked?: boolean;
    isShared?: boolean;
    album?: AlbumResponseDto;
    person?: PersonResponseDto;
    removeAction?: AssetAction.UNARCHIVE | AssetAction.ARCHIVE | AssetAction.SET_VISIBILITY_TIMELINE | null;
    /** Replaces the viewer's activity side panel; a shared space mounts its own threaded comments here. */
    activityPanel?: Snippet<[AssetResponseDto]>;
  }

  let {
    timelineManager,
    // eslint-disable-next-line no-useless-assignment
    invisible = $bindable(false),
    removeAction,
    withStacked = false,
    isShared = false,
    album,
    person,
    activityPanel,
  }: Props = $props();

  const getAsset = (id: string) => {
    return handleErrorAsync(
      () => assetCacheManager.getAsset({ ...authManager.params, id }),
      $t('error_retrieving_asset_information'),
    );
  };

  const getNextAsset = async (currentAsset: AssetResponseDto) => {
    const earlierTimelineAsset = await timelineManager.getEarlierAsset(currentAsset);
    if (!earlierTimelineAsset) {
      return;
    }
    return getAsset(earlierTimelineAsset.id);
  };

  const getPreviousAsset = async (currentAsset: AssetResponseDto) => {
    const laterTimelineAsset = await timelineManager.getLaterAsset(currentAsset);
    if (!laterTimelineAsset) {
      return;
    }
    return getAsset(laterTimelineAsset.id);
  };

  let assetCursor = $state<AssetCursor>({
    current: assetViewerManager.asset!,
    previousAsset: undefined,
    nextAsset: undefined,
  });

  let cursorVersion = 0;
  const loadCloseAssets = async (currentAsset: AssetResponseDto) => {
    const version = ++cursorVersion;
    const [nextAsset, previousAsset] = await Promise.all([getNextAsset(currentAsset), getPreviousAsset(currentAsset)]);

    if (
      version !== cursorVersion ||
      assetViewerManager.asset?.id !== currentAsset.id ||
      !assetViewerManager.isViewing
    ) {
      return;
    }
    assetCursor = {
      current: currentAsset,
      nextAsset,
      previousAsset,
    };
  };

  //TODO: replace this with async derived in svelte 6
  $effect(() => {
    const asset = assetViewerManager.asset;
    if (asset) {
      handlePromiseError(loadCloseAssets(asset));
    }
  });

  /**
   * FL-35: the filmstrip shows the loaded month around the open asset. It reads only what
   * the timeline manager already holds — it never loads a bucket of its own — so an empty
   * or not-yet-loaded month simply means no filmstrip.
   */
  const filmstripAssets = $derived.by<TimelineAsset[]>(() => {
    const current = assetCursor.current;
    if (!current) {
      return [];
    }
    return timelineManager.getTimelineMonthByAssetId(current.id)?.getAssets() ?? [];
  });

  // V-12: "n of N" through the whole timeline, from the month counts it already holds.
  const position = $derived(
    assetCursor.current ? positionInTimeline(timelineManager.months, assetCursor.current.id) : null,
  );

  const handleRandom = async () => {
    const randomAsset = await timelineManager.getRandomAsset();
    if (!randomAsset) {
      return;
    }

    await navigate({ targetRoute: 'current', assetId: randomAsset.id });
    return { id: randomAsset.id };
  };

  const handleClose = async (assetId: string) => {
    invisible = true;
    assetViewerManager.gridScrollTarget = { at: assetId };
    await navigate({
      targetRoute: 'current',
      assetId: null,
      assetGridRouteSearchParams: assetViewerManager.gridScrollTarget,
    });
  };

  const onAlbumRemoveAssets = async ({ assetIds, albumIds }: { assetIds: string[]; albumIds: string[] }) => {
    if (!album || !albumIds.includes(album.id)) {
      return;
    }

    timelineManager.removeAssets(assetIds);

    if (!assetIds.includes(assetCursor.current.id)) {
      return;
    }

    // keep the cleanup workflow in viewer by moving to adjacent asset first
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    (await navigateToAsset(assetCursor?.nextAsset)) ||
      (await navigateToAsset(assetCursor?.previousAsset)) ||
      (await handleClose(assetCursor.current.id));
  };

  const handleAssetSuppressed = async (asset: AssetResponseDto) => {
    timelineManager.removeAssets([asset.id]);

    if (asset.id !== assetCursor.current.id) {
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    (await navigateToAsset(assetCursor.nextAsset)) ||
      (await navigateToAsset(assetCursor.previousAsset)) ||
      (await handleClose(asset.id));
  };

  const handlePreAction = async (action: Action) => {
    switch (action.type) {
      case AssetAction.SET_VISIBILITY_LOCKED:
      case AssetAction.SET_VISIBILITY_TIMELINE: {
        // FL-34: Mark and Unmark Sensitive only take the item out of a view it no longer belongs in
        if (timelineManager.keepsAfterLockChange(action.type === AssetAction.SET_VISIBILITY_LOCKED)) {
          break;
        }
        timelineManager.removeAssets([action.asset.id]);
        // A delayed confirmation for A must not navigate using the current B cursor.
        if (assetViewerManager.asset?.id !== action.asset.id || assetCursor.current.id !== action.asset.id) {
          return;
        }
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        (await navigateToAsset(assetCursor?.nextAsset)) ||
          (await navigateToAsset(assetCursor?.previousAsset)) ||
          (await handleClose(action.asset.id));
        break;
      }
      case removeAction:
      case AssetAction.TRASH:
      case AssetAction.RESTORE:
      case AssetAction.DELETE:
      case AssetAction.ARCHIVE: {
        // must update manager before performing any navigation
        timelineManager.removeAssets([action.asset.id]);
        // A delayed confirmation for A must not navigate using the current B cursor.
        if (assetViewerManager.asset?.id !== action.asset.id || assetCursor.current.id !== action.asset.id) {
          return;
        }

        // find the next asset to show or close the viewer
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        (await navigateToAsset(assetCursor?.nextAsset)) ||
          (await navigateToAsset(assetCursor?.previousAsset)) ||
          (await handleClose(action.asset.id));

        break;
      }
      // no default
    }
  };
  const handleAction = (action: Action) => {
    switch (action.type) {
      case AssetAction.ARCHIVE:
      case AssetAction.UNARCHIVE: {
        timelineManager.upsertAssets([action.asset]);
        break;
      }

      case AssetAction.STACK: {
        updateStackedAssetInTimeline(timelineManager, {
          stack: action.stack,
          toDeleteIds: action.stack.assets
            .filter((asset) => asset.id !== action.stack.primaryAssetId)
            .map((asset) => asset.id),
        });
        break;
      }

      case AssetAction.UNSTACK: {
        updateUnstackedAssetInTimeline(timelineManager, action.assets);
        break;
      }
      case AssetAction.REMOVE_ASSET_FROM_STACK: {
        timelineManager.upsertAssets([toTimelineAsset(action.asset)]);
        if (action.stack) {
          //Have to unstack then restack assets in timeline in order to update the stack count in the timeline.
          updateUnstackedAssetInTimeline(
            timelineManager,
            action.stack.assets.map((asset) => toTimelineAsset(asset)),
          );
          updateStackedAssetInTimeline(timelineManager, {
            stack: action.stack,
            toDeleteIds: action.stack.assets
              .filter((asset) => asset.id !== action.stack?.primaryAssetId)
              .map((asset) => asset.id),
          });
        }
        break;
      }
      case AssetAction.SET_STACK_PRIMARY_ASSET: {
        //Have to unstack then restack assets in timeline in order for the currently removed new primary asset to be made visible.
        updateUnstackedAssetInTimeline(
          timelineManager,
          action.stack.assets.map((asset) => toTimelineAsset(asset)),
        );
        updateStackedAssetInTimeline(timelineManager, {
          stack: action.stack,
          toDeleteIds: action.stack.assets
            .filter((asset) => asset.id !== action.stack.primaryAssetId)
            .map((asset) => asset.id),
        });
        break;
      }
      // no default
    }
  };
  const handleUndoDelete = async (assets: TimelineAsset[]) => {
    timelineManager.upsertAssets(assets);
    if (assets.length === 0) {
      return;
    }

    const restoredAsset = assets[0];
    const asset = await getAssetInfo({ ...authManager.params, id: restoredAsset.id });
    assetViewerManager.setAsset(asset);
    await navigate({ targetRoute: 'current', assetId: restoredAsset.id });
  };

  const handleUpdateOrUpload = (asset: AssetResponseDto) => {
    if (asset.id === assetCursor.current.id) {
      void loadCloseAssets(asset);
    }
  };

  onMount(() => {
    const unsubscribes = [
      websocketEvents.on('on_upload_success', (asset: AssetResponseDto) => handleUpdateOrUpload(asset)),
      websocketEvents.on('on_asset_update', (asset: AssetResponseDto) => handleUpdateOrUpload(asset)),
    ];
    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  });

  onDestroy(() => {
    cursorVersion++;
    assetCacheManager.invalidate();
  });
</script>

<OnEvents {onAlbumRemoveAssets} />

{#await import('$lib/components/asset-viewer/AssetViewer.svelte') then { default: AssetViewer }}
  <AssetViewer
    {withStacked}
    cursor={assetCursor}
    {isShared}
    {album}
    {person}
    {activityPanel}
    onAssetChange={(asset) => {
      timelineManager?.upsertAssets([toTimelineAsset(asset)]);
    }}
    preAction={handlePreAction}
    onAction={(action) => {
      handleAction(action);
      assetCacheManager.invalidate();
    }}
    onUndoDelete={handleUndoDelete}
    onRandom={handleRandom}
    onAssetSuppressed={handleAssetSuppressed}
    onClose={handleClose}
    {filmstripAssets}
    {position}
  />
{/await}
