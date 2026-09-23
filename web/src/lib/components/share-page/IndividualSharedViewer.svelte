<script lang="ts">
  import { goto } from '$app/navigation';
  import type { Action } from '$lib/components/asset-viewer/actions/action';
  import Brand from '$lib/components/frameleaf/Brand.svelte';
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import ResultsAssetViewer from '$lib/components/frameleaf/ResultsAssetViewer.svelte';
  import ResultsView from '$lib/components/frameleaf/ResultsView.svelte';
  import { AssetAction } from '$lib/constants';
  import '$lib/frameleaf/tokens.css';
  import { librarySession } from '$lib/frameleaf/library-session.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { dragAndDropFilesStore } from '$lib/stores/drag-and-drop-files.store';
  import { handlePromiseError } from '$lib/utils';
  import { downloadArchive, navigateToAsset } from '$lib/utils/asset-utils';
  import { fileUploadHandler, openFileUploadDialog } from '$lib/utils/file-uploader';
  import { handleError } from '$lib/utils/handle-error';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import { getAssetInfo, type AssetResponseDto, type SharedLinkResponseDto } from '@immich/sdk';
  import { Icon, Theme as AppTheme, themeManager, toastManager } from '@immich/ui';
  import { mdiDownload, mdiFileImagePlusOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    sharedLink: SharedLinkResponseDto;
    isOwned: boolean;
  }

  let { sharedLink = $bindable(), isOwned }: Props = $props();

  let assets = $derived(sharedLink.assets);
  const timelineAssets = $derived(assets.map((asset) => toTimelineAsset(asset)));

  /**
   * A shared link is read-only for the people it is shared with: the selection bar offers the
   * download and nothing else. Its owner may additionally prune the link, which is why the link id
   * only reaches the bulk context when they own it.
   */
  const bulkContext = $derived({ readOnly: true, sharedLinkId: isOwned ? sharedLink.id : null });

  // Local cursor `$state` for the single-asset shared-link path. AssetViewer's
  // `cursor` prop is non-bindable, so the owner of the cursor (this component)
  // must hold the state and update it via the `onAssetUpdate` callback when
  // an asset refresh happens (e.g. NSFW review, refresh-people).
  let singleAsset = $state<AssetResponseDto | undefined>(undefined);

  const loadSingleAsset = async (id: string) => {
    // Clear before the network round-trip so a switch to a different shared
    // asset doesn't render the previous asset's data behind the spinner.
    if (singleAsset?.id !== id) {
      singleAsset = undefined;
    }
    singleAsset = await getAssetInfo({ ...authManager.params, id });
  };

  dragAndDropFilesStore.subscribe((value) => {
    if (!(value.isDragging && value.files.length > 0)) {
      return;
    }

    handlePromiseError(handleUploadAssets(value.files));
    dragAndDropFilesStore.set({ isDragging: false, files: [] });
  });

  const downloadAssets = async () => {
    await downloadArchive(`immich-shared`, { assetIds: assets.map((asset) => asset.id) });
  };

  const handleUploadAssets = async (files: File[] = []) => {
    try {
      await (!files || files.length === 0 || !Array.isArray(files)
        ? openFileUploadDialog()
        : fileUploadHandler({ files }));

      toastManager.primary();
    } catch (error) {
      handleError(error, $t('errors.unable_to_add_assets_to_shared_link'));
    }
  };

  const handleSelectAll = () => librarySession.selectAll(assets.map((asset) => asset.id));

  /** The link's own asset list is what the grid reads, so a prune drops the ids from it. */
  const handleRemoved = (ids: string[]) => {
    const removed = new Set(ids);
    sharedLink = { ...sharedLink, assets: sharedLink.assets.filter((asset) => !removed.has(asset.id)) };
  };

  const handleAction = async (action: Action) => {
    switch (action.type) {
      case AssetAction.ARCHIVE:
      case AssetAction.DELETE:
      case AssetAction.TRASH: {
        await goto(Route.photos());
        break;
      }
      // no default
    }
  };

  // FL-56: own layout, no LibraryRail/TopBar/account menu in either branch below.
  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
</script>

{#if sharedLink?.allowUpload || assets.length > 1}
  <main class="frameleaf isolate mx-4 mt-24 mb-40" data-theme={appTheme}>
    <ResultsView
      assets={timelineAssets}
      {bulkContext}
      onSelectAll={handleSelectAll}
      onRemoved={handleRemoved}
      onOpen={(asset) => void navigateToAsset(asset)}
    />
  </main>

  <header class="fixed inset-s-0 top-0 w-full">
    <!-- FL-56: the public viewer has its own brand, no LibraryRail/TopBar/account menu. The
         Frameleaf selection bar floats over the grid rather than replacing this header. -->
    <div class="frameleaf pv-header" data-theme={appTheme}>
      <a class="pv-brand" href="/" data-sveltekit-preload-data="hover">
        <Brand />
      </a>
      <div class="pv-actions">
        {#if sharedLink?.allowUpload}
          <IconButton label={$t('add_photos')} onclick={() => handleUploadAssets()}>
            <Icon icon={mdiFileImagePlusOutline} size="1.25em" aria-hidden={true} />
          </IconButton>
        {/if}
        {#if sharedLink?.allowDownload}
          <IconButton label={$t('download')} onclick={downloadAssets}>
            <Icon icon={mdiDownload} size="1.25em" aria-hidden={true} />
          </IconButton>
        {/if}
      </div>
    </div>
  </header>

  <ResultsAssetViewer {assets} onRemove={(id) => handleRemoved([id])} emptyRoute={Route.photos()} />
{:else if assets.length === 1}
  {#await loadSingleAsset(assets[0].id) then _}
    {#await import('$lib/components/asset-viewer/AssetViewer.svelte') then { default: AssetViewer }}
      {#if singleAsset}
        <!-- Local `$state` so the asset can be refreshed in-place (e.g. NSFW
             review). AssetViewer's `cursor` prop is non-bindable, so the owner of
             the cursor (this component) must hold the `$state` and update it
             via the `onAssetUpdate` callback. -->
        <AssetViewer
          cursor={{ current: singleAsset }}
          onAssetUpdate={(updatedAsset) => {
            if (singleAsset?.id === updatedAsset.id) {
              singleAsset = updatedAsset;
            }
          }}
          onAction={handleAction}
        />
      {/if}
    {/await}
  {/await}
{/if}

<style>
  .pv-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.75rem 1rem;
    background: color-mix(in srgb, var(--fl-canvas), transparent 12%);
    border-bottom: 1px solid var(--fl-border);
    backdrop-filter: blur(6px);
  }
  .pv-brand {
    display: inline-flex;
    flex-shrink: 0;
  }
  .pv-actions {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }
</style>
