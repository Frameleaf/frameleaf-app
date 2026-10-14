import type { AssetResponseDto, FolderSummaryResponseDto } from '@frameleaf/sdk';
import { render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { foldersStore as folders } from '$lib/stores/folders.svelte';
import { assetFactory } from '@test-data/factories/asset-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import FolderFilesTest from '@test-data/frameleaf/FolderFilesTest.svelte';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const files = (id: string) => [assetFactory.build({ id })];
const rows = (path: string): FolderSummaryResponseDto[] => [
  { path, count: 1, size: 10, coverAssetIds: [], startDate: '2026-08-01', endDate: '2026-08-02' },
];

beforeEach(() => {
  eventManager.emit('AuthLogout');
  folders.clearCache();
  vi.resetAllMocks();
});
afterEach(() => {
  folders.clearCache();
  eventManager.emit('AuthLogout');
});

describe('folder file requests', () => {
  it('keeps cached arrays, rows and nested metadata reactive for consumers', async () => {
    sdkMock.getAssetsByOriginalPath.mockResolvedValue([
      assetFactory.build({ originalFileName: 'before.jpg', exifInfo: { fileSizeInByte: 10 } }),
    ]);
    await folders.fetchAssetsByPath('/a');
    const cached = await folders.fetchAssetsByPath('/a');
    render(FolderFilesTest, { files: cached });
    expect(screen.getByTestId('file-name')).toHaveTextContent('before.jpg');
    cached[0].originalFileName = 'after.jpg';
    cached[0].exifInfo!.fileSizeInByte = 20;
    cached.push(assetFactory.build());
    await tick();
    expect(screen.getByTestId('file-count')).toHaveTextContent('2');
    expect(screen.getByTestId('file-name')).toHaveTextContent('after.jpg');
    expect(screen.getByTestId('file-size')).toHaveTextContent('20');
  });

  it('shares one request across a hundred simultaneous readers of the same folder', async () => {
    const request = deferred<AssetResponseDto[]>();
    sdkMock.getAssetsByOriginalPath.mockReturnValue(request.promise);
    const readers = Array.from({ length: 100 }, () => folders.fetchAssetsByPath('/a'));
    try {
      await vi.waitFor(() => expect(sdkMock.getAssetsByOriginalPath).toHaveBeenCalledTimes(1));
    } finally {
      request.resolve([]);
      await Promise.all(readers);
    }
    expect(sdkMock.getAssetsByOriginalPath).toHaveBeenCalledWith({ path: '/a' });
  });

  it('keeps different paths independent and caches empty folders', async () => {
    sdkMock.getAssetsByOriginalPath.mockResolvedValueOnce([]).mockResolvedValueOnce(files('b'));
    const [a, b] = await Promise.all([folders.fetchAssetsByPath('/a'), folders.fetchAssetsByPath('/b')]);
    expect(a).toEqual([]);
    expect(b.map(({ id }) => id)).toEqual(['b']);
    expect(await folders.fetchAssetsByPath('/a')).toEqual([]);
    expect(sdkMock.getAssetsByOriginalPath).toHaveBeenCalledTimes(2);
  });

  it.each(['__proto__', 'constructor', 'toString'])(
    'treats %s as a path rather than an inherited object member',
    async (path) => {
      sdkMock.getAssetsByOriginalPath.mockResolvedValue(files('actual'));
      const first = await folders.fetchAssetsByPath(path);
      expect(first.map(({ id }) => id)).toEqual(['actual']);
      expect((await folders.fetchAssetsByPath(path)).map(({ id }) => id)).toEqual(['actual']);
      expect(sdkMock.getAssetsByOriginalPath).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps the newest explicit refresh cached when an older request finishes last', async () => {
    const old = deferred<AssetResponseDto[]>();
    sdkMock.getAssetsByOriginalPath.mockReturnValueOnce(old.promise).mockResolvedValueOnce(files('fresh'));
    const first = folders.fetchAssetsByPath('/a');
    await vi.waitFor(() => expect(sdkMock.getAssetsByOriginalPath).toHaveBeenCalledTimes(1));
    await folders.refreshAssetsByPath('/a');
    old.resolve(files('old'));
    expect((await first).map(({ id }) => id)).toEqual(['old']);
    expect((await folders.fetchAssetsByPath('/a')).map(({ id }) => id)).toEqual(['fresh']);
    expect(sdkMock.getAssetsByOriginalPath).toHaveBeenCalledTimes(2);
  });

  it('cannot restore a busted cache from an earlier response', async () => {
    const old = deferred<AssetResponseDto[]>();
    sdkMock.getAssetsByOriginalPath.mockReturnValueOnce(old.promise).mockResolvedValueOnce(files('fresh'));
    const first = folders.fetchAssetsByPath('/a');
    await vi.waitFor(() => expect(sdkMock.getAssetsByOriginalPath).toHaveBeenCalledTimes(1));
    folders.bustAssetCache();
    old.resolve(files('old'));
    await first;
    expect((await folders.fetchAssetsByPath('/a')).map(({ id }) => id)).toEqual(['fresh']);
    expect(sdkMock.getAssetsByOriginalPath).toHaveBeenCalledTimes(2);
  });

  it('leaves a replacement read joinable when an obsolete read fails', async () => {
    const old = deferred<AssetResponseDto[]>();
    const fresh = deferred<AssetResponseDto[]>();
    sdkMock.getAssetsByOriginalPath.mockReturnValueOnce(old.promise).mockReturnValue(fresh.promise);
    const first = folders.fetchAssetsByPath('/a');
    const rejected = expect(first).rejects.toThrow('old offline');
    await vi.waitFor(() => expect(sdkMock.getAssetsByOriginalPath).toHaveBeenCalledTimes(1));
    folders.bustAssetCache();
    const replacement = folders.fetchAssetsByPath('/a');
    await vi.waitFor(() => expect(sdkMock.getAssetsByOriginalPath).toHaveBeenCalledTimes(2));
    old.reject(new Error('old offline'));
    await rejected;
    const joined = folders.fetchAssetsByPath('/a');
    fresh.resolve(files('fresh'));
    await Promise.all([replacement, joined]);
    expect(sdkMock.getAssetsByOriginalPath).toHaveBeenCalledTimes(2);
  });

  it('retries a failed shared read without caching its error', async () => {
    sdkMock.getAssetsByOriginalPath.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(files('ready'));
    const first = folders.fetchAssetsByPath('/a');
    const second = folders.fetchAssetsByPath('/a');
    const results = await Promise.allSettled([first, second]);
    expect(results.map(({ status }) => status)).toEqual(['rejected', 'rejected']);
    expect((await folders.fetchAssetsByPath('/a')).map(({ id }) => id)).toEqual(['ready']);
    expect(sdkMock.getAssetsByOriginalPath).toHaveBeenCalledTimes(2);
  });
});

describe('folder access boundaries', () => {
  it('does not dispatch a queued folder path after the access state changes', async () => {
    sdkMock.getAssetsByOriginalPath.mockResolvedValue(files('other-account'));
    const loading = folders.fetchAssetsByPath('/private');
    const rejected = expect(loading).rejects.toMatchObject({ name: 'AbortError' });
    eventManager.emit('SessionLocked');
    await rejected;
    expect(sdkMock.getAssetsByOriginalPath).not.toHaveBeenCalled();
  });

  it('does not reinstall a tree request retired synchronously during SDK setup', async () => {
    const old = deferred<FolderSummaryResponseDto[]>();
    sdkMock.getFolderSummary
      .mockImplementationOnce(() => {
        folders.clearCache();
        return old.promise;
      })
      .mockResolvedValueOnce(rows('/current'));
    const first = folders.fetchTree();
    await vi.waitFor(() => expect(sdkMock.getFolderSummary).toHaveBeenCalledTimes(1));
    const current = folders.fetchTree();
    old.resolve(rows('/private'));
    const [oldTree, newTree] = await Promise.all([first, current]);
    expect(oldTree.byPath.has('/private')).toBe(true);
    expect(newTree.byPath.has('/current')).toBe(true);
    expect(folders.folders).toBe(newTree);
    expect(sdkMock.getFolderSummary).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['lock', () => eventManager.emit('SessionLocked')],
    ['access restriction', () => eventManager.emit('SessionAccessChanged', { isElevated: false })],
    ['access expansion', () => eventManager.emit('SessionAccessChanged', { isElevated: true })],
    ['PIN reset', () => eventManager.emit('UserPinCodeReset')],
    ['session deletion', () => eventManager.emit('SessionDelete')],
  ] as const)('drops cached folders and files on %s', async (_name, change) => {
    sdkMock.getFolderSummary.mockResolvedValue(rows('/a'));
    sdkMock.getAssetsByOriginalPath.mockResolvedValue(files('a'));
    await Promise.all([folders.fetchTree(), folders.fetchAssetsByPath('/a')]);
    change();
    expect(folders.folders).toBeNull();
    await Promise.all([folders.fetchTree(), folders.fetchAssetsByPath('/a')]);
    expect(sdkMock.getFolderSummary).toHaveBeenCalledTimes(2);
    expect(sdkMock.getAssetsByOriginalPath).toHaveBeenCalledTimes(2);
  });

  it('keeps a routine same-account refresh cached but clears it on an account switch', async () => {
    const user = userAdminFactory.build();
    eventManager.emit('AuthUserLoaded', user);
    sdkMock.getFolderSummary.mockResolvedValue(rows('/a'));
    sdkMock.getAssetsByOriginalPath.mockResolvedValue(files('a'));
    const tree = await folders.fetchTree();
    await folders.fetchAssetsByPath('/a');
    eventManager.emit('AuthUserLoaded', user);
    expect(await folders.fetchTree()).toBe(tree);
    await folders.fetchAssetsByPath('/a');
    expect(sdkMock.getFolderSummary).toHaveBeenCalledTimes(1);
    expect(sdkMock.getAssetsByOriginalPath).toHaveBeenCalledTimes(1);
    eventManager.emit('AuthUserLoaded', userAdminFactory.build());
    expect(folders.folders).toBeNull();
    await Promise.all([folders.fetchTree(), folders.fetchAssetsByPath('/a')]);
    expect(sdkMock.getFolderSummary).toHaveBeenCalledTimes(2);
    expect(sdkMock.getAssetsByOriginalPath).toHaveBeenCalledTimes(2);
  });

  it('does not cache in-flight tree or file results across an access restriction', async () => {
    const tree = deferred<FolderSummaryResponseDto[]>();
    const assets = deferred<AssetResponseDto[]>();
    sdkMock.getFolderSummary.mockReturnValueOnce(tree.promise).mockResolvedValue(rows('/visible'));
    sdkMock.getAssetsByOriginalPath.mockReturnValueOnce(assets.promise).mockResolvedValue(files('visible'));
    const oldTree = folders.fetchTree();
    const oldAssets = folders.fetchAssetsByPath('/a');
    await vi.waitFor(() => expect(sdkMock.getAssetsByOriginalPath).toHaveBeenCalledTimes(1));
    eventManager.emit('SessionLocked');
    tree.resolve(rows('/private'));
    assets.resolve(files('private'));
    await Promise.all([oldTree, oldAssets]);
    expect(folders.folders).toBeNull();
    expect((await folders.fetchAssetsByPath('/a')).map(({ id }) => id)).toEqual(['visible']);
    expect((await folders.fetchTree()).byPath.has('/private')).toBe(false);
  });
});
