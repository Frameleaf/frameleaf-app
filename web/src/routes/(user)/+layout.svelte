<script lang="ts">
  import { afterNavigate } from '$app/navigation';
  import { page } from '$app/state';
  import UploadCover from '$lib/components/frameleaf/DragDropUploadOverlay.svelte';
  import { arrivedFromSetup, offerNextSteps } from '$lib/components/timeline/next-steps.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import type { Snippet } from 'svelte';
  interface Props {
    children?: Snippet;
  }

  let { children }: Props = $props();

  // First-run setup hands off into the app: the administrator who arrives that way is offered the
  // library's one-time "Next steps" card (LibraryNextSteps), wherever setup sent them first.
  afterNavigate(({ from }) => {
    if (arrivedFromSetup(from) && authManager.authenticated && authManager.user.isAdmin) {
      offerNextSteps(authManager.user.id);
    }
  });

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
