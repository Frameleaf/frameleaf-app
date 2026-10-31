import { AssetMediaStatus, AssetUploadAction, type UserAdminResponseDto } from '@frameleaf/sdk';
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { uploadManager } from '$lib/managers/upload-manager.svelte';
import { uploadAssetsStore } from '$lib/stores/upload';
import { UploadState } from '$lib/types';
import * as utils from '$lib/utils';
import {
  cancelRemainingUploads,
  fileUploadHandler as originalFileUploadHandler,
  openFilePicker,
  uploadExecutionQueue,
} from '$lib/utils/file-uploader';
import { preferencesFactory } from '@test-data/factories/preferences-factory';

const checksum = 'a'.repeat(64);
const digests = { sha256: checksum, sha1: 'b'.repeat(40) };
const file = new File(['bytes'], 'photo.jpg', { type: 'image/jpeg', lastModified: 1_700_000_000_000 });
let workers: WorkerControl[];
let workerAction: (worker: WorkerControl) => void;
let pendingTasks: Promise<string[]>[];
let preflightCompletions: (() => void)[];
const fileUploadHandler = (options: Parameters<typeof originalFileUploadHandler>[0]) => {
  const pending = originalFileUploadHandler(options);
  pendingTasks.push(pending);
  return pending;
};

class WorkerControl extends EventTarget {
  terminate = vi.fn();
  postMessage = vi.fn(() => workerAction(this));
  constructor() {
    super();
    workers.push(this);
  }
  message(data: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  workers = [];
  pendingTasks = [];
  preflightCompletions = [];
  workerAction = (worker) => worker.message({ result: digests });
  vi.stubGlobal('Worker', WorkerControl);
  vi.spyOn(uploadManager, 'getExtensions').mockReturnValue(['.jpg']);
  uploadAssetsStore.reset();
  authManager.reset();
  authManager.setUser({ id: 'owner-a', email: 'a@example.com' } as UserAdminResponseDto);
  authManager.setPreferences(preferencesFactory.build());
  sdkMock.checkBulkUpload
    .mockReset()
    .mockResolvedValue({ results: [{ id: file.name, action: AssetUploadAction.Accept }] });
  vi.spyOn(utils, 'uploadRequest').mockResolvedValue({
    status: 201,
    data: { id: 'uploaded', status: AssetMediaStatus.Created },
  });
});

afterEach(async () => {
  workerAction = (worker) => worker.message({ result: digests });
  for (const complete of preflightCompletions) {
    complete();
  }
  for (const worker of workers) {
    worker.message({ result: digests });
  }
  await Promise.allSettled(pendingTasks);
  for (const input of document.querySelectorAll('input[type=file]')) {
    input.remove();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('file picker lifetime', () => {
  it('settles cancellation with no selected files and removes the mounted input', async () => {
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    const pending = openFilePicker();
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
    const resolved = vi.fn();
    void pending.then(resolved);
    input.dispatchEvent(new Event('cancel'));
    await vi.waitFor(() => expect(resolved).toHaveBeenCalledWith([]));
    expect(input.isConnected).toBe(false);
  });

  it('settles a change with no FileList as an empty selection', async () => {
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    const pending = openFilePicker();
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
    Object.defineProperty(input, 'files', { value: null });
    const resolved = vi.fn();
    void pending.then(resolved);
    input.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(resolved).toHaveBeenCalledWith([]));
    expect(input.isConnected).toBe(false);
  });

  it('keeps picker options, selected file identity and browser-required mounting', async () => {
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      expect(this.isConnected).toBe(true);
      expect(this.hidden).toBe(true);
      expect(this.multiple).toBe(false);
      expect(this.accept).toBe('.jpg,.png');
      expect(this.hasAttribute('webkitdirectory')).toBe(true);
      expect(this.hasAttribute('directory')).toBe(true);
      Object.defineProperty(this, 'files', { value: [file] });
      this.dispatchEvent(new Event('change'));
    });
    const selected = await openFilePicker({ multiple: false, extensions: ['.jpg', '.png'], directory: true });
    expect(selected).toEqual([file]);
    expect(selected[0]).toBe(file);
  });

  it('removes the input when starting the native picker throws', async () => {
    const error = new Error('picker refused');
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {
      throw error;
    });
    await expect(openFilePicker()).rejects.toBe(error);
    expect(document.querySelector('input[type=file]')).toBeNull();
  });
});

describe('upload preflight lifetime', () => {
  it('cancels a pending hash and settles without starting a duplicate check or upload', async () => {
    workerAction = () => {};
    const pending = fileUploadHandler({ files: [file] });
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    cancelRemainingUploads();
    await pending;
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(sdkMock.checkBulkUpload).not.toHaveBeenCalled();
    expect(utils.uploadRequest).not.toHaveBeenCalled();
    expect(get(uploadAssetsStore)[0]).toMatchObject({
      state: UploadState.ERROR,
      error: 'frameleaf_transfer_upload_cancelled',
    });
    expect(get(uploadAssetsStore.stats).errors).toBe(1);
  });

  it('does not create a hashing worker when cancellation happens before the first tick settles', async () => {
    const pending = fileUploadHandler({ files: [file] });
    cancelRemainingUploads();
    await pending;
    expect(workers).toHaveLength(0);
    expect(utils.uploadRequest).not.toHaveBeenCalled();
    expect(get(uploadAssetsStore)[0].state).toBe(UploadState.ERROR);
  });

  it('aborts the duplicate check and ignores its late result', async () => {
    let finish: ((response: Awaited<ReturnType<typeof sdkMock.checkBulkUpload>>) => void) | undefined;
    sdkMock.checkBulkUpload.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
          preflightCompletions.push(() => resolve({ results: [{ id: file.name, action: AssetUploadAction.Accept }] }));
        }),
    );
    const pending = fileUploadHandler({ files: [file] });
    await vi.waitFor(() => expect(finish).toBeDefined());
    const signal = sdkMock.checkBulkUpload.mock.calls[0][1]?.signal;
    cancelRemainingUploads();
    expect(signal?.aborted).toBe(true);
    finish!({ results: [{ id: file.name, action: AssetUploadAction.Accept }] });
    await pending;
    expect(utils.uploadRequest).not.toHaveBeenCalled();
    expect(get(uploadAssetsStore.stats).errors).toBe(1);
  });

  it('lets a later batch start after cancellation and releases the old queue slot', async () => {
    const concurrency = vi.spyOn(uploadExecutionQueue, 'concurrency', 'get').mockReturnValue(1);
    workerAction = () => {};
    const cancelled = fileUploadHandler({ files: [file] });
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    cancelRemainingUploads();
    workerAction = (worker) => worker.message({ result: digests });
    const later = new File(['later'], 'later.jpg', { lastModified: file.lastModified });
    const started = fileUploadHandler({ files: [later] });
    await cancelled;
    await expect(started).resolves.toEqual(['uploaded']);
    expect(get(uploadAssetsStore).find((item) => item.file === later)?.state).toBe(UploadState.DONE);
    concurrency.mockRestore();
  });

  it('terminates a worker whose postMessage throws and preserves the upload fallback', async () => {
    workerAction = () => {
      throw new DOMException('clone refused', 'DataCloneError');
    };
    await expect(fileUploadHandler({ files: [file] })).resolves.toEqual(['uploaded']);
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(sdkMock.checkBulkUpload).not.toHaveBeenCalled();
  });

  it('handles unreadable worker messages through the existing upload fallback', async () => {
    workerAction = (worker) => worker.dispatchEvent(new MessageEvent('messageerror'));
    const pending = fileUploadHandler({ files: [file] });
    await vi.waitFor(() => expect(utils.uploadRequest).toHaveBeenCalled());
    await expect(pending).resolves.toEqual(['uploaded']);
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  });

  it('does not send an invalid checksum when the worker omits its result', async () => {
    workerAction = (worker) => worker.message({});
    await expect(fileUploadHandler({ files: [file] })).resolves.toEqual(['uploaded']);
    expect(sdkMock.checkBulkUpload).not.toHaveBeenCalled();
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  });

  it('does not continue an older upload after the same account signs in again', async () => {
    workerAction = () => {};
    const pending = fileUploadHandler({ files: [file] });
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    authManager.reset();
    authManager.setUser({ id: 'owner-a', email: 'a@example.com' } as UserAdminResponseDto);
    authManager.setPreferences(preferencesFactory.build());
    workers[0].message({ result: digests });
    await pending;
    expect(utils.uploadRequest).not.toHaveBeenCalled();
  });

  it('does not send a file selected by one account after a different account takes over', async () => {
    workerAction = () => {};
    const pending = fileUploadHandler({ files: [file] });
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    authManager.setUser({ id: 'owner-b', email: 'b@example.com' } as UserAdminResponseDto);
    workers[0].message({ result: digests });
    await pending;
    expect(sdkMock.checkBulkUpload).not.toHaveBeenCalled();
    expect(utils.uploadRequest).not.toHaveBeenCalled();
  });

  it('does not use a late preflight response after logout', async () => {
    let finish: ((response: Awaited<ReturnType<typeof sdkMock.checkBulkUpload>>) => void) | undefined;
    sdkMock.checkBulkUpload.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
          preflightCompletions.push(() => resolve({ results: [{ id: file.name, action: AssetUploadAction.Accept }] }));
        }),
    );
    const pending = fileUploadHandler({ files: [file] });
    await vi.waitFor(() => expect(finish).toBeDefined());
    authManager.reset();
    finish!({ results: [{ id: file.name, action: AssetUploadAction.Accept }] });
    await pending;
    expect(utils.uploadRequest).not.toHaveBeenCalled();
  });

  it('keeps queued files bound to the account that submitted the batch', async () => {
    vi.spyOn(uploadExecutionQueue, 'concurrency', 'get').mockReturnValue(1);
    workerAction = () => {};
    const other = new File(['other'], 'other.jpg');
    const pending = fileUploadHandler({ files: [file, other] });
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    authManager.setUser({ id: 'owner-b', email: 'b@example.com' } as UserAdminResponseDto);
    workers[0].message({ result: digests });
    await pending;
    expect(workers).toHaveLength(1);
    expect(sdkMock.checkBulkUpload).not.toHaveBeenCalled();
    expect(utils.uploadRequest).not.toHaveBeenCalled();
  });

  it('stops a preflight read when its shared-link parameters change', async () => {
    workerAction = () => {};
    const pending = fileUploadHandler({ files: [file] });
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    vi.spyOn(authManager, 'params', 'get').mockReturnValue({ key: 'another-link', slug: undefined });
    workers[0].message({ result: digests });
    await pending;
    expect(sdkMock.checkBulkUpload).not.toHaveBeenCalled();
    expect(utils.uploadRequest).not.toHaveBeenCalled();
  });

  it('uploads through the captured shared link without reading duplicate metadata', async () => {
    vi.spyOn(authManager, 'isSharedLink', 'get').mockReturnValue(true);
    vi.spyOn(authManager, 'params', 'get').mockReturnValue({ key: 'fixture-link', slug: undefined });
    await fileUploadHandler({ files: [file] });
    expect(workers).toHaveLength(0);
    expect(sdkMock.checkBulkUpload).not.toHaveBeenCalled();
    expect(vi.mocked(utils.uploadRequest).mock.calls[0][0].url).toContain('/assets?key=fixture-link');
  });

  it('retires the abort controller after a successful upload', async () => {
    await fileUploadHandler({ files: [file] });
    const signal = sdkMock.checkBulkUpload.mock.calls[0][1]!.signal!;
    cancelRemainingUploads();
    expect(signal.aborted).toBe(false);
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  });

  it('honors cancellation triggered by the started-state notification', async () => {
    const unsubscribe = uploadAssetsStore.subscribe((items) => {
      if (items.some((item) => item.state === UploadState.STARTED)) {
        unsubscribe();
        cancelRemainingUploads();
      }
    });
    await fileUploadHandler({ files: [file] });
    unsubscribe();
    expect(workers).toHaveLength(0);
    expect(utils.uploadRequest).not.toHaveBeenCalled();
  });

  it('honors cancellation triggered by the uploading-message notification', async () => {
    const unsubscribe = uploadAssetsStore.subscribe((items) => {
      if (items.some((item) => item.message === 'asset_uploading')) {
        unsubscribe();
        cancelRemainingUploads();
      }
    });
    await fileUploadHandler({ files: [file] });
    unsubscribe();
    expect(utils.uploadRequest).not.toHaveBeenCalled();
  });

  it('keeps a fresh batch submitted by an abort listener out of the cancelled batch', async () => {
    vi.spyOn(uploadExecutionQueue, 'concurrency', 'get').mockReturnValue(1);
    const later = new File(['later'], 'later.jpg');
    let fresh: Promise<string[]> | undefined;
    sdkMock.checkBulkUpload.mockImplementationOnce(
      (_args, options) =>
        new Promise((_resolve, reject) => {
          options!.signal!.addEventListener(
            'abort',
            () => {
              fresh = fileUploadHandler({ files: [later] });
              reject(options!.signal!.reason);
            },
            { once: true },
          );
        }),
    );
    const original = fileUploadHandler({ files: [file] });
    await vi.waitFor(() => expect(sdkMock.checkBulkUpload).toHaveBeenCalled());
    cancelRemainingUploads();
    await expect(original).resolves.toEqual([]);
    await expect(fresh).resolves.toEqual(['uploaded']);
    expect(get(uploadAssetsStore).find((item) => item.file === later)?.state).toBe(UploadState.DONE);
  });

  it('gives same-name, same-date files separate progress and cleanup ownership', async () => {
    const other = new File(['other bytes'], file.name, { lastModified: file.lastModified });
    await fileUploadHandler({ files: [file, other] });
    const items = get(uploadAssetsStore);
    expect(items).toHaveLength(2);
    expect(items[0].id).not.toBe(items[1].id);
    expect(items.map((item) => item.file)).toEqual([file, other]);
    expect(get(uploadAssetsStore.stats).total).toBe(2);
  });

  it('does not construct multipart data for a server-confirmed duplicate', async () => {
    sdkMock.checkBulkUpload.mockResolvedValueOnce({
      results: [{ id: file.name, action: AssetUploadAction.Reject, assetId: 'existing', isTrashed: false }],
    });
    const constructor = vi.fn(function () {
      throw new Error('unnecessary multipart allocation');
    });
    vi.stubGlobal('FormData', constructor);
    await expect(fileUploadHandler({ files: [file] })).resolves.toEqual(['existing']);
    expect(constructor).not.toHaveBeenCalled();
    expect(utils.uploadRequest).not.toHaveBeenCalled();
    expect(get(uploadAssetsStore)[0]).toMatchObject({ state: UploadState.DUPLICATED, assetId: 'existing' });
  });

  it('preserves multipart field names, file bytes, date values and Locked visibility', async () => {
    await fileUploadHandler({ files: [file], isLockedAssets: true });
    const request = vi.mocked(utils.uploadRequest).mock.calls[0][0];
    const data = request.data as FormData;
    expect([...data.keys()]).toEqual(['fileCreatedAt', 'fileModifiedAt', 'isFavorite', 'assetData', 'visibility']);
    expect(data.get('fileCreatedAt')).toBe(new Date(file.lastModified).toISOString());
    expect(data.get('fileModifiedAt')).toBe(data.get('fileCreatedAt'));
    expect(data.get('isFavorite')).toBe('false');
    expect(data.get('visibility')).toBe('locked');
    const uploaded = data.get('assetData') as File;
    expect(uploaded.name).toBe(file.name);
    expect(await uploaded.text()).toBe(await file.text());
    expect(uploaded.type).toBe('');
  });
});
