import { mapAsset } from 'src/dtos/asset-response.dto.js';
import { ViewService } from 'src/services/view.service.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { getForAsset } from 'test/mappers.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(ViewService.name, () => {
  let sut: ViewService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(ViewService));
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('getUniqueOriginalPaths', () => {
    it('should return unique original paths', async () => {
      const mockPaths = ['path1', 'path2', 'path3'];
      mocks.view.getUniqueOriginalPaths.mockResolvedValue(mockPaths);

      const result = await sut.getUniqueOriginalPaths(authStub.admin);

      expect(result).toEqual(mockPaths);
      expect(mocks.view.getUniqueOriginalPaths).toHaveBeenCalledWith(authStub.admin.user.id, {});
    });

    it('should leave out content hidden from a locked session (FL-46)', async () => {
      mocks.view.getUniqueOriginalPaths.mockResolvedValue([]);
      const hiddenContent = {
        userId: authStub.admin.user.id,
        includeNsfw: true,
        tagIds: [],
        personIds: [],
        petIds: [],
        scope: 'owned' as const,
      };

      await sut.getUniqueOriginalPaths({ ...authStub.admin, hiddenContent });

      expect(mocks.view.getUniqueOriginalPaths).toHaveBeenCalledWith(authStub.admin.user.id, { hiddenContent });
    });
  });

  describe('getFolderSummary', () => {
    it("should return each folder's direct count and size (FL-46)", async () => {
      const rows = [
        { path: '/photos', count: 2, size: 2048 },
        { path: '/photos/2026', count: 1, size: 512 },
      ];
      mocks.view.getFolderSummary.mockResolvedValue(rows);

      await expect(sut.getFolderSummary(authStub.admin)).resolves.toEqual(rows);
      expect(mocks.view.getFolderSummary).toHaveBeenCalledWith(authStub.admin.user.id, {});
    });

    it('should hide NSFW items from the summary when the account hides them', async () => {
      mocks.view.getFolderSummary.mockResolvedValue([]);

      await sut.getFolderSummary({ ...authStub.admin, hideNsfwAssets: true });

      expect(mocks.view.getFolderSummary).toHaveBeenCalledWith(authStub.admin.user.id, { excludeNsfw: true });
    });
  });

  describe('getAssetsByOriginalPath', () => {
    it('should return assets by original path', async () => {
      const path = '/asset';

      const asset1 = AssetFactory.create({ originalPath: '/asset/path1' });
      const asset2 = AssetFactory.create({ originalPath: '/asset/path2' });

      const mockAssets = [asset1, asset2];

      const mockAssetReponseDto = mockAssets.map((asset) => mapAsset(getForAsset(asset), { auth: authStub.admin }));

      mocks.view.getAssetsByOriginalPath.mockResolvedValue(mockAssets as any);

      const result = await sut.getAssetsByOriginalPath(authStub.admin, path);
      expect(result).toEqual(mockAssetReponseDto);
      expect(mocks.view.getAssetsByOriginalPath).toHaveBeenCalledWith(authStub.admin.user.id, path, {});
      await expect(mocks.view.getAssetsByOriginalPath(authStub.admin.user.id, path)).resolves.toEqual(mockAssets);
    });
  });
});
