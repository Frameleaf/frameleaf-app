import { CLIP_ZERO_SHOT_LABELS } from 'src/constants/clip-zero-shot-labels.js';
import { ZERO_SHOT_TAG_NAMESPACE } from 'src/constants/zero-shot-tag.js';
import { queueExecution } from 'src/queue/context.js';
import { publicationTransaction } from 'src/queue/transaction.js';
import { QueueExecution } from 'src/queue/types.js';
import { ZeroShotTaggingService } from 'src/services/zero-shot-tagging.service.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const ASSET_ID = 'asset-1';
const OWNER_ID = 'owner-1';
const EMBEDDING = '[1, 0]';

const withConfig = (mocks: ServiceMocks, machineLearning: object) => {
  mocks.systemMetadata.get.mockResolvedValue({ machineLearning });
};

const mockTagUpserts = (mocks: ServiceMocks) => {
  mocks.tag.upsertValue.mockImplementation(({ value }) => Promise.resolve({ id: `tag-${value}`, value } as never));
  mocks.tag.upsertAssetIds.mockImplementation((items) => Promise.resolve(items as never));
};

describe(ZeroShotTaggingService.name, () => {
  it('notifies direct callers only after the guarded database commit', async () => {
    const { sut, mocks } = newTestService(ZeroShotTaggingService);
    withConfig(mocks, { clip: { modelName: 'guarded-commit-notification' } });
    mocks.machineLearning.encodeText.mockResolvedValue(EMBEDDING);
    mockTagUpserts(mocks);
    let committed = false;
    const observed: boolean[] = [];
    mocks.event.emit.mockImplementation(() => {
      observed.push(committed);
      return Promise.resolve();
    });
    await sut.tagAsset(ASSET_ID, OWNER_ID, EMBEDDING, {
      assertCurrent: () => Promise.resolve(),
      publish: async (write) => {
        const result = await write();
        committed = true;
        return result;
      },
    });
    expect(observed).toEqual([true]);
  });

  it('retains the caller snapshot when a stored embedding was read before admission', async () => {
    const { sut, mocks } = newTestService(ZeroShotTaggingService);
    withConfig(mocks, { clip: { modelName: 'caller-snapshot-model' } });
    mocks.machineLearning.encodeText.mockResolvedValue(EMBEDDING);
    mockTagUpserts(mocks);
    await sut.tagAsset(ASSET_ID, OWNER_ID, EMBEDDING, {
      assertCurrent: () => Promise.reject(new Error('desktop_clip_index_changed')),
      publish: () => Promise.reject(new Error('desktop_clip_index_changed')),
    });
    expect(mocks.tag.upsertAssetIds).not.toHaveBeenCalled();
  });

  it('prepares queued ML tags without writes and publishes tags only inside accepted adoption', async () => {
    const { sut, mocks } = newTestService(ZeroShotTaggingService);
    withConfig(mocks, { clip: { modelName: 'queued-publication-model' } });
    mocks.machineLearning.encodeText.mockResolvedValue(EMBEDDING);
    mockTagUpserts(mocks);
    const context: QueueExecution = {
      claim: {
        id: 'job',
        token: 'token',
        queue: 'smart-search',
        name: 'smart-search-postprocess',
        data: {},
        workerId: 'worker',
        attempt: 1,
        runId: null,
        itemKey: null,
        deadlineMs: 1000,
        startedAt: new Date(),
      },
      signal: new AbortController().signal,
      progress: vi.fn(),
      progressUnits: 0,
      adoptions: [],
      followups: [],
      buffering: false,
    };
    await queueExecution.run(context, () => sut.tagAsset(ASSET_ID, OWNER_ID, EMBEDDING));
    expect(mocks.tag.upsertAssetIds).not.toHaveBeenCalled();
    expect(mocks.event.emit).not.toHaveBeenCalled();
    expect(context.adoptions).toHaveLength(1);
    await queueExecution.run(context, () =>
      publicationTransaction.run({} as never, () => context.adoptions[0]({} as never)),
    );
    expect(mocks.tag.upsertAssetIds).toHaveBeenCalledOnce();
    expect(mocks.event.emit).not.toHaveBeenCalled();
    for (const notify of context.afterCommit ?? []) await notify();
    expect(mocks.event.emit).toHaveBeenCalledWith('AssetTag', { assetId: ASSET_ID, userId: OWNER_ID });
  });

  it('does nothing when smart search is disabled', async () => {
    const { sut, mocks } = newTestService(ZeroShotTaggingService);
    withConfig(mocks, { enabled: false });

    await expect(sut.tagAsset(ASSET_ID, OWNER_ID, EMBEDDING)).resolves.toBeUndefined();

    expect(mocks.machineLearning.encodeText).not.toHaveBeenCalled();
    expect(mocks.tag.upsertValue).not.toHaveBeenCalled();
  });

  it('does nothing when zero-shot tagging is disabled', async () => {
    const { sut, mocks } = newTestService(ZeroShotTaggingService);
    withConfig(mocks, { clip: { zeroShotTagging: { enabled: false } } });

    await expect(sut.tagAsset(ASSET_ID, OWNER_ID, EMBEDDING)).resolves.toBeUndefined();

    expect(mocks.machineLearning.encodeText).not.toHaveBeenCalled();
  });

  it('does not reuse legacy vocabulary after an index is admitted with the same model name', async () => {
    const { sut, mocks } = newTestService(ZeroShotTaggingService);
    withConfig(mocks, { clip: { modelName: 'admission-model' } });
    mocks.machineLearning.clipCacheKey.mockResolvedValue('legacy');
    mocks.machineLearning.encodeText.mockResolvedValue(EMBEDDING);
    mockTagUpserts(mocks);
    await sut.tagAsset(ASSET_ID, OWNER_ID, EMBEDDING);
    mocks.machineLearning.clipCacheKey.mockResolvedValue('admitted:exact-producer');
    await sut.tagAsset('asset-after-admission', OWNER_ID, EMBEDDING);
    expect(mocks.machineLearning.encodeText).toHaveBeenCalledTimes(2 * CLIP_ZERO_SHOT_LABELS.length);
  });

  it('memoizes the vocabulary: one ML round-trip per model across calls', async () => {
    const { sut, mocks } = newTestService(ZeroShotTaggingService);
    withConfig(mocks, { clip: { modelName: 'memo-model' } });
    mocks.machineLearning.encodeText.mockResolvedValue(EMBEDDING);
    mockTagUpserts(mocks);

    await sut.tagAsset(ASSET_ID, OWNER_ID, EMBEDDING);
    await sut.tagAsset('asset-2', OWNER_ID, EMBEDDING);

    expect(mocks.machineLearning.encodeText).toHaveBeenCalledTimes(CLIP_ZERO_SHOT_LABELS.length);
    expect(mocks.machineLearning.encodeText).toHaveBeenCalledWith(
      expect.objectContaining({ destinationId: expect.any(String), workload: expect.any(String) }),
      expect.any(String),
      { modelName: 'memo-model' },
    );
  });

  it('logs ML failures without throwing, and retries on the next call', async () => {
    const { sut, mocks } = newTestService(ZeroShotTaggingService);
    withConfig(mocks, { clip: { modelName: 'failing-model' } });
    mocks.machineLearning.encodeText.mockRejectedValue(new Error('ml down'));

    await expect(sut.tagAsset(ASSET_ID, OWNER_ID, EMBEDDING)).resolves.toBeUndefined();
    expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('ml down'));
    expect(mocks.tag.upsertValue).not.toHaveBeenCalled();

    // The failed vocabulary promise is evicted, so the next call retries ML.
    await expect(sut.tagAsset(ASSET_ID, OWNER_ID, EMBEDDING)).resolves.toBeUndefined();
    expect(mocks.machineLearning.encodeText).toHaveBeenCalledTimes(2);
  });

  it('upserts matched tags under the zero-shot namespace and emits AssetTag', async () => {
    const { sut, mocks } = newTestService(ZeroShotTaggingService);
    withConfig(mocks, { clip: { modelName: 'namespace-model' } });
    mocks.machineLearning.encodeText.mockResolvedValue(EMBEDDING);
    mockTagUpserts(mocks);

    await sut.tagAsset(ASSET_ID, OWNER_ID, EMBEDDING);

    // hierarchical upsert: namespace root first, then namespaced label
    expect(mocks.tag.upsertValue).toHaveBeenCalledWith({
      userId: OWNER_ID,
      value: ZERO_SHOT_TAG_NAMESPACE,
      parentId: undefined,
    });
    expect(mocks.tag.upsertValue).toHaveBeenCalledWith({
      userId: OWNER_ID,
      value: `${ZERO_SHOT_TAG_NAMESPACE}/${CLIP_ZERO_SHOT_LABELS[0]}`,
      parentId: `tag-${ZERO_SHOT_TAG_NAMESPACE}`,
    });
    // default maxTags caps the number of applied tags
    expect(mocks.tag.upsertAssetIds).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ assetId: ASSET_ID })]),
    );
    expect(mocks.tag.upsertAssetIds.mock.calls[0][0]).toHaveLength(6);
    expect(mocks.event.emit).toHaveBeenCalledWith('AssetTag', { assetId: ASSET_ID, userId: OWNER_ID });
  });

  it('skips tagging for a malformed asset embedding', async () => {
    const { sut, mocks } = newTestService(ZeroShotTaggingService);
    withConfig(mocks, { clip: { modelName: 'malformed-model' } });

    await expect(sut.tagAsset(ASSET_ID, OWNER_ID, 'not-a-vector')).resolves.toBeUndefined();

    expect(mocks.machineLearning.encodeText).not.toHaveBeenCalled();
    expect(mocks.tag.upsertValue).not.toHaveBeenCalled();
  });
});
