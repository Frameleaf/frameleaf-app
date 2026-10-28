import { randomUUID } from 'node:crypto';
import { mapAsset } from 'src/dtos/asset-response.dto.js';
import { BookmarkResponseDto } from 'src/dtos/bookmark.dto.js';
import { LibraryItemSearchDto } from 'src/dtos/library-search.dto.js';
import { LibraryScope, Permission } from 'src/enum.js';
import { LibraryItemService } from 'src/services/library-item.service.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { getForAsset } from 'test/mappers.js';
import { getMocks } from 'test/utils.js';

const auth = { ...authStub.user1, user: { ...authStub.user1.user, id: randomUUID() } };
const asset = getForAsset(AssetFactory.create({ ownerId: auth.user.id, libraryScope: LibraryScope.Design }));
const bookmark = BookmarkResponseDto.schema.parse({
  id: randomUUID(),
  ownerId: auth.user.id,
  url: 'https://example.org',
  title: 'Reference',
  note: null,
  previewAssetId: null,
  libraryScope: 'design',
  isArchived: false,
  isLocked: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  deletedAt: null,
  updateId: randomUUID(),
});
const setup = () => {
  const candidates = [
    { kind: 'asset', id: asset.id, dateKey: '2026-10-28T12:00:00.123456Z', rank: 0 },
    { kind: 'bookmark', id: bookmark.id, dateKey: '2026-10-28T12:00:00.123456Z', rank: 0 },
  ];
  const repo = {
    searchLibrary: vi.fn().mockResolvedValue({ count: 2, candidates }),
    getLibraryAssets: vi.fn().mockResolvedValue([asset]),
  };
  const searches = {
    resolveSearchScopeV3: vi.fn().mockImplementation((_actor, request) =>
      Promise.resolve({
        filter: request.filter,
        scope: { userIds: [auth.user.id], lockedOwnerId: auth.user.id, viewingUserId: auth.user.id },
      }),
    ),
    searchSmart: vi.fn().mockResolvedValue({ assets: { items: [mapAsset(asset, { auth })] } }),
    searchSmartStatistics: vi.fn().mockResolvedValue({ total: 1000, capped: true }),
  };
  const bookmarks = { getForSearch: vi.fn().mockResolvedValue([bookmark]) };
  const mocks = getMocks();
  mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
  const service = new LibraryItemService(repo as never, bookmarks as never, searches as never, mocks.access as never);
  return { service, repo, searches, bookmarks, candidates };
};

describe('shared mixed-item search boundary', () => {
  it('keeps kind identity and a query-bound next cursor while counting the complete matched universe', async () => {
    const { service } = setup();
    const response = await service.search(
      auth,
      LibraryItemSearchDto.schema.parse({ filter: { libraryScope: 'design' }, limit: 1 }),
    );
    expect(response).toEqual({
      items: [{ kind: 'asset', asset: expect.objectContaining({ id: asset.id }) }],
      count: 2,
      countCapped: false,
      nextCursor: expect.any(String),
    });
  });
  it('rejects cursor reuse after changing query text', async () => {
    const { service, repo } = setup();
    const response = await service.search(auth, LibraryItemSearchDto.schema.parse({ limit: 1 }));
    repo.searchLibrary.mockClear();
    await expect(
      service.search(auth, LibraryItemSearchDto.schema.parse({ query: 'changed', cursor: response.nextCursor })),
    ).rejects.toThrow('Search changed');
    expect(repo.searchLibrary).not.toHaveBeenCalled();
  });
  it('does not list or count bookmarks with an asset-only API key', async () => {
    const { service, repo, bookmarks } = setup();
    repo.searchLibrary.mockResolvedValue({
      count: 1,
      candidates: [{ kind: 'asset', id: asset.id, dateKey: '2026-10-28T12:00:00.123456Z', rank: 0 }],
    });
    const keyAuth = { ...auth, apiKey: { id: 'key', permissions: [Permission.AssetRead] } };
    expect((await service.search(keyAuth, LibraryItemSearchDto.schema.parse({}))).count).toBe(1);
    expect(repo.searchLibrary).toHaveBeenCalledWith(keyAuth, expect.anything(), expect.anything(), false, undefined);
    expect(bookmarks.getForSearch).not.toHaveBeenCalled();
  });
  it('refuses a shared link before running the signed-in search adapter', async () => {
    const { service, repo } = setup();
    await expect(
      service.search(
        { ...auth, sharedLink: authStub.adminSharedLink.sharedLink },
        LibraryItemSearchDto.schema.parse({}),
      ),
    ).rejects.toThrow();
    expect(repo.searchLibrary).not.toHaveBeenCalled();
  });
  it('exposes the semantic candidate cap honestly and applies the full color/scope filter before ranking', async () => {
    const { service, searches } = setup();
    const request = LibraryItemSearchDto.schema.parse({
      mode: 'smart',
      query: 'green packaging',
      filter: { libraryScope: 'design', color: { hex: '#609060' } },
    });
    const result = await service.search(auth, request);
    expect(result.count).toBe(1);
    expect(result.countCapped).toBe(true);
    expect(searches.searchSmart).toHaveBeenCalledWith(
      auth,
      expect.objectContaining({ filter: request.filter, query: request.query, size: 1000 }),
    );
    expect(result.items).toEqual([{ kind: 'asset', asset: mapAsset(asset, { auth }) }]);
  });
  it('rejects a semantic cursor if the ranked universe changes between pages', async () => {
    const { service, searches } = setup();
    const other = { ...mapAsset(asset, { auth }), id: randomUUID() };
    searches.searchSmart.mockResolvedValue({ assets: { items: [mapAsset(asset, { auth }), other] } });
    const request = LibraryItemSearchDto.schema.parse({ mode: 'smart', query: 'packaging', limit: 1 });
    const page = await service.search(auth, request);
    searches.searchSmart.mockResolvedValue({ assets: { items: [other, mapAsset(asset, { auth })] } });
    await expect(service.search(auth, { ...request, cursor: page.nextCursor! })).rejects.toThrow(
      'Semantic results changed',
    );
  });
});
