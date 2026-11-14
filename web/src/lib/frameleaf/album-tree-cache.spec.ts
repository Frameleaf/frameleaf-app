import { LibraryViewScope, type AlbumTreeResponseDto } from '@frameleaf/sdk';
import { invalidate } from '$app/navigation';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { loadAlbumTree, refreshAlbumTrees } from '$lib/frameleaf/album-tree-cache';
import { eventManager } from '$lib/managers/event-manager.svelte';

vi.mock('$app/navigation', () => ({ invalidate: vi.fn().mockResolvedValue(undefined) }));

const tree = (name: string) =>
  ({ albums: [{ id: name }], collections: [], spaces: [] }) as unknown as AlbumTreeResponseDto;

describe('album tree cache (FL-1596)', () => {
  beforeEach(() => {
    vi.mocked(invalidate).mockClear();
    sdkMock.getAlbumTree.mockReset();
    // each test starts empty
    eventManager.emit('AuthLogout');
  });

  it('answers a revisit at once and re-runs the loaders only when the tree changed', async () => {
    sdkMock.getAlbumTree.mockResolvedValue(tree('a'));
    await expect(loadAlbumTree()).resolves.toEqual(tree('a'));

    // unchanged in the background: no re-run
    await expect(loadAlbumTree()).resolves.toEqual(tree('a'));
    await vi.waitFor(() => expect(sdkMock.getAlbumTree).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(invalidate).not.toHaveBeenCalled();

    // changed in the background: the cached tree first, then one re-run that reads nothing again
    sdkMock.getAlbumTree.mockResolvedValue(tree('b'));
    await expect(loadAlbumTree()).resolves.toEqual(tree('a'));
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalledExactlyOnceWith('album:data'));
    await expect(loadAlbumTree()).resolves.toEqual(tree('b'));
    expect(sdkMock.getAlbumTree).toHaveBeenCalledTimes(3);
  });

  it('keeps each workspace apart', async () => {
    sdkMock.getAlbumTree.mockImplementation(({ libraryScope }) => Promise.resolve(tree(libraryScope ?? 'library')));
    await expect(loadAlbumTree()).resolves.toEqual(tree('library'));
    await expect(loadAlbumTree(LibraryViewScope.Design)).resolves.toEqual(tree(LibraryViewScope.Design));
  });

  it('waits for a new tree after an edit or an access change', async () => {
    sdkMock.getAlbumTree.mockResolvedValue(tree('a'));
    await loadAlbumTree();

    sdkMock.getAlbumTree.mockResolvedValue(tree('edited'));
    await refreshAlbumTrees();
    expect(invalidate).toHaveBeenCalledWith('album:data');
    await expect(loadAlbumTree()).resolves.toEqual(tree('edited'));

    sdkMock.getAlbumTree.mockResolvedValue(tree('other account'));
    eventManager.emit('AuthLogout');
    await expect(loadAlbumTree()).resolves.toEqual(tree('other account'));
  });

  it('drops a tree read under the old access', async () => {
    let resolve!: (value: AlbumTreeResponseDto) => void;
    sdkMock.getAlbumTree.mockReturnValue(new Promise((done) => (resolve = done)));
    const pending = loadAlbumTree();
    eventManager.emit('SessionLocked');
    resolve(tree('unlocked'));
    await pending;

    sdkMock.getAlbumTree.mockResolvedValue(tree('locked'));
    await expect(loadAlbumTree()).resolves.toEqual(tree('locked'));
  });
});
