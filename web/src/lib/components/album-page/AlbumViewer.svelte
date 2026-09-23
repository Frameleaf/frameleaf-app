<script lang="ts">
  import { shortcut } from '$lib/actions/shortcut';
  import AlbumMap from '$lib/components/album-page/AlbumMap.svelte';
  import Brand from '$lib/components/frameleaf/Brand.svelte';
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import LibraryView from '$lib/components/frameleaf/LibraryView.svelte';
  import TimelineAssetViewer from '$lib/components/timeline/TimelineAssetViewer.svelte';
  import Portal from '$lib/elements/Portal.svelte';
  import '$lib/frameleaf/tokens.css';
  import { librarySession } from '$lib/frameleaf/library-session.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import { handleDownloadAlbum } from '$lib/services/album.service';
  import { getGlobalActions } from '$lib/services/app.service';
  import { dragAndDropFilesStore } from '$lib/stores/drag-and-drop-files.store';
  import { SlideshowNavigation, SlideshowState, slideshowStore } from '$lib/stores/slideshow.store';
  import { handlePromiseError } from '$lib/utils';
  import { fileUploadHandler, openFileUploadDialog } from '$lib/utils/file-uploader';
  import type { AlbumResponseDto, SharedLinkResponseDto } from '@immich/sdk';
  import { ActionButton, Icon, Theme as AppTheme, themeManager } from '@immich/ui';
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
  let viewerInvisible = $state(false);

  /**
   * A shared link is not a library: the only bulk action its recipients get is the download, and
   * only when the link allows it. `bulkActions` already refuses everything else without an owned,
   * live asset context, and the shared-link id is what scopes what remains.
   */
  const bulkContext = $derived({ sharedLinkId: sharedLink.id, readOnly: true });

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

  // FL-33 cleanup: Cast belongs on this header. It was dropped when the public viewer was
  // redesigned; it is a global action, so it is the same one the album detail page mounts.
  const { Cast } = $derived(getGlobalActions($t));
</script>

<svelte:document
  use:shortcut={{
    shortcut: { key: 'Escape' },
    onShortcut: () => {
      if (!assetViewerManager.isViewing && librarySession.selection.length > 0) {
        librarySession.clearSelection();
      }
    },
  }}
/>

<main
  class="frameleaf relative h-dvh overflow-hidden px-2 pt-(--navbar-height) max-md:pt-(--navbar-height-md) md:px-6"
  data-theme={appTheme}
>
  <LibraryView
    enableRouting
    syncUrl={false}
    selectAll="loaded"
    bind:timelineManager
    {options}
    destination={{ kind: 'album', id: album.id }}
    {bulkContext}
    noSelectionBar={!sharedLink.allowDownload}
  >
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

    {#snippet viewer()}
      <Portal target="body">
        {#if assetViewerManager.isViewing}
          <TimelineAssetViewer bind:invisible={viewerInvisible} {timelineManager} {album} />
        {/if}
      </Portal>
    {/snippet}
  </LibraryView>
</main>

<header>
  <!-- FL-56: the public viewer has its own brand, no LibraryRail/TopBar/account menu. The
       Frameleaf selection bar floats over the results rather than replacing this header, so the
       header's own actions stay reachable while a selection is being made. -->
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
      <!-- FL-33: Cast, restored. It draws nothing when no cast destination is available. -->
      <ActionButton action={Cast} />
      {#if sharedLink.showMetadata && featureFlagsManager.value.map}
        <AlbumMap {album} />
      {/if}
    </div>
  </div>
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
