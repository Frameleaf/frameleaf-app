<script lang="ts">
  import { goto } from '$app/navigation';
  import type { Action } from '$lib/components/asset-viewer/actions/action';
  import Brand from '$lib/components/frameleaf/Brand.svelte';
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import DownloadAction from '$lib/components/timeline/actions/DownloadAction.svelte';
  import RemoveFromSharedLink from '$lib/components/timeline/actions/RemoveFromSharedLinkAction.svelte';
  import AssetSelectControlBar from '$lib/components/timeline/AssetSelectControlBar.svelte';
  import { AssetAction } from '$lib/constants';
  import '$lib/frameleaf/tokens.css';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import type { Viewport } from '$lib/managers/timeline-manager/types';
  import { Route } from '$lib/route';
  import { dragAndDropFilesStore } from '$lib/stores/drag-and-drop-files.store';
  import { handlePromiseError } from '$lib/utils';
  import { downloadArchive } from '$lib/utils/asset-utils';
  import { fileUploadHandler, openFileUploadDialog } from '$lib/utils/file-uploader';
  import { handleError } from '$lib/utils/handle-error';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import { getAssetInfo, type AssetResponseDto, type SharedLinkResponseDto } from '@immich/sdk';
  import { Icon, IconButton as ImmichIconButton, Theme as AppTheme, themeManager, toastManager } from '@immich/ui';
  import { mdiDownload, mdiFileImagePlusOutline, mdiSelectAll } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import GalleryViewer from '../shared-components/gallery-viewer/GalleryViewer.svelte';

  interface Props {
    sharedLink: SharedLinkResponseDto;
    isOwned: boolean;
  }

  let { sharedLink = $bindable(), isOwned }: Props = $props();

  const viewport: Viewport = $state({ width: 0, height: 0 });

  let assets = $derived(sharedLink.assets);

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

  const handleSelectAll = () => {
    assetMultiSelectManager.selectAssets(assets.map((asset) => toTimelineAsset(asset)));
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
  <main
    class="frameleaf isolate mx-4 mt-24 mb-40"
    data-theme={appTheme}
    bind:clientHeight={viewport.height}
    bind:clientWidth={viewport.width}
  >
    <GalleryViewer {assets} assetInteraction={assetMultiSelectManager} {viewport} allowDeletion={false} />
  </main>

  <header class="fixed inset-s-0 top-0 w-full">
    {#if assetMultiSelectManager.selectionActive}
      <AssetSelectControlBar>
        <ImmichIconButton
          shape="round"
          color="secondary"
          variant="ghost"
          aria-label={$t('select_all')}
          icon={mdiSelectAll}
          onclick={handleSelectAll}
        />
        {#if sharedLink?.allowDownload}
          <DownloadAction filename="immich-shared" />
        {/if}
        {#if isOwned}
          <RemoveFromSharedLink bind:sharedLink />
        {/if}
      </AssetSelectControlBar>
    {:else}
      <!-- FL-56: the public viewer has its own brand, no LibraryRail/TopBar/account menu. -->
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
    {/if}
  </header>
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
