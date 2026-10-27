import { Injectable } from '@nestjs/common';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Transaction } from 'kysely';
import type { MlSelection } from 'src/repositories/machine-learning.repository.js';
import type { CloudDescriptionBatchCreate, MediaOperation } from 'src/repositories/media-operation.repository.js';
import type { MlDestinationRow } from 'src/repositories/ml-destination.repository.js';
import type { DB } from 'src/schema/index.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import {
  AssetStatus,
  AssetVisibility,
  DatabaseLock,
  FrameleafWorker,
  JobName,
  JobStatus,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  MlAdmissionRefusal,
  MlDestinationKind,
  MlWorkload,
  QueueName,
  SystemMetadataKey,
} from 'src/enum.js';
import { afterJobCommit, deferJobAdoption, deferJobFailure, jobSignal, queueExecution } from 'src/queue/context.js';
import { CloudMlGateway, CloudTransferError } from 'src/repositories/frameleaf-cloud-ml.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { PersonService } from 'src/services/person.service.js';
import { SmartInfoService } from 'src/services/smart-info.service.js';
import { CLOUD_DESCRIPTION_TRANSIENT_REFUSALS, nextServerDay } from 'src/utils/cloud-description-batch.js';
import {
  CLOUD_LIBRARY_DEADLINE_SECONDS,
  CLOUD_LIBRARY_INPUT_MAX_BYTES,
  CLOUD_LIBRARY_LEASE_MS,
  CLOUD_LIBRARY_MAX_WAIT_MS,
  CLOUD_LIBRARY_MIN_BATCH,
  CLOUD_LIBRARY_PASS_CRON,
  CLOUD_LIBRARY_POLL_MAX_MS,
  CLOUD_LIBRARY_POLL_MS,
  CLOUD_LIBRARY_STEPS_PER_PASS,
  type CloudLibraryItem,
  CloudLibraryPhase,
  type CloudLibraryResult,
  type CloudLibrarySnapshot,
  type CloudLibraryWorkload,
  appWorkloadOfLibrary,
  cloudLibraryDestination,
  cloudLibraryEstimateBody,
  cloudLibraryIdempotencyKey,
  cloudLibraryPackKey,
  cloudLibraryRequest,
  emptyCloudLibraryResult,
  groupCloudLibraryBatches,
  parseCloudLibraryResult,
  parseCloudLibrarySnapshot,
  toBoundClipResult,
  toBoundFaceResult,
} from 'src/utils/cloud-library-batch.js';
import {
  CloudModelIdentityMismatchError,
  acceptCloudClipResult,
  acceptCloudFaceResult,
  localPinnedProfile,
} from 'src/utils/cloud-model-identity.js';
import { CloudConnectionState, CloudMlGatewayDeps, resolveCloudGateway } from 'src/utils/frameleaf-cloud-gateway.js';
import {
  CloudJobInputError,
  CloudJobInputFile,
  CloudJobRead,
  FrameleafCloudJobClient,
  isTransientTransfer,
} from 'src/utils/frameleaf-cloud-job-client.js';
import {
  CLOUD_LIBRARY_RESULT_MAX_BYTES,
  CloudClipResult,
  CloudFaceResult,
  CloudJobAdmitted,
  CloudJobView,
  CloudUploadTarget,
  FrameleafCloudError,
  clipResultSchema,
  cloudCustomerCost,
  cloudErrorCode,
  estimateUsable,
  faceResultSchema,
  isFinalCloudJobStatus,
  isIdempotencyKeyReused,
  pausedMessageOf,
} from 'src/utils/frameleaf-cloud.js';
import { ImageMetadataStripError, stripImageMetadata } from 'src/utils/image-metadata-strip.js';
import { handlePromiseError } from 'src/utils/misc.js';
import {
  ML_BUDGET_WINDOW_DAYS,
  MlDestinationNotFoundError,
  MlDestinationRefusedError,
  STOPS_CREATED_CLOUD_JOB,
  admissionRefusalOf,
  consentUnconfirmedOf,
  selectMlDestination,
} from 'src/utils/ml-destination.js';
import { serverTimeZone } from 'src/utils/server-time-zone.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
const micros = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

/** Why a step stopped, and whether waiting can help. */
class BatchRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly transient: boolean,
  ) {
    super(message);
  }
}

/** A batch that waits (today's AI Wallet limit, a paused region) until `until`. */
class WaitUntil extends Error {
  constructor(
    readonly until: Date,
    message: string,
  ) {
    super(message);
  }
}

const batchRefusalOf = (error: unknown): BatchRefusal | null => {
  if (error instanceof BatchRefusal) {
    return error;
  }
  if (isIdempotencyKeyReused(error)) {
    return new BatchRefusal('cloud_library_idempotency_key_reused', errorMessage(error), false);
  }
  if (error instanceof CloudTransferError) {
    return new BatchRefusal(
      `cloud_library_${error.failure.replaceAll('-', '_')}`,
      error.message,
      isTransientTransfer(error),
    );
  }
  const refusal =
    error instanceof MlDestinationRefusedError ||
    error instanceof MlDestinationNotFoundError ||
    error instanceof FrameleafCloudError
      ? error.refusal
      : null;
  if (!refusal) {
    return null;
  }
  return new BatchRefusal(
    `cloud_library_${refusal.replaceAll('-', '_')}`,
    errorMessage(error),
    CLOUD_DESCRIPTION_TRANSIENT_REFUSALS.has(refusal),
  );
};

const workName = (workload: CloudLibraryWorkload) => (workload === 'clip' ? 'smart search' : 'faces');

type BatchRun = {
  operation: MediaOperation;
  claimToken: string;
  snapshot: CloudLibrarySnapshot;
  result: CloudLibraryResult;
  now: Date;
};

const total = (run: BatchRun) => run.snapshot.assetIds.length;

/** One output document, read for its photo: the item, or nothing this server can use. */
type LibraryDocument =
  | { workload: 'clip'; result: CloudClipResult; item: CloudClipResult['items'][number] }
  | { workload: 'face'; result: CloudFaceResult; item: CloudFaceResult['items'][number] }
  | { invalid: true };

/**
 * Frameleaf Cloud smart search and faces batches (FL-455).
 *
 * - A photo whose smart search or face job is routed to the Frameleaf Cloud destination waits in a queue
 *   (`cloud-library-batch.ts`). Once an owner has `CLOUD_LIBRARY_MIN_BATCH` photos waiting for one kind of
 *   work, or the oldest waited `CLOUD_LIBRARY_MAX_WAIT_MS`, they become a `cloud_library_batch` media
 *   operation: one cloud job (`clip` or `face`) of at most `CLOUD_LIBRARY_BATCH_SIZE` photos.
 * - The model is the catalogue entry whose identity is this server's own pinned model, and nothing else. A
 *   batch made for one model is refused once that is no longer the match (the model setting changed).
 * - Every batch is admitted through `frameleafCloudEligibility` (linked, entitled, offered, the feature's
 *   consent, budgets), estimated with a sealed estimate, checked against the AI Wallet, the daily cap and the
 *   destination's budget, then submitted with one idempotency key per estimate. The preview each photo's own
 *   job would read is sent with its metadata removed and its pixels untouched.
 * - Each result is accepted only when its model identity is this server's pin, then stored exactly as this
 *   server's own result: the embedding through smart search's own publication, the faces through face
 *   detection's. A refused result is left to this server: the photo's own job runs again here.
 * - Turning processing off, or routing the work elsewhere, stops the batch and gives its photos back to
 *   their own jobs. Locked media never leaves the server.
 */
@Injectable()
export class CloudLibraryBatchService extends BaseService {
  private readonly workerId = `cloud-library-${process.pid}-${Date.now()}`;
  private _smartInfo?: SmartInfoService;
  private _person?: PersonService;

  private get smartInfo(): SmartInfoService {
    this._smartInfo ??= BaseService.create(SmartInfoService, this);
    return this._smartInfo;
  }

  private get person(): PersonService {
    this._person ??= BaseService.create(PersonService, this);
    return this._person;
  }

  @OnEvent({ name: 'AppBootstrap', workers: [FrameleafWorker.Microservices] })
  onBootstrap() {
    this.cronRepository.create({
      name: 'frameleafCloudLibraryBatches',
      expression: CLOUD_LIBRARY_PASS_CRON,
      onTick: () =>
        handlePromiseError(this.jobRepository.queue({ name: JobName.CloudMlLibraryBatch, data: {} }), this.logger),
      start: !!this.configRepository.getEnv().frameleafCloud.url,
    });
  }

  @OnJob({ name: JobName.CloudMlLibraryBatch, queue: QueueName.BackgroundTask })
  async handleBatchPass(): Promise<JobStatus> {
    await this.databaseRepository.withLock(DatabaseLock.FrameleafCloudMlLibraryBatch, () => this.runPass());
    return JobStatus.Success;
  }

  /**
   * One pass: new batches from the queue, the release of cloud jobs
   * whose batch ended while nobody held it, then the next step of up to `CLOUD_LIBRARY_STEPS_PER_PASS`
   * batches.
   */
  async runPass(now = new Date()): Promise<void> {
    const cloudMl = (await this.getConfig({ withCache: false })).frameleafCloud.cloudMl;
    if (cloudMl.enabled) {
      try {
        await this.batchQueued(now);
      } catch (error) {
        this.logger.warn(`Frameleaf Cloud smart search and faces batching did not run: ${errorMessage(error)}`);
      }
    }
    await this.releaseAbandoned();

    for (let step = 0; step < CLOUD_LIBRARY_STEPS_PER_PASS; step++) {
      const claim = await this.mediaOperationRepository.claimNext({
        kinds: [MediaOperationKind.CloudLibraryBatch],
        workerId: this.workerId,
        leaseMs: CLOUD_LIBRARY_LEASE_MS,
      });
      if (!claim) {
        break;
      }
      try {
        await this.step(claim.operation, claim.claimToken, now);
      } catch (error) {
        jobSignal()?.throwIfAborted();
        this.logger.error(`Smart search or faces batch ${claim.operation.id} failed: ${errorMessage(error)}`);
        const outcome = await this.mediaOperationRepository.fail(claim.operation.id, claim.claimToken, {
          error: errorMessage(error),
          errorCode: 'cloud_library_failed',
        });
        if (outcome === 'failed') {
          const snapshot = parseCloudLibrarySnapshot(claim.operation.snapshot);
          await this.handBack({ snapshot, result: parseCloudLibraryResult(claim.operation.result, snapshot.assetIds) });
        }
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Making batches                                                      */
  /* ------------------------------------------------------------------ */

  /** Turn the photos waiting long enough, or numerous enough, into batches per owner and kind of work. */
  async batchQueued(now: Date): Promise<void> {
    await this.databaseRepository.withLock(DatabaseLock.FrameleafCloudMlBatchQueue, async () => {
      const queue = (await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafCloudLibraryQueue)) ?? {
        items: [],
      };
      if (queue.items.length === 0) {
        return;
      }
      const config = await this.getConfig({ withCache: true });
      const taken = new Set<string>();
      const operations: CloudDescriptionBatchCreate[] = [];
      const backHome: Array<{ workload: CloudLibraryWorkload; assetId: string }> = [];

      for (const workload of ['clip', 'face'] as const) {
        const waiting = queue.items.filter((item) => item.workload === workload);
        if (waiting.length === 0) {
          continue;
        }
        const appWorkload = appWorkloadOfLibrary(workload);
        const destination = await cloudLibraryDestination(this.mlDestinationRepository, appWorkload);
        if (!destination) {
          // the work is routed elsewhere now: the photos go back to their own jobs
          for (const item of waiting) {
            taken.add(`${workload}:${item.assetId}`);
            backHome.push({ workload, assetId: item.assetId });
          }
          continue;
        }
        const modelSku = destination.lastProbeCloud?.localModels?.[appWorkload];
        if (!modelSku) {
          // nothing offered with this server's model at the last check: they wait for the next check
          continue;
        }
        const modelName =
          workload === 'clip'
            ? config.machineLearning.clip.modelName
            : config.machineLearning.facialRecognition.modelName;

        const perOwner = new Map<string, typeof waiting>();
        for (const item of waiting) {
          perOwner.set(item.ownerId, [...(perOwner.get(item.ownerId) ?? []), item]);
        }
        const open = await this.mediaOperationRepository.getOpenCloudLibraryAssetIds(workload);
        for (const items of perOwner.values()) {
          const ready =
            items.length >= CLOUD_LIBRARY_MIN_BATCH ||
            now.getTime() - Date.parse(items[0].queuedAt) >= CLOUD_LIBRARY_MAX_WAIT_MS;
          if (!ready) {
            continue;
          }
          for (const item of items) {
            taken.add(`${workload}:${item.assetId}`);
          }
          const candidates = items.filter((item) => !open.has(item.assetId));
          for (const batch of groupCloudLibraryBatches(candidates)) {
            operations.push(this.batchRow(workload, destination, modelSku, modelName, batch));
          }
        }
      }
      if (taken.size === 0) {
        return;
      }
      await this.mediaOperationRepository.createCloudDescriptionBatches(operations, (tx) =>
        new SystemMetadataRepository(tx).set(SystemMetadataKey.FrameleafCloudLibraryQueue, {
          items: queue.items.filter((item) => !taken.has(`${item.workload}:${item.assetId}`)),
        }),
      );
      if (operations.length > 0) {
        this.logger.log(`Queued ${operations.length} Frameleaf Cloud smart search or faces batches`);
      }
      await this.backToTheirJobs(backHome, false);
    });
  }

  private batchRow(
    workload: CloudLibraryWorkload,
    destination: MlDestinationRow,
    modelSku: string,
    modelName: string,
    { ownerId, assetIds }: { ownerId: string; assetIds: string[] },
  ): CloudDescriptionBatchCreate {
    const snapshot: CloudLibrarySnapshot = {
      version: 1,
      workload,
      destinationId: destination.id,
      assetIds,
      modelSku,
      modelName,
      packKey: cloudLibraryPackKey(workload, modelSku),
    };
    const photos = `${assetIds.length} ${assetIds.length === 1 ? 'photo' : 'photos'}`;
    return {
      ownerId,
      kind: MediaOperationKind.CloudLibraryBatch,
      destination: MediaOperationDestination.FrameleafCloud,
      destinationDetail: destination.name,
      label:
        workload === 'clip'
          ? `Prepare smart search for ${photos} with Frameleaf Cloud`
          : `Find faces in ${photos} with Frameleaf Cloud`,
      assetId: assetIds.length === 1 ? assetIds[0] : null,
      resultAssetId: null,
      retryOfId: null,
      projectId: null,
      revisionId: null,
      snapshot: snapshot as unknown as Record<string, unknown>,
      settings: { workload, photos: assetIds.length, model: modelSku },
      estimate: null,
      result: emptyCloudLibraryResult(assetIds) as unknown as Record<string, unknown>,
      totalUnits: String(assetIds.length),
    };
  }

  /**
   * Give photos back to their own jobs. `onThisServer` runs them on this server whatever the route says
   * (a Frameleaf Cloud result was refused); otherwise they run wherever they are routed now.
   */
  private async backToTheirJobs(
    items: ReadonlyArray<{ workload: CloudLibraryWorkload; assetId: string }>,
    onThisServer: boolean,
  ) {
    if (items.length === 0) {
      return;
    }
    await this.jobRepository.queueAll(
      items.map(({ workload, assetId }) =>
        workload === 'clip'
          ? ({ name: JobName.SmartSearch, data: { id: assetId, ...(onThisServer && { onThisServer }) } } as const)
          : ({ name: JobName.AssetDetectFaces, data: { id: assetId, ...(onThisServer && { onThisServer }) } } as const),
      ),
    );
  }

  /* ------------------------------------------------------------------ */
  /* Steps                                                               */
  /* ------------------------------------------------------------------ */

  async step(operation: MediaOperation, claimToken: string, now: Date): Promise<void> {
    let snapshot: CloudLibrarySnapshot;
    try {
      snapshot = parseCloudLibrarySnapshot(operation.snapshot);
    } catch (error) {
      await this.mediaOperationRepository.fail(
        operation.id,
        claimToken,
        { error: errorMessage(error), errorCode: 'cloud_library_snapshot_invalid' },
        { retry: false },
      );
      return;
    }
    const run: BatchRun = {
      operation,
      claimToken,
      snapshot,
      result: parseCloudLibraryResult(operation.result, snapshot.assetIds),
      now,
    };

    const config = await this.getConfig({ withCache: false });
    const routed = await cloudLibraryDestination(this.mlDestinationRepository, appWorkloadOfLibrary(snapshot.workload));
    if (!config.frameleafCloud.cloudMl.enabled || routed?.id !== snapshot.destinationId) {
      await this.stopTurnedOff(run);
      return;
    }

    const resolution = await resolveCloudGateway(this.gatewayDeps());
    if (resolution.state !== CloudConnectionState.Ready) {
      const transient = resolution.state === CloudConnectionState.Unavailable;
      if (transient && run.result.phase === CloudLibraryPhase.Submitted) {
        run.result = {
          ...run.result,
          waiting: { refusal: 'cloud_library_unavailable', detail: resolution.detail, at: now.toISOString() },
        };
        if (await this.save(run)) {
          await this.wait(run, CLOUD_LIBRARY_POLL_MS);
        }
        return;
      }
      await this.refuse(run, new BatchRefusal('cloud_library_unavailable', resolution.detail, transient));
      return;
    }
    const gateway = resolution.gateway;

    try {
      switch (run.result.phase) {
        case CloudLibraryPhase.Queued: {
          await this.estimate(run, gateway);
          return;
        }
        case CloudLibraryPhase.Estimated: {
          await this.resume(run, gateway);
          return;
        }
        case CloudLibraryPhase.Submitted: {
          await this.poll(run, gateway);
          return;
        }
        case CloudLibraryPhase.Finished: {
          await this.mediaOperationRepository.fail(
            operation.id,
            claimToken,
            { error: 'This batch had already ended', errorCode: 'cloud_library_ended' },
            { retry: false },
          );
          return;
        }
      }
    } catch (error) {
      const refusal = error instanceof WaitUntil ? error : (this.pausedWait(run, error) ?? batchRefusalOf(error));
      if (!refusal) {
        throw error;
      }
      await this.refuse(run, refusal);
    }
  }

  /**
   * Processing turned off, or the work routed elsewhere: a started cloud job is cancelled and released, the
   * batch fails with the reason, and its photos go back to their own jobs, which run where they are routed.
   */
  private async stopTurnedOff(run: BatchRun) {
    const job = run.result.job;
    if (job) {
      const resolution = await resolveCloudGateway(this.gatewayDeps());
      if (resolution.state === CloudConnectionState.Ready) {
        await this.release(resolution.gateway, run.operation.id, job.jobId, true);
      }
    }
    const failed = await this.mediaOperationRepository.fail(
      run.operation.id,
      run.claimToken,
      {
        error: `Frameleaf Cloud processing is turned off, or ${workName(run.snapshot.workload)} is routed elsewhere now. Nothing more is sent; the photos run where they are routed.`,
        errorCode: 'cloud_library_turned_off',
      },
      { retry: false },
    );
    if (failed) {
      await this.backToTheirJobs(
        run.result.items
          .filter((item) => !item.outcome)
          .map(({ assetId }) => ({ workload: run.snapshot.workload, assetId })),
        false,
      );
    }
  }

  /** Prepare the batch's previews (metadata removed, pixels untouched), admit it and ask for a sealed estimate. */
  private async estimate(run: BatchRun, gateway: CloudMlGateway) {
    const { operation, snapshot } = run;
    const locked = await this.mediaOperationRepository.getLockedAssetIds(operation.ownerId, snapshot.assetIds);
    const folder = join(tmpdir(), 'frameleaf-cloud-library', operation.id);
    this.storageRepository.mkdirSync(folder);
    const items: CloudLibraryItem[] = [];
    try {
      for (const item of run.result.items) {
        items.push(await this.prepareItem(snapshot.workload, item, operation.ownerId, locked, folder));
      }
    } finally {
      await this.storageRepository.unlinkDir(folder, { recursive: true, force: true });
    }
    run.result = { ...run.result, items };
    // A photo whose preview could not be made ready for the cloud is still one this server's own job can read.
    await this.backToTheirJobs(
      items
        .filter((item) => item.refused === 'unsupported' || item.refused === 'prepare-failed')
        .map(({ assetId }) => ({ workload: snapshot.workload, assetId })),
      true,
    );
    const inputs = items.filter((item) => !item.refused);
    if (inputs.length === 0) {
      await this.finishEmpty(run);
      return;
    }

    await this.admitBatch(run);
    const request = await this.request(snapshot);
    const estimate = await this.frameleafCloudMlRepository.createEstimate(
      gateway,
      cloudLibraryEstimateBody(
        snapshot.workload,
        snapshot.modelSku,
        inputs.map((item) => this.toInput(item)),
        request,
      ),
    );
    const estimates = run.result.estimates + 1;
    run.result = {
      ...run.result,
      phase: CloudLibraryPhase.Estimated,
      estimates,
      submission: {
        idempotencyKey: cloudLibraryIdempotencyKey(snapshot.workload, operation.id, estimates),
        estimate: estimate.estimate,
        expiresAt: estimate.expiresAt,
        modelRev: estimate.modelRev,
        computeSku: estimate.computeSku,
        p50Usd: cloudCustomerCost(estimate).p50,
        p90Usd: cloudCustomerCost(estimate).p90,
        holdUsd: cloudCustomerCost(estimate).hold,
        startupUsd: estimate.cost.startup,
        request,
        attemptedAt: null,
      },
      waiting: null,
    };
    await this.preflight(run, gateway, cloudCustomerCost(estimate).hold);
    if (await this.save(run)) {
      await this.submit(run, gateway);
    }
  }

  /** The request: the model this server expects, and for faces its own detection threshold. */
  private async request(snapshot: CloudLibrarySnapshot) {
    const { facialRecognition } = (await this.getConfig({ withCache: true })).machineLearning;
    return cloudLibraryRequest(snapshot.workload, snapshot.modelName, facialRecognition.minScore);
  }

  /** An estimated batch: a sent submission is replayed first; otherwise everything is checked again. */
  private async resume(run: BatchRun, gateway: CloudMlGateway) {
    const submission = run.result.submission;
    if (!submission) {
      await this.reestimate(run);
      return;
    }
    if (await this.inputsChanged(run)) {
      if (submission.attemptedAt) {
        throw new BatchRefusal(
          'cloud_library_photos_changed',
          'A photo of this batch was Locked, removed or changed after the batch was sent; nothing more is sent',
          false,
        );
      }
      await this.reestimate(run);
      return;
    }
    await this.admitBatch(run);
    await this.preflight(run, gateway, submission.holdUsd);
    await this.submit(run, gateway);
  }

  /** Whether a photo the batch would send changed: Locked, gone, hidden, or another preview or original now. */
  private async inputsChanged(run: BatchRun): Promise<boolean> {
    const sent = run.result.items.filter((item) => !item.refused);
    const locked = await this.mediaOperationRepository.getLockedAssetIds(
      run.operation.ownerId,
      sent.map(({ assetId }) => assetId),
    );
    for (const item of sent) {
      if (locked.has(item.assetId)) {
        return true;
      }
      const source = await this.source(run.snapshot.workload, item.assetId, run.operation.ownerId);
      if (
        !source ||
        'refused' in source ||
        source.previewPath !== item.previewPath ||
        source.checksum !== item.checksum
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * FL-201: before a created job's photos leave this server, admission runs again. A refusal that means the
   * photos may no longer be sent cancels and releases the cloud job; wallet, cap and model refusals do not
   * stop a job the cloud already accepted.
   */
  private async readmitBatch(run: BatchRun, gateway: CloudMlGateway, jobId: string) {
    try {
      await this.admitBatch(run, true);
    } catch (error) {
      const refusal = admissionRefusalOf(error);
      const stops =
        (refusal !== null && STOPS_CREATED_CLOUD_JOB.has(refusal)) ||
        (error instanceof BatchRefusal && error.code === 'cloud_library_not_cloud');
      if (stops) {
        await this.release(gateway, run.operation.id, jobId, true);
        throw error;
      }
      if (batchRefusalOf(error)?.transient) {
        throw error;
      }
      if (!refusal || consentUnconfirmedOf(error)) {
        throw new BatchRefusal(
          'cloud_library_consent_unconfirmed',
          `The consent in force could not be confirmed (${errorMessage(error)}); no photo was sent, it is tried again`,
          true,
        );
      }
    }
  }

  /**
   * Admission through `frameleafCloudEligibility`, with the kill switch. The model is the one matching this
   * server's pin now; a batch made for another model is refused, never sent with it.
   */
  private async admitBatch(run: BatchRun, createdCloudJob = false): Promise<MlSelection> {
    const selection = await selectMlDestination(
      {
        mlDestinationRepository: this.mlDestinationRepository,
        machineLearningRepository: this.machineLearningRepository,
        cloudMlSettings: async () => (await this.getConfig({ withCache: false })).frameleafCloud.cloudMl,
      },
      {
        workload: appWorkloadOfLibrary(run.snapshot.workload),
        destinationId: run.snapshot.destinationId,
        jobId: run.operation.id,
        jobName: JobName.CloudMlLibraryBatch,
        createdCloudJob,
      },
    );
    if (selection.kind !== MlDestinationKind.FrameleafCloud) {
      throw new BatchRefusal(
        'cloud_library_not_cloud',
        'The destination this batch was made for is not Frameleaf Cloud any more; nothing was sent',
        false,
      );
    }
    if (!createdCloudJob && selection.cloudModelId !== run.snapshot.modelSku) {
      throw new BatchRefusal(
        'cloud_library_model_changed',
        "Frameleaf Cloud no longer offers this server's own model for this batch; nothing was sent",
        false,
      );
    }
    return selection;
  }

  /** The photo as its own job reads it: the preview and the original's checksum, or null when it may not go. */
  private async source(
    workload: CloudLibraryWorkload,
    assetId: string,
    ownerId: string,
  ): Promise<{ previewPath: string; checksum: string } | { refused: string } | null> {
    const asset = await this.assetJobRepository.getForImageEnrichment(assetId);
    if (!asset || asset.ownerId !== ownerId || asset.deletedAt || asset.status !== AssetStatus.Active) {
      return null;
    }
    if (asset.visibility === AssetVisibility.Hidden) {
      return { refused: 'hidden' };
    }
    if (workload === 'clip') {
      const clip = await this.assetJobRepository.getForClipEncoding(assetId);
      const path = clip?.files.length === 1 ? clip.files[0].path : null;
      return path ? { previewPath: path, checksum: '' } : { refused: 'no-preview' };
    }
    const faces = await this.assetJobRepository.getForDetectFacesJob(assetId);
    const preview = faces?.files.find((file) => file.isEdited) ?? faces?.files[0];
    return preview && faces
      ? { previewPath: preview.path, checksum: faces.checksum.toString('hex') }
      : { refused: 'no-preview' };
  }

  /**
   * The upload copy of one photo: exactly the preview its own job reads, with its metadata removed and its
   * pixels untouched, so the cloud sees the pixels this server's ML service would.
   */
  private async prepareItem(
    workload: CloudLibraryWorkload,
    item: CloudLibraryItem,
    ownerId: string,
    locked: Set<string>,
    folder: string,
  ): Promise<CloudLibraryItem> {
    const base = { assetId: item.assetId, inputId: item.inputId };
    if (locked.has(item.assetId)) {
      return { ...base, refused: 'locked' };
    }
    const source = await this.source(workload, item.assetId, ownerId);
    if (!source) {
      return { ...base, refused: 'not-found' };
    }
    if ('refused' in source) {
      return { ...base, refused: source.refused };
    }
    try {
      const stripped = stripImageMetadata(await this.storageRepository.readFile(source.previewPath));
      if (stripped.data.length > CLOUD_LIBRARY_INPUT_MAX_BYTES) {
        return { ...base, refused: 'unsupported' };
      }
      const output = join(folder, `${item.inputId}.bin`);
      await this.storageRepository.createOrOverwriteFile(output, stripped.data);
      const { sha256, sizeInBytes } = await this.cryptoRepository.hashFileDigests(output);
      return {
        ...base,
        sha256: sha256.toString('hex'),
        bytes: sizeInBytes,
        contentType: stripped.contentType,
        previewPath: source.previewPath,
        checksum: source.checksum,
      };
    } catch (error) {
      if (error instanceof ImageMetadataStripError) {
        return { ...base, refused: 'unsupported' };
      }
      this.logger.warn(`Could not prepare photo ${item.assetId} for Frameleaf Cloud: ${errorMessage(error)}`);
      return { ...base, refused: 'prepare-failed' };
    }
  }

  private toInput(item: CloudLibraryItem) {
    return { inputId: item.inputId, contentType: item.contentType!, bytes: item.bytes!, sha256: item.sha256! };
  }

  /**
   * The checks every batch passes before it is submitted: the AI Wallet can hold the estimate, the account's
   * daily cap leaves room for it (else it waits for tomorrow), and the destination's budget, with what running
   * batches hold, covers it.
   */
  private async preflight(run: BatchRun, gateway: CloudMlGateway, hold: number) {
    const wallet = await this.frameleafCloudMlRepository.getWallet(gateway);
    const available = wallet.balanceUsd - wallet.heldUsd;
    if (hold > available) {
      throw new BatchRefusal(
        'cloud_library_wallet_insufficient',
        `This batch needs $${hold.toFixed(2)} held and the AI Wallet has $${Math.max(0, available).toFixed(2)} available. Nothing was sent.`,
        false,
      );
    }
    if (wallet.dailyCapUsd !== null && wallet.spentTodayUsd + hold > wallet.dailyCapUsd) {
      throw new WaitUntil(
        nextServerDay(run.now, serverTimeZone((await this.getConfig({ withCache: true })).server)),
        "Today's AI Wallet limit is reached; this batch waits for tomorrow",
      );
    }
    const destination = await this.mlDestinationRepository.getById(run.snapshot.destinationId);
    if (destination && destination.budgetLimitUsd !== null) {
      const since = new Date(run.now.getTime() - ML_BUDGET_WINDOW_DAYS * DAY_MS);
      const [spent, held] = await Promise.all([
        this.mlDestinationRepository.getSpend(destination.id, since),
        this.mediaOperationRepository.sumCloudDescriptionOpenHolds(destination.id, since, [
          MediaOperationKind.CloudDescriptionBatch,
          MediaOperationKind.CloudLibraryBatch,
        ]),
      ]);
      if (spent + held + hold > destination.budgetLimitUsd) {
        throw new BatchRefusal(
          'cloud_library_budget_exceeded',
          `${destination.name} has $${Math.max(0, destination.budgetLimitUsd - spent - held).toFixed(2)} left of its spending limit, less than this batch needs held. Nothing was sent.`,
          false,
        );
      }
    }
  }

  /** Submit: one cloud job for the batch, its attempt recorded first so a replay never makes a second one. */
  private async submit(run: BatchRun, gateway: CloudMlGateway) {
    const { operation, snapshot, now } = run;
    const submission = run.result.submission;
    if (
      !submission ||
      (!submission.attemptedAt && !estimateUsable({ expiresAt: submission.expiresAt }, now.getTime()))
    ) {
      await this.reestimate(run);
      return;
    }
    if (!submission.attemptedAt) {
      run.result = { ...run.result, submission: { ...submission, attemptedAt: now.toISOString() } };
      if (!(await this.save(run))) {
        return;
      }
    }
    let admitted: CloudJobAdmitted;
    try {
      admitted = await this.frameleafCloudMlRepository.createJob(
        gateway,
        this.jobBody(operation.id, snapshot, run.result, submission),
        submission.idempotencyKey,
      );
    } catch (error) {
      if (isIdempotencyKeyReused(error)) {
        this.logger.error(`Smart search or faces batch ${operation.id}: ${errorMessage(error)}`);
        throw error;
      }
      if (
        error instanceof FrameleafCloudError &&
        error.refusal === MlAdmissionRefusal.ModelMismatch &&
        run.result.estimates < 3
      ) {
        await this.reestimate(run);
        return;
      }
      throw error;
    }
    if (!(await this.mediaOperationRepository.setRemoteJobId(operation.id, run.claimToken, admitted.jobId))) {
      this.logger.warn(
        `Smart search or faces batch ${operation.id}: claim lost after its job ${admitted.jobId} was admitted`,
      );
      await this.mediaOperationRepository.recordRemoteJobId(operation.id, admitted.jobId);
      await this.release(gateway, operation.id, admitted.jobId, true);
      return;
    }
    const inputs = run.result.items.filter((item) => !item.refused);
    await this.mlDestinationRepository.recordCloudJobAccounting({
      destinationId: snapshot.destinationId,
      destinationKind: MlDestinationKind.FrameleafCloud,
      workload: appWorkloadOfLibrary(snapshot.workload),
      jobId: operation.id,
      jobName: snapshot.workload === 'clip' ? JobName.SmartSearch : JobName.AssetDetectFaces,
      bytesSent: inputs.reduce((sum, item) => sum + (item.bytes ?? 0), 0),
      bytesReceived: 0,
      durationMs: 0,
      outcome: 'success',
      costUsd: null,
      startedAt: now,
      finishedAt: now,
      cloudJobId: admitted.jobId,
    });
    run.result = {
      ...run.result,
      phase: CloudLibraryPhase.Submitted,
      job: {
        jobId: admitted.jobId,
        status: admitted.status,
        holdUsd: admitted.hold.amountUsd,
        ceilingUsd: admitted.hold.ceilingUsd,
        admittedAt: admitted.createdAt,
        meteredSeconds: null,
        started: false,
        etag: null,
      },
      waiting: null,
    };
    if (await this.save(run)) {
      await this.transfer(run, gateway, admitted.uploads ?? null);
    }
  }

  /** The `POST /v2/jobs` body, the same every time it is sent or replayed. */
  private jobBody(
    operationId: string,
    snapshot: CloudLibrarySnapshot,
    result: CloudLibraryResult,
    submission: NonNullable<CloudLibraryResult['submission']>,
  ) {
    const { workload, request, ...body } = cloudLibraryEstimateBody(
      snapshot.workload,
      snapshot.modelSku,
      result.items.filter((item) => !item.refused).map((item) => this.toInput(item)),
      submission.request,
    );
    const job = {
      ...body,
      estimate: submission.estimate,
      modelRev: submission.modelRev,
      clientRef: `library-${operationId}`,
      packKey: snapshot.packKey,
      deadlineSeconds: CLOUD_LIBRARY_DEADLINE_SECONDS,
    };
    return workload === 'clip'
      ? { ...job, workload, request: { model: request.model } }
      : { ...job, workload, request };
  }

  private async reestimate(run: BatchRun) {
    run.result = { ...run.result, phase: CloudLibraryPhase.Queued, submission: null };
    if (await this.save(run)) {
      await this.wait(run, 0);
    }
  }

  /** Upload the previews to the admitted job's storage and start it; a photo that changed stops the batch. */
  private async transfer(run: BatchRun, gateway: CloudMlGateway, given: CloudUploadTarget[] | null) {
    const job = run.result.job!;
    const client = this.jobClient(gateway);
    const folder = join(tmpdir(), 'frameleaf-cloud-library', `${run.operation.id}-upload`);
    this.storageRepository.mkdirSync(folder);
    try {
      const files = await this.prepareUploads(run, folder);
      let outcome: Awaited<ReturnType<FrameleafCloudJobClient['upload']>>;
      try {
        outcome = await client.upload(job.jobId, files, structuredClone(run.result.uploads), {
          given,
          now: run.now,
          record: async (state) => {
            run.result = { ...run.result, uploads: structuredClone(state) };
            if (!(await this.save(run))) {
              return false;
            }
            await this.readmitBatch(run, gateway, job.jobId);
            return true;
          },
        });
      } catch (error) {
        if (error instanceof CloudJobInputError) {
          throw new BatchRefusal('cloud_library_input_refused', error.message, false);
        }
        throw error;
      }
      if (outcome === 'stopped') {
        return;
      }
      if (outcome === 'uploaded') {
        try {
          await this.readmitBatch(run, gateway, job.jobId);
          await client.start(job.jobId);
        } catch (error) {
          if (cloudErrorCode(error) !== 'inputs-missing') {
            throw error;
          }
          const uploads = Object.fromEntries(
            Object.entries(run.result.uploads).map(([id, state]) => [id, { ...state, done: false }]),
          );
          run.result = { ...run.result, uploads };
          throw new BatchRefusal('cloud_library_inputs_missing', 'Frameleaf Cloud did not have every photo yet', true);
        }
      }
      run.result = { ...run.result, job: { ...job, started: true }, waiting: null };
      if (await this.save(run)) {
        await this.wait(run, CLOUD_LIBRARY_POLL_MS);
      }
    } finally {
      await this.storageRepository.unlinkDir(folder, { recursive: true, force: true });
    }
  }

  /** The upload copies not uploaded yet, each checked against what the job was admitted with. */
  private async prepareUploads(run: BatchRun, folder: string): Promise<CloudJobInputFile[]> {
    const sent = run.result.items.filter((item) => !item.refused);
    const pending = sent.filter((item) => !run.result.uploads[item.inputId]?.done);
    const locked = await this.mediaOperationRepository.getLockedAssetIds(
      run.operation.ownerId,
      pending.map(({ assetId }) => assetId),
    );
    const changed = () =>
      new BatchRefusal(
        'cloud_library_photos_changed',
        'A photo of this batch was Locked, removed or changed after the batch was sent; nothing more is sent',
        false,
      );
    const files: CloudJobInputFile[] = [];
    for (const item of sent) {
      const path = join(folder, `${item.inputId}.bin`);
      const input = { inputId: item.inputId, sha256: item.sha256!, bytes: item.bytes!, path };
      if (!pending.includes(item)) {
        files.push(input);
        continue;
      }
      if (locked.has(item.assetId)) {
        throw changed();
      }
      const prepared = await this.prepareItem(run.snapshot.workload, item, run.operation.ownerId, locked, folder);
      if (prepared.refused || prepared.sha256 !== item.sha256 || prepared.bytes !== item.bytes) {
        throw changed();
      }
      files.push(input);
    }
    return files;
  }

  /** Read the job with its ETag and act on where it is: uploads, a later read, or collecting an ended job. */
  private async poll(run: BatchRun, gateway: CloudMlGateway) {
    const job = run.result.job;
    if (!job) {
      throw new BatchRefusal('cloud_library_no_job', 'This batch has no cloud job to read', false);
    }
    if (!job.started) {
      await this.readmitBatch(run, gateway, job.jobId);
      await this.transfer(run, gateway, null);
      return;
    }
    let read: CloudJobRead;
    try {
      const ended = isFinalCloudJobStatus(job.status as CloudJobView['status']);
      read = await this.jobClient(gateway).read(job.jobId, ended ? null : job.etag, {
        defaultMs: CLOUD_LIBRARY_POLL_MS,
        maxMs: CLOUD_LIBRARY_POLL_MAX_MS,
      });
    } catch (error) {
      const refusal = batchRefusalOf(error);
      if (!refusal?.transient) {
        throw error;
      }
      run.result = {
        ...run.result,
        waiting: { refusal: refusal.code, detail: refusal.message, at: run.now.toISOString() },
      };
      if (await this.save(run)) {
        await this.wait(run, CLOUD_LIBRARY_POLL_MS);
      }
      return;
    }
    const view = read.view;
    if (!view) {
      await this.wait(run, read.delayMs);
      return;
    }
    run.result = {
      ...run.result,
      job: { ...job, status: view.status, meteredSeconds: view.run.meteredSeconds, etag: read.etag },
      waiting: null,
    };
    if (!(await this.save(run))) {
      return;
    }
    if (!isFinalCloudJobStatus(view.status)) {
      const progress = view.progress;
      await this.mediaOperationRepository.reportProgress(run.operation.id, run.claimToken, {
        status: view.status === 'running' ? MediaOperationStatus.Rendering : MediaOperationStatus.Preparing,
        processedUnits: progress?.done ?? 0,
        totalUnits: total(run),
        progress: progress && progress.total > 0 ? Math.min(99, Math.round((progress.done / progress.total) * 100)) : 0,
      });
      await this.wait(run, read.delayMs);
      return;
    }
    await this.collect(run, gateway, view);
  }

  /**
   * An ended job: each output is downloaded, checked against its SHA-256, read, and accepted only when its
   * model identity is this server's pin; then stored through the same publication this server's own result
   * uses. A photo whose result was refused runs again here; one photo never fails the batch. The job is
   * released only once every photo is written.
   */
  private async collect(run: BatchRun, gateway: CloudMlGateway, view: CloudJobView) {
    const job = run.result.job!;
    const outputs = view.result?.outputs ?? [];
    const delivered = (view.status === 'completed' || view.status === 'cancelled_budget') && outputs.length > 0;
    deferJobFailure(async (tx) => {
      await this.mediaOperationRepository.requeue(
        run.operation.id,
        run.claimToken,
        { delayMs: CLOUD_LIBRARY_POLL_MS, returnAttempt: true },
        undefined,
        tx,
      );
    });
    if (view.cost && run.result.settledUsd !== view.cost.totalUsd) {
      await this.mlDestinationRepository.applySettlements([
        { cloudJobId: job.jobId, costUsd: view.cost.totalUsd, credits: null },
      ]);
      const sent = run.result.items.filter((item) => !item.refused);
      const share = sent.length > 0 ? micros(view.cost.totalUsd / sent.length) : 0;
      run.result = {
        ...run.result,
        settledUsd: view.cost.totalUsd,
        items: run.result.items.map((item) => (item.refused ? item : { ...item, costShareUsd: share })),
      };
    }
    const documents = delivered ? await this.downloadResults(run, gateway, view) : new Map<string, LibraryDocument>();
    const items: CloudLibraryItem[] = [];
    const local: Array<{ workload: CloudLibraryWorkload; assetId: string }> = [];
    const context = queueExecution.getStore();
    const adoptionStart = context?.adoptions.length ?? 0;
    let adoptions: NonNullable<typeof context>['adoptions'] = [];
    try {
      for (const item of run.result.items) {
        if (item.refused || item.outcome) {
          items.push(item);
          continue;
        }
        const written = await this.writeResult(
          run.snapshot,
          item,
          delivered ? (documents.get(item.inputId) ?? null) : null,
        );
        if (written.outcome === 'local' || written.outcome === 'failed') {
          local.push({ workload: run.snapshot.workload, assetId: item.assetId });
        }
        items.push(written);
      }
    } finally {
      adoptions = context?.adoptions.splice(adoptionStart) ?? [];
    }
    const commit = async (tx?: Transaction<DB>) => {
      if (!(await this.mediaOperationRepository.beginValidation(run.operation.id, run.claimToken, true, tx))) {
        throw new Error('Smart search or faces batch claim changed before adoption');
      }
      for (const adopt of adoptions) {
        await adopt(tx!);
      }
      run.result = { ...run.result, items, phase: CloudLibraryPhase.Finished };
      const written = await this.mediaOperationRepository.setBulkResult(
        run.operation.id,
        run.claimToken,
        {
          result: run.result as unknown as Record<string, unknown>,
          processedUnits: total(run),
          totalUnits: total(run),
          progress: 100,
          leaseMs: CLOUD_LIBRARY_LEASE_MS,
        },
        tx,
      );
      if (
        !written ||
        written.cancelRequestedAt ||
        written.pauseRequestedAt ||
        written.status === MediaOperationStatus.Cancelling
      ) {
        throw new Error('Smart search or faces batch claim changed during adoption');
      }
      const stored = items.filter((item) => item.outcome === 'stored').length;
      const settled =
        stored > 0
          ? await this.mediaOperationRepository.complete(
              run.operation.id,
              run.claimToken,
              { resultAssetId: null },
              tx,
              true,
            )
          : await this.mediaOperationRepository.fail(
              run.operation.id,
              run.claimToken,
              delivered
                ? {
                    errorCode: 'cloud_library_nothing_stored',
                    error: `Frameleaf Cloud returned no usable ${workName(run.snapshot.workload)} result in this batch; the photos run on this server instead.`,
                  }
                : {
                    errorCode: `cloud_library_job_${(view.error?.code ?? view.status).replaceAll('-', '_')}`,
                    error:
                      view.error?.message ??
                      `Frameleaf Cloud ended this batch (${view.status.replaceAll('_', ' ')}). The photos run on this server instead.`,
                  },
              { retry: false, executor: tx },
            );
      if (!settled) {
        throw new Error('Smart search or faces batch could not settle its adopted results');
      }
      await afterJobCommit(async () => {
        await this.release(gateway, run.operation.id, job.jobId, false);
        // FL-455: a refused or missing result is made on this server, never with another cloud model
        await this.backToTheirJobs(local, true);
      });
    };
    if (!deferJobAdoption(commit)) {
      await commit();
    }
  }

  /** Download the outputs and read each for its own photo; one that cannot be read is `invalid`. */
  private async downloadResults(
    run: BatchRun,
    gateway: CloudMlGateway,
    view: CloudJobView,
  ): Promise<Map<string, LibraryDocument>> {
    const sent = new Set(run.result.items.filter((item) => !item.refused && !item.outcome).map((item) => item.inputId));
    const outputs = (view.result?.outputs ?? []).filter(
      (output) => sent.has(output.outputId) && output.bytes <= CLOUD_LIBRARY_RESULT_MAX_BYTES,
    );
    const folder = join(tmpdir(), 'frameleaf-cloud-library', `${run.operation.id}-results`);
    this.storageRepository.mkdirSync(folder);
    const documents = new Map<string, LibraryDocument>();
    for (const inputId of sent) {
      documents.set(inputId, { invalid: true });
    }
    try {
      let files: string[] | null;
      try {
        files = await this.jobClient(gateway).download(view, outputs, folder, {
          done: [],
          exists: (file) => this.storageRepository.checkFileExists(file),
          remove: (file) => this.storageRepository.unlink(file).catch(() => {}),
          fileName: (output) => `${output.outputId}.json`,
          record: () => Promise.resolve(true),
        });
      } catch (error) {
        if (error instanceof CloudTransferError && error.failure === 'sha256-mismatch') {
          throw new BatchRefusal(
            'cloud_library_output_sha256_mismatch',
            'A result from Frameleaf Cloud did not match its SHA-256 and was not kept',
            true,
          );
        }
        throw error;
      }
      for (const [index, output] of outputs.entries()) {
        documents.set(output.outputId, await this.readResult(run.snapshot, files?.[index], output.outputId));
      }
    } finally {
      await this.storageRepository.unlinkDir(folder, { recursive: true, force: true });
    }
    return documents;
  }

  private async readResult(
    snapshot: CloudLibrarySnapshot,
    file: string | undefined,
    inputId: string,
  ): Promise<LibraryDocument> {
    if (!file) {
      return { invalid: true };
    }
    try {
      const json: unknown = JSON.parse((await this.storageRepository.readFile(file)).toString('utf8'));
      if (snapshot.workload === 'clip') {
        const parsed = clipResultSchema.safeParse(json);
        const item =
          parsed.success && parsed.data.modelSku === snapshot.modelSku
            ? parsed.data.items.find((entry) => entry.inputId === inputId)
            : undefined;
        return item && parsed.success ? { workload: 'clip', result: parsed.data, item } : { invalid: true };
      }
      const parsed = faceResultSchema.safeParse(json);
      const item =
        parsed.success && parsed.data.modelSku === snapshot.modelSku
          ? parsed.data.items.find((entry) => entry.inputId === inputId)
          : undefined;
      return item && parsed.success ? { workload: 'face', result: parsed.data, item } : { invalid: true };
    } catch {
      return { invalid: true };
    }
  }

  /**
   * Store one photo's result and say what became of it. Never throws: one photo never fails the batch. The
   * identity guard runs first: a result made by another model than this server's pin is left to this server.
   */
  private async writeResult(
    snapshot: CloudLibrarySnapshot,
    item: CloudLibraryItem,
    document: LibraryDocument | null,
  ): Promise<CloudLibraryItem> {
    if (!document || 'invalid' in document) {
      return { ...item, outcome: 'local', error: 'Frameleaf Cloud returned no readable result for this photo' };
    }
    const warnings = [...document.item.warnings];
    const config = await this.getConfig({ withCache: true });
    try {
      if (document.workload === 'clip') {
        const bound = toBoundClipResult(document.item);
        if (!bound) {
          return {
            ...item,
            warnings,
            outcome: 'local',
            error: `Frameleaf Cloud could not read this photo (${warnings.join(', ')})`,
          };
        }
        const profile = localPinnedProfile(MlWorkload.Clip, config.machineLearning.clip.modelName);
        const embedding = acceptCloudClipResult(profile, { identity: document.result.identity, result: bound });
        const status = await this.smartInfo.publishClipEmbedding(item.assetId, embedding, {
          modelName: snapshot.modelName,
          previewPath: item.previewPath ?? '',
        });
        return status === JobStatus.Success
          ? { ...item, warnings, outcome: 'stored' }
          : {
              ...item,
              warnings,
              outcome: 'failed',
              error: 'The photo or the smart search model changed; it runs again',
            };
      }
      const bound = toBoundFaceResult(document.item);
      if (!bound) {
        return {
          ...item,
          warnings,
          outcome: 'local',
          error: `Frameleaf Cloud could not read this photo (${warnings.join(', ')})`,
        };
      }
      const profile = localPinnedProfile(MlWorkload.Face, config.machineLearning.facialRecognition.modelName);
      const detection = acceptCloudFaceResult(profile, { identity: document.result.identity, result: bound });
      await this.person.publishDetectedFaces(item.assetId, {
        previewPath: item.previewPath ?? '',
        checksum: item.checksum ?? '',
        imageWidth: detection.imageWidth,
        imageHeight: detection.imageHeight,
        faces: detection['facial-recognition'],
      });
      return { ...item, warnings, outcome: 'stored' };
    } catch (error) {
      jobSignal()?.throwIfAborted();
      if (error instanceof CloudModelIdentityMismatchError) {
        this.logger.warn(`A Frameleaf Cloud result for ${item.assetId} was refused: ${error.reason}`);
        return { ...item, warnings, outcome: 'local', error: error.message };
      }
      this.logger.warn(`The Frameleaf Cloud result of ${item.assetId} was not stored: ${errorMessage(error)}`);
      return { ...item, warnings, outcome: 'failed', error: errorMessage(error) };
    }
  }

  private jobClient(gateway: CloudMlGateway) {
    return new FrameleafCloudJobClient(this.frameleafCloudMlRepository, gateway);
  }

  /** Cancel (when asked) and release a cloud job; true once the cloud confirmed it. */
  private async release(gateway: CloudMlGateway, operationId: string, jobId: string, cancel: boolean) {
    try {
      if (cancel) {
        try {
          await this.frameleafCloudMlRepository.cancelJob(gateway, jobId);
        } catch (error) {
          if (cloudErrorCode(error) !== 'job-ended') {
            throw error;
          }
        }
      }
      await this.frameleafCloudMlRepository.deleteJob(gateway, jobId);
      await this.mediaOperationRepository.markRemoteReleased(operationId);
      return true;
    } catch (error) {
      this.logger.warn(`Frameleaf Cloud job ${jobId} was not released yet: ${errorMessage(error)}`);
      return false;
    }
  }

  /** Release cloud jobs of batches that ended while nobody held them, and settle sent-but-unrecorded submissions. */
  private async releaseAbandoned() {
    const unreleased = await this.mediaOperationRepository.getUnreleasedRemoteOperations(100, [
      MediaOperationKind.CloudLibraryBatch,
    ]);
    const pending = await this.mediaOperationRepository.listCloudDescriptionPendingReleases(
      20,
      MediaOperationKind.CloudLibraryBatch,
    );
    if (unreleased.length === 0 && pending.length === 0) {
      return;
    }
    const resolution = await resolveCloudGateway(this.gatewayDeps());
    if (resolution.state !== CloudConnectionState.Ready) {
      return;
    }
    const now = Date.now();
    for (const operation of pending) {
      let snapshot: CloudLibrarySnapshot;
      try {
        snapshot = parseCloudLibrarySnapshot(operation.snapshot);
      } catch {
        continue;
      }
      const result = parseCloudLibraryResult(operation.result, snapshot.assetIds);
      const submission = result.submission;
      if (!submission?.attemptedAt || estimateUsable({ expiresAt: submission.expiresAt }, now)) {
        continue;
      }
      try {
        const admitted = await this.frameleafCloudMlRepository.createJob(
          resolution.gateway,
          this.jobBody(operation.id, snapshot, result, submission),
          submission.idempotencyKey,
        );
        await this.mediaOperationRepository.recordRemoteJobId(operation.id, admitted.jobId);
        await this.release(resolution.gateway, operation.id, admitted.jobId, true);
      } catch (error) {
        if (
          !isIdempotencyKeyReused(error) &&
          !(error instanceof FrameleafCloudError && error.refusal === MlAdmissionRefusal.ModelMismatch)
        ) {
          this.logger.warn(`Smart search or faces batch ${operation.id}: its submission could not be checked yet`);
          continue;
        }
      }
      await this.mediaOperationRepository.setFinishedResult(operation.id, {
        ...result,
        submission: { ...submission, attemptedAt: null },
      } as unknown as Record<string, unknown>);
    }
    for (const operation of unreleased) {
      await this.release(resolution.gateway, operation.id, operation.remoteJobId!, true);
    }
  }

  private async finishEmpty(run: BatchRun) {
    run.result = { ...run.result, phase: CloudLibraryPhase.Finished };
    if (!(await this.save(run))) {
      return;
    }
    if (await this.mediaOperationRepository.beginValidation(run.operation.id, run.claimToken)) {
      await this.mediaOperationRepository.complete(run.operation.id, run.claimToken, { resultAssetId: null });
    }
  }

  /** A refusal: wait and retry when it may pass (never sent elsewhere), else fail and give the photos back. */
  private async refuse(run: BatchRun, refusal: BatchRefusal | WaitUntil) {
    if (refusal instanceof WaitUntil) {
      const attempted = !!run.result.submission?.attemptedAt && !run.result.job;
      run.result = {
        ...run.result,
        phase: attempted ? CloudLibraryPhase.Estimated : CloudLibraryPhase.Queued,
        submission: attempted ? run.result.submission : null,
        waiting: { refusal: 'cloud_library_waiting', detail: refusal.message, at: run.now.toISOString() },
      };
      if (await this.save(run)) {
        await this.wait(run, Math.max(0, refusal.until.getTime() - run.now.getTime()));
      }
      return;
    }
    run.result = {
      ...run.result,
      waiting: { refusal: refusal.code, detail: refusal.message, at: run.now.toISOString() },
    };
    if (await this.save(run)) {
      const outcome = await this.mediaOperationRepository.fail(
        run.operation.id,
        run.claimToken,
        { error: refusal.message, errorCode: refusal.code },
        // the batch resumes by its phase, cloud job and idempotency key, so its one retry repeats nothing
        { retry: refusal.transient, resumable: true },
      );
      if (outcome === 'failed') {
        this.logger.log(`Smart search or faces batch ${run.operation.id} was refused: ${refusal.message}`);
        await this.handBack(run);
      }
    }
  }

  /**
   * A batch that failed for good made nothing for its photos, and their own jobs no longer hold them (they
   * left the queue when the batch was made): they run on this server instead, as a refused result does (FL-455).
   */
  private async handBack({ snapshot, result }: Pick<BatchRun, 'snapshot' | 'result'>) {
    await this.backToTheirJobs(
      result.items
        .filter((item) => !item.outcome && !item.refused)
        .map(({ assetId }) => ({ workload: snapshot.workload, assetId })),
      true,
    );
  }

  /** Write the batch's result; false when the claim is gone or a cancel arrived (then it is handled). */
  private async save(run: BatchRun): Promise<boolean> {
    const processed = run.result.phase === CloudLibraryPhase.Finished ? total(run) : 0;
    const written = await this.mediaOperationRepository.setBulkResult(run.operation.id, run.claimToken, {
      result: run.result as unknown as Record<string, unknown>,
      processedUnits: processed,
      totalUnits: total(run),
      progress: processed === total(run) ? 100 : 0,
      leaseMs: CLOUD_LIBRARY_LEASE_MS,
    });
    if (!written) {
      this.logger.warn(`Smart search or faces batch ${run.operation.id}: claim lost, stopping`);
      return false;
    }
    if (written.status === MediaOperationStatus.Cancelling || written.cancelRequestedAt) {
      const resolution = await resolveCloudGateway(this.gatewayDeps());
      if (resolution.state === CloudConnectionState.Ready) {
        const job = run.result.job;
        const released = job ? await this.release(resolution.gateway, run.operation.id, job.jobId, true) : true;
        await this.mediaOperationRepository.acknowledgeCancel(run.operation.id, run.claimToken, {
          released: !!job && released,
        });
      }
      return false;
    }
    return true;
  }

  private async wait(run: BatchRun, delayMs: number) {
    await this.mediaOperationRepository.requeue(run.operation.id, run.claimToken, { delayMs, returnAttempt: true });
  }

  /** A batch not yet admitted, refused because the region takes no new jobs, waits as the cloud asked. */
  private pausedWait(run: BatchRun, error: unknown): WaitUntil | null {
    const paused = pausedMessageOf(error);
    if (!paused || run.result.job) {
      return null;
    }
    const seconds = Math.max(60, (error as FrameleafCloudError).retryAfterSeconds ?? 300);
    return new WaitUntil(new Date(run.now.getTime() + seconds * 1000), paused);
  }

  private gatewayDeps(): CloudMlGatewayDeps {
    return {
      configRepository: this.configRepository,
      databaseRepository: this.databaseRepository,
      systemMetadataRepository: this.systemMetadataRepository,
      instanceIdentityRepository: this.instanceIdentityRepository,
      frameleafCloudRepository: this.frameleafCloudRepository,
      eventRepository: this.eventRepository,
      logger: this.logger,
    };
  }
}
