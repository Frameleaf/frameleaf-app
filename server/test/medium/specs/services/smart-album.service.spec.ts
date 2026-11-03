import { Kysely } from 'kysely';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { SmartAlbumRepository } from 'src/repositories/smart-album.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { SmartAlbumService } from 'src/services/smart-album.service.js';
import { clearConfigCache } from 'src/utils/config.js';
import { MediumTestContext, newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

// pgvector unit vector: 768 dims, 1.0 at `index`. Cosine similarity between
// two of these is exactly 1 (same index) or 0 (different index).
const unitVector = (index: number) => `[${Array.from({ length: 768 }, (_, i) => (i === index ? 1 : 0)).join(',')}]`;

const setup = (db?: Kysely<DB>) => {
  const { sut, ctx } = newMediumService(SmartAlbumService, {
    database: db || defaultDatabase,
    real: [ConfigRepository, SearchRepository, SmartAlbumRepository, SystemMetadataRepository, UserRepository],
    mock: [LoggingRepository, MachineLearningRepository, MlDestinationRepository, JobRepository],
  });
  ctx
    .getMock(JobRepository)
    .pinDestination.mockImplementation((_workload, destinationId) => Promise.resolve(destinationId));
  ctx.getMock(MachineLearningRepository).clipCacheKey.mockResolvedValue('legacy');
  return { sut, ctx };
};

/**
 * Enable smart albums with a per-test CLIP model name. The model name is part
 * of the service's module-level query-embedding cache key, so a unique name
 * per test keeps cached embeddings from leaking between tests.
 */
const enableSmartAlbums = async (ctx: MediumTestContext, modelName: string) => {
  const config = await ctx.getConfig({ withCache: false });
  config.smartAlbums.enabled = true;
  config.machineLearning.clip.modelName = modelName;
  await ctx.updateConfig(config);
  clearConfigCache();
};

const newSmartAlbumUser = async (ctx: MediumTestContext) => {
  const { user } = await ctx.newUser();
  const repo = ctx.get(SmartAlbumRepository);
  await repo.ensureForUser(user.id, [{ kind: 'travel', name: 'Travel' }]);
  const albumIdByKind = await repo.getAllSmartAlbumIdsForOwner(user.id);
  return { user, travelAlbumId: albumIdByKind.get('travel') as string };
};

const getMemberships = (database: Kysely<DB>, smartAlbumId: string) =>
  database.selectFrom('smart_album_asset').selectAll().where('smartAlbumId', '=', smartAlbumId).execute();

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

beforeEach(() => {
  clearConfigCache();
});

describe(SmartAlbumService.name, () => {
  it('should work', () => {
    const { sut } = setup();
    expect(sut).toBeDefined();
  });

  describe('counts, previews and hiding (FL-522)', () => {
    it('counts and samples what the album holds, previews a rule, and hides it for its owner only', async () => {
      const { ctx } = setup(await getKyselyDB());
      const repo = ctx.get(SmartAlbumRepository);
      const { user, travelAlbumId } = await newSmartAlbumUser(ctx);
      const { asset: beach } = await ctx.newAsset({ ownerId: user.id });
      const { asset: city } = await ctx.newAsset({ ownerId: user.id });
      const { asset: trashed } = await ctx.newAsset({ ownerId: user.id, deletedAt: new Date() });
      await ctx.get(SearchRepository).upsert(beach.id, unitVector(0));
      await ctx.get(SearchRepository).upsert(city.id, unitVector(1));
      for (const asset of [city, trashed]) {
        await repo.addAssetToSmartAlbum(travelAlbumId, asset.id, 'tag');
      }

      const [listed] = await repo.listForOwner(user.id);
      expect(listed).toEqual(expect.objectContaining({ kind: 'travel', hidden: false, count: 1, samples: [city.id] }));

      // A rule that looks like the beach adds it and takes the city out.
      const preview = await repo.previewRule(user.id, 'travel', {
        tags: [],
        embeddings: [unitVector(0)],
        threshold: 0.5,
      });
      expect(preview).toEqual({
        current: 1,
        matched: 1,
        adds: 1,
        removes: 1,
        addSamples: [beach.id],
        removeSamples: [city.id],
      });

      await expect(repo.setHidden(user.id, 'travel', true)).resolves.toBe(true);
      await expect(repo.setHidden(user.id, 'pets', true)).resolves.toBe(false);
      const albumId = (await repo.listForOwner(user.id))[0].albumId;
      await expect(repo.getHiddenAlbumIds(user.id)).resolves.toEqual(new Set([albumId]));
      await expect(repo.getHouseholdCounts()).resolves.toEqual([{ kind: 'travel', count: 1, people: 1, hiddenBy: 1 }]);
    });
  });

  describe('evaluate (CLIP)', () => {
    it('should add a membership with source "clip" when similarity meets the threshold', async () => {
      const { sut, ctx } = setup();
      await enableSmartAlbums(ctx, 'medium-clip-match');
      const { user, travelAlbumId } = await newSmartAlbumUser(ctx);
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.get(SearchRepository).upsert(asset.id, unitVector(0));
      ctx.getMock(MachineLearningRepository).encodeText.mockResolvedValue(unitVector(0)); // cosine 1 >= 0.28

      await sut.evaluate({ assetId: asset.id, ownerId: user.id, tags: [] });

      const rows = await getMemberships(ctx.database, travelAlbumId);
      expect(rows).toEqual([expect.objectContaining({ assetId: asset.id, matchReason: 'clip' })]);
    });

    it('should not add a membership when similarity is below the threshold', async () => {
      const { sut, ctx } = setup();
      await enableSmartAlbums(ctx, 'medium-clip-below');
      const { user, travelAlbumId } = await newSmartAlbumUser(ctx);
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.get(SearchRepository).upsert(asset.id, unitVector(0));
      ctx.getMock(MachineLearningRepository).encodeText.mockResolvedValue(unitVector(1)); // cosine 0 < 0.28

      await sut.evaluate({ assetId: asset.id, ownerId: user.id, tags: [] });

      await expect(getMemberships(ctx.database, travelAlbumId)).resolves.toEqual([]);
    });

    it('should remove a stale clip membership when the embedding changes', async () => {
      const { sut, ctx } = setup();
      await enableSmartAlbums(ctx, 'medium-clip-stale');
      const { user, travelAlbumId } = await newSmartAlbumUser(ctx);
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.get(SearchRepository).upsert(asset.id, unitVector(0));
      ctx.getMock(MachineLearningRepository).encodeText.mockResolvedValue(unitVector(0));

      await sut.evaluate({ assetId: asset.id, ownerId: user.id, tags: [] });
      await expect(getMemberships(ctx.database, travelAlbumId)).resolves.toHaveLength(1);

      // Embedding is re-generated and no longer resembles any travel query.
      await ctx.get(SearchRepository).upsert(asset.id, unitVector(1));

      await sut.evaluate({ assetId: asset.id, ownerId: user.id, tags: [] });

      await expect(getMemberships(ctx.database, travelAlbumId)).resolves.toEqual([]);
      // The album_asset mirror must be cleaned up too.
      const mirror = await ctx.database.selectFrom('album_asset').selectAll().where('assetId', '=', asset.id).execute();
      expect(mirror).toEqual([]);
    });

    it('should keep tag matching intact when ML is unavailable', async () => {
      const { sut, ctx } = setup();
      await enableSmartAlbums(ctx, 'medium-clip-ml-down');
      const { user, travelAlbumId } = await newSmartAlbumUser(ctx);
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.get(SearchRepository).upsert(asset.id, unitVector(0));
      ctx.getMock(MachineLearningRepository).encodeText.mockRejectedValue(new Error('ml down'));

      await expect(sut.evaluate({ assetId: asset.id, ownerId: user.id, tags: ['beach'] })).resolves.not.toThrow();

      const rows = await getMemberships(ctx.database, travelAlbumId);
      expect(rows).toEqual([expect.objectContaining({ assetId: asset.id, matchReason: 'tag' })]);
      expect(ctx.getMock(LoggingRepository).warn).toHaveBeenCalled();
    });

    it('should upgrade a tag membership to "both" when CLIP also matches', async () => {
      const { sut, ctx } = setup();
      await enableSmartAlbums(ctx, 'medium-clip-both');
      const { user, travelAlbumId } = await newSmartAlbumUser(ctx);
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.get(SearchRepository).upsert(asset.id, unitVector(0));
      ctx.getMock(MachineLearningRepository).encodeText.mockResolvedValue(unitVector(0));

      await sut.evaluate({ assetId: asset.id, ownerId: user.id, tags: ['beach'] });

      const rows = await getMemberships(ctx.database, travelAlbumId);
      expect(rows).toEqual([expect.objectContaining({ assetId: asset.id, matchReason: 'both' })]);
    });

    it('should skip CLIP matching for an asset without a smart_search embedding', async () => {
      const { sut, ctx } = setup();
      await enableSmartAlbums(ctx, 'medium-clip-no-embedding');
      const { user, travelAlbumId } = await newSmartAlbumUser(ctx);
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      ctx.getMock(MachineLearningRepository).encodeText.mockResolvedValue(unitVector(0));

      await sut.evaluate({ assetId: asset.id, ownerId: user.id, tags: [] });

      await expect(getMemberships(ctx.database, travelAlbumId)).resolves.toEqual([]);
      expect(ctx.getMock(MachineLearningRepository).encodeText).not.toHaveBeenCalled();
    });
  });
});
