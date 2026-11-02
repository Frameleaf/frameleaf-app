import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { LibraryScope } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { BookmarkRepository } from 'src/repositories/bookmark.repository.js';
import { BookmarkService } from 'src/services/bookmark.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { automock, getMocks } from 'test/utils.js';

const row = {
  id: 'bookmark',
  ownerId: authStub.user1.user.id,
  url: 'https://example.org',
  title: 'Reference',
  note: 'Private note',
  rating: 4,
  source: null,
  previewAssetId: 'preview',
  libraryScope: LibraryScope.Design,
  isArchived: false,
  isLocked: false,
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  updateId: 'revision',
};

describe(BookmarkService.name, () => {
  const bookmarks = automock(BookmarkRepository, { args: [{}] });
  const mocks = getMocks();
  const service = new BookmarkService(bookmarks, mocks.access as unknown as AccessRepository);

  it('refuses to read a private address for a link preview', async () => {
    await expect(service.preview(authStub.user1, { url: 'http://192.168.1.1/' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
  it('keeps bookmark ratings private when returning shared album items', async () => {
    bookmarks.getForAlbum.mockResolvedValue([row]);
    expect((await service.getForAlbum(authStub.user1, 'album'))[0].rating).toBe(4);
    expect((await service.getForAlbum(authStub.admin, 'album'))[0].rating).toBeNull();
  });
  beforeEach(() => {
    bookmarks.resetAllMocks();
    bookmarks.getOwned.mockResolvedValue(row);
    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());
    mocks.access.asset.checkAlbumAccess.mockResolvedValue(new Set());
    mocks.access.asset.checkItemShareAccess.mockResolvedValue(new Set());
    mocks.access.asset.checkSharedLinkAccess.mockResolvedValue(new Set());
  });

  it('redacts an inaccessible preview while retaining the bookmark', async () => {
    expect(await service.get(authStub.user1, row.id)).toEqual(
      expect.objectContaining({ id: row.id, previewAssetId: null }),
    );
  });

  it('redacts private notes in album reads for members and shared links', async () => {
    bookmarks.getForAlbum.mockResolvedValue([row]);
    for (const auth of [authStub.admin, { ...authStub.user1, sharedLink: authStub.adminSharedLink.sharedLink }]) {
      expect(await service.getForAlbum(auth, 'album')).toEqual([
        expect.objectContaining({ note: null, previewAssetId: null }),
      ]);
    }
  });

  it('never includes private capture provenance in an album bookmark projection', async () => {
    bookmarks.getForAlbum.mockResolvedValue([
      { ...row, source: { pageUrl: 'https://private.example.org', note: 'Private provenance' } } as never,
    ]);
    const [result] = await service.getForAlbum(authStub.admin, 'album');
    expect(result).not.toHaveProperty('source');
  });

  it('never grants preview media access from bookmark membership', async () => {
    await expect(
      service.create(authStub.user1, {
        url: row.url,
        title: row.title,
        libraryScope: LibraryScope.Design,
        previewAssetId: 'preview',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(bookmarks.create).not.toHaveBeenCalled();
  });

  it('does not expose an unknown, foreign, or locked bookmark', async () => {
    bookmarks.getOwned.mockResolvedValue(undefined);
    await expect(service.get(authStub.admin, row.id)).rejects.toThrow(NotFoundException);
    await expect(service.update(authStub.admin, row.id, { title: 'Stolen' })).rejects.toThrow(NotFoundException);
    expect(bookmarks.update).not.toHaveBeenCalled();
  });

  it('requires an elevated owner session to change a lock', async () => {
    await expect(service.update(authStub.user1, row.id, { isLocked: true })).rejects.toThrow(UnauthorizedException);
    expect(bookmarks.update).not.toHaveBeenCalled();
  });

  it('refuses shared-link authority even when its user ID matches the owner', async () => {
    const shared = { ...authStub.user1, sharedLink: authStub.adminSharedLink.sharedLink };
    await expect(service.get(shared, row.id)).rejects.toThrow(NotFoundException);
    expect(bookmarks.getOwned).not.toHaveBeenCalled();
  });

  it('trashes and restores without changing identity or memberships', async () => {
    bookmarks.setTrashed.mockResolvedValue(row);
    await service.trash(authStub.user1, row.id);
    await service.restore(authStub.user1, row.id);
    expect(bookmarks.setTrashed).toHaveBeenNthCalledWith(1, authStub.user1, row.id, true);
    expect(bookmarks.setTrashed).toHaveBeenNthCalledWith(2, authStub.user1, row.id, false);
  });
});
