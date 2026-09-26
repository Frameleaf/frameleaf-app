<script lang="ts">
  import { shortcut } from '$lib/actions/shortcut';
  import PublicViewerShell from '$lib/components/frameleaf/PublicViewerShell.svelte';
  import ResultsAssetViewer from '$lib/components/frameleaf/ResultsAssetViewer.svelte';
  import ResultsView from '$lib/components/frameleaf/ResultsView.svelte';
  import { namedArchiveName } from '$lib/frameleaf/archive-name';
  import { librarySession } from '$lib/frameleaf/library-session.svelte';
  import { sendCopiesWithFeedback } from '$lib/frameleaf/send-copy';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { dragAndDropFilesStore } from '$lib/stores/drag-and-drop-files.store';
  import { handlePromiseError } from '$lib/utils';
  import { downloadArchive, ignoreCancelledDownload, navigateToAsset } from '$lib/utils/asset-utils';
  import { fileUploadHandler, openFileUploadDialog } from '$lib/utils/file-uploader';
  import { handleError } from '$lib/utils/handle-error';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import { getMySharedLink, type SharedLinkResponseDto } from '@immich/sdk';
  import { toastManager } from '@immich/ui';
  import { t } from 'svelte-i18n';

  /**
   * A public link to hand-picked items (FL-56, prototype `PublicViewer.jsx`): the items in the
   * Frameleaf grid inside the public shell, with the same Select mode and download as an album link.
   */
  interface Props {
    sharedLink: SharedLinkResponseDto;
    isOwned: boolean;
  }

  let { sharedLink = $bindable(), isOwned }: Props = $props();

  let assets = $derived(sharedLink.assets);
  const timelineAssets = $derived(assets.map((asset) => toTimelineAsset(asset)));
  let selectMode = $state(false);

  const selectedCount = $derived(librarySession.selection.length);
  // A tile picked by its own checkbox is a selection too, so the header follows it.
  const selecting = $derived(selectMode || selectedCount > 0);

  /**
   * A shared link is read-only for the people it is shared with, so they get the header's download
   * and no selection bar. Its owner may additionally prune the link, which is why the owner keeps
   * the library's selection bar and why the link id only reaches the bulk context when they own it.
   */
  const bulkContext = $derived({ readOnly: true, sharedLinkId: isOwned ? sharedLink.id : null });

  /** FL-45: an individual link has no album to name the download after; its description often is
   * descriptive, and the generic "Shared" label stands in when it is not. */
  const sharedDownloadFileName = $derived(
    namedArchiveName(sharedLink.description, $t('frameleaf_archive_name_shared')),
  );

  dragAndDropFilesStore.subscribe((value) => {
    if (!(value.isDragging && value.files.length > 0)) {
      return;
    }
    // Only a link that allows uploads takes dropped files; the server refuses the rest anyway.
    if (sharedLink.allowUpload) {
      handlePromiseError(handleUploadAssets(value.files));
    }
    dragAndDropFilesStore.set({ isDragging: false, files: [] });
  });

  // A cancelled download is the user's choice, not an error to log.
  const download = (assetIds: string[]) =>
    handlePromiseError(downloadArchive(sharedDownloadFileName, { assetIds }).catch(ignoreCancelledDownload));

  /**
   * FL-56 (`PublicViewer.jsx` handleFiles): the server adds each upload through a link to that link,
   * so the link is read again to show the new items, and the count is announced.
   */
  const handleUploadAssets = async (files: File[] = []) => {
    try {
      const uploaded = await (files.length === 0 ? openFileUploadDialog() : fileUploadHandler({ files }));
      const count = uploaded.filter(Boolean).length;
      if (count === 0) {
        return;
      }
      sharedLink = await getMySharedLink({ ...authManager.params });
      toastManager.success($t('frameleaf_public_added', { values: { count } }));
    } catch (error) {
      handleError(error, $t('errors.unable_to_add_assets_to_shared_link'));
    }
  };

  const setSelecting = (next: boolean) => {
    selectMode = next;
    librarySession.clearSelection();
  };

  /** The link's own asset list is what the grid reads, so a prune drops the ids from it. */
  const handleRemoved = (ids: string[]) => {
    const removed = new Set(ids);
    sharedLink = { ...sharedLink, assets: sharedLink.assets.filter((asset) => !removed.has(asset.id)) };
  };
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
  title={sharedLink.description || $t('frameleaf_public_default_title')}
  count={assets.length}
  {selecting}
  {selectedCount}
  onSelectingChange={setSelecting}
  onUpload={() => handlePromiseError(handleUploadAssets())}
  onDownloadAll={() => download(assets.map((asset) => asset.id))}
  onDownloadSelected={() => download([...librarySession.selection])}
  onSendCopy={() => void sendCopiesWithFeedback([...librarySession.selection])}
  onSelectAll={() => librarySession.selectAll(assets.map((asset) => asset.id))}
  onClear={() => librarySession.clearSelection()}
  noSelectBar={isOwned}
>
  <div class="pt-4">
    <ResultsView
      assets={timelineAssets}
      {bulkContext}
      downloadFileName={sharedDownloadFileName}
      selectionMode={selecting}
      noSelectionBar={!isOwned}
      onSelectAll={() => librarySession.selectAll(assets.map((asset) => asset.id))}
      onRemoved={handleRemoved}
      onOpen={(asset) => void navigateToAsset(asset)}
    >
      {#snippet empty()}
        <div class="pv-empty" role="status">
          <h2>{$t('frameleaf_public_empty_title')}</h2>
          <p>
            {sharedLink.allowUpload ? $t('frameleaf_public_empty_upload') : $t('frameleaf_public_empty_owner')}
          </p>
        </div>
      {/snippet}
    </ResultsView>
  </div>
</PublicViewerShell>

<ResultsAssetViewer {assets} onRemove={(id) => handleRemoved([id])} emptyRoute={Route.photos()} />

<style>
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
