<script lang="ts">
  import { page } from '$app/state';
  import UploadCover from '$lib/components/frameleaf/DragDropUploadOverlay.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import type { Snippet } from 'svelte';
  interface Props {
    children?: Snippet;
  }

  let { children }: Props = $props();

  // $page.data.asset is loaded by route specific +page.ts loaders if that
  // route contains the assetId path.
  //
  // Without one, the viewer closes only when the navigation leaves the page or the asset its route
  // loaded. A page that opens the viewer itself on the same route (Command Center utilities and Trash
  // step through `?assetId=`) keeps it open: closing it on every step remounted the viewer, and a key
  // pressed in between reached the page behind it instead (the duplicate review took an ArrowRight
  // meant for the viewer as "next group").
  let previous: { routeId: string | null; hadAsset: boolean } | undefined;
  $effect.pre(() => {
    const routeId = page.route.id;
    const routeAsset = page.data.asset;
    if (routeAsset) {
      assetViewerManager.setAsset(routeAsset);
    } else if (!previous || previous.routeId !== routeId || previous.hadAsset) {
      assetViewerManager.showAssetViewer(false);
    }
    previous = { routeId, hadAsset: !!routeAsset };
    const asset = page.url.searchParams.get('at');
    assetViewerManager.gridScrollTarget = { at: asset };
  });
</script>

<div class:display-none={assetViewerManager.isViewing}>
  {@render children?.()}
</div>
<UploadCover />

<style>
  :root {
    overscroll-behavior: none;
  }
  .display-none {
    display: none;
  }
</style>
