import { Kysely } from 'kysely';
import { AssetMetadataKey } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DownloadRepository } from 'src/repositories/download.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { DownloadService } from 'src/services/download.service.js';
import { upsertTags } from 'src/utils/tag.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getActiveForkKyselyDB as getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  return newMediumService(DownloadService, {
    database: db || defaultDatabase,
    real: [AccessRepository, AlbumRepository, AssetRepository, DownloadRepository, TagRepository, UserRepository],
    mock: [LoggingRepository, StorageRepository],
  });
};

const nsfwMetadata = (isNsfw: boolean, review?: { action: string; isNsfw: boolean }) => ({
  nsfwDetection: {
    status: 'success',
    result: { isNsfw, score: isNsfw ? 0.95 : 0.05, labels: { explicit: isNsfw ? 0.95 : 0.05 } },
    ...(review && { review }),
  },
});

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(DownloadService.name, () => {
  describe('getDownloadInfo', () => {
    it('should use private NSFW review state when planning album and timeline downloads', async () => {
      const { sut, ctx } = setup(await getKyselyDB());
      const { user } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: user.id });

      const { asset: visible } = await ctx.newAsset({ ownerId: user.id });
      const { asset: unreviewedNsfw } = await ctx.newAsset({ ownerId: user.id });
      const { asset: markedSafe } = await ctx.newAsset({ ownerId: user.id });
      const { asset: markedNsfw } = await ctx.newAsset({ ownerId: user.id });
      const { asset: tagOnly } = await ctx.newAsset({ ownerId: user.id });

      const assetIds = [visible.id, unreviewedNsfw.id, markedSafe.id, markedNsfw.id, tagOnly.id];
      for (const assetId of assetIds) {
        await ctx.newExif({ assetId, fileSizeInByte: 1000 });
        await ctx.newAlbumAsset({ albumId: album.id, assetId });
      }

      await ctx.newMetadata({
        assetId: unreviewedNsfw.id,
        key: AssetMetadataKey.MlEnrichment,
        value: nsfwMetadata(true),
      });
      await ctx.newMetadata({
        assetId: markedSafe.id,
        key: AssetMetadataKey.MlEnrichment,
        value: nsfwMetadata(true, { action: 'marked-safe', isNsfw: false }),
      });
      await ctx.newMetadata({
        assetId: markedNsfw.id,
        key: AssetMetadataKey.MlEnrichment,
        value: nsfwMetadata(false, { action: 'marked-nsfw', isNsfw: true }),
      });

      const [visibleNsfwTag] = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['nsfw'] });
      await ctx.newTagAsset({ tagIds: [visibleNsfwTag.id], assetIds: [tagOnly.id] });

      const hiddenAuth = { ...factory.auth({ user: { id: user.id } }), hideNsfwAssets: true };
      const albumDownload = await sut.getDownloadInfo(hiddenAuth, { albumId: album.id });
      const timelineDownload = await sut.getDownloadInfo(hiddenAuth, { userId: user.id });

      for (const response of [albumDownload, timelineDownload]) {
        const plannedAssetIds = response.archives.flatMap(({ assetIds }) => assetIds);
        expect(plannedAssetIds).toEqual(expect.arrayContaining([visible.id, markedSafe.id, tagOnly.id]));
        expect(plannedAssetIds).not.toEqual(expect.arrayContaining([unreviewedNsfw.id, markedNsfw.id]));
        expect(response.totalSize).toBe(3000);
      }

      const unlockedDownload = await sut.getDownloadInfo(factory.auth({ user: { id: user.id } }), {
        albumId: album.id,
      });
      expect(unlockedDownload.archives.flatMap(({ assetIds }) => assetIds)).toEqual(expect.arrayContaining(assetIds));
      expect(unlockedDownload.totalSize).toBe(5000);
    });
  });
});
