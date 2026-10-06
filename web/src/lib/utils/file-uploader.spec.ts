import { AssetMediaStatus, type AssetMediaResponseDto, type UserAdminResponseDto } from '@frameleaf/sdk';
import { get } from 'svelte/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { uploadManager } from '$lib/managers/upload-manager.svelte';
import * as albumService from '$lib/services/album.service';
import { uploadAssetsStore } from '$lib/stores/upload';
import { UploadState } from '$lib/types';
import * as utils from '$lib/utils';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { cancelRemainingUploads, fileUploadHandler, retryFailedUploads, uploadExecutionQueue } from './file-uploader';

describe('fileUploader error handling', () => {
  const mockFile = new File(['content'], 'test.jpg', { type: 'image/jpeg' });
  const mockUserObject = { id: 'user-123', email: 'test@example.com' } as UserAdminResponseDto;
  const mockError = new Error('Upload failed');
  const mockUploadResponse = { id: 'mock-id', status: AssetMediaStatus.Created } as AssetMediaResponseDto;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(uploadManager, 'getExtensions').mockReturnValue(['.jpg']);
    uploadAssetsStore.reset();
    authManager.reset();
  });

  for (const [name, mockUser] of [
    ['logged-in users', true],
    ['anonymous users', false],
  ] as const) {
    describe(`for ${name}`, () => {
      beforeEach(() => {
        if (mockUser) {
          authManager.setUser(mockUserObject);
        }
      });

      it(`should transition successful uploads to done`, async () => {
        vi.spyOn(utils, 'uploadRequest').mockResolvedValue({ status: 200, data: mockUploadResponse });

        await fileUploadHandler({ files: [mockFile] });

        const items = get(uploadAssetsStore);
        expect(items.length).toBe(1);
        expect(items[0].state).toBe(UploadState.DONE);
      });

      it('should capture errors', async () => {
        vi.spyOn(utils, 'uploadRequest').mockRejectedValue(mockError);

        await fileUploadHandler({ files: [mockFile] });

        const items = get(uploadAssetsStore);
        expect(items.length).toBe(1);
        expect(items[0].state).toBe(UploadState.ERROR);
      });
    });
  }

  it('should suppress errors on logout', async () => {
    authManager.setUser(mockUserObject);
    authManager.setPreferences(preferencesFactory.build());
    vi.spyOn(utils, 'uploadRequest').mockImplementationOnce(() => {
      authManager.reset();
      return Promise.reject(mockError);
    });

    await fileUploadHandler({ files: [mockFile] });

    const items = get(uploadAssetsStore);
    expect(items.length).toBe(1);
    expect(items[0].state).toBe(UploadState.STARTED);
  });

  it('should mark duplicate uploads without an asset id as duplicated', async () => {
    vi.spyOn(utils, 'uploadRequest').mockResolvedValue({
      status: 201,
      data: { id: '', status: AssetMediaStatus.Duplicate } as AssetMediaResponseDto,
    });

    await fileUploadHandler({ files: [mockFile] });

    const items = get(uploadAssetsStore);
    expect(items.length).toBe(1);
    expect(items[0].state).toBe(UploadState.DUPLICATED);
    expect(items[0].assetId).toBeUndefined();
    expect(get(uploadAssetsStore.stats).duplicates).toBe(1);
    expect(get(uploadAssetsStore.stats).errors).toBe(0);
  });

  it('should add the uploaded asset to the target album', async () => {
    authManager.setUser(mockUserObject);
    vi.spyOn(utils, 'uploadRequest').mockResolvedValue({ status: 200, data: mockUploadResponse });
    const addAssetsToAlbumsSpy = vi.spyOn(albumService, 'addAssetsToAlbums').mockResolvedValue(true);

    await fileUploadHandler({ files: [mockFile], albumId: 'album-1' });

    expect(addAssetsToAlbumsSpy).toHaveBeenCalledWith(['album-1'], [mockUploadResponse.id], { notify: false });
    const items = get(uploadAssetsStore);
    expect(items[0].state).toBe(UploadState.DONE);
  });

  it('uploads every file of a partly failing batch into the album that could be uploaded (FL-53)', async () => {
    authManager.setUser(mockUserObject);
    const second = new File(['content-2'], 'second.jpg', { type: 'image/jpeg' });
    vi.spyOn(utils, 'uploadRequest')
      .mockResolvedValueOnce({ status: 200, data: mockUploadResponse })
      .mockRejectedValueOnce(mockError);
    const addAssetsToAlbumsSpy = vi.spyOn(albumService, 'addAssetsToAlbums').mockResolvedValue(true);

    const ids = await fileUploadHandler({ files: [mockFile, second], albumId: 'album-1' });

    expect(ids).toEqual([mockUploadResponse.id]);
    // Only the file that uploaded is added; the failed one is reported, not silently dropped.
    expect(addAssetsToAlbumsSpy).toHaveBeenCalledTimes(1);
    expect(addAssetsToAlbumsSpy).toHaveBeenCalledWith(['album-1'], [mockUploadResponse.id], { notify: false });
    const states = get(uploadAssetsStore).map(({ state }) => state);
    expect(states).toContain(UploadState.DONE);
    expect(states).toContain(UploadState.ERROR);
  });

  it('says so when the upload worked but adding it to the album did not (FL-53)', async () => {
    authManager.setUser(mockUserObject);
    vi.spyOn(utils, 'uploadRequest').mockResolvedValue({ status: 200, data: mockUploadResponse });
    vi.spyOn(albumService, 'addAssetsToAlbums').mockResolvedValue(false);

    const ids = await fileUploadHandler({ files: [mockFile], albumId: 'album-1' });

    // The original is kept in the library either way.
    expect(ids).toEqual([mockUploadResponse.id]);
    const [item] = get(uploadAssetsStore);
    expect(item.state).toBe(UploadState.ERROR);
    expect(item.assetId).toBe(mockUploadResponse.id);
    expect(item.error).toBeTruthy();
    expect(item.message).not.toBe('asset_added_to_album');
  });

  it('retrying a failed upload clears the previous error and re-runs the same file', async () => {
    authManager.setUser(mockUserObject);
    const uploadRequestSpy = vi
      .spyOn(utils, 'uploadRequest')
      .mockRejectedValueOnce(mockError)
      .mockResolvedValueOnce({ status: 200, data: mockUploadResponse });

    await fileUploadHandler({ files: [mockFile] });
    expect(get(uploadAssetsStore)[0].state).toBe(UploadState.ERROR);

    const failedItem = get(uploadAssetsStore)[0];
    uploadAssetsStore.removeItem(failedItem.id);
    await fileUploadHandler({ files: [mockFile] });

    expect(uploadRequestSpy).toHaveBeenCalledTimes(2);
    const items = get(uploadAssetsStore);
    expect(items.length).toBe(1);
    expect(items[0].state).toBe(UploadState.DONE);
  });

  it('cancelRemainingUploads() fails the uploads still waiting for a queue slot', async () => {
    authManager.setUser(mockUserObject);
    // Force one slot so the second file stays queued behind the first instead of both
    // starting together (the module singleton defaults to concurrency 2).
    const concurrencySpy = vi.spyOn(uploadExecutionQueue, 'concurrency', 'get').mockReturnValue(1);

    let releaseFirst: (() => void) | undefined;
    vi.spyOn(utils, 'uploadRequest').mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve({ status: 200, data: mockUploadResponse });
        }),
    );

    const secondFile = new File(['content-2'], 'test-2.jpg', { type: 'image/jpeg' });
    const handled = fileUploadHandler({ files: [mockFile, secondFile] });

    // Let the first file's request start (and the second land in the store as PENDING)
    // before cancelling the one still queued behind it. The first file hashes and checks for
    // duplicates before it reaches the request, so wait for the request itself.
    await vi.waitFor(() => expect(releaseFirst).toBeDefined());
    expect(get(uploadAssetsStore).find((item) => item.file === secondFile)?.state).toBe(UploadState.PENDING);

    cancelRemainingUploads();
    releaseFirst?.();
    await handled;

    const items = get(uploadAssetsStore);
    expect(items.find((item) => item.file === mockFile)?.state).toBe(UploadState.DONE);
    expect(items.find((item) => item.file === secondFile)?.state).toBe(UploadState.ERROR);

    concurrencySpy.mockRestore();
  });

  it('cancelRemainingUploads() stops an upload already on its way and says it was cancelled', async () => {
    authManager.setUser(mockUserObject);
    vi.spyOn(utils, 'uploadRequest').mockImplementation(
      () =>
        new Promise((_, reject) => {
          vi.spyOn(utils, 'cancelUploadRequests').mockImplementation(() => reject(new utils.AbortError()));
        }),
    );

    const handled = fileUploadHandler({ files: [mockFile] });
    await vi.waitFor(() => expect(get(uploadAssetsStore)[0].state).toBe(UploadState.STARTED));
    await vi.waitFor(() => expect(vi.isMockFunction(utils.cancelUploadRequests)).toBe(true));

    cancelRemainingUploads();
    await handled;

    const [item] = get(uploadAssetsStore);
    expect(item.state).toBe(UploadState.ERROR);
    expect(item.error).toBe('frameleaf_transfer_upload_cancelled');
    expect(get(uploadAssetsStore.stats).errors).toBe(1);
  });

  it('retrying a failed Locked upload sends it to the Locked folder again', async () => {
    authManager.setUser(mockUserObject);
    const uploadRequestSpy = vi
      .spyOn(utils, 'uploadRequest')
      .mockRejectedValueOnce(mockError)
      .mockResolvedValueOnce({ status: 200, data: mockUploadResponse });

    await fileUploadHandler({ files: [mockFile], isLockedAssets: true });
    expect(get(uploadAssetsStore)[0].state).toBe(UploadState.ERROR);

    await retryFailedUploads();

    expect(uploadRequestSpy).toHaveBeenCalledTimes(2);
    const retried = uploadRequestSpy.mock.calls[1][0].data as FormData;
    expect(retried.get('visibility')).toBe('locked');
    expect(get(uploadAssetsStore)[0].state).toBe(UploadState.DONE);
  });

  it('retries every failed upload through the queue together, each into its own album', async () => {
    authManager.setUser(mockUserObject);
    const addSpy = vi.spyOn(albumService, 'addAssetsToAlbums').mockResolvedValue(true);
    const secondFile = new File(['content-2'], 'test-2.jpg', { type: 'image/jpeg' });
    const uploadRequestSpy = vi
      .spyOn(utils, 'uploadRequest')
      .mockRejectedValueOnce(mockError)
      .mockRejectedValueOnce(mockError);

    await fileUploadHandler({ files: [mockFile], albumId: 'album-a' });
    await fileUploadHandler({ files: [secondFile], albumId: 'album-b' });
    expect(get(uploadAssetsStore).every((item) => item.state === UploadState.ERROR)).toBe(true);

    const releases: Array<() => void> = [];
    uploadRequestSpy.mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ status: 200, data: mockUploadResponse }));
        }),
    );

    const retried = retryFailedUploads();
    // Both requests are in flight at once: the queue's concurrency applies, not one file at a time.
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    for (const release of releases) {
      release();
    }
    await retried;

    expect(addSpy).toHaveBeenCalledWith(['album-a'], [mockUploadResponse.id], { notify: false });
    expect(addSpy).toHaveBeenCalledWith(['album-b'], [mockUploadResponse.id], { notify: false });
    expect(get(uploadAssetsStore).every((item) => item.state === UploadState.DONE)).toBe(true);
  });
});
