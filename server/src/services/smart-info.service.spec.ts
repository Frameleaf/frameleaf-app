import type { QueueExecution } from 'src/queue/types.js';
import { SystemConfig } from 'src/dtos/config.dto.js';
import { AssetFileType, AssetVisibility, FrameleafWorker, JobName, JobStatus, MlWorkload } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { JobDependencyUnavailable } from 'src/queue/dependency.js';
import { CustomClipModelRefusedError } from 'src/repositories/machine-learning.repository.js';
import { SmartInfoService } from 'src/services/smart-info.service.js';
import { CUSTOM_CLIP_MODELS_KEY } from 'src/types.js';
import { getCLIPModelInfo } from 'src/utils/misc.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { mlDestinationStub } from 'test/fixtures/ml-destination.stub.js';
import { systemConfigStub } from 'test/fixtures/system-config.stub.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(SmartInfoService.name, () => {
  let sut: SmartInfoService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(SmartInfoService));

    mocks.asset.getByIds.mockResolvedValue([AssetFactory.create()]);
    mocks.config.getWorker.mockReturnValue(FrameleafWorker.Microservices);
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  it('reconsiders landmark recognition after image embeddings are available', async () => {
    const asset = { id: 'asset', ownerId: 'owner', visibility: AssetVisibility.Timeline };
    mocks.assetJob.getForClipEncoding.mockResolvedValue(asset as never);
    mocks.search.getEmbedding.mockResolvedValue({
      assetId: asset.id,
      embedding: '[1]',
      producerModelKey: 'producer',
    } as never);
    await sut.handlePostprocessClip({ id: asset.id });
    expect(mocks.job.queue).toHaveBeenCalledWith({
      name: JobName.LandmarkInfer,
      data: { id: asset.id, trigger: 'embedding' },
    });
  });

  it("hands a photo's embedding on to its partner copies once it has one", async () => {
    const asset = { id: 'asset', ownerId: 'owner', visibility: AssetVisibility.Timeline };
    mocks.assetJob.getForClipEncoding.mockResolvedValue(asset as never);
    mocks.search.getEmbedding.mockResolvedValue({
      assetId: asset.id,
      embedding: '[1]',
      producerModelKey: null,
    } as never);
    mocks.partnerOrigin.getLiveCopyIds.mockResolvedValue(['copy']);
    await sut.handlePostprocessClip({ id: asset.id });
    expect(mocks.partnerOrigin.getLiveCopyIds).toHaveBeenCalledWith(asset.id);
    expect(mocks.job.queueOutsideRun).toHaveBeenCalledWith([{ name: JobName.SmartSearch, data: { id: 'copy' } }]);
  });

  it('refuses a stored producer change even when postprocessing vector bytes stay equal', async () => {
    const asset = { id: 'asset', ownerId: 'owner', visibility: AssetVisibility.Timeline };
    mocks.assetJob.getForClipEncoding.mockResolvedValue(asset as never);
    const stored = { assetId: asset.id, embedding: '[1]', producerModelKey: 'producer-before' };
    mocks.search.getEmbedding.mockResolvedValueOnce(stored as never).mockResolvedValue({
      ...stored,
      producerModelKey: 'producer-after',
    } as never);
    const context = {
      claim: { id: 'job', token: 'token' },
      signal: new AbortController().signal,
      adoptions: [],
      followups: [],
      buffering: false,
    } as unknown as QueueExecution;
    await queueExecution.run(context, () => sut.handlePostprocessClip({ id: asset.id }));
    await expect(context.adoptions[0]({} as never)).rejects.toThrow('CLIP embedding changed');
  });

  describe('onConfigValidateEvent', () => {
    it.each(['ViT-B-16__openai', 'immich-app/ViT-B-16__openai'])('allows a supported model %s', async (modelName) => {
      await expect(
        sut.onConfigValidate({
          newConfig: { machineLearning: { clip: { modelName } } } as SystemConfig,
          oldConfig: {} as SystemConfig,
        }),
      ).resolves.toBeUndefined();
      expect(mocks.machineLearning.assertClipModel).toHaveBeenCalledWith(modelName);
    });
    it('fails for an unsupported model', async () => {
      await expect(
        sut.onConfigValidate({
          newConfig: { machineLearning: { clip: { modelName: 'test-model' } } } as SystemConfig,
          oldConfig: {} as SystemConfig,
        }),
      ).rejects.toThrow('Unknown CLIP model: test-model');
    });
    it('refuses changing the model of an admitted index', async () => {
      mocks.machineLearning.assertClipModel.mockRejectedValue(new Error('desktop_clip_profile_unavailable'));
      await expect(
        sut.onConfigValidate({
          newConfig: systemConfigStub.machineLearningEnabled as SystemConfig,
          oldConfig: {} as SystemConfig,
        }),
      ).rejects.toThrow('desktop_clip_profile_unavailable');
    });
  });

  it('refuses an incompatible admitted model before initialization can clear or resize vectors', async () => {
    mocks.machineLearning.assertClipModel.mockRejectedValue(new Error('desktop_clip_profile_unavailable'));
    await expect(
      sut.onConfigInit({ newConfig: systemConfigStub.machineLearningEnabled as SystemConfig }),
    ).rejects.toThrow('desktop_clip_profile_unavailable');
    expect(mocks.database.setDimensionSize).not.toHaveBeenCalled();
    expect(mocks.database.deleteAllSearchEmbeddings).not.toHaveBeenCalled();
  });

  describe('onConfigInit', () => {
    it('should return if machine learning is disabled', async () => {
      await sut.onConfigInit({ newConfig: systemConfigStub.machineLearningDisabled as SystemConfig });

      expect(mocks.database.getDimensionSize).not.toHaveBeenCalled();
      expect(mocks.database.setDimensionSize).not.toHaveBeenCalled();
      expect(mocks.database.deleteAllSearchEmbeddings).not.toHaveBeenCalled();
    });

    it('should return if model and DB dimension size are equal', async () => {
      mocks.database.getDimensionSize.mockResolvedValue(512);

      await sut.onConfigInit({ newConfig: systemConfigStub.machineLearningEnabled as SystemConfig });

      expect(mocks.database.getDimensionSize).toHaveBeenCalledTimes(1);
      expect(mocks.database.setDimensionSize).not.toHaveBeenCalled();
      expect(mocks.database.deleteAllSearchEmbeddings).not.toHaveBeenCalled();
    });

    it('should update DB dimension size if model and DB have different values', async () => {
      mocks.database.getDimensionSize.mockResolvedValue(768);

      await sut.onConfigInit({ newConfig: systemConfigStub.machineLearningEnabled as SystemConfig });

      expect(mocks.database.getDimensionSize).toHaveBeenCalledTimes(1);
      expect(mocks.database.setDimensionSize).toHaveBeenCalledWith(512);
    });
  });

  describe('onConfigUpdateEvent', () => {
    it('should return if machine learning is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.machineLearningDisabled);

      await sut.onConfigUpdate({
        newConfig: systemConfigStub.machineLearningDisabled as SystemConfig,
        oldConfig: systemConfigStub.machineLearningDisabled as SystemConfig,
      });

      expect(mocks.systemMetadata.get).not.toHaveBeenCalled();
      expect(mocks.database.getDimensionSize).not.toHaveBeenCalled();
      expect(mocks.database.setDimensionSize).not.toHaveBeenCalled();
      expect(mocks.database.deleteAllSearchEmbeddings).not.toHaveBeenCalled();
    });

    it('should return if model and DB dimension size are equal', async () => {
      mocks.database.getDimensionSize.mockResolvedValue(512);

      await sut.onConfigUpdate({
        newConfig: {
          machineLearning: { clip: { modelName: 'ViT-B-16__openai', enabled: true }, enabled: true },
        } as SystemConfig,
        oldConfig: {
          machineLearning: { clip: { modelName: 'ViT-B-16__openai', enabled: true }, enabled: true },
        } as SystemConfig,
      });

      expect(mocks.database.getDimensionSize).toHaveBeenCalledTimes(1);
      expect(mocks.database.setDimensionSize).not.toHaveBeenCalled();
      expect(mocks.database.deleteAllSearchEmbeddings).not.toHaveBeenCalled();
    });

    it('should update DB dimension size if model and DB have different values', async () => {
      mocks.database.getDimensionSize.mockResolvedValue(512);

      await sut.onConfigUpdate({
        newConfig: {
          machineLearning: { clip: { modelName: 'ViT-L-14-quickgelu__dfn2b', enabled: true }, enabled: true },
        } as SystemConfig,
        oldConfig: {
          machineLearning: { clip: { modelName: 'ViT-B-16__openai', enabled: true }, enabled: true },
        } as SystemConfig,
      });

      expect(mocks.database.getDimensionSize).toHaveBeenCalledTimes(1);
      expect(mocks.database.setDimensionSize).toHaveBeenCalledWith(768);
    });

    it('should clear embeddings if old and new models are different', async () => {
      mocks.database.getDimensionSize.mockResolvedValue(512);

      await sut.onConfigUpdate({
        newConfig: {
          machineLearning: { clip: { modelName: 'ViT-B-32__openai', enabled: true }, enabled: true },
        } as SystemConfig,
        oldConfig: {
          machineLearning: { clip: { modelName: 'ViT-B-16__openai', enabled: true }, enabled: true },
        } as SystemConfig,
      });

      expect(mocks.database.deleteAllSearchEmbeddings).toHaveBeenCalled();
      expect(mocks.database.getDimensionSize).toHaveBeenCalledTimes(1);
      expect(mocks.database.setDimensionSize).not.toHaveBeenCalled();
    });
  });

  describe('handleQueueEncodeClip', () => {
    beforeEach(() => mocks.database.getDimensionSize.mockResolvedValue(768));
    it('should do nothing if machine learning is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.machineLearningDisabled);

      await expect(sut.handleQueueEncodeClip({})).resolves.toBe(JobStatus.Skipped);

      expect(mocks.database.setDimensionSize).not.toHaveBeenCalled();
      expect(mocks.assetJob.selectionForEncodeClip).not.toHaveBeenCalled();
      expect(mocks.job.queueSelection).not.toHaveBeenCalled();
    });

    it('should queue the assets without clip embeddings', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.selectionForEncodeClip.mockReturnValue({ selected: [asset] } as never);

      await sut.handleQueueEncodeClip({ force: false });

      expect(mocks.job.queueSelection).toHaveBeenCalledWith(
        JobName.SmartSearch,
        mocks.assetJob.selectionForEncodeClip.mock.results[0].value,
      );
      expect(mocks.assetJob.selectionForEncodeClip).toHaveBeenCalledWith(false);
      expect(mocks.database.setDimensionSize).not.toHaveBeenCalled();
    });

    it('should queue all the assets', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.selectionForEncodeClip.mockReturnValue({ selected: [asset] } as never);

      await sut.handleQueueEncodeClip({ force: true });

      expect(mocks.job.queueSelection).toHaveBeenCalledWith(
        JobName.SmartSearch,
        mocks.assetJob.selectionForEncodeClip.mock.results[0].value,
      );
      expect(mocks.assetJob.selectionForEncodeClip).toHaveBeenCalledWith(true);
      expect(mocks.database.setDimensionSize).not.toHaveBeenCalled();
      expect(mocks.database.deleteAllSearchEmbeddings).not.toHaveBeenCalled();
    });
  });

  describe('handleEncodeClip', () => {
    it('should do nothing if machine learning is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.machineLearningDisabled);

      expect(await sut.handleEncodeClip({ id: '123' })).toEqual(JobStatus.Skipped);

      expect(mocks.assetJob.getForClipEncoding).not.toHaveBeenCalled();
      expect(mocks.machineLearning.encodeImage).not.toHaveBeenCalled();
      expect(mocks.search.upsert).not.toHaveBeenCalled();
    });

    it('should skip assets without a resize path', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.getForClipEncoding.mockResolvedValue(asset);

      expect(await sut.handleEncodeClip({ id: asset.id })).toEqual(JobStatus.Skipped);

      expect(mocks.search.upsert).not.toHaveBeenCalled();
      expect(mocks.machineLearning.encodeImage).not.toHaveBeenCalled();
    });

    it("takes a partner copy's embedding from its source instead of encoding the same picture again", async () => {
      const copy = AssetFactory.from().file({ type: AssetFileType.Preview }).build();
      mocks.assetJob.getForClipEncoding.mockResolvedValue(copy);
      mocks.partnerOrigin.getLiveSourceId.mockResolvedValue('source');

      // the source has none yet: it hands it over after its own postprocess
      mocks.search.getEmbedding.mockResolvedValueOnce(undefined);
      expect(await sut.handleEncodeClip({ id: copy.id })).toEqual(JobStatus.Skipped);
      expect(mocks.search.upsert).not.toHaveBeenCalled();

      mocks.search.getEmbedding.mockResolvedValue({
        assetId: 'source',
        embedding: '[1]',
        producerModelKey: null,
      } as never);
      expect(await sut.handleEncodeClip({ id: copy.id })).toEqual(JobStatus.Success);
      expect(mocks.search.getEmbedding).toHaveBeenCalledWith('source');
      expect(mocks.search.upsert).toHaveBeenCalledWith(copy.id, '[1]');
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.SmartSearchPostprocess, data: { id: copy.id } });
      expect(mocks.machineLearning.encodeImage).not.toHaveBeenCalled();
    });

    it('should save the returned objects', async () => {
      const asset = AssetFactory.from().file({ type: AssetFileType.Preview }).build();
      mocks.machineLearning.encodeImage.mockResolvedValue('[0.01, 0.02, 0.03]');
      mocks.assetJob.getForClipEncoding.mockResolvedValue(asset);

      expect(await sut.handleEncodeClip({ id: asset.id })).toEqual(JobStatus.Success);

      expect(mocks.machineLearning.encodeImage).toHaveBeenCalledWith(
        expect.objectContaining({ destinationId: expect.any(String), workload: expect.any(String) }),
        asset.files[0].path,
        expect.objectContaining({ modelName: 'ViT-B-16-SigLIP-384__webli' }),
      );
      expect(mocks.search.upsert).toHaveBeenCalledWith(asset.id, '[0.01, 0.02, 0.03]');
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.SmartSearchPostprocess, data: { id: asset.id } });
    });

    it('leaves a photo routed to Frameleaf Cloud for a batch, encoding nothing here (FL-455)', async () => {
      const asset = AssetFactory.from().file({ type: AssetFileType.Preview }).build();
      mocks.assetJob.getForClipEncoding.mockResolvedValue(asset);
      mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.frameleafCloudConsented);

      expect(await sut.handleEncodeClip({ id: asset.id })).toEqual(JobStatus.Skipped);

      expect(mocks.machineLearning.encodeImage).not.toHaveBeenCalled();
      expect(mocks.search.upsert).not.toHaveBeenCalled();
    });

    it("keeps a person's own search model off Frameleaf Cloud, even when search is routed there", async () => {
      const asset = AssetFactory.from().file({ type: AssetFileType.Preview }).build();
      mocks.assetJob.getForClipEncoding.mockResolvedValue(asset);
      mocks.machineLearning.encodeImage.mockResolvedValue('[0.01, 0.02, 0.03]');
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: { clip: { modelName: 'someone/my-search-model' } },
      });
      mocks.mlDestination.getById.mockImplementation((id) =>
        Promise.resolve(
          id === mlDestinationStub.local.id ? mlDestinationStub.local : mlDestinationStub.frameleafCloudConsented,
        ),
      );
      mocks.mlDestination.getRoute.mockResolvedValue({
        workload: MlWorkload.Clip,
        destinationId: mlDestinationStub.frameleafCloudConsented.id,
        modelId: null,
        updatedAt: new Date(),
      } as never);
      mocks.mlDestination.getAll.mockResolvedValue([
        mlDestinationStub.frameleafCloudConsented,
        mlDestinationStub.local,
      ]);

      expect(await sut.handleEncodeClip({ id: asset.id })).toEqual(JobStatus.Success);

      expect(mocks.machineLearning.encodeImage).toHaveBeenCalledWith(
        expect.objectContaining({ destinationId: mlDestinationStub.local.id }),
        asset.files[0].path,
        expect.objectContaining({ modelName: 'someone/my-search-model' }),
      );
    });

    it("makes a refused Frameleaf Cloud result on this server's own machine learning (FL-455)", async () => {
      const asset = AssetFactory.from().file({ type: AssetFileType.Preview }).build();
      mocks.assetJob.getForClipEncoding.mockResolvedValue(asset);
      mocks.machineLearning.encodeImage.mockResolvedValue('[0.01, 0.02, 0.03]');
      mocks.mlDestination.getById.mockImplementation((id) =>
        Promise.resolve(
          id === mlDestinationStub.local.id ? mlDestinationStub.local : mlDestinationStub.frameleafCloudConsented,
        ),
      );
      mocks.mlDestination.getRoute.mockResolvedValue({
        workload: MlWorkload.Clip,
        destinationId: mlDestinationStub.frameleafCloudConsented.id,
        modelId: null,
        updatedAt: new Date(),
      } as never);
      mocks.mlDestination.getAll.mockResolvedValue([
        mlDestinationStub.frameleafCloudConsented,
        mlDestinationStub.local,
      ]);

      expect(await sut.handleEncodeClip({ id: asset.id, onThisServer: true })).toEqual(JobStatus.Success);

      expect(mocks.machineLearning.encodeImage).toHaveBeenCalledWith(
        expect.objectContaining({ destinationId: mlDestinationStub.local.id }),
        asset.files[0].path,
        expect.anything(),
      );
      expect(mocks.search.upsert).toHaveBeenCalledWith(asset.id, '[0.01, 0.02, 0.03]');
    });

    it('stores a Frameleaf Cloud embedding like its own, and refuses one for another preview (FL-455)', async () => {
      const asset = AssetFactory.from().file({ type: AssetFileType.Preview }).build();
      mocks.assetJob.getForClipEncoding.mockResolvedValue(asset);
      const embedding = { embedding: '[0.5]', modelKey: `clip:${'a'.repeat(64)}` };

      await expect(
        sut.publishClipEmbedding(asset.id, embedding, {
          modelName: 'ViT-B-16-SigLIP-384__webli',
          previewPath: 'other',
        }),
      ).resolves.toBe(JobStatus.Skipped);
      expect(mocks.search.upsert).not.toHaveBeenCalled();

      await expect(
        sut.publishClipEmbedding(asset.id, embedding, {
          modelName: 'ViT-B-16-SigLIP-384__webli',
          previewPath: asset.files[0].path,
        }),
      ).resolves.toBe(JobStatus.Success);
      expect(mocks.search.upsert).toHaveBeenCalledWith(asset.id, embedding);
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.SmartSearchPostprocess, data: { id: asset.id } });
    });

    it('should skip invisible assets', async () => {
      const asset = AssetFactory.from({ visibility: AssetVisibility.Hidden })
        .file({ type: AssetFileType.Preview })
        .build();
      mocks.assetJob.getForClipEncoding.mockResolvedValue(asset);

      expect(await sut.handleEncodeClip({ id: asset.id })).toEqual(JobStatus.Skipped);

      expect(mocks.machineLearning.encodeImage).not.toHaveBeenCalled();
      expect(mocks.search.upsert).not.toHaveBeenCalled();
    });

    it('waits for a missing preview only while one can still arrive, and never for a hidden asset', async () => {
      const execution = {
        claim: { id: 'job', token: 'token', data: {} },
        signal: new AbortController().signal,
      } as unknown as QueueExecution;
      const encode = (id: string) => queueExecution.run(execution, () => sut.handleEncodeClip({ id }));
      // A Live Photo's motion part is hidden and never gets a preview.
      mocks.assetJob.getForClipEncoding.mockResolvedValue(
        AssetFactory.from({ visibility: AssetVisibility.Hidden }).build(),
      );
      await expect(encode('hidden')).resolves.toBe(JobStatus.Skipped);

      mocks.assetJob.getForClipEncoding.mockResolvedValue(AssetFactory.from().build());
      await expect(encode('pending')).rejects.toThrow(JobDependencyUnavailable);
      // The run's thumbnail item for this damaged original has ended without a preview.
      mocks.job.previewMayArrive.mockResolvedValue(false);
      await expect(encode('damaged')).resolves.toBe(JobStatus.Skipped);
      expect(mocks.job.previewMayArrive).toHaveBeenCalledWith('damaged');
      expect(mocks.machineLearning.encodeImage).not.toHaveBeenCalled();
    });

    it('should fail if asset could not be found', async () => {
      mocks.assetJob.getForClipEncoding.mockResolvedValue(void 0);

      expect(await sut.handleEncodeClip({ id: 'non-existent' })).toEqual(JobStatus.Failed);

      expect(mocks.machineLearning.encodeImage).not.toHaveBeenCalled();
      expect(mocks.search.upsert).not.toHaveBeenCalled();
    });

    it('should wait for database', async () => {
      const asset = AssetFactory.from().file({ type: AssetFileType.Preview }).build();
      mocks.machineLearning.encodeImage.mockResolvedValue('[0.01, 0.02, 0.03]');
      mocks.database.isBusy.mockReturnValue(true);
      mocks.assetJob.getForClipEncoding.mockResolvedValue(asset);

      expect(await sut.handleEncodeClip({ id: asset.id })).toEqual(JobStatus.Success);

      expect(mocks.database.wait).toHaveBeenCalledWith(512);
      expect(mocks.machineLearning.encodeImage).toHaveBeenCalledWith(
        expect.objectContaining({ destinationId: expect.any(String), workload: expect.any(String) }),
        asset.files[0].path,
        expect.objectContaining({ modelName: 'ViT-B-16-SigLIP-384__webli' }),
      );
      expect(mocks.search.upsert).toHaveBeenCalledWith(asset.id, '[0.01, 0.02, 0.03]');
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.SmartSearchPostprocess, data: { id: asset.id } });
    });
  });

  describe('a custom Hugging Face model', () => {
    const modelName = 'someone/my-search-model';
    const custom = (name = modelName) =>
      ({ machineLearning: { enabled: true, clip: { enabled: true, modelName: name } } }) as SystemConfig;
    const published = custom('ViT-B-32__openai');

    beforeEach(() => {
      mocks.machineLearning.getCustomClipDimSize.mockResolvedValue(640);
    });

    it('accepts a new name and remembers the size the worker learned', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ 'other/model': 256 });

      await expect(sut.onConfigValidate({ newConfig: custom(), oldConfig: published })).resolves.toBeUndefined();

      expect(mocks.machineLearning.getCustomClipDimSize).toHaveBeenCalledWith(expect.anything(), modelName);
      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(CUSTOM_CLIP_MODELS_KEY, {
        'other/model': 256,
        [modelName]: 640,
      });
    });

    it('fails the save with the reason a refused repository gives', async () => {
      const reason = "The Hugging Face model 'someone/my-search-model' can't be used for search: it's missing x.";
      mocks.machineLearning.getCustomClipDimSize.mockRejectedValue(new CustomClipModelRefusedError(reason));

      await expect(sut.onConfigValidate({ newConfig: custom(), oldConfig: published })).rejects.toThrow(reason);

      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
    });

    it('fails the save in plain words when the worker cannot be reached', async () => {
      mocks.machineLearning.getCustomClipDimSize.mockRejectedValue(new Error('fetch failed'));

      await expect(sut.onConfigValidate({ newConfig: custom(), oldConfig: published })).rejects.toThrow(
        "Frameleaf couldn't check 'someone/my-search-model'",
      );
    });

    it('does not ask the worker again when another setting is saved', async () => {
      await expect(sut.onConfigValidate({ newConfig: custom(), oldConfig: custom() })).resolves.toBeUndefined();

      expect(mocks.machineLearning.getCustomClipDimSize).not.toHaveBeenCalled();
    });

    it('does not treat a published model with an owner as custom, or a malformed name as a repository', async () => {
      await expect(
        sut.onConfigValidate({ newConfig: custom('immich-app/ViT-B-32__openai'), oldConfig: published }),
      ).resolves.toBeUndefined();
      await expect(sut.onConfigValidate({ newConfig: custom('../etc/passwd'), oldConfig: published })).rejects.toThrow(
        'Unknown CLIP model',
      );

      expect(mocks.machineLearning.getCustomClipDimSize).not.toHaveBeenCalled();
    });

    it('resizes the vector columns to the learned size and clears results on a change', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ [modelName]: 640 });
      mocks.database.getDimensionSize.mockResolvedValue(512);

      await sut.onConfigUpdate({ newConfig: custom(), oldConfig: published });

      expect(mocks.database.setDimensionSize).toHaveBeenCalledWith(640);
    });

    it('clears search results when the size is unchanged, like any other model', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ [modelName]: 512 });
      mocks.database.getDimensionSize.mockResolvedValue(512);

      await sut.onConfigUpdate({ newConfig: custom(), oldConfig: published });

      expect(mocks.database.setDimensionSize).not.toHaveBeenCalled();
      expect(mocks.database.deleteAllSearchEmbeddings).toHaveBeenCalled();
    });

    it('learns the size again when a queue-all run finds none, once the worker is back', async () => {
      let sizes: Record<string, number> = {};
      mocks.systemMetadata.get.mockImplementation(
        (key) =>
          Promise.resolve(
            key === CUSTOM_CLIP_MODELS_KEY
              ? sizes
              : { machineLearning: { enabled: true, clip: { enabled: true, modelName } } },
          ) as never,
      );
      mocks.systemMetadata.set.mockImplementation((_key, value) => {
        sizes = value as Record<string, number>;
        return Promise.resolve();
      });
      mocks.database.getDimensionSize.mockResolvedValue(640);
      mocks.assetJob.selectionForEncodeClip.mockReturnValue({} as never);

      await expect(sut.handleQueueEncodeClip({})).resolves.toBe(JobStatus.Success);

      expect(mocks.machineLearning.getCustomClipDimSize).toHaveBeenCalled();
      expect(mocks.job.queueSelection).toHaveBeenCalled();
    });

    const queueConfig = (name: string) => ({
      machineLearning: { enabled: true, clip: { enabled: true, modelName: name } },
    });

    it('repairs a size mismatch left by a failed resize on the next queue-all run', async () => {
      mocks.systemMetadata.get.mockResolvedValue(queueConfig('ViT-B-32__openai'));
      mocks.database.getDimensionSize.mockResolvedValueOnce(768).mockResolvedValueOnce(768).mockResolvedValue(512);
      mocks.assetJob.selectionForEncodeClip.mockReturnValue({} as never);

      await expect(sut.handleQueueEncodeClip({})).resolves.toBe(JobStatus.Success);

      expect(mocks.database.setDimensionSize).toHaveBeenCalledWith(512);
      expect(mocks.job.queueSelection).toHaveBeenCalled();
    });

    it('leaves the index alone when a save changed the model before the retry got the lock', async () => {
      mocks.systemMetadata.get
        .mockResolvedValueOnce(queueConfig('ViT-B-32__openai'))
        .mockResolvedValue(queueConfig('ViT-B-16-SigLIP-384__webli'));
      mocks.database.getDimensionSize.mockResolvedValue(768);

      await sut.handleQueueEncodeClip({});

      expect(mocks.database.setDimensionSize).not.toHaveBeenCalled();
      expect(mocks.database.deleteAllSearchEmbeddings).not.toHaveBeenCalled();
      expect(mocks.job.queueSelection).not.toHaveBeenCalled();
    });

    it('waits instead of breaking startup when the size cannot be learned', async () => {
      mocks.systemMetadata.get.mockResolvedValue({});
      mocks.machineLearning.getCustomClipDimSize.mockRejectedValue(new Error('fetch failed'));

      await expect(sut.onConfigInit({ newConfig: custom() })).resolves.toBeUndefined();

      expect(mocks.database.setDimensionSize).not.toHaveBeenCalled();
      expect(mocks.database.deleteAllSearchEmbeddings).not.toHaveBeenCalled();
    });

    it('queues nothing until the size is known', async () => {
      mocks.systemMetadata.get.mockResolvedValueOnce({ machineLearning: custom().machineLearning });
      mocks.systemMetadata.get.mockResolvedValue({});

      await expect(sut.handleQueueEncodeClip({ force: false })).resolves.toBe(JobStatus.Failed);

      expect(mocks.job.queueSelection).not.toHaveBeenCalled();
    });
  });

  describe('getCLIPModelInfo', () => {
    it('should return the model info', () => {
      expect(getCLIPModelInfo('ViT-B-32__openai')).toEqual({ dimSize: 512 });
      expect(getCLIPModelInfo('M-CLIP/XLM-Roberta-Large-Vit-L-14')).toEqual({ dimSize: 768 });
    });

    it('should clean the model name', () => {
      expect(getCLIPModelInfo('ViT-B-32::openai')).toEqual({ dimSize: 512 });
    });

    it('should throw an error if the model is not present', () => {
      expect(() => getCLIPModelInfo('test-model')).toThrow('Unknown CLIP model: test-model');
    });
  });
});
