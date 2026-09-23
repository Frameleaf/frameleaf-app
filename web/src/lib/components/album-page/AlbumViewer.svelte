<script lang="ts">
  import { shortcut } from '$lib/actions/shortcut';
  import AlbumMap from '$lib/components/album-page/AlbumMap.svelte';
  import Brand from '$lib/components/frameleaf/Brand.svelte';
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import DownloadAction from '$lib/components/timeline/actions/DownloadAction.svelte';
  import SelectAllAssets from '$lib/components/timeline/actions/SelectAllAction.svelte';
  import AssetSelectControlBar from '$lib/components/timeline/AssetSelectControlBar.svelte';
  import Timeline from '$lib/components/timeline/Timeline.svelte';
  import '$lib/frameleaf/tokens.css';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import { handleDownloadAlbum } from '$lib/services/album.service';
  import { dragAndDropFilesStore } from '$lib/stores/drag-and-drop-files.store';
  import { SlideshowNavigation, SlideshowState, slideshowStore } from '$lib/stores/slideshow.store';
  import { handlePromiseError } from '$lib/utils';
  import { fileUploadHandler, openFileUploadDialog } from '$lib/utils/file-uploader';
  import type { AlbumResponseDto, SharedLinkResponseDto } from '@immich/sdk';
  import { Icon, Theme as AppTheme, themeManager } from '@immich/ui';
  import { mdiDownload, mdiFileImagePlusOutline, mdiPresentationPlay } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    sharedLink: SharedLinkResponseDto;
  }

  let { sharedLink }: Props = $props();

  const album = sharedLink.album as AlbumResponseDto;

  let { slideshowState, slideshowNavigation } = slideshowStore;

  const options = $derived({ albumId: album.id, order: album.order });
  let timelineManager = $state<TimelineManager>() as TimelineManager;

  dragAndDropFilesStore.subscribe((value) => {
    if (!(value.isDragging && value.files.length > 0)) {
      return;
    }

    handlePromiseError(fileUploadHandler({ files: value.files, albumId: album.id }));
    dragAndDropFilesStore.set({ isDragging: false, files: [] });
  });

  const handleStartSlideshow = async () => {
    const asset =
      $slideshowNavigation === SlideshowNavigation.Shuffle
        ? await timelineManager.getRandomAsset()
        : timelineManager.months[0]?.timelineDays[0]?.viewerAssets[0]?.asset;
    if (asset) {
      handlePromiseError(
        assetViewerManager.setAssetId(asset.id).then(() => ($slideshowState = SlideshowState.PlaySlideshow)),
      );
    }
  };

  // FL-56: own layout, no LibraryRail/TopBar/account menu.
  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
</script>

<svelte:document
  use:shortcut={{
    shortcut: { key: 'Escape' },
    onShortcut: () => {
      if (!assetViewerManager.isViewing && assetMultiSelectManager.selectionActive) {
        assetMultiSelectManager.clear();
      }
    },
  }}
/>

<main
  class="frameleaf relative h-dvh overflow-hidden px-2 pt-(--navbar-height) max-md:pt-(--navbar-height-md) md:px-6"
  data-theme={appTheme}
>
  <Timeline enableRouting={true} {album} bind:timelineManager {options} assetInteraction={assetMultiSelectManager}>
    <section class="px-2 pt-8 md:px-0 md:pt-24">
      <!-- FL-56: the public album's own title block, ported from the design template's
           PublicViewer.jsx `pv-title`. -->
      <div class="pv-album-title">
        <h1>{album.albumName}</h1>
        <span class="pv-album-meta">
          {$t('frameleaf_sharing.individual_items', { values: { count: album.assetCount } })}
        </span>
      </div>
      {#if album.description}
        <p class="pv-album-description">{album.description}</p>
      {/if}
    </section>
  </Timeline>
</main>

<header>
  {#if assetMultiSelectManager.selectionActive}
    <AssetSelectControlBar>
      <SelectAllAssets {timelineManager} assetInteraction={assetMultiSelectManager} />
      {#if sharedLink.allowDownload}
        <DownloadAction filename={album.albumName} />
      {/if}
    </AssetSelectControlBar>
  {:else}
    <!-- FL-56: the public viewer has its own brand, no LibraryRail/TopBar/account menu. -->
    <div class="frameleaf pv-header" data-theme={appTheme}>
      <a class="pv-brand" href="/" data-sveltekit-preload-data="hover">
        <Brand />
      </a>
      <div class="pv-actions">
        {#if sharedLink.allowUpload}
          <IconButton label={$t('add_photos')} onclick={() => openFileUploadDialog({ albumId: album.id })}>
            <Icon icon={mdiFileImagePlusOutline} size="1.25em" aria-hidden={true} />
          </IconButton>
        {/if}
        {#if album.assetCount > 0 && sharedLink.allowDownload}
          <IconButton label={$t('slideshow')} onclick={handleStartSlideshow}>
            <Icon icon={mdiPresentationPlay} size="1.25em" aria-hidden={true} />
          </IconButton>
          <IconButton label={$t('download')} onclick={() => handleDownloadAlbum(album)}>
            <Icon icon={mdiDownload} size="1.25em" aria-hidden={true} />
          </IconButton>
        {/if}
        {#if sharedLink.showMetadata && featureFlagsManager.value.map}
          <AlbumMap {album} />
        {/if}
      </div>
    </div>
  {/if}
</header>

<style>
  .pv-album-title h1 {
    font-size: 1.75rem;
    color: var(--fl-text);
  }
  .pv-album-meta {
    color: var(--fl-muted);
    font-size: 0.875rem;
  }
  .pv-album-description {
    margin: 0.75rem 0 2rem;
    color: var(--fl-muted);
    white-space: pre-line;
  }
  .pv-header {
    position: fixed;
    inset-inline: 0;
    top: 0;
    z-index: 10;
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
