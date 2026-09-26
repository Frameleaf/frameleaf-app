<script lang="ts">
  import { page } from '$app/state';
  import { shouldIgnoreEvent } from '$lib/actions/shortcut';
  import '$lib/frameleaf/tokens.css';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { dragAndDropFilesStore } from '$lib/stores/drag-and-drop-files.store';
  import { fileUploadHandler } from '$lib/utils/file-uploader';
  import { isAlbumsRoute, isLockedFolderRoute } from '$lib/utils/navigation';
  import { Icon, Theme as AppTheme, themeManager } from '@immich/ui';
  import { mdiCloudUploadOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { fade } from 'svelte/transition';

  /**
   * Drag-and-drop upload overlay for library pages (FL-45), restyled from the legacy
   * `routes/(user)/DragAndDropUploadOverlay.svelte` under the Frameleaf token sheet. The
   * directory-reading and paste handling are unchanged from the production component this
   * replaces; only the drop card's appearance is new (`design/frameleaf/template/src/App.jsx`
   * `DragDropOverlay`). Files still go straight to `fileUploadHandler`, never a simulation.
   */

  let albumId = $derived(isAlbumsRoute(page.route?.id) ? page.params.albumId : undefined);
  let isInLockedFolder = $derived(isLockedFolderRoute(page.route.id));
  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');

  let dragStartTarget: EventTarget | null = $state(null);
  let isInternalDrag = false;

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

    if (!browserSupportsDirectoryUpload()) {
      return handleFiles(dataTransfer.files);
    }

    const entries: FileSystemEntry[] = [];
    const files: File[] = [];
    for (const item of dataTransfer.items) {
      // eslint-disable-next-line tscompat/tscompat
      const entry = item.webkitGetAsEntry();
      if (entry) {
        entries.push(entry);
        continue;
      }

      const file = item.getAsFile();
      if (file) {
        files.push(file);
      }
    }

    const directoryFiles = await getAllFilesFromTransferEntries(entries);
    return handleFiles([...files, ...directoryFiles]);
  };

  // eslint-disable-next-line tscompat/tscompat
  const browserSupportsDirectoryUpload = () => typeof DataTransferItem.prototype.webkitGetAsEntry === 'function';

  const getAllFilesFromTransferEntries = async (transferEntries: FileSystemEntry[]): Promise<File[]> => {
    const allFiles: File[] = [];
    let entriesToCheckForSubDirectories = [...transferEntries];
    while (entriesToCheckForSubDirectories.length > 0) {
      const currentEntry = entriesToCheckForSubDirectories.pop();

      if (isFileSystemDirectoryEntry(currentEntry)) {
        entriesToCheckForSubDirectories = entriesToCheckForSubDirectories.concat(
          await getContentsFromFileSystemDirectoryEntry(currentEntry),
        );
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
  ): Promise<FileSystemEntry[]> => {
    const reader = fileSystemDirectoryEntry.createReader();
    const files: FileSystemEntry[] = [];
    let entries: FileSystemEntry[];

    do {
      entries = await readEntriesAsync(reader);
      files.push(...entries);
    } while (entries.length > 0);

    return files;
  };

  const handleFiles = async (files?: FileList | File[]) => {
    if (!files) {
      return;
    }

    const filesArray: File[] = Array.from<File>(files);
    if (authManager.isSharedLink) {
      dragAndDropFilesStore.set({ isDragging: true, files: filesArray });
    } else {
      await fileUploadHandler({ files: filesArray, albumId, isLockedAssets: isInLockedFolder });
    }
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
    transition:fade={{ duration: 250 }}
    ondragover={onDragOver}
  >
    <div class="fl-drop-frame" aria-hidden="true"></div>
    <div class="fl-drop-card">
      <Icon icon={mdiCloudUploadOutline} size="40" aria-hidden="true" />
      <strong>{$t('frameleaf_transfer_drop_title')}</strong>
      <span>{$t('frameleaf_transfer_drop_hint')}</span>
    </div>
  </div>
{/if}

<style>
  .fl-drop-overlay {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: color-mix(in srgb, var(--fl-canvas), transparent 8%);
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
    border-radius: var(--fl-radius-dialog);
    box-shadow: var(--fl-shadow-2);
  }
  .fl-drop-card strong {
    font-size: 1.0625rem;
  }
  .fl-drop-card span {
    color: var(--fl-muted);
    font-size: 0.8125rem;
  }
</style>
