import { Injectable } from '@nestjs/common';
import type { ArgOf } from 'src/repositories/event.repository.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { SystemConfig } from 'src/dtos/config.dto.js';
import { AssetVisibility, DatabaseLock, FrameleafWorker, JobName, JobStatus, MlWorkload, QueueName } from 'src/enum.js';
import { deferJobAdoption } from 'src/queue/context.js';
import { deferJobUntilDependency } from 'src/queue/dependency.js';
import { CustomClipModelRefusedError } from 'src/repositories/machine-learning.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { ClassificationService } from 'src/services/classification.service.js';
import { ZeroShotTaggingService } from 'src/services/zero-shot-tagging.service.js';
import { CUSTOM_CLIP_MODELS_KEY, type JobOf } from 'src/types.js';
import { type ClipEmbedding } from 'src/utils/clip-embedding.js';
import { CloudLibraryQueueWriter, cloudLibraryDestination } from 'src/utils/cloud-library-batch.js';
import { getCLIPModelInfo, isCustomClipModelName, isSmartSearchEnabled } from 'src/utils/misc.js';
import { homeMlDestinationId } from 'src/utils/ml-destination.js';

@Injectable()
export class SmartInfoService extends BaseService {
  private _classificationService: ClassificationService | undefined;
  /** FL-455: photos whose smart search is routed to Frameleaf Cloud wait here for a batch. */
  private readonly cloudLibraryQueue = new CloudLibraryQueueWriter(
    () => ({ databaseRepository: this.databaseRepository, systemMetadataRepository: this.systemMetadataRepository }),
    (message) => this.logger.warn(message),
  );

  @OnEvent({ name: 'AppShutdown' })
  async onShutdownFlushCloudLibraryQueue() {
    try {
      await this.cloudLibraryQueue.flush();
    } catch (error) {
      this.logger.warn(`The Frameleaf Cloud smart search queue was not written: ${error}`);
    }
  }

  private get classificationService(): ClassificationService {
    this._classificationService ??= BaseService.create(ClassificationService, this);
    return this._classificationService;
  }

  private get zeroShotTaggingService(): ZeroShotTaggingService {
    // Constructed lazily via BaseService.create so we reuse the same repo
    // singletons without threading a new dep through BaseService's ctor.
    this.zeroShotTaggingServiceInstance ??= BaseService.create(ZeroShotTaggingService, this);
    return this.zeroShotTaggingServiceInstance;
  }
  private zeroShotTaggingServiceInstance?: ZeroShotTaggingService;

  @OnEvent({ name: 'ConfigInit', workers: [FrameleafWorker.Microservices] })
  async onConfigInit({ newConfig }: ArgOf<'ConfigInit'>) {
    await this.init(newConfig);
  }

  @OnEvent({ name: 'ConfigUpdate', workers: [FrameleafWorker.Microservices], server: true })
  async onConfigUpdate({ oldConfig, newConfig }: ArgOf<'ConfigUpdate'>) {
    await this.init(newConfig, oldConfig);
  }

  @OnEvent({ name: 'ConfigValidate' })
  async onConfigValidate({ newConfig, oldConfig }: ArgOf<'ConfigValidate'>) {
    const { modelName } = newConfig.machineLearning.clip;
    if (isCustomClipModelName(modelName)) {
      await this.machineLearningRepository.assertClipModel(modelName);
      // Only a new name is checked, so an unrelated setting still saves while the model's worker is away.
      if (oldConfig.machineLearning?.clip.modelName !== modelName) {
        await this.learnCustomClipDimSize(modelName);
      }
      return;
    }
    try {
      getCLIPModelInfo(modelName);
    } catch {
      throw new Error(
        `Unknown CLIP model: ${modelName}. Please check the model name for typos and confirm this is a supported model.`,
      );
    }
    await this.machineLearningRepository.assertClipModel(modelName);
  }

  /** Ask this server's own worker for a person's model's embedding size and remember it. Throws a message for them. */
  private async learnCustomClipDimSize(modelName: string): Promise<number> {
    let dimSize: number;
    try {
      const selection = await this.selectClipTextDestination();
      dimSize = await this.machineLearningRepository.getCustomClipDimSize(selection, modelName);
    } catch (error) {
      if (error instanceof CustomClipModelRefusedError) {
        throw error;
      }
      this.logger.warn(`Could not check the search model ${modelName}: ${error}`);
      throw new Error(
        `Frameleaf couldn't check '${modelName}' because its machine learning service isn't answering. Make sure it's running, then try again.`,
        { cause: error },
      );
    }
    const known = await this.systemMetadataRepository.get(CUSTOM_CLIP_MODELS_KEY);
    await this.systemMetadataRepository.set(CUSTOM_CLIP_MODELS_KEY, { ...known, [modelName]: dimSize });
    return dimSize;
  }

  /** The embedding size of `modelName`; undefined for a person's own model whose size isn't known yet. */
  private async getClipDimSize(modelName: string): Promise<number | undefined> {
    if (!isCustomClipModelName(modelName)) {
      return getCLIPModelInfo(modelName).dimSize;
    }
    const known = (await this.systemMetadataRepository.get(CUSTOM_CLIP_MODELS_KEY)) as Record<string, number> | null;
    return known?.[modelName];
  }

  private async init(newConfig: SystemConfig, oldConfig?: SystemConfig) {
    if (!isSmartSearchEnabled(newConfig.machineLearning)) {
      return;
    }
    await this.machineLearningRepository.assertClipModel(newConfig.machineLearning.clip.modelName);

    await this.databaseRepository.withLock(DatabaseLock.CLIPDimSize, async () => {
      const { modelName } = newConfig.machineLearning.clip;
      let dimSize = await this.getClipDimSize(modelName);
      if (dimSize === undefined) {
        // Set by a config file or restored from a backup, so it was never checked at save time.
        try {
          dimSize = await this.learnCustomClipDimSize(modelName);
        } catch (error) {
          this.logger.warn(`Smart search will wait for the search model ${modelName}: ${error}`);
          return;
        }
      }
      const smartSearchDimSize = await this.databaseRepository.getDimensionSize('smart_search');
      this.logger.verbose(`Current smart search database CLIP dimension size is ${smartSearchDimSize}`);

      const modelChange =
        oldConfig && oldConfig.machineLearning.clip.modelName !== newConfig.machineLearning.clip.modelName;
      const isDimSizeChange = smartSearchDimSize !== dimSize;
      if (!modelChange && !isDimSizeChange) {
        return;
      }

      if (isDimSizeChange) {
        this.logger.log(
          `Dimension size of model ${newConfig.machineLearning.clip.modelName} is ${dimSize}, but database dimension is smart_search=${smartSearchDimSize}.`,
        );
        this.logger.log(`Updating database CLIP dimension size to ${dimSize}.`);
        await this.databaseRepository.setDimensionSize(dimSize);
        this.logger.log(`Successfully updated database CLIP dimension size to ${dimSize}.`);
      } else {
        await this.databaseRepository.deleteAllSearchEmbeddings();
      }

      // TODO: A job to reindex all assets should be scheduled, though user
      // confirmation should probably be requested before doing that.
    });
  }

  @OnJob({ name: JobName.SmartSearchQueueAll, queue: QueueName.SmartSearch })
  async handleQueueEncodeClip({ force }: JobOf<JobName.SmartSearchQueueAll>): Promise<JobStatus> {
    const config = await this.getConfig({ withCache: false });
    const { machineLearning } = config;
    if (!isSmartSearchEnabled(machineLearning)) {
      deferJobUntilDependency('workload-disabled');
      return JobStatus.Skipped;
    }

    // Configuration initialization owns dimensional DDL. A rerun must retain working vectors
    // until each accepted replacement is ready, rather than clearing the entire index.
    let dimSize = await this.getClipDimSize(machineLearning.clip.modelName);
    if (dimSize === undefined) {
      // A custom model whose size couldn't be learned at startup: the worker may be back by now.
      try {
        await this.init(config);
      } catch (error) {
        this.logger.warn(`Could not learn the size of ${machineLearning.clip.modelName}: ${error}`);
      }
      dimSize = await this.getClipDimSize(machineLearning.clip.modelName);
    }
    if (dimSize === undefined || (await this.databaseRepository.getDimensionSize('smart_search')) !== dimSize) {
      deferJobUntilDependency('destination-configuration');
      return JobStatus.Failed;
    }

    await this.jobRepository.queueSelection(JobName.SmartSearch, this.assetJobRepository.selectionForEncodeClip(force));

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.SmartSearch, queue: QueueName.SmartSearch })
  async handleEncodeClip({ id, onThisServer }: JobOf<JobName.SmartSearch>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: true });
    if (!isSmartSearchEnabled(machineLearning)) {
      deferJobUntilDependency('workload-disabled');
      return JobStatus.Skipped;
    }

    await this.jobRepository.guardAssetSource(id);
    const asset = await this.assetJobRepository.getForClipEncoding(id);
    if (!asset) {
      return JobStatus.Failed;
    }

    // Before the preview: a hidden asset (a Live Photo's motion part) never gets one.
    if (asset.visibility === AssetVisibility.Hidden) {
      return JobStatus.Skipped;
    }

    if (asset.files.length !== 1) {
      if (await this.jobRepository.previewMayArrive(id)) deferJobUntilDependency('source-unavailable');
      return JobStatus.Failed;
    }

    // FL-455: routed to Frameleaf Cloud, the photo waits for a batch; one job never sends one photo. A
    // Frameleaf Cloud result that was refused is made here instead (`onThisServer`), never on the cloud.
    // A person's own search model is never offered to Frameleaf Cloud, so it always runs at home.
    const customModel = isCustomClipModelName(machineLearning.clip.modelName);
    if (
      !onThisServer &&
      !customModel &&
      (await cloudLibraryDestination(this.mlDestinationRepository, MlWorkload.Clip))
    ) {
      await this.cloudLibraryQueue.add({ assetId: asset.id, ownerId: asset.ownerId, workload: 'clip' });
      return JobStatus.Skipped;
    }

    const selection =
      onThisServer || customModel
        ? await this.selectMlDestination({
            workload: MlWorkload.Clip,
            jobId: id,
            jobName: JobName.SmartSearch,
            destinationId: await homeMlDestinationId(this.mlDestinationRepository, MlWorkload.Clip),
          })
        : await this.selectRoutedMlDestination({ workload: MlWorkload.Clip, jobId: id, jobName: JobName.SmartSearch });
    const embedding = await this.machineLearningRepository.encodeImage(
      selection,
      asset.files[0].path,
      machineLearning.clip,
    );
    return this.publishClipEmbedding(asset.id, embedding, {
      modelName: machineLearning.clip.modelName,
      previewPath: asset.files[0].path,
    });
  }

  /**
   * Store one photo's smart search embedding and queue its postprocessing, the same way for this server's
   * own result and a Frameleaf Cloud result (FL-455). Skipped when the model changed since the embedding was
   * made, or the photo's preview is not the one it was made from any more.
   */
  async publishClipEmbedding(
    assetId: string,
    embedding: ClipEmbedding,
    made: { modelName: string; previewPath: string },
  ): Promise<JobStatus> {
    const current = await this.assetJobRepository.getForClipEncoding(assetId);
    if (!current || current.files.length !== 1 || current.files[0].path !== made.previewPath) {
      return JobStatus.Skipped;
    }
    if (current.visibility === AssetVisibility.Hidden) {
      return JobStatus.Skipped;
    }

    if (this.databaseRepository.isBusy(DatabaseLock.CLIPDimSize)) {
      this.logger.verbose(`Waiting for CLIP dimension size to be updated`);
      await this.databaseRepository.wait(DatabaseLock.CLIPDimSize);
    }

    const newConfig = await this.getConfig({ withCache: true });
    if (made.modelName !== newConfig.machineLearning.clip.modelName) {
      // Skip the job if the model has changed since the embedding was generated.
      return JobStatus.Skipped;
    }

    await this.searchRepository.upsert(assetId, embedding);
    await this.jobRepository.collectFollowups(() =>
      this.jobRepository.queue({
        name: JobName.SmartSearchPostprocess,
        data: { id: assetId },
      }),
    );
    return JobStatus.Success;
  }

  @OnJob({ name: JobName.SmartSearchPostprocess, queue: QueueName.SmartSearch })
  async handlePostprocessClip({ id }: JobOf<JobName.SmartSearchPostprocess>): Promise<JobStatus> {
    await this.jobRepository.guardAssetSource(id);
    const read = await this.machineLearningRepository.captureClipRead();
    const asset = await this.assetJobRepository.getForClipEncoding(id);
    const persisted = await this.searchRepository.getEmbedding(id);
    if (!asset || !persisted || asset.visibility === AssetVisibility.Hidden) {
      return JobStatus.Skipped;
    }
    deferJobAdoption(async () => {
      const current = await this.searchRepository.getEmbedding(id);
      if (current?.embedding !== persisted.embedding || current?.producerModelKey !== persisted.producerModelKey) {
        throw new Error('CLIP embedding changed before postprocessing publication');
      }
    });
    await this.zeroShotTaggingService.tagAsset(asset.id, asset.ownerId, persisted.embedding, read);
    await this.classificationService.evaluateAsset(asset.id, asset.ownerId);
    const { reverseGeocoding } = await this.getConfig({ withCache: true });
    if (reverseGeocoding.enabled) {
      await this.jobRepository.queue({ name: JobName.LandmarkInfer, data: { id, trigger: 'embedding' } });
    }
    return JobStatus.Success;
  }
}
