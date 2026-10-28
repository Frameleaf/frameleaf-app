import { LibraryAssetItemKind, LibraryBookmarkItemKind, type LibraryItemDto } from '@frameleaf/sdk';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { organizeLibraryItems } from './library-item-organization';

const items = [
  { kind: LibraryAssetItemKind.Asset, asset: { id: 'same', ownerId: 'owner' } },
  { kind: LibraryBookmarkItemKind.Bookmark, bookmark: { id: 'same', ownerId: 'owner' } },
] as LibraryItemDto[];
beforeEach(() => vi.clearAllMocks());
it('sends each kind to its own album endpoint and accepts existing memberships', async () => {
  sdkMock.addAssetsToAlbum.mockResolvedValue([{ id: 'same', success: true }]);
  sdkMock.addBookmarksToAlbum.mockResolvedValue([{ id: 'same', success: false, error: 'duplicate' as never }]);
  await organizeLibraryItems(items, ['same', 'bookmark:same'], 'owner', { albumId: 'album' }, () => true);
  expect(sdkMock.addAssetsToAlbum).toHaveBeenCalledWith({ id: 'album', bulkIdsDto: { ids: ['same'] } });
  expect(sdkMock.addBookmarksToAlbum).toHaveBeenCalledWith({ id: 'album', bookmarkIdsDto: { ids: ['same'] } });
});
it('adds bookmark tags without replacing existing tags', async () => {
  await organizeLibraryItems(items, ['bookmark:same'], 'owner', { tagIds: ['new'] }, () => true);
  expect(sdkMock.addBookmarkTags).toHaveBeenCalledWith({ id: 'same', bookmarkTagsDto: { ids: ['new'] } });
  expect(sdkMock.bulkTagAssets).not.toHaveBeenCalled();
});
it('stops before writing when the account or permission boundary has changed', async () => {
  await expect(
    organizeLibraryItems(items, ['bookmark:same'], 'owner', { albumId: 'album' }, () => false),
  ).rejects.toThrow();
  expect(sdkMock.addBookmarksToAlbum).not.toHaveBeenCalled();
});

it('removes mixed album memberships without deleting either original', async () => {
  sdkMock.removeAssetFromAlbum.mockResolvedValue([{ id: 'same', success: true }]);
  sdkMock.removeBookmarksFromAlbum.mockResolvedValue([{ id: 'same', success: true }]);
  await organizeLibraryItems(items, ['same', 'bookmark:same'], 'owner', { albumId: 'album' }, () => true, 'remove');
  expect(sdkMock.removeAssetFromAlbum).toHaveBeenCalledWith({ id: 'album', bulkIdsDto: { ids: ['same'] } });
  expect(sdkMock.removeBookmarksFromAlbum).toHaveBeenCalledWith({ id: 'album', bookmarkIdsDto: { ids: ['same'] } });
  expect(sdkMock.deleteAssets).not.toHaveBeenCalled();
  expect(sdkMock.trashBookmark).not.toHaveBeenCalled();
});

it('batches a large mixed selection without losing or duplicating either kind', async () => {
  const selected = Array.from({ length: 501 }, (_, index) => String(index));
  const largeItems = selected.flatMap((id) => [
    { ...items[0], asset: { id, ownerId: 'owner' } },
    { ...items[1], bookmark: { id, ownerId: 'owner' } },
  ]) as LibraryItemDto[];
  sdkMock.addAssetsToAlbum.mockResolvedValue([]);
  sdkMock.addBookmarksToAlbum.mockResolvedValue([]);
  await organizeLibraryItems(
    largeItems,
    selected.flatMap((id) => [id, `bookmark:${id}`]),
    'owner',
    { albumId: 'album' },
    () => true,
  );
  expect(sdkMock.addAssetsToAlbum.mock.calls.map(([request]) => request.bulkIdsDto.ids.length)).toEqual([500, 1]);
  expect(sdkMock.addBookmarksToAlbum.mock.calls.flatMap(([request]) => request.bookmarkIdsDto.ids)).toEqual(selected);
  expect(sdkMock.deleteAssets).not.toHaveBeenCalled();
  expect(sdkMock.trashBookmark).not.toHaveBeenCalled();
});

it('stops the rest of a mixed organization after access changes during the first write', async () => {
  let current = true;
  sdkMock.addAssetsToAlbum.mockImplementation(async () => {
    current = false;
    return [];
  });
  await expect(
    organizeLibraryItems(items, ['same', 'bookmark:same'], 'owner', { albumId: 'album' }, () => current),
  ).rejects.toThrow('Library access changed');
  expect(sdkMock.addBookmarksToAlbum).not.toHaveBeenCalled();
});
