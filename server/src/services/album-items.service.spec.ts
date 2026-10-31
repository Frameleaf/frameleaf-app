import { AccessRepository } from 'src/repositories/access.repository.js';
import { BookmarkRepository } from 'src/repositories/bookmark.repository.js';
import { AlbumItemsService } from 'src/services/album-items.service.js';
import { BookmarkService } from 'src/services/bookmark.service.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { automock, getMocks } from 'test/utils.js';

describe('mixed album item pages', () => {
  const asset = { ...AssetFactory.create(), exifInfo: undefined, faces: undefined };
  const repo = automock(BookmarkRepository, { args: [{}] });
  const mocks = getMocks();
  const bookmarks = automock(BookmarkService, { args: [repo, mocks.access] });
  const service = new AlbumItemsService(repo, bookmarks, mocks.access as unknown as AccessRepository);
  const bookmark = { id: 'bookmark-id', title: 'Reference' } as never;
  beforeEach(() => {
    repo.resetAllMocks();
    bookmarks.resetAllMocks();
    mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set(['album']));
    mocks.access.album.checkSharedAlbumAccess.mockResolvedValue(new Set());
    repo.getAlbumCounts.mockResolvedValue({ assetCount: 1, bookmarkCount: 1, itemCount: 2 });
  });

  it('continues across the kind boundary without repeating an asset', async () => {
    repo.getAlbumAssets.mockResolvedValueOnce([asset]).mockResolvedValueOnce([]);
    bookmarks.getForAlbum.mockResolvedValue([bookmark]);
    const first = await service.get(authStub.user1, 'album', { limit: 1 });
    expect(first.items.map(({ kind }) => kind)).toEqual(['asset']);
    expect(first.nextCursor).toEqual({ kind: 'asset', id: asset.id });
    const second = await service.get(authStub.user1, 'album', { limit: 1, afterKind: 'asset', afterId: asset.id });
    expect(second.items).toEqual([{ kind: 'bookmark', bookmark }]);
    expect(second.nextCursor).toBeNull();
    expect(second).toEqual(expect.objectContaining({ assetCount: 1, bookmarkCount: 1, itemCount: 2 }));
  });

  it('does not restart the asset page after a bookmark cursor', async () => {
    bookmarks.getForAlbum.mockResolvedValue([]);
    expect(
      (await service.get(authStub.user1, 'album', { limit: 10, afterKind: 'bookmark', afterId: 'bookmark-id' })).items,
    ).toEqual([]);
    expect(repo.getAlbumAssets).not.toHaveBeenCalled();
    expect(bookmarks.getForAlbum).toHaveBeenCalledWith(authStub.user1, 'album', 'bookmark-id', 11);
  });

  it('does not return items or counts after album access is revoked', async () => {
    mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set());
    await expect(service.get(authStub.user1, 'album', { limit: 10 })).rejects.toThrow();
    expect(repo.getAlbumAssets).not.toHaveBeenCalled();
    expect(repo.getAlbumCounts).not.toHaveBeenCalled();
  });
});
