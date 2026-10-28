<script lang="ts">
  import type { AlbumResponseDto } from '@frameleaf/sdk';
  import { libraryUploadScope } from '$lib/frameleaf/search-context';
  import { page } from '$app/state';
  import { shouldIgnoreEvent } from '$lib/actions/shortcut';
  import '$lib/frameleaf/tokens.css';
  import { getPrivateBrowserStateGeneration } from '$lib/frameleaf/private-browser-state';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { getDropUploadContext } from '$lib/stores/drag-and-drop-files.store';
  import { fileUploadHandler } from '$lib/utils/file-uploader';
  import { isAlbumsRoute, isLockedFolderRoute } from '$lib/utils/navigation';
  import { Icon, Theme as AppTheme, themeManager } from '@frameleaf/ui';
  import { mdiCloudUploadOutline, mdiShieldLockOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { onDestroy } from 'svelte';
  import { motionFade } from '$lib/frameleaf/motion';
  import { DURATION } from '$lib/frameleaf/tokens';

  /**
   * The card says where the files will go, because it depends on the page: on an album they also
   * join that album, and in Locked they are uploaded as Locked. The page shows through a frosted
   * veil rather than being covered, so the album you are dropping into stays in view.
   */

  let albumId = $derived(isAlbumsRoute(page.route?.id) ? page.params.albumId : undefined);
  let isInLockedFolder = $derived(isLockedFolderRoute(page.route.id));
  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
  /** The album page's own album, when its loader put one in the page data. */
  const albumName = $derived.by(() => {
    const album = albumId ? (page.data as { album?: { id?: string; albumName?: string } } | undefined)?.album : null;
    return album && album.id === albumId ? album.albumName?.trim() || null : null;
  });
  const dropTitle = $derived(
    isInLockedFolder
      ? $t('frameleaf_transfer_drop_title_locked')
      : albumId
        ? albumName
          ? $t('frameleaf_transfer_drop_title_album', { values: { album: albumName } })
          : $t('frameleaf_transfer_drop_title_this_album')
        : $t('frameleaf_transfer_drop_title'),
  );
  const dropHint = $derived(
    isInLockedFolder
      ? $t('frameleaf_transfer_drop_hint_locked')
      : albumId
        ? $t('frameleaf_transfer_drop_hint_album')
        : $t('frameleaf_transfer_drop_hint'),
  );

  let dragStartTarget: EventTarget | null = $state(null);
  let isInternalDrag = false;
  const dropUploads = getDropUploadContext();
  let mounted = true;
  onDestroy(() => {
    mounted = false;
  });

  const onDragEnter = (e: DragEvent) => {
    if (e.dataTransfer && e.dataTransfer.types.includes('Files')) {
      dragStartTarget = e.target;
    }
  };

  const onDragLeave = (e: DragEvent) => {
    if (dragStartTarget === e.target) {
      dragStartTarget = null;
    }
  };

  const onDrop = async (e: DragEvent) => {
    dragStartTarget = null;
    await handleDataTransfer(e.dataTransfer);
  };

  const onPaste = (event: ClipboardEvent) => {
    if (shouldIgnoreEvent(event)) {
      return;
    }

    return handleDataTransfer(event.clipboardData);
  };

  const handleDataTransfer = async (dataTransfer?: DataTransfer | null) => {
    if (!dataTransfer) {
      return;
    }

    const generation = getPrivateBrowserStateGeneration();
    const pathname = page.url.pathname;
    const owner = authManager.authenticated ? authManager.user.id : undefined;
    const sharedLink = authManager.isSharedLink;
    const { key, slug } = authManager.params;
    const targetAlbumId = albumId;
    const libraryScope = libraryUploadScope(
      new URL(page.url.href),
      (page.data as { album?: AlbumResponseDto } | undefined)?.album,
    );
    const isLockedAssets = isInLockedFolder;
    const receiveSharedFiles = dropUploads?.capture();
    // Directory reads can outlive the route or session that admitted the drop.
    const isCurrent = () =>
      mounted &&
      getPrivateBrowserStateGeneration() === generation &&
      page.url.pathname === pathname &&
      (authManager.authenticated ? authManager.user.id : undefined) === owner &&
      authManager.isSharedLink === sharedLink &&
      authManager.params.key === key &&
      authManager.params.slug === slug;
    const files = await readTransferFiles(dataTransfer, isCurrent);
    if (!isCurrent()) {
      return;
    }
    if (sharedLink) {
      receiveSharedFiles?.(files);
    } else {
      await fileUploadHandler({ files, albumId: targetAlbumId, isLockedAssets, libraryScope });
    }
  };

  const readTransferFiles = async (dataTransfer: DataTransfer, isCurrent: () => boolean): Promise<File[]> => {
    if (!browserSupportsDirectoryUpload()) {
      return Array.from(dataTransfer.files);
    }
    const entries: FileSystemEntry[] = [];
    const files: File[] = [];
    for (const item of dataTransfer.items) {
      // eslint-disable-next-line tscompat/tscompat -- The directory API is feature-checked above; other browsers use files.
      const entry = item.webkitGetAsEntry();
      if (entry) {
        entries.push(entry);
      } else {
        const file = item.getAsFile();
        if (file) {
          files.push(file);
        }
      }
    }
    return [...files, ...(await getAllFilesFromTransferEntries(entries, isCurrent))];
  };

  // eslint-disable-next-line tscompat/tscompat -- Reading the optional method is the feature check itself.
  const browserSupportsDirectoryUpload = () => typeof DataTransferItem.prototype.webkitGetAsEntry === 'function';

  const getAllFilesFromTransferEntries = async (
    transferEntries: FileSystemEntry[],
    isCurrent: () => boolean,
  ): Promise<File[]> => {
    const allFiles: File[] = [];
    const entriesToCheckForSubDirectories = [...transferEntries];
    while (isCurrent() && entriesToCheckForSubDirectories.length > 0) {
      const currentEntry = entriesToCheckForSubDirectories.pop();

      if (isFileSystemDirectoryEntry(currentEntry)) {
        for (const entry of await getContentsFromFileSystemDirectoryEntry(currentEntry, isCurrent)) {
          entriesToCheckForSubDirectories.push(entry);
        }
      } else if (isFileSystemFileEntry(currentEntry)) {
        allFiles.push(await getFileFromFileSystemEntry(currentEntry));
      }
    }

    return allFiles;
  };

  const isFileSystemDirectoryEntry = (entry?: FileSystemEntry): entry is FileSystemDirectoryEntry =>
    !!entry && entry.isDirectory;
  const isFileSystemFileEntry = (entry?: FileSystemEntry): entry is FileSystemFileEntry => !!entry && entry.isFile;

  const getFileFromFileSystemEntry = async (fileSystemFileEntry: FileSystemFileEntry): Promise<File> => {
    return new Promise((resolve, reject) => {
      fileSystemFileEntry.file(resolve, reject);
    });
  };

  const readEntriesAsync = (reader: FileSystemDirectoryReader) => {
    return new Promise<FileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
  };

  const getContentsFromFileSystemDirectoryEntry = async (
    fileSystemDirectoryEntry: FileSystemDirectoryEntry,
    isCurrent: () => boolean,
  ): Promise<FileSystemEntry[]> => {
    const reader = fileSystemDirectoryEntry.createReader();
    const files: FileSystemEntry[] = [];
    let entries: FileSystemEntry[];

    do {
      entries = await readEntriesAsync(reader);
      files.push(...entries);
    } while (isCurrent() && entries.length > 0);

    return files;
  };

  const ondragstart = () => {
    isInternalDrag = true;
  };

  const ondragend = () => {
    isInternalDrag = false;
  };

  const ondragenter = (e: DragEvent) => {
    if (isInternalDrag) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    onDragEnter(e);
  };

  const ondragleave = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onDragLeave(e);
  };

  const ondrop = async (e: DragEvent) => {
    if (isInternalDrag) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    await onDrop(e);
  };

  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
</script>

<svelte:window onpaste={onPaste} />

<svelte:body {ondragstart} {ondragend} {ondragenter} {ondragleave} {ondrop} />

{#if dragStartTarget}
  <div
    class="frameleaf fl-drop-overlay"
    data-theme={appTheme}
    role="status"
    aria-live="polite"
    transition:motionFade={{ duration: DURATION.fade }}
    ondragover={onDragOver}
  >
    <div class="fl-drop-frame" aria-hidden="true"></div>
    <div class="fl-drop-card fl-pop fl-origin-center">
      <Icon icon={isInLockedFolder ? mdiShieldLockOutline : mdiCloudUploadOutline} size="40" aria-hidden="true" />
      <strong>{dropTitle}</strong>
      <span>{dropHint}</span>
    </div>
  </div>
{/if}

<style>
  .fl-drop-overlay {
    position: fixed;
    inset: 0;
    z-index: var(--fl-z-toast);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    /* A frosted veil: the page behind stays recognisable. */
    background: color-mix(in srgb, var(--fl-canvas) 55%, transparent);
    -webkit-backdrop-filter: var(--fl-scrim-blur);
    backdrop-filter: var(--fl-scrim-blur);
  }
  @media (prefers-contrast: more), (prefers-reduced-transparency: reduce) {
    .fl-drop-overlay {
      background: color-mix(in srgb, var(--fl-canvas), transparent 8%);
      -webkit-backdrop-filter: none;
      backdrop-filter: none;
    }
  }
  .fl-drop-frame {
    position: absolute;
    inset: 0.75rem;
    border: 2px dashed var(--fl-accent);
    border-radius: var(--fl-radius-card);
    pointer-events: none;
  }
  .fl-drop-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    padding: 2rem 2.5rem;
    color: var(--fl-text);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-sheet);
    box-shadow: var(--fl-shadow-4);
    max-width: min(28rem, calc(100vw - 3rem));
    text-align: center;
  }
  .fl-drop-card :global(svg) {
    color: var(--fl-accent);
  }
  .fl-drop-card strong {
    font-size: 1.0625rem;
    overflow-wrap: anywhere;
  }
  .fl-drop-card span {
    color: var(--fl-muted);
    font-size: 0.8125rem;
  }
</style>
