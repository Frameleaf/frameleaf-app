<script lang="ts">
  import type { Action } from '$lib/components/asset-viewer/actions/action';
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import TrashManager from '$lib/components/frameleaf/TrashManager.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import { AssetAction } from '$lib/constants';
  import Portal from '$lib/elements/Portal.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { handlePromiseError } from '$lib/utils';
  import { navigateToAsset } from '$lib/utils/asset-utils';
  import { navigate } from '$lib/utils/navigation';
  import { getAssetInfo, type AssetResponseDto, type TrashItemResponseDto } from '@immich/sdk';
  import { Container, Theme as AppTheme, themeManager } from '@immich/ui';
  import type { PageData } from './$types';

  /**
   * Trash (FL-47): the Frameleaf trash browser, as in the design template's Trash area.
   *
   * `/trash/photos/:id` keeps its URL contract: it opens the full viewer over the trash, where an
   * item can be restored or permanently deleted, and the viewer then moves to the next item in the
   * order the trash page shows them.
   */
  type Props = {
    data: PageData;
  };

  let { data }: Props = $props();

  let items = $state<TrashItemResponseDto[]>([]);
  let neighbours = $state<{ nextAsset?: AssetResponseDto; previousAsset?: AssetResponseDto }>({});

  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');

  // The viewer's next and previous items are the trash page's own neighbours of the open item.
  $effect(() => {
    const current = assetViewerManager.isViewing ? assetViewerManager.asset : undefined;
    const index = current ? items.findIndex((item) => item.id === current.id) : -1;
    const nextId = index === -1 ? undefined : items[index + 1]?.id;
    const previousId = index > 0 ? items[index - 1]?.id : undefined;
    neighbours = {};

    let cancelled = false;
    const load = (id?: string) => (id ? getAssetInfo({ id }).catch(() => undefined) : Promise.resolve(undefined));
    void Promise.all([load(nextId), load(previousId)]).then(([nextAsset, previousAsset]) => {
      if (!cancelled) {
        neighbours = { nextAsset, previousAsset };
      }
    });
    return () => {
      cancelled = true;
    };
  });

  const cursor = $derived({ current: assetViewerManager.asset!, ...neighbours });

  const closeViewer = () => {
    assetViewerManager.showAssetViewer(false);
    handlePromiseError(navigate({ targetRoute: 'current', assetId: null }));
  };

  /** A restored or permanently deleted item leaves the trash: show the next one, as the timeline does. */
  const moveOn = async (assetId: string) => {
    const { nextAsset, previousAsset } = neighbours;
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
</script>

<UserPageLayout title={data.meta.title}>
  <Container size="large" center class="my-4">
    <Theme theme={appTheme}>
      <TrashManager bind:items />
    </Theme>
  </Container>
</UserPageLayout>

{#if assetViewerManager.isViewing && assetViewerManager.asset}
  {#await import('$lib/components/asset-viewer/AssetViewer.svelte') then { default: AssetViewer }}
    <Portal target="body">
      <AssetViewer
        {cursor}
        showNavigation={items.length > 1}
        {preAction}
        {onAction}
        onClose={closeViewer}
        onAssetUpdate={(updatedAsset) => assetViewerManager.setAsset(updatedAsset)}
      />
    </Portal>
  {/await}
{/if}
