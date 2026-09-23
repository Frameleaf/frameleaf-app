<script lang="ts">
  import type { Action } from '$lib/components/asset-viewer/actions/action';
  import LargeFilesReview from '$lib/components/frameleaf/LargeFilesReview.svelte';
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import { AssetAction } from '$lib/constants';
  import Portal from '$lib/elements/Portal.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { handlePromiseError } from '$lib/utils';
  import { getNextAsset, getPreviousAsset, navigateToAsset } from '$lib/utils/asset-utils';
  import { navigate } from '$lib/utils/navigation';
  import type { AssetResponseDto } from '@immich/sdk';
  import { Container, Theme as AppTheme, themeManager } from '@immich/ui';
  import { SvelteSet } from 'svelte/reactivity';
  import type { PageData } from './$types';

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
  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');

  /** What the viewer steps through: largest first, without what already went to the trash. */
  const inLibrary = $derived(assets.filter((asset) => !trashed.has(asset.id)));

  const onOpen = async (asset: AssetResponseDto) => {
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
    if (payload.type === AssetAction.TRASH) {
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      (await navigateToAsset(assetCursor.nextAsset)) ||
        (await navigateToAsset(assetCursor.previousAsset)) ||
        assetViewerManager.showAssetViewer(false);
    }
  };
</script>

<UserPageLayout title={data.meta.title} scrollbar={true}>
  <Container size="large" center class="my-4">
    <Theme theme={appTheme}>
      <LargeFilesReview {assets} {trashed} onOpen={(asset) => void onOpen(asset)} />
    </Theme>
  </Container>
</UserPageLayout>

{#if assetViewerManager.isViewing}
  {#await import('$lib/components/asset-viewer/AssetViewer.svelte') then { default: AssetViewer }}
    <Portal target="body">
      <AssetViewer
        cursor={assetCursor}
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
