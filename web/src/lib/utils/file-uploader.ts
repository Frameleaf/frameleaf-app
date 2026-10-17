import {
  AssetMediaStatus,
  AssetUploadAction,
  AssetVisibility,
  checkBulkUpload,
  getBaseUrl,
  type AssetMediaResponseDto,
} from '@frameleaf/sdk';
import { toastManager } from '@frameleaf/ui';
import { tick } from 'svelte';
import { t } from 'svelte-i18n';
import { get } from 'svelte/store';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { uploadManager } from '$lib/managers/upload-manager.svelte';
import { addAssetsToAlbums } from '$lib/services/album.service';
import { uploadAssetsStore } from '$lib/stores/upload';
import { UploadState } from '$lib/types';
import { AbortError, cancelUploadRequests, uploadRequest } from '$lib/utils';
import { ExecutorQueue } from '$lib/utils/executor-queue';
import { generateId } from '$lib/utils/generate-id';
import { asQueryString } from '$lib/utils/shared-links';
import { handleError } from './handle-error';

export const uploadExecutionQueue = new ExecutorQueue({ concurrency: 2 });
const activeUploads = new Set<AbortController>();
type UploadContext = { owner: string | undefined; sharedLink: boolean; query: string };

type FilePickerParam = { multiple?: boolean; extensions?: string[]; directory?: boolean };
type FileUploadParam = { multiple?: boolean; albumId?: string; directory?: boolean; isLockedAssets?: boolean };

export const openFilePicker = async (options: FilePickerParam = {}) => {
  const { multiple = true, extensions, directory = false } = options;

  return new Promise<File[]>((resolve, reject) => {
    let mountedSelector: HTMLInputElement | undefined;
    try {
      const fileSelector = document.createElement('input');
      mountedSelector = fileSelector;

      fileSelector.type = 'file';
      fileSelector.multiple = multiple;

      if (extensions) {
        fileSelector.accept = extensions.join(',');
      }

      if (directory) {
        // Non-standard attributes with broad browser support for picking a whole folder;
        // both spellings are set for maximum compatibility (Chromium prefers the property,
        // older Firefox needed the attribute). The folder's own file-type restrictions
        // still apply through fileUploadHandler, which skips unsupported extensions.
        fileSelector.setAttribute('webkitdirectory', '');
        fileSelector.setAttribute('directory', '');
      }

      fileSelector.addEventListener(
        'change',
        () => {
          fileSelector.remove();
          resolve(Array.from(fileSelector.files ?? []));
        },
        { passive: true, once: true },
      );

      fileSelector.addEventListener(
        'cancel',
        () => {
          fileSelector.remove();
          resolve([]);
        },
        { passive: true, once: true },
      );

      // Safari requires the file selector to be mounted
      fileSelector.hidden = true;
      document.body.append(fileSelector);
      fileSelector.click();
    } catch (error) {
      mountedSelector?.remove();
      console.log('Error selecting file', error);
      reject(error);
    }
  });
};

export const openFileUploadDialog = async (options: FileUploadParam = {}) => {
  const { albumId, multiple = true, directory = false, isLockedAssets } = options;
  const extensions = uploadManager.getExtensions();
  const files = await openFilePicker({
    multiple,
    // A directory picker ignores `accept`; fileUploadHandler still filters unsupported
    // files out of whatever the folder contains, so nothing unsupported gets uploaded.
    extensions: directory ? undefined : extensions,
    directory,
  });

  return fileUploadHandler({ files, albumId, isLockedAssets });
};

type FileUploadHandlerParams = Omit<FileUploaderParams, 'deviceAssetId' | 'assetFile'> & {
  files: File[];
};

export const fileUploadHandler = async ({
  files,
  albumId,
  isLockedAssets = false,
}: FileUploadHandlerParams): Promise<string[]> => {
  const extensions = uploadManager.getExtensions();
  const context: UploadContext = {
    owner: authManager.authenticated ? authManager.user.id : undefined,
    sharedLink: authManager.isSharedLink,
    query: asQueryString(authManager.params),
  };
  const promises = [];
  for (const file of files) {
    const name = file.name.toLowerCase();
    if (extensions.some((extension) => name.endsWith(extension))) {
      const deviceAssetId = getDeviceAssetId(file);
      uploadAssetsStore.addItem({ id: deviceAssetId, file, albumId, isLockedAssets });
      promises.push(
        uploadExecutionQueue.addTask(() =>
          fileUploader({ deviceAssetId, assetFile: file, albumId, isLockedAssets }, context),
        ),
      );
    } else {
      toastManager.warning(get(t)('unsupported_file_type', { values: { file: file.name, type: file.type } }), {
        timeout: 10_000,
      });
    }
  }

  // fileUploader() already catches its own failures and resolves with undefined; the extra
  // catch here only guards the path a task takes when cancelRemainingUploads() rejects it
  // out of the queue before it starts, so one cancelled file never fails the whole batch.
  const results = await Promise.all(promises.map((promise) => promise.catch(() => undefined)));
  return results.filter((result): result is string => !!result);
};

/**
 * Re-runs every failed upload with the album and Locked destination it was first sent to. The
 * files join the shared queue together, so the panel's parallel uploads setting applies.
 */
export const retryFailedUploads = async () => {
  const failed = get(uploadAssetsStore).filter((item) => item.state === UploadState.ERROR);
  await Promise.all(
    failed.map(({ id, file, albumId, isLockedAssets }) => {
      uploadAssetsStore.removeItem(id);
      return fileUploadHandler({ files: [file], albumId, isLockedAssets });
    }),
  );
};

/**
 * Stops the uploads the panel calls "remaining": in-flight requests are aborted (they
 * settle through fileUploader's own error handling, same as any other failed upload), and
 * anything still waiting for a queue slot is dropped from the executor queue and marked
 * failed, since this architecture has no way to pause or resume a request once it starts.
 * Uploads already finished, duplicated or failed are untouched.
 */
export const cancelRemainingUploads = () => {
  const controllers = [...activeUploads];
  const pending = get(uploadAssetsStore).filter((asset) => asset.state === UploadState.PENDING);
  uploadExecutionQueue.clear();
  cancelUploadRequests();

  const $t = get(t);
  for (const asset of pending) {
    uploadAssetsStore.track('error');
    uploadAssetsStore.updateItem(asset.id, {
      state: UploadState.ERROR,
      error: $t('frameleaf_transfer_upload_cancelled'),
    });
  }
  for (const controller of controllers) {
    controller.abort(new AbortError());
  }
};

function getDeviceAssetId(asset: File) {
  return `web-${asset.name}-${asset.lastModified}-${generateId()}`;
}

async function hashFile(file: File, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const worker = new Worker(new URL('$lib/workers/hash-file.ts', import.meta.url), { type: 'module' });
  let abort: () => void;
  try {
    return await new Promise<string>((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      worker.addEventListener(
        'message',
        ({ data }: MessageEvent<{ result?: unknown; error?: string }>) => {
          if (data?.error) {
            reject(new Error(data.error));
          } else if (typeof data?.result === 'string' && data.result.length > 0) {
            resolve(data.result);
          } else {
            reject(new Error('Missing file checksum'));
          }
        },
        { once: true },
      );
      worker.addEventListener('error', (event) => reject(new Error(event.message)), { once: true });
      worker.addEventListener('messageerror', () => reject(new Error('Unable to read file checksum')), { once: true });
      worker.postMessage(file);
    });
  } finally {
    signal.removeEventListener('abort', abort!);
    worker.terminate();
  }
}

type FileUploaderParams = {
  assetFile: File;
  albumId?: string;
  replaceAssetId?: string;
  isLockedAssets?: boolean;
  // TODO rework the asset uploader and remove this
  deviceAssetId: string;
};

// TODO: should probably use the @api SDK
async function fileUploader(
  { assetFile, deviceAssetId, albumId, isLockedAssets = false }: FileUploaderParams,
  context: UploadContext,
): Promise<string | undefined> {
  const fileCreatedAt = new Date(assetFile.lastModified).toISOString();
  const $t = get(t);
  const wasInitiallyLoggedIn = !!authManager.authenticated;

  const controller = new AbortController();
  const { signal } = controller;
  activeUploads.add(controller);
  const assertCurrent = (pending = true) => {
    if (pending) {
      signal.throwIfAborted();
    }
    const owner = authManager.authenticated ? authManager.user.id : undefined;
    if (
      owner !== context.owner ||
      authManager.isSharedLink !== context.sharedLink ||
      asQueryString(authManager.params) !== context.query
    ) {
      throw new AbortError();
    }
  };

  try {
    assertCurrent();
    uploadAssetsStore.markStarted(deviceAssetId);
    assertCurrent();
    let responseData: { id: string; status: AssetMediaStatus; isTrashed?: boolean } | undefined;
    if (!context.sharedLink) {
      uploadAssetsStore.updateItem(deviceAssetId, { message: $t('asset_hashing') });
      await tick();
      try {
        assertCurrent();
        const checksum = await hashFile(assetFile, signal);
        assertCurrent();

        const {
          results: [checkUploadResult],
        } = await checkBulkUpload(
          { assetBulkUploadCheckDto: { assets: [{ id: assetFile.name, checksum }] } },
          { signal },
        );
        assertCurrent();
        if (checkUploadResult.action === AssetUploadAction.Reject && checkUploadResult.assetId) {
          responseData = {
            status: AssetMediaStatus.Duplicate,
            id: checkUploadResult.assetId,
            isTrashed: checkUploadResult.isTrashed,
          };
        }
      } catch (error) {
        assertCurrent();
        if (error instanceof AbortError) {
          throw error;
        }
        console.error(`Error calculating checksum file=${assetFile.name})`, error);
      }
    }

    if (!responseData) {
      assertCurrent();
      const formData = new FormData();
      formData.append('fileCreatedAt', fileCreatedAt);
      formData.append('fileModifiedAt', fileCreatedAt);
      formData.append('isFavorite', 'false');
      formData.append('assetData', new File([assetFile], assetFile.name));
      if (isLockedAssets) {
        formData.append('visibility', AssetVisibility.Locked);
      }

      uploadAssetsStore.updateItem(deviceAssetId, { message: $t('asset_uploading') });
      assertCurrent();
      const response = await uploadRequest<AssetMediaResponseDto>({
        url: getBaseUrl() + '/assets' + (context.query ? `?${context.query}` : ''),
        data: formData,
        onUploadProgress: (event) => uploadAssetsStore.updateProgress(deviceAssetId, event.loaded, event.total),
      });

      if (![200, 201].includes(response.status)) {
        throw new Error($t('errors.unable_to_upload_file'));
      }

      responseData = response.data;
    }

    // An acknowledged upload is saved; cancelling the batch cannot undo it.
    assertCurrent(false);
    if (responseData.status === AssetMediaStatus.Duplicate) {
      uploadAssetsStore.track('duplicate');
    } else {
      uploadAssetsStore.track('success');
    }

    if (albumId && !context.sharedLink && responseData.id) {
      uploadAssetsStore.updateItem(deviceAssetId, { message: $t('asset_adding_to_album') });
      assertCurrent(false);
      const added = await addAssetsToAlbums([albumId], [responseData.id], { notify: false });
      assertCurrent(false);
      if (!added) {
        // FL-53: the file is safely in the library, but it is not in the album. Say exactly that,
        // rather than "added to album"; retrying finds the uploaded original and only adds it.
        uploadAssetsStore.updateItem(deviceAssetId, {
          state: UploadState.ERROR,
          assetId: responseData.id,
          error: $t('frameleaf_upload_album_add_failed'),
        });
        return responseData.id;
      }
      uploadAssetsStore.updateItem(deviceAssetId, { message: $t('asset_added_to_album') });
    }

    uploadAssetsStore.updateItem(deviceAssetId, {
      state: responseData.status === AssetMediaStatus.Duplicate ? UploadState.DUPLICATED : UploadState.DONE,
      assetId: responseData.id || undefined,
      isTrashed: responseData.isTrashed,
    });

    if (responseData.status !== AssetMediaStatus.Duplicate) {
      setTimeout(() => {
        uploadAssetsStore.removeItem(deviceAssetId);
      }, 1000);
    }

    return responseData.id;
  } catch (error) {
    // If the user store no longer holds a user, it means they have logged out
    // In this case don't bother reporting any errors.
    if (wasInitiallyLoggedIn && !authManager.authenticated) {
      return;
    }

    // Cancel remaining aborted it; handleError stays quiet about an AbortError.
    const errorMessage =
      error instanceof AbortError
        ? $t('frameleaf_transfer_upload_cancelled')
        : handleError(error, $t('errors.unable_to_upload_file'));
    uploadAssetsStore.track('error');
    uploadAssetsStore.updateItem(deviceAssetId, { state: UploadState.ERROR, error: errorMessage });
    return;
  } finally {
    activeUploads.delete(controller);
  }
}
