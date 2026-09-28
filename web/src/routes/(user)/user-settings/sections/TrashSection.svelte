<script lang="ts">
  import { page } from '$app/state';
  import type { Action } from '$lib/components/asset-viewer/actions/action';
  import TrashManager from '$lib/components/frameleaf/TrashManager.svelte';
  import { AssetAction } from '$lib/constants';
  import Portal from '$lib/elements/Portal.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { handlePromiseError } from '$lib/utils';
  import { navigateToAsset } from '$lib/utils/asset-utils';
  import { navigate } from '$lib/utils/navigation';
  import { getAssetInfo, type AssetResponseDto, type TrashItemResponseDto } from '@immich/sdk';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { onDestroy } from 'svelte';
  import { resolveTrashNeighbours, survivingTrashNeighbours } from './trash-neighbours';
  import { websocketEvents } from '$lib/stores/websocket';
  import { trashFilmstripAsset } from '$lib/frameleaf/trash';

  /**
   * Trash (FL-47): the Frameleaf trash browser, the design template's Trash area of the Command
   * Center (FL-71); the old `/trash` addresses only redirect here.
   *
   * `?assetId=<id>` opens the full viewer over the trash, where an item can be restored or
   * permanently deleted, and the viewer then moves to the next item in the order the trash shows them.
   */

  let items = $state<TrashItemResponseDto[]>([]);
  let neighbours = $state<{ nextAsset?: AssetResponseDto; previousAsset?: AssetResponseDto }>({});

  // The open item comes from the address, as for the utilities (FL-69).
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

  const loadAsset = (id?: string) =>
    id ? getAssetInfo({ ...authManager.params, id }).catch(() => undefined) : Promise.resolve(undefined);

  // The viewer's next and previous items are the trash page's own neighbours of the open item.
  $effect(() => {
    const current = assetViewerManager.isViewing ? assetViewerManager.asset : undefined;
    const index = current ? items.findIndex((item) => item.id === current.id) : -1;
    const nextId = index === -1 ? undefined : items[index + 1]?.id;
    const previousId = index > 0 ? items[index - 1]?.id : undefined;
    neighbours = {};

    let cancelled = false;
    void Promise.all([loadAsset(nextId), loadAsset(previousId)]).then(([nextAsset, previousAsset]) => {
      if (!cancelled) {
        neighbours = { nextAsset, previousAsset };
      }
    });
    return () => {
      cancelled = true;
    };
  });

  const cursor = $derived({ current: assetViewerManager.asset!, ...neighbours });

  // V-17: the trash viewer's filmstrip is the page's own list, in the order the trash shows it.
  const filmstripAssets = $derived(
    authManager.authenticated ? items.map((item) => trashFilmstripAsset(item, authManager.user.id)) : [],
  );

  const closeViewer = () => {
    assetViewerManager.showAssetViewer(false);
    handlePromiseError(navigate({ targetRoute: 'current', assetId: null }));
  };

  /** Items this viewer restored or deleted itself; it has already moved on from them. */
  const handledHere = new Set<string>();

  /** A restored or permanently deleted item leaves the trash: show the next one, as the timeline does. */
  const moveOn = async (assetId: string) => {
    handledHere.add(assetId);
    // A second delete or restore can land before the neighbour lookup for this item finishes; look
    // the neighbours up directly then, instead of closing the viewer on an empty lookup.
    const { nextAsset, previousAsset } = await resolveTrashNeighbours(items, assetId, neighbours, loadAsset);
    items = items.filter((item) => item.id !== assetId);
    if (!(await navigateToAsset(nextAsset)) && !(await navigateToAsset(previousAsset))) {
      closeViewer();
    }
  };

  const preAction = async (action: Action) => {
    if (action.type === AssetAction.DELETE) {
      await moveOn(action.asset.id);
    }
  };

  const onAction = async (action: Action) => {
    if (action.type === AssetAction.RESTORE) {
      await moveOn(action.asset.id);
    }
  };

  /**
   * The open item was restored elsewhere (another tab or device): move on as a local restore does,
   * or close when nothing is left. A delete elsewhere is the viewer's own AssetsDelete handling.
   */
  const onRestoredElsewhere = async (ids: string[]) => {
    const current = assetViewerManager.isViewing ? assetViewerManager.asset : undefined;
    if (!current || !ids.includes(current.id) || handledHere.has(current.id)) {
      return;
    }
    const known = neighbours;
    for (const id of survivingTrashNeighbours(items, current.id, known, ids)) {
      const candidate =
        [known.nextAsset, known.previousAsset].find((asset) => asset?.id === id) ?? (await loadAsset(id));
      if (await navigateToAsset(candidate)) {
        return;
      }
    }
    closeViewer();
  };

  // Subscribed before TrashManager mounts, so this runs while the list still holds the open item.
  onDestroy(websocketEvents.on('on_asset_restore', (ids) => handlePromiseError(onRestoredElsewhere(ids))));
</script>

<TrashManager bind:items />

{#if assetViewerManager.isViewing && assetViewerManager.asset}
  {#await import('$lib/components/asset-viewer/AssetViewer.svelte') then { default: AssetViewer }}
    <Portal target="body">
      <AssetViewer
        {cursor}
        showNavigation={items.length > 1}
        {filmstripAssets}
        {preAction}
        {onAction}
        onClose={closeViewer}
        onAssetUpdate={(updatedAsset) => assetViewerManager.setAsset(updatedAsset)}
      />
    </Portal>
  {/await}
{/if}
