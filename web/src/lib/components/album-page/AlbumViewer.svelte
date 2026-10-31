<script lang="ts">
  import { shortcut } from '$lib/actions/shortcut';
  import LibraryView from '$lib/components/frameleaf/LibraryView.svelte';
  import PublicViewerShell from '$lib/components/frameleaf/PublicViewerShell.svelte';
  import TimelineAssetViewer from '$lib/components/timeline/TimelineAssetViewer.svelte';
  import Portal from '$lib/elements/Portal.svelte';
  import { namedArchiveName } from '$lib/frameleaf/archive-name';
  import { librarySession } from '$lib/frameleaf/library-session.svelte';
  import { sendCopiesWithFeedback } from '$lib/frameleaf/send-copy';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import { handleDownloadAlbum } from '$lib/services/album.service';
  import { getDropUploadContext } from '$lib/stores/drag-and-drop-files.store';
  import { handlePromiseError } from '$lib/utils';
  import { downloadArchive, ignoreCancelledDownload, navigateToAsset } from '$lib/utils/asset-utils';
  import { fileUploadHandler, openFileUploadDialog } from '$lib/utils/file-uploader';
  import type { AlbumResponseDto, SharedLinkResponseDto } from '@frameleaf/sdk';
  import { toastManager } from '@frameleaf/ui';
  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * A public album link (FL-56, prototype `PublicViewer.jsx`): the album's photos in the Frameleaf
   * timeline inside the public shell. Select mode picks tiles with a plain click; the header's
   * download takes everything or the selection, and only exists when the link allows downloads.
   */
  interface Props {
    sharedLink: SharedLinkResponseDto;
  }

  let { sharedLink }: Props = $props();

  const album = $derived(sharedLink.album as AlbumResponseDto);

  const options = $derived({ albumId: album.id, order: album.order });
  let timelineManager = $state<TimelineManager>() as TimelineManager;
  let viewerInvisible = $state(false);
  let selectMode = $state(false);

  const selectedCount = $derived(librarySession.selection.length);
  // A tile picked by its own checkbox is a selection too, so the header follows it.
  const selecting = $derived(selectMode || selectedCount > 0);
  const downloadFileName = $derived(namedArchiveName(album.albumName, $t('frameleaf_archive_name_album')));

  /**
   * A shared link is not a library: its recipients get no bulk actions beyond the header's
   * download, so the library's selection bar is not mounted here.
   */
  const bulkContext = $derived({ sharedLinkId: sharedLink.id, readOnly: true });

  let alive = true;
  let generation = 0;
  let previousLinkId: string | undefined;
  let previousAlbumId: string | undefined;
  $effect.pre(() => {
    if (sharedLink.id === previousLinkId && album.id === previousAlbumId) {
      return;
    }
    previousLinkId = sharedLink.id;
    previousAlbumId = album.id;
    generation++;
    selectMode = false;
  });
  const captureView = () => {
    const owner = generation;
    const params = { ...authManager.params };
    const isCurrentSession = authManager.captureSession();
    return () =>
      alive &&
      owner === generation &&
      isCurrentSession() &&
      params.key === authManager.params.key &&
      params.slug === authManager.params.slug;
  };

  const stopDropUploads = getDropUploadContext()?.register((files) => {
    if (sharedLink.allowUpload) {
      handlePromiseError(announceUploads(fileUploadHandler({ files, albumId: album.id })));
    }
  });
  onDestroy(() => {
    alive = false;
    stopDropUploads?.();
  });

  /** FL-56 (`PublicViewer.jsx` handleFiles): "N items added to this share." */
  const announceUploads = async (upload: Promise<(string | undefined)[]>) => {
    const isCurrent = captureView();
    try {
      const uploaded = await upload;
      if (!isCurrent()) {
        return;
      }
      const count = uploaded.filter(Boolean).length;
      if (count > 0) {
        toastManager.success($t('frameleaf_public_added', { values: { count } }));
      }
    } catch (error) {
      if (isCurrent()) {
        throw error;
      }
    }
  };

  const setSelecting = (next: boolean) => {
    selectMode = next;
    librarySession.clearSelection();
  };

  /** Everything in the album, loading the months the timeline has not loaded yet. */
  const selectAll = async () => {
    const manager = timelineManager;
    if (!manager) {
      return;
    }
    const isCurrentView = captureView();
    const isCurrent = () => manager === timelineManager && isCurrentView();
    try {
      for (const month of manager.months) {
        if (!isCurrent()) {
          return;
        }
        if (!month.isLoaded) {
          await manager.loadTimelineMonth(month.yearMonth);
        }
      }
      if (!isCurrent()) {
        return;
      }
      librarySession.selectAll(
        manager.months.flatMap((month) =>
          month.timelineDays.flatMap((day) => day.viewerAssets.map((viewerAsset) => viewerAsset.id)),
        ),
      );
    } catch (error) {
      if (isCurrent()) {
        throw error;
      }
    }
  };

  const downloadSelected = () =>
    handlePromiseError(
      downloadArchive(downloadFileName, { assetIds: [...librarySession.selection] }).catch(ignoreCancelledDownload),
    );
</script>

<svelte:document
  use:shortcut={{
    shortcut: { key: 'Escape' },
    onShortcut: () => {
      if (!assetViewerManager.isViewing && selecting) {
        setSelecting(false);
      }
    },
  }}
/>

<PublicViewerShell
  {sharedLink}
  title={album.albumName}
  count={album.assetCount}
  {selecting}
  {selectedCount}
  onSelectingChange={setSelecting}
  onUpload={() => handlePromiseError(announceUploads(openFileUploadDialog({ albumId: album.id })))}
  onDownloadAll={() => handlePromiseError(handleDownloadAlbum(album))}
  onDownloadSelected={downloadSelected}
  onSendCopy={() => void sendCopiesWithFeedback([...librarySession.selection])}
  onSelectAll={() => handlePromiseError(selectAll())}
  onClear={() => librarySession.clearSelection()}
>
  <div class="h-full">
    <LibraryView
      enableRouting
      syncUrl={false}
      selectAll="loaded"
      bind:timelineManager
      {options}
      destination={{ kind: 'album', id: album.id }}
      {bulkContext}
      {downloadFileName}
      selectionMode={selecting}
      noSelectionBar
      publicView
      onOpen={(asset) => void navigateToAsset(asset)}
    >
      {#if album.description}
        <p class="pv-album-description">{album.description}</p>
      {/if}

      {#snippet empty()}
        <div class="pv-empty" role="status">
          <h2>{$t('frameleaf_public_empty_title')}</h2>
          <p>
            {sharedLink.allowUpload ? $t('frameleaf_public_empty_upload') : $t('frameleaf_public_empty_owner')}
          </p>
        </div>
      {/snippet}

      {#snippet viewer()}
        <Portal target="body">
          {#if assetViewerManager.isViewing}
            <TimelineAssetViewer bind:invisible={viewerInvisible} {timelineManager} {album} />
          {/if}
        </Portal>
      {/snippet}
    </LibraryView>
  </div>
</PublicViewerShell>

<style>
  .pv-album-description {
    margin: 1rem 0;
    color: var(--fl-muted);
    white-space: pre-line;
  }
  .pv-empty {
    padding: 4rem 1rem;
    text-align: center;
    color: var(--fl-muted);
  }
  .pv-empty h2 {
    margin-bottom: 0.5rem;
    font-size: 1.125rem;
    color: var(--fl-text);
  }
</style>
