import { vi } from 'vitest';
import type { QueueClaim, QueueExecution } from 'src/queue/types.js';
import { defaults } from 'src/config.js';
import { JobName, JobStatus } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { SmartAlbumService } from 'src/services/smart-album.service.js';
import { newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

// Build an albumIdByKind map for the given kinds.
const albumMap = (entries: Record<string, string>) => new Map(Object.entries(entries));

// pgvector-style unit vector: 768 dims, 1.0 at `index`, 0 elsewhere. Two such
// vectors have cosine similarity 1 (same index) or 0 (different index), which
// makes threshold assertions exact.
const unitVector = (index: number) => `[${Array.from({ length: 768 }, (_, i) => (i === index ? 1 : 0)).join(',')}]`;

// Enable smart albums with a per-test CLIP model name — the model name is part
// of the module-level query embedding cache key, so a unique name per test
// keeps cached embeddings from leaking between tests.
const withClipConfig = (mocks: ServiceMocks, modelName: string) =>
  mocks.systemMetadata.get.mockResolvedValue({
    smartAlbums: { enabled: true },
    machineLearning: { clip: { modelName } },
  });

describe(SmartAlbumService.name, () => {
  let sut: SmartAlbumService;
  let mocks: ServiceMocks;

  const ownerId = newUuid();
  const assetId = newUuid();
  const travelAlbumId = newUuid();
  const foodAlbumId = newUuid();
  const natureAlbumId = newUuid();

  beforeEach(() => {
    ({ sut, mocks } = newTestService(SmartAlbumService));

    // Default: smartAlbums enabled, all built-in kinds enabled (relying on
    // SystemConfig defaults loaded via getConfig).
    mocks.systemMetadata.get.mockResolvedValue({
      smartAlbums: { enabled: true },
    });

    // Default repo state: no smart albums bootstrapped, no exclusions, no
    // existing memberships.
    mocks.smartAlbum.getAllSmartAlbumIdsForOwner.mockResolvedValue(new Map());
    mocks.smartAlbum.getExcludedSmartAlbumIds.mockResolvedValue(new Set());
    mocks.smartAlbum.getMatchingKinds.mockResolvedValue([]);
    mocks.smartAlbum.isExcluded.mockResolvedValue(false);
    mocks.smartAlbum.getSmartAlbumIdForOwnerAndKind.mockResolvedValue(null);
    mocks.smartAlbum.addAssetToSmartAlbum.mockResolvedValue();
    mocks.smartAlbum.removeAssetFromSmartAlbum.mockResolvedValue();
  });

  describe('evaluate', () => {
    it('should add asset to matching kinds based on tags', async () => {
      mocks.smartAlbum.getAllSmartAlbumIdsForOwner.mockResolvedValue(albumMap({ travel: travelAlbumId }));

      await sut.evaluate({ assetId, ownerId, tags: ['beach', 'sunset'] });

      expect(mocks.smartAlbum.addAssetToSmartAlbum).toHaveBeenCalledWith(travelAlbumId, assetId, 'tag');
      expect(mocks.smartAlbum.addAssetToSmartAlbum).toHaveBeenCalledTimes(1);
    });

    it('should skip when master smartAlbums.enabled is false', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        smartAlbums: { enabled: false },
      });

      await sut.evaluate({ assetId, ownerId, tags: ['beach', 'airport'] });

      expect(mocks.smartAlbum.getAllSmartAlbumIdsForOwner).not.toHaveBeenCalled();
      expect(mocks.smartAlbum.getMatchingKinds).not.toHaveBeenCalled();
      expect(mocks.smartAlbum.addAssetToSmartAlbum).not.toHaveBeenCalled();
    });

    it('should skip kinds whose builtIn[kind].enabled is false', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        smartAlbums: {
          enabled: true,
          builtIn: { travel: { enabled: false } },
        },
      });
      mocks.smartAlbum.getAllSmartAlbumIdsForOwner.mockResolvedValue(albumMap({ travel: travelAlbumId }));

      await sut.evaluate({ assetId, ownerId, tags: ['beach', 'airport'] });

      // travel is disabled, no other kinds have a bootstrapped album
      expect(mocks.smartAlbum.addAssetToSmartAlbum).not.toHaveBeenCalled();
    });

    it('should skip when exclusion exists for the asset in that smart album', async () => {
      mocks.smartAlbum.getAllSmartAlbumIdsForOwner.mockResolvedValue(albumMap({ travel: travelAlbumId }));
      mocks.smartAlbum.getExcludedSmartAlbumIds.mockResolvedValue(new Set([travelAlbumId]));

      await sut.evaluate({ assetId, ownerId, tags: ['beach', 'airport'] });

      expect(mocks.smartAlbum.addAssetToSmartAlbum).not.toHaveBeenCalled();
    });

    it('should remove asset from previously-matched kinds when tags no longer match', async () => {
      // Asset is currently in 'travel'.
      mocks.smartAlbum.getMatchingKinds.mockResolvedValue(['travel']);
      mocks.smartAlbum.getAllSmartAlbumIdsForOwner.mockResolvedValue(albumMap({ travel: travelAlbumId }));

      // 'sunset' matches nature, not travel, and nature has no bootstrapped album.
      await sut.evaluate({ assetId, ownerId, tags: ['sunset'] });

      expect(mocks.smartAlbum.removeAssetFromSmartAlbum).toHaveBeenCalledWith(travelAlbumId, assetId);
    });

    it('should be idempotent when called twice (relies on addAssetToSmartAlbum ON CONFLICT)', async () => {
      mocks.smartAlbum.getAllSmartAlbumIdsForOwner.mockResolvedValue(albumMap({ food: foodAlbumId }));

      await sut.evaluate({ assetId, ownerId, tags: ['food', 'meal'] });
      await sut.evaluate({ assetId, ownerId, tags: ['food', 'meal'] });

      // addAssetToSmartAlbum called twice — repo layer handles ON CONFLICT DO NOTHING
      expect(mocks.smartAlbum.addAssetToSmartAlbum).toHaveBeenCalledTimes(2);
    });

    it('should match case-insensitively (tag "Beach" matches trigger "beach")', async () => {
      mocks.smartAlbum.getAllSmartAlbumIdsForOwner.mockResolvedValue(albumMap({ travel: travelAlbumId }));

      // Tag is mixed-case, trigger in config is lowercase
      await sut.evaluate({ assetId, ownerId, tags: ['Beach', 'Sunset'] });

      expect(mocks.smartAlbum.addAssetToSmartAlbum).toHaveBeenCalledWith(travelAlbumId, assetId, 'tag');
    });

    it('should skip when no kinds have a bootstrapped album (user not yet bootstrapped)', async () => {
      mocks.smartAlbum.getAllSmartAlbumIdsForOwner.mockResolvedValue(new Map());

      await sut.evaluate({ assetId, ownerId, tags: ['beach', 'airport', 'food', 'meal', 'dog', 'cat'] });

      expect(mocks.smartAlbum.addAssetToSmartAlbum).not.toHaveBeenCalled();
    });

    it('should produce no false matches when the asset has no embedding (only tag matching fires)', async () => {
      mocks.smartAlbum.getAllSmartAlbumIdsForOwner.mockResolvedValue(albumMap({ travel: travelAlbumId }));
      mocks.search.getEmbedding.mockResolvedValue(undefined);

      // Empty tags — no tag matches; CLIP matching has no embedding to score
      await sut.evaluate({ assetId, ownerId, tags: [] });

      expect(mocks.smartAlbum.addAssetToSmartAlbum).not.toHaveBeenCalled();
    });

    it('should match multiple kinds when tags overlap multiple triggers', async () => {
      mocks.smartAlbum.getAllSmartAlbumIdsForOwner.mockResolvedValue(
        albumMap({ travel: travelAlbumId, food: foodAlbumId }),
      );

      // 'beach' matches travel, 'food' matches food
      await sut.evaluate({ assetId, ownerId, tags: ['beach', 'food'] });

      expect(mocks.smartAlbum.addAssetToSmartAlbum).toHaveBeenCalledWith(travelAlbumId, assetId, 'tag');
      expect(mocks.smartAlbum.addAssetToSmartAlbum).toHaveBeenCalledWith(foodAlbumId, assetId, 'tag');
    });

    it('keeps an exclusion added after matching but before publication', async () => {
      mocks.smartAlbum.getAllSmartAlbumIdsForOwner.mockResolvedValue(albumMap({ travel: travelAlbumId }));
      mocks.smartAlbum.getExcludedSmartAlbumIds
        .mockResolvedValueOnce(new Set())
        .mockResolvedValueOnce(new Set([travelAlbumId]));

      await sut.evaluate({ assetId, ownerId, tags: ['beach'] });

      expect(mocks.smartAlbum.getExcludedSmartAlbumIds).toHaveBeenCalledTimes(2);
      expect(mocks.smartAlbum.addAssetToSmartAlbum).not.toHaveBeenCalled();
    });

    it('batches candidate lookups and rechecks each matching album before publication', async () => {
      mocks.smartAlbum.getAllSmartAlbumIdsForOwner.mockResolvedValue(
        albumMap({ travel: travelAlbumId, food: foodAlbumId, nature: natureAlbumId }),
      );

      await sut.evaluate({ assetId, ownerId, tags: ['beach'] });

      expect(mocks.smartAlbum.getAllSmartAlbumIdsForOwner).toHaveBeenCalledTimes(1);
      expect(mocks.smartAlbum.getExcludedSmartAlbumIds).toHaveBeenCalledTimes(2);
      expect(mocks.smartAlbum.getExcludedSmartAlbumIds).toHaveBeenNthCalledWith(1, assetId, [
        travelAlbumId,
        foodAlbumId,
        natureAlbumId,
      ]);
      expect(mocks.smartAlbum.getExcludedSmartAlbumIds).toHaveBeenNthCalledWith(2, assetId, [travelAlbumId]);
      // Per-kind isExcluded MUST NOT be called; we batched it.
      expect(mocks.smartAlbum.isExcluded).not.toHaveBeenCalled();
      // Per-kind getSmartAlbumIdForOwnerAndKind MUST NOT be called either.
      expect(mocks.smartAlbum.getSmartAlbumIdForOwnerAndKind).not.toHaveBeenCalled();
    });
  });

  describe('evaluate (CLIP)', () => {
    it('should add asset with source "clip" when similarity meets the threshold', async () => {
      withClipConfig(mocks, 'clip-model-match');
      mocks.smartAlbum.getAllSmartAlbumIdsForOwner.mockResolvedValue(albumMap({ travel: travelAlbumId }));
      mocks.search.getEmbedding.mockResolvedValue({ assetId, embedding: unitVector(0) } as never);
      mocks.machineLearning.encodeText.mockResolvedValue(unitVector(0)); // cosine = 1 >= 0.28

      await sut.evaluate({ assetId, ownerId, tags: [] });

      expect(mocks.smartAlbum.addAssetToSmartAlbum).toHaveBeenCalledWith(travelAlbumId, assetId, 'clip');
      expect(mocks.machineLearning.encodeText).toHaveBeenCalledWith(
        expect.objectContaining({ destinationId: expect.any(String), workload: expect.any(String) }),
        'vacation travel landscape',
        {
          modelName: 'clip-model-match',
        },
      );
    });

    it('should not add asset when similarity is below the threshold', async () => {
      withClipConfig(mocks, 'clip-model-below');
      mocks.smartAlbum.getAllSmartAlbumIdsForOwner.mockResolvedValue(albumMap({ travel: travelAlbumId }));
      mocks.search.getEmbedding.mockResolvedValue({ assetId, embedding: unitVector(0) } as never);
      mocks.machineLearning.encodeText.mockResolvedValue(unitVector(1)); // cosine = 0 < 0.28

      await sut.evaluate({ assetId, ownerId, tags: [] });

      expect(mocks.smartAlbum.addAssetToSmartAlbum).not.toHaveBeenCalled();
    });

    it('should record source "both" when tag and CLIP both match', async () => {
      withClipConfig(mocks, 'clip-model-both');
      mocks.smartAlbum.getAllSmartAlbumIdsForOwner.mockResolvedValue(albumMap({ travel: travelAlbumId }));
      mocks.search.getEmbedding.mockResolvedValue({ assetId, embedding: unitVector(0) } as never);
      mocks.machineLearning.encodeText.mockResolvedValue(unitVector(0));

      await sut.evaluate({ assetId, ownerId, tags: ['beach'] });

      expect(mocks.smartAlbum.addAssetToSmartAlbum).toHaveBeenCalledWith(travelAlbumId, assetId, 'both');
    });

    it('should remove a stale clip membership when the embedding no longer matches', async () => {
      withClipConfig(mocks, 'clip-model-stale');
      mocks.smartAlbum.getMatchingKinds.mockResolvedValue(['travel']);
      mocks.smartAlbum.getAllSmartAlbumIdsForOwner.mockResolvedValue(albumMap({ travel: travelAlbumId }));
      mocks.search.getEmbedding.mockResolvedValue({ assetId, embedding: unitVector(0) } as never);
      mocks.machineLearning.encodeText.mockResolvedValue(unitVector(1)); // below threshold now

      await sut.evaluate({ assetId, ownerId, tags: [] });

      expect(mocks.smartAlbum.removeAssetFromSmartAlbum).toHaveBeenCalledWith(travelAlbumId, assetId);
    });

    it('should keep tag matching intact and log a warning when ML encoding fails', async () => {
      withClipConfig(mocks, 'clip-model-ml-down');
      mocks.smartAlbum.getAllSmartAlbumIdsForOwner.mockResolvedValue(albumMap({ travel: travelAlbumId }));
      mocks.search.getEmbedding.mockResolvedValue({ assetId, embedding: unitVector(0) } as never);
      mocks.machineLearning.encodeText.mockRejectedValue(new Error('ml down'));

      await expect(sut.evaluate({ assetId, ownerId, tags: ['beach'] })).resolves.not.toThrow();

      expect(mocks.smartAlbum.addAssetToSmartAlbum).toHaveBeenCalledWith(travelAlbumId, assetId, 'tag');
      expect(mocks.logger.warn).toHaveBeenCalled();
    });

    it('should not add anything when ML fails and no tag matches', async () => {
      withClipConfig(mocks, 'clip-model-ml-down-2');
      mocks.smartAlbum.getAllSmartAlbumIdsForOwner.mockResolvedValue(albumMap({ travel: travelAlbumId }));
      mocks.search.getEmbedding.mockResolvedValue({ assetId, embedding: unitVector(0) } as never);
      mocks.machineLearning.encodeText.mockRejectedValue(new Error('ml down'));

      await expect(sut.evaluate({ assetId, ownerId, tags: [] })).resolves.not.toThrow();

      expect(mocks.smartAlbum.addAssetToSmartAlbum).not.toHaveBeenCalled();
    });

    it('should cache query embeddings across evaluations (one encodeText per model+query)', async () => {
      withClipConfig(mocks, 'clip-model-cache');
      mocks.smartAlbum.getAllSmartAlbumIdsForOwner.mockResolvedValue(albumMap({ travel: travelAlbumId }));
      mocks.search.getEmbedding.mockResolvedValue({ assetId, embedding: unitVector(0) } as never);
      mocks.machineLearning.encodeText.mockResolvedValue(unitVector(0));

      await sut.evaluate({ assetId, ownerId, tags: [] });
      await sut.evaluate({ assetId, ownerId, tags: [] });

      // travel matches on its FIRST query both times — exactly one encode call.
      expect(mocks.machineLearning.encodeText).toHaveBeenCalledTimes(1);
    });

    it('should skip CLIP matching entirely when smart search is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        smartAlbums: { enabled: true },
        machineLearning: { enabled: false },
      });
      mocks.smartAlbum.getAllSmartAlbumIdsForOwner.mockResolvedValue(albumMap({ travel: travelAlbumId }));

      await sut.evaluate({ assetId, ownerId, tags: ['beach'] });

      expect(mocks.search.getEmbedding).not.toHaveBeenCalled();
      expect(mocks.machineLearning.encodeText).not.toHaveBeenCalled();
      expect(mocks.smartAlbum.addAssetToSmartAlbum).toHaveBeenCalledWith(travelAlbumId, assetId, 'tag');
    });
  });

  describe('ensureBuiltInAlbumsForUser', () => {
    it('should call ensureForUser with all 6 kinds and their names', async () => {
      mocks.smartAlbum.ensureForUser.mockResolvedValue();

      await sut.ensureBuiltInAlbumsForUser(ownerId);

      expect(mocks.smartAlbum.ensureForUser).toHaveBeenCalledWith(
        ownerId,
        expect.arrayContaining([
          expect.objectContaining({ kind: 'travel' }),
          expect.objectContaining({ kind: 'documents' }),
          expect.objectContaining({ kind: 'screenshots' }),
          expect.objectContaining({ kind: 'food' }),
          expect.objectContaining({ kind: 'pets' }),
          expect.objectContaining({ kind: 'nature' }),
        ]),
      );
      const [, kinds] = (mocks.smartAlbum.ensureForUser as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(kinds).toHaveLength(6);
    });

    it('should not call ensureForUser when smartAlbums.enabled is false', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        smartAlbums: { enabled: false },
      });

      await sut.ensureBuiltInAlbumsForUser(ownerId);

      expect(mocks.smartAlbum.ensureForUser).not.toHaveBeenCalled();
    });
  });

  describe('handleReevaluateAll', () => {
    it('should return Skipped when smartAlbums.enabled is false', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        smartAlbums: { enabled: false },
      });

      const result = await sut.handleReevaluateAll({});

      expect(result).toBe(JobStatus.Skipped);
      expect(mocks.assetJob.selectionForSmartAlbumReevaluation).not.toHaveBeenCalled();
      expect(mocks.job.queueSelection).not.toHaveBeenCalled();
    });

    it.each([undefined, 'food'] as const)(
      'should freeze per-asset work for kind %s without evaluating inline',
      async (kind) => {
        const selection = {} as never;
        mocks.assetJob.selectionForSmartAlbumReevaluation.mockReturnValue(selection);
        const result = await sut.handleReevaluateAll({});
        expect(result).toBe(JobStatus.Success);
        expect(mocks.job.queueSelection).toHaveBeenCalledWith(JobName.SmartAlbumReevaluate, selection, {});
        expect(mocks.smartAlbum.getAllSmartAlbumIdsForOwner).not.toHaveBeenCalled();
        if (kind) {
          await sut.handleReevaluateAll({ kind });
          expect(mocks.job.queueSelection).toHaveBeenLastCalledWith(JobName.SmartAlbumReevaluate, selection, { kind });
        }
      },
    );

    it('should propagate a failed snapshot instead of recording producer success', async () => {
      const selection = {} as never;
      mocks.assetJob.selectionForSmartAlbumReevaluation.mockReturnValue(selection);
      mocks.job.queueSelection.mockRejectedValue(new Error('snapshot unavailable'));
      await expect(sut.handleReevaluateAll({})).rejects.toThrow('snapshot unavailable');
      expect(mocks.job.queueSelection).toHaveBeenCalledWith(JobName.SmartAlbumReevaluate, selection, {});
    });

    it('should skip with unknown kind', async () => {
      const result = await sut.handleReevaluateAll({ kind: 'not-a-real-kind' as never });
      expect(result).toBe(JobStatus.Skipped);
      expect(mocks.assetJob.selectionForSmartAlbumReevaluation).not.toHaveBeenCalled();
      expect(mocks.job.queueSelection).not.toHaveBeenCalled();
    });
  });

  describe('handleReevaluate', () => {
    beforeEach(() => {
      mocks.assetJob.getForSmartAlbumReevaluation.mockResolvedValue({ id: assetId, ownerId, tags: ['food', 'beach'] });
    });

    it('should pass onlyKind to evaluate when data.kind is set', async () => {
      mocks.smartAlbum.getAllSmartAlbumIdsForOwner.mockResolvedValue(
        albumMap({ food: foodAlbumId, travel: travelAlbumId }),
      );

      const result = await sut.handleReevaluate({ id: assetId, kind: 'food' });

      expect(result).toBe(JobStatus.Success);
      // Only the food album should have the asset added — travel must NOT,
      // even though "beach" would normally match travel.
      expect(mocks.smartAlbum.addAssetToSmartAlbum).toHaveBeenCalledWith(foodAlbumId, assetId, 'tag');
      expect(mocks.smartAlbum.addAssetToSmartAlbum).not.toHaveBeenCalledWith(travelAlbumId, assetId, 'tag');
    });

    it('should not strip non-scoped memberships when scoped to a single kind', async () => {
      mocks.assetJob.getForSmartAlbumReevaluation.mockResolvedValue({ id: assetId, ownerId, tags: ['screenshot'] });
      // Asset is in travel and food. Re-evaluate kind=food only.
      mocks.smartAlbum.getMatchingKinds.mockResolvedValue(['travel', 'food']);
      mocks.smartAlbum.getAllSmartAlbumIdsForOwner.mockResolvedValue(
        albumMap({ travel: travelAlbumId, food: foodAlbumId }),
      );

      await sut.handleReevaluate({ id: assetId, kind: 'food' });

      // food no longer matches and should be removed.
      expect(mocks.smartAlbum.removeAssetFromSmartAlbum).toHaveBeenCalledWith(foodAlbumId, assetId);
      // travel was NOT scoped — it must NOT be touched.
      expect(mocks.smartAlbum.removeAssetFromSmartAlbum).not.toHaveBeenCalledWith(travelAlbumId, assetId);
    });

    it('should skip with unknown kind', async () => {
      const result = await sut.handleReevaluate({ id: assetId, kind: 'not-a-real-kind' as never });

      expect(result).toBe(JobStatus.Skipped);
      expect(mocks.assetJob.getForSmartAlbumReevaluation).not.toHaveBeenCalled();
    });

    it('should propagate an item error and allow an unrelated item to execute', async () => {
      // First call throws, second succeeds
      mocks.smartAlbum.getAllSmartAlbumIdsForOwner
        .mockRejectedValueOnce(new Error('db error'))
        .mockResolvedValueOnce(new Map());

      await expect(sut.handleReevaluate({ id: assetId })).rejects.toThrow('db error');
      await expect(sut.handleReevaluate({ id: newUuid() })).resolves.toBe(JobStatus.Success);
      expect(mocks.logger.warn).not.toHaveBeenCalled();
      expect(mocks.smartAlbum.getAllSmartAlbumIdsForOwner).toHaveBeenCalledTimes(2);
    });

    it('should skip a deleted or ineligible frozen ID', async () => {
      mocks.assetJob.getForSmartAlbumReevaluation.mockResolvedValue(undefined);
      await expect(sut.handleReevaluate({ id: assetId })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.smartAlbum.getAllSmartAlbumIdsForOwner).not.toHaveBeenCalled();
    });

    it('should fail corrupt tags rather than silently hiding them', async () => {
      mocks.assetJob.getForSmartAlbumReevaluation.mockResolvedValue({ id: assetId, ownerId, tags: [123] } as never);
      await expect(sut.handleReevaluate({ id: assetId })).rejects.toThrow('Invalid smart-album description tags');
      expect(mocks.smartAlbum.addAssetToSmartAlbum).not.toHaveBeenCalled();
    });

    it('should defer membership writes and reject changed tags during accepted publication', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        smartAlbums: { enabled: true },
        machineLearning: { clip: { enabled: false } },
      });
      mocks.smartAlbum.getAllSmartAlbumIdsForOwner.mockResolvedValue(albumMap({ food: foodAlbumId }));
      const execution: QueueExecution = {
        claim: { id: newUuid(), token: newUuid(), data: {}, safeToRetry: true } as QueueClaim,
        signal: new AbortController().signal,
        progress: vi.fn(),
        progressUnits: 0,
        adoptions: [],
        followups: [],
        buffering: false,
      };
      await queueExecution.run(execution, () => sut.handleReevaluate({ id: assetId, kind: 'food' }));
      expect(mocks.job.guardAssetSource).toHaveBeenCalledWith(assetId);
      expect(mocks.smartAlbum.addAssetToSmartAlbum).not.toHaveBeenCalled();
      mocks.assetJob.getForSmartAlbumReevaluation.mockResolvedValue({ id: assetId, ownerId, tags: ['changed'] });
      await expect(execution.adoptions[0]({} as never)).rejects.toThrow('inputs changed before publication');
      expect(mocks.smartAlbum.addAssetToSmartAlbum).not.toHaveBeenCalled();
    });
  });

  describe('backfillAllUsers', () => {
    it('should call ensureBuiltInAlbumsForUser for each user', async () => {
      const userId1 = newUuid();
      const userId2 = newUuid();
      mocks.user.getList.mockResolvedValue([{ id: userId1 }, { id: userId2 }] as never);
      mocks.smartAlbum.ensureForUser.mockResolvedValue();

      await sut.backfillAllUsers();

      expect(mocks.smartAlbum.ensureForUser).toHaveBeenCalledTimes(2);
    });

    it('should continue if one user backfill fails', async () => {
      const userId1 = newUuid();
      const userId2 = newUuid();
      mocks.user.getList.mockResolvedValue([{ id: userId1 }, { id: userId2 }] as never);
      mocks.smartAlbum.ensureForUser.mockRejectedValueOnce(new Error('db error')).mockResolvedValueOnce();

      await expect(sut.backfillAllUsers()).resolves.not.toThrow();

      expect(mocks.smartAlbum.ensureForUser).toHaveBeenCalledTimes(2);
      expect(mocks.logger.warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('onConfigUpdate', () => {
    it('should backfill all users when smartAlbums.enabled flips from false to true', async () => {
      const userId1 = newUuid();
      mocks.user.getList.mockResolvedValue([{ id: userId1 }] as never);
      mocks.smartAlbum.ensureForUser.mockResolvedValue();

      await sut.onConfigUpdate({
        oldConfig: { ...defaults, smartAlbums: { ...defaults.smartAlbums, enabled: false } },
        newConfig: { ...defaults, smartAlbums: { ...defaults.smartAlbums, enabled: true } },
      });

      expect(mocks.user.getList).toHaveBeenCalledTimes(1);
      expect(mocks.smartAlbum.ensureForUser).toHaveBeenCalledTimes(1);
    });

    it('should not backfill when smartAlbums.enabled remains true', async () => {
      await sut.onConfigUpdate({
        oldConfig: { ...defaults, smartAlbums: { ...defaults.smartAlbums, enabled: true } },
        newConfig: { ...defaults, smartAlbums: { ...defaults.smartAlbums, enabled: true } },
      });

      expect(mocks.user.getList).not.toHaveBeenCalled();
      expect(mocks.smartAlbum.ensureForUser).not.toHaveBeenCalled();
    });

    it('should not backfill when smartAlbums.enabled remains false', async () => {
      await sut.onConfigUpdate({
        oldConfig: { ...defaults, smartAlbums: { ...defaults.smartAlbums, enabled: false } },
        newConfig: { ...defaults, smartAlbums: { ...defaults.smartAlbums, enabled: false } },
      });

      expect(mocks.user.getList).not.toHaveBeenCalled();
      expect(mocks.smartAlbum.ensureForUser).not.toHaveBeenCalled();
    });

    it('should not backfill when smartAlbums.enabled flips from true to false', async () => {
      await sut.onConfigUpdate({
        oldConfig: { ...defaults, smartAlbums: { ...defaults.smartAlbums, enabled: true } },
        newConfig: { ...defaults, smartAlbums: { ...defaults.smartAlbums, enabled: false } },
      });

      expect(mocks.user.getList).not.toHaveBeenCalled();
      expect(mocks.smartAlbum.ensureForUser).not.toHaveBeenCalled();
    });
  });

  describe('onBootstrap', () => {
    it('should call ensureBuiltInAlbumsForUser for each active user', async () => {
      const userId1 = newUuid();
      const userId2 = newUuid();
      mocks.user.getList.mockResolvedValue([{ id: userId1 }, { id: userId2 }] as never);
      mocks.smartAlbum.ensureForUser.mockResolvedValue();

      await sut.onBootstrap();

      expect(mocks.smartAlbum.ensureForUser).toHaveBeenCalledTimes(2);
    });

    it('should continue bootstrapping other users if one fails', async () => {
      const userId1 = newUuid();
      const userId2 = newUuid();
      mocks.user.getList.mockResolvedValue([{ id: userId1 }, { id: userId2 }] as never);
      mocks.smartAlbum.ensureForUser.mockRejectedValueOnce(new Error('db error')).mockResolvedValueOnce();

      await expect(sut.onBootstrap()).resolves.not.toThrow();

      expect(mocks.smartAlbum.ensureForUser).toHaveBeenCalledTimes(2);
    });

    it('should not enumerate users when smartAlbums.enabled is false', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        smartAlbums: { enabled: false },
      });

      await sut.onBootstrap();

      expect(mocks.user.getList).not.toHaveBeenCalled();
      expect(mocks.smartAlbum.ensureForUser).not.toHaveBeenCalled();
    });
  });
});
