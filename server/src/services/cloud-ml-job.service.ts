import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Kysely } from 'kysely';
import type { SystemConfig } from 'src/config.js';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { MediaOperation } from 'src/repositories/media-operation.repository.js';
import type { DB } from 'src/schema/index.js';
import type { RawImageInfo } from 'src/types.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent } from 'src/decorators.js';
import {
  AssetRestorationMode,
  AssetRestorationRegion,
  AssetRestorationSourceType,
  AssetRestorationStatus,
  DEFAULT_RESTORATION_REGION,
} from 'src/dtos/asset-restoration.dto.js';
import {
  CloudMlJobActivityDto,
  CloudMlJobCreateDto,
  CloudMlJobEstimateRequestDto,
  CloudMlJobEstimateResponseDto,
  CloudMlJobResponseDto,
} from 'src/dtos/cloud-ml-job.dto.js';
import {
  AssetType,
  Colorspace,
  DatabaseLock,
  ImageFormat,
  ImmichWorker,
  JobName,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  MlAdmissionRefusal,
  MlDestinationKind,
  MlWorkload,
  Permission,
  StorageFolder,
  SystemMetadataKey,
} from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRestoration, AssetRestorationRepository } from 'src/repositories/asset-restoration.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import {
  CloudMlGateway,
  CloudTransferError,
  FrameleafCloudMlRepository,
} from 'src/repositories/frameleaf-cloud-ml.repository.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import { InstanceIdentityRepository } from 'src/repositories/instance-identity.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { MlDestinationRepository, MlDestinationRow } from 'src/repositories/ml-destination.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { parseDurationSeconds } from 'src/services/asset-restoration.service.js';
import { requireAccess } from 'src/utils/access.js';
import {
  CLOUD_ML_JOB_COST_POLL_MS,
  CLOUD_ML_JOB_COST_READS,
  CLOUD_ML_JOB_ESTIMATES_KEPT,
  CLOUD_ML_JOB_INPUT_TYPES,
  CLOUD_ML_JOB_LEASE_MS,
  CLOUD_ML_JOB_MAX_ESTIMATES,
  CLOUD_ML_JOB_MAX_POLL_MS,
  CLOUD_ML_JOB_MAX_TRANSIENT_FAILURES,
  CLOUD_ML_JOB_MAX_UNAUTHORIZED_READS,
  CLOUD_ML_JOB_POLL_MS,
  CLOUD_ML_JOB_PREPARING_RETRY_SECONDS,
  CLOUD_ML_JOB_PREVIEW_SECONDS,
  CLOUD_ML_JOB_PRICE_TOLERANCE,
  CLOUD_ML_JOB_RUNTIME_CAP_MESSAGE,
  CLOUD_ML_JOB_STEPS_PER_TICK,
  CLOUD_ML_JOB_TICK_MS,
  CloudMlJobCost,
  CloudMlJobEstimateRecord,
  CloudMlJobInput,
  CloudMlJobPhase,
  CloudMlJobResult,
  CloudMlJobSnapshot,
  CloudMlJobUpscale,
  CloudMlJobWorkload,
  cloudMlJobActivity,
  cloudMlJobBackoffMs,
  cloudMlJobClientRef,
  cloudMlJobCostOf,
  cloudMlJobIdempotencyKey,
  cloudMlJobMonthStart,
  cloudMlJobRecordOf,
  cloudMlJobSpentUsd,
  cloudMlJobWorkload,
  emptyCloudMlJobResult,
  orderedOutputs,
  outputsComplete,
  parseCloudMlJobResult,
  parseCloudMlJobSnapshot,
  perUnitEstimate,
  plannedWorkers,
} from 'src/utils/cloud-ml-job.js';
import { getConfig } from 'src/utils/config.js';
import { CloudConnectionState, CloudMlGatewayDeps, resolveCloudGateway } from 'src/utils/frameleaf-cloud-gateway.js';
import { CloudJobInputError, FrameleafCloudJobClient } from 'src/utils/frameleaf-cloud-job-client.js';
import {
  CLOUD_RESULT_OUTPUT_ID,
  CLOUD_UPSCALE_RESULT_MAX_BYTES,
  CloudCatalogEntry,
  CloudEstimate,
  CloudJobView,
  CloudUploadTarget,
  FrameleafCloudError,
  catalogGroupKey,
  cloudErrorCode,
  cloudUpscaleAppliedScale,
  estimateUsable,
  isFinalCloudJobStatus,
  isIdempotencyInFlight,
  isIdempotencyKeyReused,
  isNewWorkPaused,
  offeredCatalogModels,
  pausedException,
  upscaleResultSchema,
} from 'src/utils/frameleaf-cloud.js';
import { AudioChannelPolicy, findAudioLayoutMismatch, findAvAlignmentMismatch } from 'src/utils/media-policy.js';
import {
  audioReattachOffsetSeconds,
  fullVideoUploadOutputOptions,
  previewClipOutputOptions,
  reattachAudioOutputOptions,
  strippedStillFormat,
  uploadClipOutputOptions,
} from 'src/utils/media-privacy.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import {
  MlDestinationNotFoundError,
  MlDestinationRefusedError,
  STOPS_CREATED_CLOUD_JOB,
  admissionRefusalOf,
  cloudRouteAllows,
  consentUnconfirmedOf,
  selectMlDestination,
} from 'src/utils/ml-destination.js';
import {
  RESTORATION_PREVIEW_EDGE,
  STAGE_STATUSES,
  cappedOutputSize,
  isFullRegion,
  previewExpiryAfterDecision,
  previewExpiryAfterReady,
  previewRegionPixels,
  restorationOutputPaths,
  resultExpiryAfterAbandon,
} from 'src/utils/restoration.js';

type CloudMlSettings = SystemConfig['frameleafCloud']['cloudMl'];

type Source = NonNullable<Awaited<ReturnType<AssetJobRepository['getForGenerateThumbnailJob']>>>;

const DAY_MS = 24 * 60 * 60 * 1000;

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A whole video prepared for Frameleaf Cloud once, kept in its own folder for every estimate of it. */
const PREPARED_INPUT_PREFIX = 'cloud_ml_input_';
/** Bumped when the way a whole video is prepared changes, so an older copy is never reused. */
const PREPARED_INPUT_VERSION = 2;
/** The record written next to a prepared copy once it is complete. */
const PREPARED_INPUT_RECORD = 'prepared.json';

type PreparedCopy = { file: string; contentType: string; bytes: number; sha256: string };

/** Why a step was stopped from outside: its claim was lost, the owner cancelled, or the server stops. */
type StepAbort = 'lost' | 'cancel' | 'shutdown';

/** Even dimensions, as yuv420p encoders require. */
const even = (value: number) => Math.max(2, value - (value % 2));

/** How a job is read again: after the cloud's `Retry-After`, else the default, never longer than the maximum. */
const POLL_TIMING = { defaultMs: CLOUD_ML_JOB_POLL_MS, maxMs: CLOUD_ML_JOB_MAX_POLL_MS };

/** A stored preview region, or the default centre half when it cannot be read. */
const regionOf = (value: unknown): AssetRestorationRegion =>
  value && typeof value === 'object' && 'x' in value && 'y' in value && 'w' in value && 'h' in value
    ? (value as AssetRestorationRegion)
    : DEFAULT_RESTORATION_REGION;

/**
 * Why a step stopped. `retry` says whether the one automatic retry may help (a cloud that did not
 * answer, a transfer that broke); a refusal of the job itself (402, a model mismatch, a price that
 * moved) is reported at once and never retried.
 */
export class CloudMlJobFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retry: boolean,
  ) {
    super(message);
    this.name = 'CloudMlJobFailure';
  }
}

/** One claimed job in hand. */
type JobRun = {
  operation: MediaOperation;
  claimToken: string;
  snapshot: CloudMlJobSnapshot;
  result: CloudMlJobResult;
  now: Date;
};

/** A published file: moved from its work path to its final path inside the publishing transaction. */
type PublishedFile = {
  tmp: string;
  final: string;
  column: 'previewBeforePath' | 'previewAfterPath' | 'resultPath' | 'resultPreviewPath';
};

/** The refusal a failed call means for this job, as a failure it reports. */
const failureOf = (error: unknown): CloudMlJobFailure | null => {
  if (error instanceof CloudMlJobFailure) {
    return error;
  }
  if (error instanceof CloudJobInputError) {
    return new CloudMlJobFailure('cloud_ml_upload_mismatch', `${error.message}; nothing more is sent`, false);
  }
  if (error instanceof CloudTransferError) {
    // a broken transfer may pass on the automatic retry, which carries on from the recorded parts
    return new CloudMlJobFailure(`cloud_ml_transfer_${error.failure.replaceAll('-', '_')}`, error.message, true);
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
  const transient = [
    MlAdmissionRefusal.CloudUnavailable,
    MlAdmissionRefusal.DestinationUnhealthy,
    MlAdmissionRefusal.QuotaExceeded,
  ].includes(refusal);
  return new CloudMlJobFailure(`cloud_ml_${refusal.replaceAll('-', '_')}`, errorMessage(error), transient);
};

/**
 * Frameleaf Cloud restoration, upscaling and Smooth motion jobs (FL-162, `CLD-202`).
 *
 * The owner asks for an estimate (`POST /cloud/ml/jobs/estimate`): the preview clip or crop, or the
 * whole file, is prepared on this server without any metadata, digested and sealed by Frameleaf Cloud
 * as metered GPU time × rate + a start fee per worker, shown p50–p90 with a per-photo or per-minute
 * figure and the AI Wallet. Confirming it (`POST /cloud/ml/jobs`, with the consent version and the
 * acknowledgement that the file leaves this server) creates a `media_operation` of kind
 * `cloud_ml_job`, which this worker then carries through, a step per claim:
 *
 * 1. **Submit** with the confirmed sealed estimate and `Idempotency-Key` = the operation id. An
 *    estimate the queue held past its 15 minutes is sealed again and sent only within 10 % of the
 *    confirmed high end; a 402 refuses the job as it is, never with a lighter model.
 * 2. **Upload** each input inline or in 8 MiB parts, recording every part, then **start** it.
 * 3. **Poll** with `If-None-Match` and `Retry-After` until the job ends. Frameleaf Cloud cuts a long
 *    video into 20–30 s chunks over at most five workers with a checkpoint per chunk; this server
 *    reads the job's progress and, when it ends, joins the per-shard outputs in order.
 * 4. **Collect**: every output is downloaded and checked against its SHA-256, the result is
 *    published as a new version of the asset, and only then is the job acknowledged
 *    (`DELETE /v2/jobs/{id}`, so the cloud purges it). What the job cost is recorded once, from its
 *    settlement.
 *
 * The cloud side of steps 2 to 4 is `FrameleafCloudJobClient`, shared by every workload. A restart, a
 * lost claim or the automatic retry resumes from the result by the cloud job id; a job is never
 * submitted twice. A cancel stops the cloud job (the hold is released, what ran is settled) and a
 * failure on the cloud's side is refunded in full by Frameleaf Cloud. Nothing ever moves to another
 * destination, and turning Frameleaf Cloud processing off stops every job.
 */
@Injectable()
export class CloudMlJobService {
  private tickHandle?: ReturnType<typeof setInterval>;
  private cleanupHandle?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private cleaning?: Promise<void>;
  private stopping = false;
  /** Aborted at shutdown: stops every transfer in flight, whose lease hands the job on. */
  private shutdown = new AbortController();
  private readonly workerId = `cloud-ml-job-${randomUUID()}`;
  /** Whole videos being prepared for an estimate, by prepared-copy folder; one per person at a time. */
  private readonly preparing = new Map<string, Promise<void>>();
  private readonly preparingBy = new Map<string, string>();
  /** Why the last preparation of a folder failed, told once to the next estimate of it. */
  private readonly preparingFailed = new Map<string, string>();

  constructor(
    private logger: LoggingRepository,
    private accessRepository: AccessRepository,
    private assetJobRepository: AssetJobRepository,
    private configRepository: ConfigRepository,
    private cryptoRepository: CryptoRepository,
    private databaseRepository: DatabaseRepository,
    private eventRepository: EventRepository,
    private frameleafCloudRepository: FrameleafCloudRepository,
    private frameleafCloudMlRepository: FrameleafCloudMlRepository,
    private instanceIdentityRepository: InstanceIdentityRepository,
    private jobRepository: JobRepository,
    private machineLearningRepository: MachineLearningRepository,
    private mediaOperationRepository: MediaOperationRepository,
    private mediaRepository: MediaRepository,
    private mlDestinationRepository: MlDestinationRepository,
    private restorationRepository: AssetRestorationRepository,
    private storageRepository: StorageRepository,
    private systemMetadataRepository: SystemMetadataRepository,
  ) {
    this.logger.setContext(CloudMlJobService.name);
  }

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  onBootstrap() {
    this.stopping = false;
    if (this.shutdown.signal.aborted) {
      this.shutdown = new AbortController();
    }
    this.tickHandle ??= setInterval(() => this.tick(), CLOUD_ML_JOB_TICK_MS);
    // cancels, acknowledgements and settlements run on their own timer, so a long transfer in one job
    // never holds up another job's cleanup
    this.cleanupHandle ??= setInterval(() => this.cleanupTick(), CLOUD_ML_JOB_COST_POLL_MS);
  }

  /** Stop taking steps and let the one in hand land; its lease hands the job to the next worker. */
  @OnEvent({ name: 'AppShutdown' })
  async onShutdown() {
    this.stopping = true;
    this.shutdown.abort('shutdown' satisfies StepAbort);
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = undefined;
    }
    if (this.cleanupHandle) {
      clearInterval(this.cleanupHandle);
      this.cleanupHandle = undefined;
    }
    await Promise.all([this.active, this.cleaning]);
  }

  tick() {
    if (this.active || this.stopping) {
      return;
    }
    this.active = this.drain()
      .catch((error) => this.logger.warn(`Frameleaf Cloud job worker failed: ${errorMessage(error)}`))
      .finally(() => {
        this.active = undefined;
      });
  }

  cleanupTick() {
    if (this.cleaning || this.stopping) {
      return;
    }
    this.cleaning = this.cleanup()
      .catch((error) => this.logger.warn(`Frameleaf Cloud job cleanup failed: ${errorMessage(error)}`))
      .finally(() => {
        this.cleaning = undefined;
      });
  }

  /**
   * The passes over jobs no step holds: stop cancelled and failed cloud jobs, acknowledge finished
   * ones whose acknowledgement did not land, record settled costs, and drop lapsed estimates.
   */
  async cleanup(now = new Date()): Promise<void> {
    await this.releaseUnwatched();
    await this.reconcileCancelled(now);
    await this.acknowledgeFinished();
    await this.settleFinished(now);
    await this.pruneEstimates(now);
  }

  /** The next due steps. */
  async drain(): Promise<void> {
    for (let step = 0; step < CLOUD_ML_JOB_STEPS_PER_TICK && !this.stopping; step++) {
      const claim = await this.mediaOperationRepository.claimNext({
        kinds: [MediaOperationKind.CloudMlJob],
        workerId: this.workerId,
        leaseMs: CLOUD_ML_JOB_LEASE_MS,
      });
      if (!claim) {
        return;
      }
      await this.step(claim.operation, claim.claimToken, new Date());
    }
  }

  /* ------------------------------------------------------------------ */
  /* Estimate and confirm                                                */
  /* ------------------------------------------------------------------ */

  /**
   * `POST /cloud/ml/jobs/estimate`: what the job would cost, before anything is sent. The input is
   * prepared here without metadata and digested, and Frameleaf Cloud seals an estimate for exactly
   * that input, model and request. The estimate is kept on this server under the id it answers with.
   */
  async estimate(
    auth: AuthDto,
    dto: CloudMlJobEstimateRequestDto,
    now = new Date(),
  ): Promise<CloudMlJobEstimateResponseDto> {
    await requireAccess(this.accessRepository, { auth, permission: Permission.AssetEditCreate, ids: [dto.assetId] });
    const source = await this.requireSource(dto.assetId);
    const video = source.type === AssetType.Video;
    const sourceType = video ? AssetRestorationSourceType.Video : AssetRestorationSourceType.Image;
    const sizes = this.sourceSize(source);
    const durationSeconds = video ? this.durationOf(source) : null;
    if (dto.purpose === 'smooth-motion' && !video) {
      throw new BadRequestException('Smooth motion is for videos');
    }

    // the preview a full render inherits its model and settings from; without one, a full-stage
    // estimate is a quote for the whole file with the given settings, which cannot be confirmed (FL-348)
    const quoteOnly = dto.stage === 'full' && !dto.restorationId;
    const preview = dto.stage === 'full' && !quoteOnly ? await this.requireReviewedPreview(auth, dto) : null;
    const smooth = dto.purpose === 'smooth-motion';
    const settings = preview
      ? {
          mode: preview.mode as AssetRestorationMode,
          upscale: preview.upscale,
          keepGrain: preview.keepGrain,
          factor: preview.mode === AssetRestorationMode.SmoothMotion ? preview.upscale : null,
          region: regionOf(preview.previewRegion),
        }
      : {
          mode: smooth ? AssetRestorationMode.SmoothMotion : (dto.mode ?? AssetRestorationMode.Faithful),
          upscale: smooth ? 1 : (dto.upscale ?? 2),
          keepGrain: dto.keepGrain ?? false,
          factor: smooth ? (dto.factor ?? 2) : null,
          region: dto.region ?? DEFAULT_RESTORATION_REGION,
        };
    if (smooth !== (settings.mode === AssetRestorationMode.SmoothMotion)) {
      throw new BadRequestException('Estimate a Smooth motion version as Smooth motion, and a restoration as one');
    }

    const workload = cloudMlJobWorkload(dto.purpose, sourceType);
    if (workload === 'upscale' && settings.mode === AssetRestorationMode.Creative) {
      throw new BadRequestException('Frameleaf Cloud restores photos by upscaling them; choose Faithful for a photo');
    }
    const appWorkload = this.appWorkloadOf(workload, settings.mode);
    const destination = await this.requireCloudDestination(dto.destinationId, appWorkload);
    const gateway = await this.requireGateway();

    const chosen = await this.chooseModel(gateway, workload, settings.mode, dto.modelSku);
    const model = chosen.model;
    // a full render runs the model reviewed in its preview: the slider is only offered for a preview
    const offered = preview ? [model] : chosen.offered;
    if (preview) {
      // FL-115: the full render runs the model the owner reviewed in the preview, at the same revision
      const reviewed = this.previewModel(preview);
      if (reviewed?.sku !== model.sku || reviewed.rev !== model.rev) {
        throw this.modelMismatch('The model changed since the preview; request a new preview');
      }
    }

    const id = this.cryptoRepository.randomUUID();
    const workDir = path.join(
      StorageCore.getNestedFolder(StorageFolder.Thumbnails, source.ownerId, source.id),
      `cloud_ml_${id}`,
    );
    // a whole video is prepared once, in the background, and reused by every estimate of it
    const copy = video && dto.stage === 'full' ? await this.preparedWholeVideo(auth, source) : null;
    this.storageRepository.mkdirSync(workDir);
    let prepared: Awaited<ReturnType<CloudMlJobService['prepareInput']>>;
    try {
      prepared = copy
        ? this.fromPreparedCopy(copy, workload, sizes, durationSeconds, smooth ? 1 : settings.upscale)
        : await this.prepareInput(source, {
            workDir,
            stage: dto.stage,
            workload,
            sourceType,
            sizes,
            durationSeconds,
            region: settings.region,
            crop: !smooth,
            upscale: smooth ? 1 : settings.upscale,
          });
    } catch (error) {
      await this.removeWorkDir(workDir);
      throw error instanceof CloudMlJobFailure ? new BadRequestException(error.message) : error;
    }

    const request = this.requestOf(workload, settings, prepared.size);
    let sealed: CloudEstimate;
    let wallet: Awaited<ReturnType<FrameleafCloudMlRepository['getWallet']>>;
    let consent: Awaited<ReturnType<FrameleafCloudMlRepository['getConsent']>>;
    try {
      sealed = await this.frameleafCloudMlRepository.createEstimate(gateway, {
        workload,
        modelSku: model.sku,
        inputs: [this.toCloudInput(prepared.input)],
        request,
      } as Parameters<FrameleafCloudMlRepository['createEstimate']>[1]);
      if (sealed.modelSku !== model.sku || sealed.modelRev !== model.rev) {
        throw this.modelMismatch('Frameleaf Cloud estimated another revision of this model; choose the model again');
      }
      [wallet, consent] = await Promise.all([
        this.frameleafCloudMlRepository.getWallet(gateway),
        this.frameleafCloudMlRepository.getConsent(gateway),
      ]);
    } catch (error) {
      await this.removeWorkDir(workDir);
      throw this.clientError(error);
    }

    let upscale: CloudMlJobUpscale | undefined;
    try {
      upscale = workload === 'upscale' ? this.upscaleQuote(sealed, settings.upscale, prepared.size) : undefined;
    } catch (error) {
      await this.removeWorkDir(workDir);
      throw error instanceof CloudMlJobFailure ? new BadRequestException(error.message) : error;
    }
    // the version is the photo times the factor it really gets, never capped again here
    const output = upscale
      ? { width: upscale.input.width * upscale.appliedScale, height: upscale.input.height * upscale.appliedScale }
      : prepared.output;
    const workers = plannedWorkers(sealed, model.rate.startFeeUsd);
    const quantity = video
      ? { unit: 'minute' as const, value: (prepared.durationSeconds ?? 0) / 60 }
      : { unit: 'photo' as const, value: 1 };
    const availableUsd = Math.max(0, wallet.balanceUsd - wallet.heldUsd);
    const record: CloudMlJobEstimateRecord = {
      id,
      ownerId: source.ownerId,
      createdBy: auth.user.id,
      createdAt: now.toISOString(),
      expiresAt: sealed.expiresAt,
      purpose: dto.purpose,
      stage: dto.stage,
      assetId: source.id,
      restorationId: preview?.id ?? null,
      sourceChecksumHex: Buffer.from(source.checksum).toString('hex'),
      sourceType: video ? 'video' : 'image',
      destinationId: destination.id,
      workload,
      appWorkload,
      settings,
      model: { sku: model.sku, rev: model.rev, label: model.label },
      computeSku: sealed.computeSku,
      request,
      inputs: [prepared.input],
      workDir,
      beforePath: prepared.beforePath,
      output,
      durationSeconds: prepared.durationSeconds,
      ...(upscale && { upscale }),
      sealed: sealed.estimate,
      approved: {
        estimateId: id,
        p50Usd: sealed.cost.p50,
        p90Usd: sealed.cost.p90,
        holdUsd: sealed.cost.hold,
        startupUsd: sealed.cost.startup,
        minimumUsd: sealed.cost.minimum,
        startFeeUsd: model.rate.startFeeUsd,
        perSecondUsd: model.rate.perSecondUsd,
        plannedWorkers: workers,
        coldStartSeconds: sealed.seconds.coldStart,
        runSeconds: sealed.seconds.run,
        basis: sealed.basis,
      },
      consent: { version: consent.requiredVersion, textSha256: consent.textSha256 },
      operationId: null,
    };
    await this.keepEstimate(record, now);

    return {
      estimateId: id,
      expiresAt: sealed.expiresAt,
      workload: appWorkload,
      model: this.modelOf(model),
      models: offered.toSorted((a, b) => a.rank - b.rank).map((entry) => this.modelOf(entry)),
      basis: sealed.basis,
      p50Usd: sealed.cost.p50,
      p90Usd: sealed.cost.p90,
      startupUsd: sealed.cost.startup,
      startFeeUsd: model.rate.startFeeUsd,
      perSecondUsd: model.rate.perSecondUsd,
      holdUsd: sealed.cost.hold,
      minimumUsd: sealed.cost.minimum,
      plannedWorkers: workers,
      coldStartSeconds: sealed.seconds.coldStart,
      runSeconds: sealed.seconds.run,
      perUnit: { ...perUnitEstimate(sealed, quantity), quantity: Math.round(quantity.value * 100) / 100 },
      availableUsd,
      dailyCapUsd: wallet.dailyCapUsd,
      spentTodayUsd: wallet.spentTodayUsd,
      consent: { version: consent.requiredVersion, summary: consent.summary, documentUrl: consent.documentUrl },
      refusal: this.walletRefusal(wallet, availableUsd, sealed.cost.hold),
      // everyone may see what a job would cost; only those allowed may confirm it
      permission: await this.spendPermission(auth, sealed.cost.hold, now),
      upscale: upscale
        ? {
            requestedScale: upscale.requestedScale,
            appliedScale: upscale.appliedScale,
            lowered: upscale.lowered,
            outputWidth: output.width,
            outputHeight: output.height,
          }
        : null,
      quoteOnly,
    };
  }

  /**
   * FC-46 (owner decision 2026-09-27): the factor a photo upscale really gets. The 64 MP output cap
   * stays, so the cloud lowers the factor of a photo the requested one would take over it and says so
   * in `EstimateResponse.upscale`; the owner sees it before confirming, since it changes what is made
   * and paid for. The cloud's answer is checked against the same rule it decides with.
   */
  private upscaleQuote(
    sealed: CloudEstimate,
    requested: number,
    size: { width: number; height: number },
  ): CloudMlJobUpscale {
    const requestedScale = requested === 4 ? 4 : 2;
    const quoted = sealed.upscale?.items.find((item) => item.inputId === 'v1')?.scale;
    const expected = cloudUpscaleAppliedScale(size.width, size.height, requestedScale);
    if (expected === null) {
      throw new CloudMlJobFailure(
        'cloud_ml_input_too_large',
        'This photo is too large to upscale on Frameleaf Cloud: even 2× would go over the 64 MP limit',
        false,
      );
    }
    if (quoted !== undefined && quoted !== expected) {
      throw new CloudMlJobFailure(
        'cloud_ml_estimate_unstable',
        `Frameleaf Cloud quoted ${quoted}× for a photo this server expected at ${expected}×; request a new estimate`,
        false,
      );
    }
    const appliedScale = quoted ?? expected;
    return {
      requestedScale,
      appliedScale,
      lowered: appliedScale < requestedScale || (sealed.upscale?.lowered.includes('v1') ?? false),
      input: { width: size.width, height: size.height },
    };
  }

  /**
   * Whether this person may confirm a job that holds `holdUsd` (FL-162 owner decision, 2026-09-26).
   * Administrators always may. Anyone else only when an administrator allowed them
   * (`frameleafCloud.cloudMl.spenders`), and, with a monthly limit, only while this month's settled
   * charges plus the holds of their unsettled jobs plus this job's hold stay within it.
   */
  async spendPermission(
    auth: AuthDto,
    holdUsd: number,
    now: Date,
  ): Promise<CloudMlJobEstimateResponseDto['permission']> {
    if (auth.user.isAdmin) {
      return { canConfirm: true, reason: null, monthlyCapUsd: null, spentThisMonthUsd: null };
    }
    const { spenders } = await this.cloudMlSettings();
    const spender = spenders.find((entry) => entry.userId === auth.user.id);
    if (!spender) {
      return { canConfirm: false, reason: 'not-allowed', monthlyCapUsd: null, spentThisMonthUsd: null };
    }
    if (spender.monthlyCapUsd === null) {
      return { canConfirm: true, reason: null, monthlyCapUsd: null, spentThisMonthUsd: null };
    }
    const rows = await this.mediaOperationRepository.listCloudMlJobSpend(auth.user.id, cloudMlJobMonthStart(now));
    const spent = cloudMlJobSpentUsd(rows);
    // a job the queue held past its estimate may be resealed up to 10 % higher: the limit keeps room for it
    const within = spent + holdUsd * CLOUD_ML_JOB_PRICE_TOLERANCE <= spender.monthlyCapUsd + 1e-9;
    return {
      canConfirm: within,
      reason: within ? null : 'monthly-cap',
      monthlyCapUsd: spender.monthlyCapUsd,
      spentThisMonthUsd: spent,
    };
  }

  /** Refuse a confirmation this person may not make, in plain words; never left to the web app. */
  private async requireSpendPermission(auth: AuthDto, holdUsd: number, now: Date) {
    const permission = await this.spendPermission(auth, holdUsd, now);
    if (permission.canConfirm) {
      return;
    }
    const message =
      permission.reason === 'monthly-cap'
        ? `This job would take you past your monthly Frameleaf Cloud limit of ${permission.monthlyCapUsd?.toFixed(2)} USD (${permission.spentThisMonthUsd?.toFixed(2)} USD used). An administrator can raise it.`
        : 'Only administrators, and people an administrator allows, can run jobs on Frameleaf Cloud. An administrator can allow you.';
    throw new ForbiddenException({
      message,
      error: 'Forbidden',
      statusCode: HttpStatus.FORBIDDEN,
      code: permission.reason,
    });
  }

  /**
   * `POST /cloud/ml/jobs`: confirm a kept estimate. Only its id, the consent version it was shown with
   * and the acknowledgement are read from the request; everything else is what the server kept. A
   * repeated confirmation answers with the job the first one created. An estimate past its expiry is
   * refused with 409 `estimate-expired`: the owner estimates again, and an old estimate is never sent.
   */
  create(auth: AuthDto, dto: CloudMlJobCreateDto, now = new Date()): Promise<CloudMlJobResponseDto> {
    return this.databaseRepository.withLock(DatabaseLock.FrameleafCloudMlJobEstimates, async () => {
      const store = (await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafCloudMlJobEstimates)) ?? {
        records: [],
      };
      const record = store.records.find((entry) => entry.id === dto.estimateId);
      if (!record || record.createdBy !== auth.user.id) {
        throw new NotFoundException('This estimate is not known any more; estimate again');
      }
      if (record.operationId && record.restorationId) {
        return { operationId: record.operationId, restorationId: record.restorationId, stage: record.stage };
      }
      if (record.stage === 'full' && !record.restorationId) {
        // FL-115: a full render runs only what the owner reviewed in a preview; a quote is not a job
        throw new ConflictException({
          message: 'This is a quote for the whole file; preview it first, then estimate the reviewed preview in full',
          error: 'Conflict',
          statusCode: HttpStatus.CONFLICT,
          code: 'quote-only',
        });
      }
      // a confirmation whose job was created but not written back to the estimate answers with that job
      const [existing] = await this.mediaOperationRepository.getLatestBySubject(
        MediaOperationKind.CloudMlJob,
        'estimateId',
        [record.id],
      );
      if (existing?.revisionId) {
        await this.linkEstimate(store, record.id, existing.id, existing.revisionId);
        return { operationId: existing.id, restorationId: existing.revisionId, stage: record.stage };
      }
      if (Date.parse(record.expiresAt) <= now.getTime()) {
        throw new ConflictException({
          message: 'This estimate expired; estimate again. An old estimate is never sent.',
          error: 'Conflict',
          statusCode: HttpStatus.CONFLICT,
          code: 'estimate-expired',
        });
      }
      if (dto.consentVersion !== record.consent.version) {
        throw new ConflictException({
          message: 'The Frameleaf Cloud terms changed since the estimate; review them and estimate again',
          error: 'Conflict',
          statusCode: HttpStatus.CONFLICT,
          code: 'consent-version-outdated',
        });
      }

      await requireAccess(this.accessRepository, {
        auth,
        permission: Permission.AssetEditCreate,
        ids: [record.assetId],
      });
      // checked under the estimates lock, so two confirmations at once cannot both fit one monthly limit
      await this.requireSpendPermission(auth, record.approved.holdUsd, now);
      const source = await this.requireSource(record.assetId);
      if (Buffer.from(source.checksum).toString('hex') !== record.sourceChecksumHex) {
        throw new ConflictException('The original changed since the estimate; estimate again');
      }
      const destination = await this.requireCloudDestination(record.destinationId, record.appWorkload);

      // the version, the job and the version's link to the job land together, or not at all
      const { operation, value: restoration } = await this.mediaOperationRepository.createWithin(
        async (trx) => {
          const bound = await this.bindRestoration(auth, record, destination, source, now, trx);
          return { operation: this.jobOf(auth, record, destination, source, bound, dto, now), value: bound };
        },
        async (trx, created, bound) => {
          await this.restorationRepository.update(
            bound.id,
            record.stage === 'preview' ? { previewOperationId: created.id } : { fullOperationId: created.id },
            trx,
          );
        },
      );
      await this.linkEstimate(store, record.id, operation.id, restoration.id);
      this.logger.log(`Frameleaf Cloud ${record.purpose} ${record.stage} of ${record.assetId} is job ${operation.id}`);
      return { operationId: operation.id, restorationId: restoration.id, stage: record.stage };
    });
  }

  /** Write a confirmed estimate's job back to it, so a repeated confirmation answers the same. */
  private async linkEstimate(
    store: { records: CloudMlJobEstimateRecord[]; prepared?: { dir: string; ownerId: string; at: string }[] },
    estimateId: string,
    operationId: string,
    restorationId: string,
  ) {
    await this.systemMetadataRepository.set(SystemMetadataKey.FrameleafCloudMlJobEstimates, {
      ...store,
      records: store.records.map((entry) =>
        entry.id === estimateId ? { ...entry, operationId, restorationId } : entry,
      ),
    });
  }

  /** The job a confirmed estimate creates: its immutable snapshot and its first result. */
  private jobOf(
    auth: AuthDto,
    record: CloudMlJobEstimateRecord,
    destination: MlDestinationRow,
    source: Source,
    restoration: AssetRestoration,
    dto: CloudMlJobCreateDto,
    now: Date,
  ): Parameters<MediaOperationRepository['create']>[0] {
    const snapshot: CloudMlJobSnapshot = {
      version: 1,
      purpose: record.purpose,
      stage: record.stage,
      restorationId: restoration.id,
      assetId: record.assetId,
      ownerId: record.ownerId,
      sourceChecksumHex: record.sourceChecksumHex,
      sourceType: record.sourceType,
      destinationId: record.destinationId,
      workload: record.workload,
      appWorkload: record.appWorkload,
      model: record.model,
      request: record.request,
      inputs: record.inputs,
      workDir: record.workDir,
      beforePath: record.beforePath,
      output: record.output,
      durationSeconds: record.durationSeconds,
      approved: record.approved,
      estimateId: record.id,
      ...(record.upscale && { upscale: record.upscale }),
      consent: {
        version: record.consent.version,
        textSha256: record.consent.textSha256,
        acknowledgeDataLeaves: dto.acknowledgeDataLeaves,
        acceptedBy: auth.user.id,
        acceptedAt: now.toISOString(),
      },
    };
    const result: CloudMlJobResult = {
      ...emptyCloudMlJobResult(),
      submission: {
        idempotencyKey: null,
        estimate: record.sealed,
        expiresAt: record.expiresAt,
        modelRev: record.model.rev,
        computeSku: record.computeSku,
        p50Usd: record.approved.p50Usd,
        p90Usd: record.approved.p90Usd,
        holdUsd: record.approved.holdUsd,
        startupUsd: record.approved.startupUsd,
        attemptedAt: null,
      },
    };

    return {
      ownerId: record.ownerId,
      kind: MediaOperationKind.CloudMlJob,
      destination: MediaOperationDestination.FrameleafCloud,
      destinationDetail: destination.name,
      label: source.originalFileName,
      assetId: record.assetId,
      resultAssetId: null,
      retryOfId: null,
      projectId: null,
      revisionId: restoration.id,
      snapshot: snapshot as unknown as Record<string, unknown>,
      settings: this.settingsOf(record, destination.name),
      estimate: {
        seconds: record.approved.coldStartSeconds + record.approved.runSeconds,
        sizeBytes: null,
        cloudCost: {
          p50Usd: record.approved.p50Usd,
          p90Usd: record.approved.p90Usd,
          holdUsd: record.approved.holdUsd,
          startupUsd: record.approved.startupUsd,
          plannedWorkers: record.approved.plannedWorkers,
          basis: record.approved.basis,
        },
      },
      result: result as unknown as Record<string, unknown>,
      totalUnits: null,
    };
  }

  /** `GET /cloud/ml/jobs/{id}`: one of the owner's cloud jobs, as Activity shows it. */
  async get(auth: AuthDto, id: string): Promise<CloudMlJobActivityDto> {
    const operation = await this.mediaOperationRepository.getForOwner(id, auth.user.id);
    const activity = operation ? cloudMlJobActivity(operation) : null;
    if (!activity) {
      throw new NotFoundException('Frameleaf Cloud job not found');
    }
    return activity;
  }

  /** What Activity shows under the job title. Customer words, not enum values. */
  private settingsOf(record: CloudMlJobEstimateRecord, destinationName: string): Record<string, unknown> {
    const smooth = record.purpose === 'smooth-motion';
    return {
      mode: smooth ? 'Smooth motion' : this.modeLabel(record.settings.mode),
      ...(smooth
        ? { factor: record.settings.factor }
        : { upscale: record.upscale?.appliedScale ?? record.settings.upscale }),
      preview: record.stage === 'preview',
      model: record.model.label,
      destination: destinationName,
    };
  }

  /**
   * The restoration row a confirmed job renders into: a new version for a preview, or the reviewed
   * preview itself, accepted, for the full render (guarded, so a decision made from another tab wins).
   */
  private async bindRestoration(
    auth: AuthDto,
    record: CloudMlJobEstimateRecord,
    destination: MlDestinationRow,
    source: Source,
    now: Date,
    trx: Kysely<DB>,
  ): Promise<AssetRestoration> {
    if (record.stage === 'full') {
      const accepted = record.restorationId
        ? await this.restorationRepository.transition(
            record.restorationId,
            [AssetRestorationStatus.PreviewReady],
            {
              status: AssetRestorationStatus.Accepted,
              reviewedAt: now,
              previewExpiresAt: previewExpiryAfterDecision(now),
              error: null,
            },
            trx,
          )
        : undefined;
      if (!accepted) {
        throw new ConflictException('This preview was already decided');
      }
      return accepted;
    }
    const sizes = this.sourceSize(source);
    const smooth = record.purpose === 'smooth-motion';
    return this.restorationRepository.create(
      {
        assetId: record.assetId,
        ownerId: record.ownerId,
        status: AssetRestorationStatus.PreviewQueued,
        mode: record.settings.mode,
        // a Smooth motion version keeps its frame-rate factor where a restoration keeps its upscale
        upscale: smooth ? (record.settings.factor ?? 2) : (record.upscale?.appliedScale ?? record.settings.upscale),
        keepGrain: record.settings.keepGrain,
        workload: record.appWorkload,
        destinationId: destination.id,
        destinationKind: MlDestinationKind.FrameleafCloud,
        destinationName: destination.name,
        sourceType: record.sourceType,
        sourceChecksum: Buffer.from(record.sourceChecksumHex, 'hex'),
        sourceWidth: sizes.width,
        sourceHeight: sizes.height,
        sourceDurationSeconds: record.sourceType === 'video' ? this.durationOf(source) : null,
        previewRegion: record.settings.region as unknown as Record<string, unknown>,
        estimate: null,
        provenance: { requestedBy: auth.user.id, sessionElevated: !!auth.session?.hasElevatedPermission },
      },
      trx,
    );
  }

  /** Keep an estimate for confirmation, dropping lapsed unconfirmed ones (and their prepared files). */
  private keepEstimate(record: CloudMlJobEstimateRecord, now: Date) {
    return this.pruneEstimates(now, record);
  }

  /**
   * Drop unconfirmed estimates that lapsed, keep at most `CLOUD_ML_JOB_ESTIMATES_KEPT` per person, and
   * remove the files only they used: their work folders, and prepared whole-video copies no kept
   * estimate or unfinished job refers to (a copy nobody estimated with is dropped after a day).
   */
  async pruneEstimates(now: Date, add?: CloudMlJobEstimateRecord): Promise<void> {
    const removed: string[] = [];
    await this.databaseRepository.withLock(DatabaseLock.FrameleafCloudMlJobEstimates, async () => {
      const store = (await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafCloudMlJobEstimates)) ?? {
        records: [],
      };
      // a confirmed estimate is kept for a day, so a repeated confirmation answers the same
      const confirmed = store.records.filter(
        (entry) => entry.operationId && now.getTime() - Date.parse(entry.createdAt) < DAY_MS,
      );
      const waiting = store.records.filter((entry) => !entry.operationId);
      const live = waiting.filter((entry) => Date.parse(entry.expiresAt) > now.getTime());
      const kept: CloudMlJobEstimateRecord[] = [];
      for (const person of new Set(live.map((entry) => entry.createdBy))) {
        const theirs = live.filter((entry) => entry.createdBy === person);
        const room = CLOUD_ML_JOB_ESTIMATES_KEPT - (add?.createdBy === person ? 1 : 0);
        kept.push(...theirs.slice(-room));
      }
      const records = [...confirmed, ...kept, ...(add ? [add] : [])];
      for (const entry of waiting) {
        if (!kept.includes(entry)) {
          removed.push(entry.workDir);
        }
      }
      // a prepared copy stays while an estimate or an unfinished job (queued, paused, uploading) needs it
      const jobs = await this.mediaOperationRepository.listUnfinishedCloudMlJobSnapshots();
      const jobInputs = jobs.flatMap((snapshot) => {
        const inputs = (snapshot as { inputs?: unknown } | null)?.inputs;
        return Array.isArray(inputs) ? inputs.map((input) => String((input as { path?: unknown })?.path ?? '')) : [];
      });
      const inUse = new Set(
        [...records.flatMap((entry) => entry.inputs.map((input) => input.path)), ...jobInputs].map((file) =>
          path.dirname(file),
        ),
      );
      const prepared = (store.prepared ?? []).filter((entry) => {
        const keep =
          inUse.has(entry.dir) || this.preparing.has(entry.dir) || now.getTime() - Date.parse(entry.at) < DAY_MS;
        if (!keep) {
          removed.push(entry.dir);
        }
        return keep;
      });
      if (records.length !== store.records.length || prepared.length !== (store.prepared ?? []).length || add) {
        await this.systemMetadataRepository.set(SystemMetadataKey.FrameleafCloudMlJobEstimates, { records, prepared });
      }
    });
    for (const dir of removed) {
      await this.removeWorkDir(dir);
    }
  }

  /* ------------------------------------------------------------------ */
  /* One step                                                            */
  /* ------------------------------------------------------------------ */

  async step(operation: MediaOperation, claimToken: string, now: Date): Promise<void> {
    let snapshot: CloudMlJobSnapshot;
    try {
      snapshot = parseCloudMlJobSnapshot(operation.snapshot);
    } catch (error) {
      await this.mediaOperationRepository.fail(
        operation.id,
        claimToken,
        { error: errorMessage(error), errorCode: 'cloud_ml_snapshot_invalid' },
        { retry: false },
      );
      return;
    }
    const run: JobRun = { operation, claimToken, snapshot, result: parseCloudMlJobResult(operation.result), now };
    // a transfer in flight stops when the claim is lost, the owner cancels, or the server shuts down
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, this.shutdown.signal]);
    const keepAlive = setInterval(
      () => void this.watchStep(operation.id, claimToken, abort),
      CLOUD_ML_JOB_LEASE_MS / 4,
    );

    try {
      if (!(await this.markRunning(run))) {
        return;
      }
      const gateway = await this.gatewayFor(run);
      if (!gateway) {
        return;
      }
      const client = new FrameleafCloudJobClient(this.frameleafCloudMlRepository, gateway, { signal });
      switch (run.result.phase) {
        case CloudMlJobPhase.Queued: {
          await this.submit(run, gateway, client, signal);
          break;
        }
        case CloudMlJobPhase.Uploading: {
          // FL-201: a job resumed later sends the owner's files only under the consent in force now
          await this.readmit(run, client);
          await this.upload(run, client, null, signal);
          break;
        }
        case CloudMlJobPhase.Started: {
          await this.poll(run, client);
          break;
        }
        case CloudMlJobPhase.Ending: {
          await this.end(run, client, null);
          break;
        }
        case CloudMlJobPhase.Finished: {
          await this.mediaOperationRepository.fail(
            operation.id,
            claimToken,
            { error: 'This job had already ended', errorCode: 'cloud_ml_job_ended' },
            { retry: false },
          );
          break;
        }
      }
    } catch (error) {
      if (signal.aborted) {
        await this.afterAbort(run, signal);
        return;
      }
      const failure = failureOf(error);
      if (await this.waitOut(run, error, failure)) {
        return;
      }
      if (!failure) {
        this.logger.error(`Frameleaf Cloud job ${operation.id} failed: ${errorMessage(error)}`);
      }
      await this.stop(run, failure ?? new CloudMlJobFailure('cloud_ml_job_failed', errorMessage(error), true));
    } finally {
      clearInterval(keepAlive);
    }
  }

  /** Renew a step's lease; stop its transfer when the claim is gone or the owner asked to cancel. */
  private async watchStep(id: string, claimToken: string, abort: AbortController) {
    try {
      if (!(await this.mediaOperationRepository.heartbeat(id, claimToken, CLOUD_ML_JOB_LEASE_MS))) {
        abort.abort('lost' satisfies StepAbort);
        return;
      }
      const current = await this.mediaOperationRepository.getForWorker(id);
      if (current?.cancelRequestedAt) {
        abort.abort('cancel' satisfies StepAbort);
      }
    } catch {
      // the next beat tries again; the lease covers a missed one
    }
  }

  /**
   * A step whose transfer was stopped from outside. A cancel is handled now (the cloud job is stopped
   * and settled); a lost claim or a shutdown leaves the job to whichever worker claims it next.
   */
  private async afterAbort(run: JobRun, signal: AbortSignal) {
    if ((signal.reason as StepAbort) === 'cancel') {
      await this.save(run);
    }
  }

  /**
   * A failure that may pass, once a cloud job exists, is waited out instead of spending the job's one
   * automatic retry: a running job keeps being read until it ends (a cloud that does not answer, a 5xx
   * or a 429 only delays the next read, never sooner than its `Retry-After`), and an upload or a
   * result collection is tried again up to `CLOUD_ML_JOB_MAX_TRANSIENT_FAILURES` times in a row.
   * False when the failure is the job's own (then it stops as before).
   */
  private async waitOut(run: JobRun, error: unknown, failure: CloudMlJobFailure | null): Promise<boolean> {
    if (!run.result.job && error instanceof FrameleafCloudError && isIdempotencyInFlight(error)) {
      // FC-43: the cloud is still processing this key's first request; the same key and body are sent
      // again after `Retry-After` (the submission is recorded, so the replay is identical)
      return this.waitForAdmission(run, error, failure);
    }
    if (!run.result.job && isNewWorkPaused(error)) {
      // FC-62: the region takes no new jobs for now (503 `capacity`, the cloud's own words in the message):
      // the job waits for it as asked (`Retry-After`) a limited number of times, then fails with that message
      return this.waitForAdmission(run, error, failure);
    }
    const { phase } = run.result;
    const counted = phase === CloudMlJobPhase.Uploading || phase === CloudMlJobPhase.Ending;
    if (!run.result.job || failure?.retry === false || (!counted && phase !== CloudMlJobPhase.Started)) {
      return false;
    }
    // a 4xx other than a timeout or a rate limit (the job is unknown, the request refused) never passes
    const status = error instanceof FrameleafCloudError ? error.status : null;
    if (status !== null && status >= 400 && status < 500 && ![401, 408, 429].includes(status)) {
      return false;
    }
    const failures = run.result.transientFailures + 1;
    if (counted && failures > CLOUD_ML_JOB_MAX_TRANSIENT_FAILURES) {
      return false;
    }
    // a refused access token is signed again on the next read; one refused for a day will not pass
    if (status === 401 && failures > CLOUD_ML_JOB_MAX_UNAUTHORIZED_READS) {
      return false;
    }
    const retryAfter = error instanceof FrameleafCloudError ? error.retryAfterSeconds : null;
    run.result = {
      ...run.result,
      transientFailures: failures,
      waiting: { code: failure?.code ?? 'cloud_ml_waiting', detail: errorMessage(error), at: run.now.toISOString() },
    };
    this.logger.warn(`Frameleaf Cloud job ${run.operation.id} waits after a failure: ${errorMessage(error)}`);
    if (await this.save(run)) {
      await this.wait(run, cloudMlJobBackoffMs(failures, retryAfter));
    }
    return true;
  }

  private async waitForAdmission(
    run: JobRun,
    error: FrameleafCloudError,
    failure: CloudMlJobFailure | null,
  ): Promise<boolean> {
    const failures = run.result.transientFailures + 1;
    if (failures > CLOUD_ML_JOB_MAX_TRANSIENT_FAILURES) {
      return false;
    }
    run.result = {
      ...run.result,
      transientFailures: failures,
      waiting: { code: failure?.code ?? 'cloud_ml_waiting', detail: errorMessage(error), at: run.now.toISOString() },
    };
    this.logger.warn(`Frameleaf Cloud job ${run.operation.id} waits to be admitted: ${errorMessage(error)}`);
    if (await this.save(run)) {
      await this.wait(run, cloudMlJobBackoffMs(failures, error.retryAfterSeconds));
    }
    return true;
  }

  /** Put the restoration row in its running state the first time a step runs. False: it was decided meanwhile. */
  private async markRunning(run: JobRun): Promise<boolean> {
    const statuses = STAGE_STATUSES[run.snapshot.stage];
    const row = await this.restorationRepository.get(run.snapshot.restorationId);
    if (!row) {
      const failure = new CloudMlJobFailure('cloud_ml_restoration_missing', 'This version no longer exists', false);
      await this.stop(run, failure);
      return false;
    }
    if (row.status === statuses.running) {
      return true;
    }
    const from =
      run.snapshot.stage === 'preview'
        ? [AssetRestorationStatus.PreviewQueued, AssetRestorationStatus.PreviewFailed]
        : [AssetRestorationStatus.Accepted, AssetRestorationStatus.RestoreFailed];
    const moved = await this.restorationRepository.transition(row.id, from, { status: statuses.running, error: null });
    if (!moved) {
      const detail = `This version is ${row.status.replaceAll('_', ' ')} now; nothing more is sent`;
      await this.stop(run, new CloudMlJobFailure('cloud_ml_restoration_decided', detail, false));
      return false;
    }
    return true;
  }

  /**
   * The gateway for a step, or null when the step already ended. Turning processing off, or keeping the
   * work on this server, stops the job (a started cloud job is cancelled). A cloud that does not answer
   * leaves a started job to be read again later; an unsent one fails and gets its automatic retry.
   */
  private async gatewayFor(run: JobRun): Promise<CloudMlGateway | null> {
    const settings = await this.cloudMlSettings();
    if (!settings.enabled || !cloudRouteAllows(settings, run.snapshot.appWorkload)) {
      if (run.result.job) {
        const resolution = await resolveCloudGateway(this.gatewayDeps());
        if (resolution.state === CloudConnectionState.Ready) {
          await this.sendCancel(run, new FrameleafCloudJobClient(this.frameleafCloudMlRepository, resolution.gateway));
        }
      }
      const detail =
        'Frameleaf Cloud processing is turned off, or Where each job runs keeps this work on this server. The job stopped; nothing more is sent.';
      await this.stop(run, new CloudMlJobFailure('cloud_ml_turned_off', detail, false));
      return null;
    }
    const resolution = await resolveCloudGateway(this.gatewayDeps());
    if (resolution.state === CloudConnectionState.Ready) {
      return resolution.gateway;
    }
    if (run.result.job && resolution.state === CloudConnectionState.Unavailable) {
      // a cloud job already running is read again later rather than given up on
      run.result = {
        ...run.result,
        waiting: { code: 'cloud_ml_unavailable', detail: resolution.detail, at: run.now.toISOString() },
      };
      if (await this.save(run)) {
        await this.wait(run, CLOUD_ML_JOB_MAX_POLL_MS);
      }
      return null;
    }
    const transient = resolution.state === CloudConnectionState.Unavailable;
    throw new CloudMlJobFailure('cloud_ml_unavailable', resolution.detail, transient);
  }

  /* ------------------------------------------------------------------ */
  /* Submit                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Admit and submit the job. The attempt is recorded before `POST /v2/jobs`, so a retry after a lost
   * answer or a crash replays the same key and body and is answered with the same admission. An
   * estimate the queue held past its expiry is sealed again first, and sent only within 10 % of what
   * the owner confirmed; a changed model, a price above that, or a 402 stops the job as it is.
   */
  private async submit(
    run: JobRun,
    gateway: CloudMlGateway,
    client: FrameleafCloudJobClient,
    signal: AbortSignal | null,
  ) {
    const { operation, snapshot } = run;
    await this.checkInputs(run);
    await this.admit(snapshot, snapshot.approved.holdUsd, operation.id);

    let submission = run.result.submission;
    const expired = !!submission && !estimateUsable({ expiresAt: submission.expiresAt }, run.now.getTime());
    if (!submission || (!submission.attemptedAt && expired)) {
      submission = await this.reestimate(run, gateway);
    }
    if (!submission.attemptedAt || !submission.idempotencyKey) {
      submission = {
        ...submission,
        idempotencyKey: submission.idempotencyKey ?? cloudMlJobIdempotencyKey(operation.id, run.result.estimates),
        attemptedAt: submission.attemptedAt ?? run.now.toISOString(),
      };
      run.result = { ...run.result, submission };
      if (!(await this.save(run))) {
        return;
      }
    }

    let admitted: Awaited<ReturnType<FrameleafCloudMlRepository['createJob']>>;
    try {
      admitted = await this.frameleafCloudMlRepository.createJob(
        gateway,
        {
          estimate: submission.estimate,
          workload: snapshot.workload,
          modelSku: snapshot.model.sku,
          modelRev: submission.modelRev,
          clientRef: cloudMlJobClientRef(operation.id),
          inputs: snapshot.inputs.map((input) => this.toCloudInput(input)),
          request: snapshot.request,
        } as Parameters<FrameleafCloudMlRepository['createJob']>[1],
        submission.idempotencyKey!,
      );
    } catch (error) {
      const code = cloudErrorCode(error);
      // an expired sealed estimate (409) created no job under this key: seal it again. A used or
      // mismatched one is not resealed: it may belong to a job this key already created
      if (code === 'estimate-expired' && run.result.estimates < CLOUD_ML_JOB_MAX_ESTIMATES) {
        run.result = { ...run.result, submission: null };
        if (await this.save(run)) {
          await this.wait(run, 0);
        }
        return;
      }
      throw this.submitFailure(error);
    }

    const held = await this.mediaOperationRepository.setRemoteJobId(operation.id, run.claimToken, admitted.jobId);
    if (!held) {
      // the claim is gone: keep the job's id on the row first so the cleanup pass can always find it,
      // then stop it rather than leave it holding the wallet unwatched
      this.logger.warn(
        `Frameleaf Cloud job ${operation.id}: claim lost after cloud job ${admitted.jobId} was admitted`,
      );
      await this.mediaOperationRepository.recordRemoteJobId(operation.id, admitted.jobId);
      await client.cancel(admitted.jobId, admitted.status).catch(() => {});
    }
    // one accounting row per cloud job, which its settlement fills once; a replay adds none. A job whose
    // claim was lost was stopped above, and its row says so; what it cost is settled all the same
    await this.mlDestinationRepository.recordCloudJobAccounting({
      destinationId: snapshot.destinationId,
      destinationKind: MlDestinationKind.FrameleafCloud,
      workload: snapshot.appWorkload,
      jobId: operation.id,
      jobName: MediaOperationKind.CloudMlJob,
      bytesSent: snapshot.inputs.reduce((sum, input) => sum + input.bytes, 0),
      bytesReceived: 0,
      durationMs: 0,
      outcome: held ? 'success' : 'failure',
      costUsd: null,
      startedAt: run.now,
      finishedAt: run.now,
      cloudJobId: admitted.jobId,
    });
    if (!held) {
      return;
    }
    run.result = {
      ...run.result,
      phase: CloudMlJobPhase.Uploading,
      job: {
        jobId: admitted.jobId,
        status: admitted.status,
        holdUsd: admitted.hold.amountUsd,
        ceilingUsd: admitted.hold.ceilingUsd,
        meteredUsd: 0,
        meteredSeconds: 0,
        workers: 0,
        startFees: 0,
        progress: null,
        etag: null,
        admittedAt: admitted.createdAt,
        startedAt: null,
        error: null,
      },
      waiting: null,
      // waits before admission (FC-62) never count against the job's uploads
      transientFailures: 0,
    };
    if (await this.save(run)) {
      await this.upload(run, client, admitted.uploads ?? null, signal);
    }
  }

  /** What a refused submission means: a 402 or a model mismatch stops the job as it is, never downgraded. */
  private submitFailure(error: unknown): unknown {
    if (!(error instanceof FrameleafCloudError)) {
      return error;
    }
    if (isIdempotencyKeyReused(error)) {
      // FC-43: one key per job and one body per key, so this is a bug here: fail, never send again
      this.logger.error(`Frameleaf Cloud job refused as a reused idempotency key: ${error.message}`);
      return new CloudMlJobFailure(
        'cloud_ml_idempotency_key_reused',
        'Frameleaf Cloud refused this job because this server sent it twice with different details. Nothing was sent again; estimate it again.',
        false,
      );
    }
    switch (error.refusal) {
      case MlAdmissionRefusal.WalletInsufficient: {
        return new CloudMlJobFailure(
          'cloud_ml_insufficient_credits',
          'The AI Wallet cannot hold this job. Nothing was sent, and the job does not run with a lighter model; add credit and estimate again.',
          false,
        );
      }
      case MlAdmissionRefusal.BudgetExceeded: {
        return new CloudMlJobFailure(
          'cloud_ml_daily_cap',
          "This job would go over today's AI Wallet limit. Nothing was sent, and the job does not run with a lighter model.",
          false,
        );
      }
      case MlAdmissionRefusal.ModelMismatch: {
        return new CloudMlJobFailure(
          'cloud_ml_model_mismatch',
          'Frameleaf Cloud no longer runs this model or revision. Choose the model again and estimate again; nothing was sent.',
          false,
        );
      }
      default: {
        return error;
      }
    }
  }

  /**
   * Seal the job's estimate again (the queue held it past 15 minutes). Sent only while the new high end
   * stays within `CLOUD_ML_JOB_PRICE_TOLERANCE` of what the owner confirmed.
   */
  private async reestimate(run: JobRun, gateway: CloudMlGateway): Promise<NonNullable<CloudMlJobResult['submission']>> {
    const { snapshot, operation } = run;
    if (run.result.estimates >= CLOUD_ML_JOB_MAX_ESTIMATES) {
      throw new CloudMlJobFailure(
        'cloud_ml_estimate_unstable',
        'Frameleaf Cloud could not hold an estimate for this job. Nothing was sent; estimate it again.',
        false,
      );
    }
    const sealed = await this.frameleafCloudMlRepository.createEstimate(gateway, {
      workload: snapshot.workload,
      modelSku: snapshot.model.sku,
      inputs: snapshot.inputs.map((input) => this.toCloudInput(input)),
      request: snapshot.request,
    } as Parameters<FrameleafCloudMlRepository['createEstimate']>[1]);
    if (sealed.modelSku !== snapshot.model.sku || sealed.modelRev !== snapshot.model.rev) {
      throw new CloudMlJobFailure(
        'cloud_ml_model_mismatch',
        'Frameleaf Cloud now runs another revision of this model. Nothing was sent; choose the model and estimate again.',
        false,
      );
    }
    if (
      snapshot.upscale &&
      this.upscaleQuote(sealed, snapshot.upscale.requestedScale, snapshot.upscale.input).appliedScale !==
        snapshot.upscale.appliedScale
    ) {
      throw new CloudMlJobFailure(
        'cloud_ml_estimate_unstable',
        'Frameleaf Cloud changed the upscale factor after confirmation. Nothing was sent; estimate again.',
        false,
      );
    }
    if (
      sealed.cost.p90 > snapshot.approved.p90Usd * CLOUD_ML_JOB_PRICE_TOLERANCE ||
      sealed.cost.hold > snapshot.approved.holdUsd * CLOUD_ML_JOB_PRICE_TOLERANCE
    ) {
      throw new CloudMlJobFailure(
        'cloud_ml_estimate_increased',
        `Frameleaf Cloud now estimates this job at up to ${sealed.cost.p90.toFixed(2)} USD, above the ${snapshot.approved.p90Usd.toFixed(2)} USD you confirmed. Nothing was sent; estimate again.`,
        false,
      );
    }
    const estimates = run.result.estimates + 1;
    const submission = {
      idempotencyKey: cloudMlJobIdempotencyKey(operation.id, estimates),
      estimate: sealed.estimate,
      expiresAt: sealed.expiresAt,
      modelRev: sealed.modelRev,
      computeSku: sealed.computeSku,
      p50Usd: sealed.cost.p50,
      p90Usd: sealed.cost.p90,
      holdUsd: sealed.cost.hold,
      startupUsd: sealed.cost.startup,
      attemptedAt: null,
    };
    run.result = { ...run.result, estimates, submission };
    return submission;
  }

  /* ------------------------------------------------------------------ */
  /* Upload and start                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Upload every input (resuming from the recorded parts), then start the job. A cancel or a pause
   * lands between two parts. A job that no longer takes uploads was started already: it is polled.
   */
  private async upload(
    run: JobRun,
    client: FrameleafCloudJobClient,
    given: CloudUploadTarget[] | null,
    signal: AbortSignal | null,
  ) {
    const job = run.result.job!;
    const uploads = structuredClone(run.result.uploads);
    const outcome = await client.upload(job.jobId, run.snapshot.inputs, uploads, {
      given,
      now: run.now,
      record: async (state) => {
        run.result = { ...run.result, uploads: structuredClone(state) };
        if (!(await this.save(run))) {
          return false;
        }
        await this.readmit(run, client);
        return true;
      },
    });
    if (outcome === 'stopped') {
      if (signal?.aborted) {
        await this.afterAbort(run, signal);
      }
      return;
    }
    if (outcome === 'uploaded') {
      try {
        // metering can only begin once every input is uploaded and the job is started
        await this.readmit(run, client);
        const view = await client.start(job.jobId);
        run.result = { ...run.result, job: cloudMlJobRecordOf(view, job, null) };
      } catch (error) {
        if (cloudErrorCode(error) !== 'inputs-missing') {
          throw error;
        }
        // an input is not complete in storage: the next attempt uploads what is missing again
        const reset = Object.fromEntries(
          Object.entries(run.result.uploads).map(([id, state]) => [id, { ...state, done: false }]),
        );
        run.result = { ...run.result, uploads: reset };
        await this.save(run, { quiet: true });
        throw new CloudMlJobFailure('cloud_ml_inputs_missing', 'Frameleaf Cloud did not have every input yet', true);
      }
    }
    run.result = { ...run.result, phase: CloudMlJobPhase.Started, waiting: null, transientFailures: 0 };
    if (await this.save(run)) {
      await this.wait(run, CLOUD_ML_JOB_POLL_MS);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Poll                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * Read the job, conditionally: a 304 means nothing changed, and the next read waits for the cloud's
   * `Retry-After` (or `CLOUD_ML_JOB_POLL_MS`). Progress (items, seconds or segments of a chunked video)
   * is shown as the cloud reports it. An ended job is collected in the same step.
   */
  private async poll(run: JobRun, client: FrameleafCloudJobClient) {
    const job = run.result.job!;
    const read = await client.read(job.jobId, job.etag, POLL_TIMING);
    const view = read.view;
    if (!view) {
      if (run.result.transientFailures > 0) {
        run.result = { ...run.result, transientFailures: 0, waiting: null };
        if (!(await this.save(run))) {
          return;
        }
      }
      await this.wait(run, read.delayMs);
      return;
    }
    run.result = {
      ...run.result,
      job: cloudMlJobRecordOf(view, job, read.etag),
      waiting: null,
      transientFailures: 0,
    };
    if (isFinalCloudJobStatus(view.status)) {
      run.result = { ...run.result, phase: CloudMlJobPhase.Ending };
      if (await this.save(run)) {
        await this.end(run, client, view);
      }
      return;
    }
    if (!(await this.save(run))) {
      return;
    }
    const progress = view.progress;
    const counted = !!progress && progress.total > 0;
    await this.mediaOperationRepository.reportProgress(run.operation.id, run.claimToken, {
      status: view.status === 'running' ? MediaOperationStatus.Rendering : MediaOperationStatus.Preparing,
      processedUnits: progress?.done ?? 0,
      totalUnits: counted ? progress.total : null,
      progress: counted ? Math.min(99, Math.round((progress.done / progress.total) * 100)) : 0,
    });
    await this.wait(run, read.delayMs);
  }

  /* ------------------------------------------------------------------ */
  /* Collect                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * An ended job. A completed job (or one stopped at its hold, which keeps its completed outputs) is
   * downloaded and every output checked against its SHA-256, and the result is published. Only once
   * the publication is committed is the job acknowledged, so the cloud purges it: until then the
   * cloud keeps the result and a failed or interrupted publication downloads it again. A job that
   * failed or expired is acknowledged and reported with its fixed reason; its hold went back in full.
   * The cost is recorded once, when settled.
   */
  private async end(run: JobRun, client: FrameleafCloudJobClient, known: CloudJobView | null) {
    const job = run.result.job!;
    let view = known;
    if (!view) {
      const read = await client.read(job.jobId, null, POLL_TIMING);
      if (!read.view) {
        await this.wait(run, read.delayMs);
        return;
      }
      view = read.view;
      run.result = { ...run.result, job: cloudMlJobRecordOf(view, job, read.etag) };
    }
    this.recordCost(run, view);

    // FC-46/FC-47: a job's result document (output `result`) describes its media outputs; it is never one
    const all = view.result?.outputs ?? [];
    const document_ = all.find((output) => output.outputId === CLOUD_RESULT_OUTPUT_ID);
    const outputs = orderedOutputs(all.filter((output) => output.outputId !== CLOUD_RESULT_OUTPUT_ID));
    const budgetStopped = view.status === 'cancelled_budget';
    const delivered = view.status === 'completed' || budgetStopped;
    if (delivered && outputs.length > 0 && !outputsComplete(outputs, view.progress, budgetStopped)) {
      // shards missing (a job stopped at its hold part-way, or a gap): not a whole version
      throw budgetStopped
        ? new CloudMlJobFailure(
            'cloud_ml_budget_reached',
            'The job reached its AI Wallet hold before every part was done, so nothing was published',
            false,
          )
        : new CloudMlJobFailure('cloud_ml_output_incomplete', 'Frameleaf Cloud did not return every part', false);
    }
    if (!delivered || outputs.length === 0) {
      await this.acknowledge(run, client);
      await this.settleAccounting(run);
      const reason =
        view.error?.code === 'runtime-cap'
          ? CLOUD_ML_JOB_RUNTIME_CAP_MESSAGE
          : (view.error?.message ?? `Frameleaf Cloud ended this job (${view.status.replaceAll('_', ' ')}).`);
      const code = `cloud_ml_job_${(view.error?.code ?? view.status).replaceAll('-', '_')}`;
      run.result = { ...run.result, phase: CloudMlJobPhase.Finished };
      await this.stop(run, new CloudMlJobFailure(code, reason, false));
      return;
    }

    // an upscale is written at the factor its result document says the photo really got (FC-46)
    const document = run.snapshot.workload === 'upscale' ? (document_ ?? null) : null;
    let files: string[] | null;
    try {
      files = await client.download(view, document ? [...outputs, document] : outputs, run.snapshot.workDir, {
        done: run.result.downloaded,
        exists: (file) => this.storageRepository.checkFileExists(file),
        remove: (file) => this.storageRepository.unlink(file).catch(() => {}),
        fileName: (output) => `out-${output.outputId}${this.extensionOf(output.contentType)}`,
        record: (outputId) => {
          run.result = { ...run.result, downloaded: [...new Set([...run.result.downloaded, outputId])] };
          return this.save(run);
        },
      });
    } catch (error) {
      if (error instanceof CloudTransferError && error.failure === 'sha256-mismatch') {
        // nothing was kept; the job is read again after a wait, with fresh addresses
        throw new CloudMlJobFailure(
          'cloud_ml_output_sha256_mismatch',
          'A result from Frameleaf Cloud did not match its SHA-256 and was not kept',
          true,
        );
      }
      throw error;
    }
    if (!files) {
      return;
    }
    if (document) {
      const upscaleScale = await this.readUpscaleResult(run, files.at(-1)!);
      files = files.slice(0, -1);
      run.result = { ...run.result, upscaleScale };
    } else if (run.snapshot.workload === 'upscale' && run.snapshot.upscale) {
      throw new CloudMlJobFailure(
        'cloud_ml_output_invalid',
        'Frameleaf Cloud did not say which factor it upscaled this photo by, so nothing was published',
        false,
      );
    }
    run.result = { ...run.result, transientFailures: 0, waiting: null };
    if (!(await this.save(run))) {
      return;
    }
    const published = await this.publish(run, files);
    if (published !== 'lost') {
      // the version is committed (or was discarded): the cloud may purge the job now
      await this.releaseFinished(run, client);
    }
  }

  /**
   * Acknowledge and settle a job whose step already finished it. A failure here is only logged: the
   * cleanup pass (`acknowledgeFinished`) acknowledges any finished job that is still unacknowledged.
   */
  private async releaseFinished(run: JobRun, client: FrameleafCloudJobClient) {
    try {
      await this.acknowledge(run, client);
      // the settle pass may have recorded the cost since this step read the job: keep it
      const stored = await this.mediaOperationRepository.getForWorker(run.operation.id);
      const kept = stored ? parseCloudMlJobResult(stored.result) : null;
      if (!run.result.cost && kept?.cost) {
        run.result = { ...run.result, cost: kept.cost, costReads: Math.max(run.result.costReads, kept.costReads) };
      }
      await this.settleAccounting(run);
      await this.mediaOperationRepository.setFinishedResult(
        run.operation.id,
        run.result as unknown as Record<string, unknown>,
      );
    } catch (error) {
      this.logger.warn(`Frameleaf Cloud job ${run.operation.id} is acknowledged later: ${errorMessage(error)}`);
    }
  }

  /** Record the job's settled cost the first time it is seen; never overwritten afterwards. */
  private recordCost(run: Pick<JobRun, 'result'>, view: Pick<CloudJobView, 'cost'>) {
    if (!run.result.cost && view.cost) {
      run.result = { ...run.result, cost: cloudMlJobCostOf(view) };
    }
  }

  /** `ml_workload_accounting` is settled once, from the job's own settlement (FC-43). */
  private async settleAccounting(run: Pick<JobRun, 'result'>) {
    const { job, cost } = run.result;
    if (job && cost) {
      await this.mlDestinationRepository.applySettlements([
        { cloudJobId: job.jobId, costUsd: cost.totalUsd, credits: null },
      ]);
    }
  }

  private async acknowledge(run: Pick<JobRun, 'result' | 'operation'>, client: FrameleafCloudJobClient) {
    if (run.result.acknowledged || !run.result.job) {
      return;
    }
    await client.acknowledge(run.result.job.jobId);
    await this.mediaOperationRepository.markRemoteReleased(run.operation.id);
    run.result = { ...run.result, acknowledged: true };
  }

  /* ------------------------------------------------------------------ */
  /* Publish                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Assemble the downloaded outputs into the version's files and publish them with the restoration
   * row's change and the job's completion in one transaction (FL-43). A chunked video's outputs are
   * joined in shard order and the original's audio is put back.
   */
  private async publish(run: JobRun, outputs: string[]): Promise<'completed' | 'rejected' | 'lost'> {
    const { snapshot, operation, claimToken } = run;
    const statuses = STAGE_STATUSES[snapshot.stage];
    const row = await this.restorationRepository.get(snapshot.restorationId);
    const source = await this.assetJobRepository.getForGenerateThumbnailJob(snapshot.assetId);
    if (!row || !source) {
      throw new CloudMlJobFailure(
        'cloud_ml_source_missing',
        'The original or its version is no longer available',
        false,
      );
    }
    const base = StorageCore.getNestedFolder(StorageFolder.Thumbnails, row.ownerId, row.assetId);
    const paths = restorationOutputPaths(base, row.assetId, row.id);
    const original = snapshot.stage === 'preview' ? null : source.originalPath;
    const output =
      snapshot.sourceType === 'video'
        ? await this.assembleVideo(run, outputs, original)
        : await this.assembleImage(run, outputs[0]);

    const files: PublishedFile[] = [];
    if (snapshot.stage === 'preview') {
      const extension = snapshot.sourceType === 'video' ? '.mp4' : '.jpg';
      files.push(
        { tmp: snapshot.beforePath!, final: `${paths.before}${extension}`, column: 'previewBeforePath' },
        { tmp: output.file, final: `${paths.after}${path.extname(output.file)}`, column: 'previewAfterPath' },
      );
    } else {
      files.push({ tmp: output.file, final: `${paths.result}${path.extname(output.file)}`, column: 'resultPath' });
      if (output.preview) {
        files.push({ tmp: output.preview, final: paths.resultPreview, column: 'resultPreviewPath' });
      }
    }

    if (!(await this.mediaOperationRepository.beginValidation(operation.id, claimToken))) {
      return 'lost';
    }
    const now = new Date();
    const provenance = {
      ...(typeof row.provenance === 'object' && row.provenance),
      [snapshot.stage]: {
        operationId: operation.id,
        destinationId: snapshot.destinationId,
        destinationKind: MlDestinationKind.FrameleafCloud,
        workload: snapshot.appWorkload,
        cloudJobId: run.result.job?.jobId ?? null,
        modelSku: snapshot.model.sku,
        modelRev: snapshot.model.rev,
        modelName: snapshot.model.label,
        consentVersion: snapshot.consent.version,
        sourceChecksumHex: snapshot.sourceChecksumHex,
        finishedAt: now.toISOString(),
      },
    };
    const placed: string[] = [];
    const columns: Partial<Record<PublishedFile['column'], string>> = {};
    let outcome: Awaited<ReturnType<MediaOperationRepository['publishValidated']>>;
    try {
      outcome = await this.mediaOperationRepository.publishValidated(operation.id, claimToken, async (trx) => {
        for (const file of files) {
          this.storageRepository.mkdirSync(path.dirname(file.final));
          await this.storageRepository.rename(file.tmp, file.final);
          placed.push(file.final);
          columns[file.column] = file.final;
        }
        const updated = await this.restorationRepository.transition(
          row.id,
          [statuses.running],
          {
            status: statuses.done,
            ...columns,
            modelName: snapshot.model.label,
            modelVersion: snapshot.model.rev,
            provenance,
            error: null,
            ...(snapshot.stage === 'preview'
              ? { previewReadyAt: now, previewExpiresAt: previewExpiryAfterReady(now) }
              : { restoredAt: now, outputWidth: output.width, outputHeight: output.height }),
            // FC-46: the version records the factor its photo really got
            ...(run.result.upscaleScale !== null && { upscale: run.result.upscaleScale }),
          },
          trx,
        );
        return !!updated;
      });
    } catch (error) {
      for (const file of placed) {
        await this.storageRepository.unlink(file).catch(() => {});
      }
      throw error;
    }
    if (outcome === 'rejected') {
      await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: placed } });
      await this.mediaOperationRepository.fail(
        operation.id,
        claimToken,
        { error: 'The version was discarded while Frameleaf Cloud was working on it', errorCode: 'cloud_ml_discarded' },
        { retry: false },
      );
      await this.removeJobFiles(snapshot);
      return 'rejected';
    }
    if (outcome === 'completed') {
      await this.removeJobFiles(snapshot);
      this.logger.log(`Frameleaf Cloud job ${operation.id} published ${snapshot.purpose} ${snapshot.stage} ${row.id}`);
    }
    return outcome;
  }

  /**
   * A video version: the per-shard outputs joined in order, with audio put back (the preview's own
   * clip, or the original for a full render) and no metadata. It must fit its size cap and keep the
   * source's length; a job stopped at its hold before every part was done is not a whole video.
   */
  private async assembleVideo(run: JobRun, outputs: string[], original: string | null) {
    const { snapshot, operation } = run;
    const joined = outputs.length === 1 ? outputs[0] : await this.join(snapshot.workDir, outputs);
    const audioFrom = snapshot.stage === 'preview' ? snapshot.beforePath : original;
    // CLD-202: the audio never went to the cloud; it is put back from this server's own copy, in step
    // with the picture as it was there (its start offset against the first frame kept)
    const audioSource = audioFrom ? await this.mediaRepository.probe(audioFrom) : null;
    const sourceAudio = audioSource?.audioStreams[0];
    const offset = audioReattachOffsetSeconds(audioSource?.videoStreams[0]?.startTime, sourceAudio?.startTime);
    const file = path.join(snapshot.workDir, `version-${operation.id}.mp4`);
    await this.storageRepository.unlink(file).catch(() => {});
    await this.mediaRepository.transcode(joined, file, {
      inputOptions: [],
      outputOptions: reattachAudioOutputOptions(sourceAudio ? audioFrom : null, offset),
      twoPass: false,
      progress: { frameCount: 0, percentInterval: 5 },
    });
    const probe = await this.mediaRepository.probe(file);
    const stream = probe.videoStreams[0];
    // FL-102: verified with ffprobe: the source's audio is there with its layout, and ends with the picture
    const audioProblem = sourceAudio
      ? (findAudioLayoutMismatch(
          {
            policy: AudioChannelPolicy.Preserve,
            channels: sourceAudio.channels ?? null,
            channelLayout: sourceAudio.channelLayout ?? null,
            sampleRate: sourceAudio.sampleRate ?? null,
          },
          probe.audioStreams[0],
        ) ?? findAvAlignmentMismatch(stream, probe.audioStreams[0]))
      : probe.audioStreams.length > 0
        ? 'it carries audio its source never had'
        : null;
    if (audioProblem) {
      throw new CloudMlJobFailure(
        'cloud_ml_audio_invalid',
        `The video's own audio could not be put back in step: ${audioProblem}`,
        false,
      );
    }
    const cap = snapshot.output;
    if (!stream || stream.width > cap.width + 1 || stream.height > cap.height + 1) {
      throw new CloudMlJobFailure(
        'cloud_ml_output_invalid',
        'The video from Frameleaf Cloud does not fit this version',
        false,
      );
    }
    if (snapshot.durationSeconds && probe.format.duration < snapshot.durationSeconds * 0.9) {
      throw new CloudMlJobFailure(
        'cloud_ml_output_invalid',
        'The video from Frameleaf Cloud is shorter than its source',
        false,
      );
    }
    return { file, preview: null, width: stream.width, height: stream.height };
  }

  /**
   * FC-46: read the upscale job's result document and answer the factor this photo was really upscaled
   * by (`UpscaleItem.scale`). The document must be the contract's, name this job's model, describe the
   * photo that was declared, and give it an output; each output is its input times its own item's
   * factor, never the document's requested one.
   */
  private async readUpscaleResult(run: JobRun, file: string): Promise<2 | 4> {
    const { snapshot } = run;
    const invalid = (detail: string) =>
      new CloudMlJobFailure('cloud_ml_output_invalid', `The upscale result from Frameleaf Cloud ${detail}`, false);
    const body = await this.storageRepository.readFile(file);
    if (body.length > CLOUD_UPSCALE_RESULT_MAX_BYTES) {
      throw invalid('is larger than the contract allows');
    }
    let parsed: ReturnType<typeof upscaleResultSchema.safeParse>;
    try {
      parsed = upscaleResultSchema.safeParse(JSON.parse(body.toString('utf8')));
    } catch {
      throw invalid('is not JSON');
    }
    if (!parsed.success) {
      throw invalid('does not match the contract');
    }
    const result = parsed.data;
    if (result.modelSku !== snapshot.model.sku) {
      throw invalid('names another model');
    }
    const input = snapshot.inputs[0];
    const item = result.items.find((entry) => entry.inputId === input?.inputId);
    if (!item || item.scale === null || item.outputs.length === 0) {
      throw invalid(`says the photo was not upscaled (${item?.warnings.join(', ') || 'no item'})`);
    }
    const declared = snapshot.upscale?.input;
    if (declared && (item.input?.width !== declared.width || item.input?.height !== declared.height)) {
      throw invalid('describes another photo than the one sent');
    }
    if (snapshot.upscale && item.scale !== snapshot.upscale.appliedScale) {
      throw invalid(`says ${item.scale}×, but the owner approved ${snapshot.upscale.appliedScale}×`);
    }
    return item.scale;
  }

  /** A photo version, checked against its size cap; a full render also gets a preview-sized copy. */
  private async assembleImage(run: JobRun, file: string) {
    const { snapshot, operation } = run;
    const cap = snapshot.output;
    const meta = await this.mediaRepository.getImageMetadata(file);
    const upscale = snapshot.upscale;
    const scale = run.result.upscaleScale;
    if (upscale && scale !== null) {
      // FC-46: exactly the declared photo times the factor its own item was upscaled by
      if (meta.width !== upscale.input.width * scale || meta.height !== upscale.input.height * scale) {
        throw new CloudMlJobFailure(
          'cloud_ml_output_invalid',
          `The photo from Frameleaf Cloud is ${meta.width}×${meta.height}, not ${scale}× the photo that was sent`,
          false,
        );
      }
    } else if (!(meta.width > 0 && meta.height > 0) || meta.width > cap.width + 1 || meta.height > cap.height + 1) {
      throw new CloudMlJobFailure(
        'cloud_ml_output_invalid',
        'The photo from Frameleaf Cloud does not fit this version',
        false,
      );
    }
    let preview: string | null = null;
    if (snapshot.stage === 'full') {
      const { image } = await this.getConfig();
      preview = path.join(snapshot.workDir, `version-preview-${operation.id}.jpg`);
      await this.mediaRepository.generateThumbnail(
        file,
        {
          format: ImageFormat.Jpeg,
          quality: image.preview.quality,
          size: image.preview.size,
          colorspace: image.colorspace,
          processInvalidImages: false,
        },
        preview,
      );
    }
    return { file, preview, width: meta.width, height: meta.height };
  }

  /** Join a chunked video's per-shard outputs, in order, with a stream copy. */
  private async join(workDir: string, outputs: string[]): Promise<string> {
    const list = path.join(workDir, 'concat.txt');
    await this.storageRepository.createOrOverwriteFile(
      list,
      Buffer.from(outputs.map((file) => `file '${file.replaceAll("'", String.raw`'\''`)}'`).join('\n') + '\n'),
    );
    const joined = path.join(workDir, 'joined.mp4');
    await this.storageRepository.unlink(joined).catch(() => {});
    await this.mediaRepository.transcode(list, joined, {
      inputOptions: ['-f', 'concat', '-safe', '0'],
      outputOptions: ['-c', 'copy'],
      twoPass: false,
      progress: { frameCount: 0, percentInterval: 5 },
    });
    return joined;
  }

  /* ------------------------------------------------------------------ */
  /* Stop, cancel, wait                                                  */
  /* ------------------------------------------------------------------ */

  /**
   * A step met a failure. A job whose failure may pass gets its one automatic retry (FL-104); anything
   * else fails at once. The restoration row follows a failure that is reported, and a started cloud
   * job is left to the cleanup pass, which cancels and acknowledges it.
   */
  private async stop(run: JobRun, failure: CloudMlJobFailure) {
    const { operation, claimToken, snapshot } = run;
    const statuses = STAGE_STATUSES[snapshot.stage];
    run.result = { ...run.result, waiting: { code: failure.code, detail: failure.message, at: run.now.toISOString() } };
    await this.save(run, { quiet: true });
    const outcome = await this.mediaOperationRepository.fail(
      operation.id,
      claimToken,
      { error: failure.message, errorCode: failure.code },
      { retry: failure.retry },
    );
    if (outcome === 'failed') {
      await this.restorationRepository.transition(snapshot.restorationId, [statuses.running, this.queuedStatus(run)], {
        status: statuses.failed,
        error: failure.message.slice(0, 500),
        ...(snapshot.stage === 'full' && { resultExpiresAt: resultExpiryAfterAbandon(new Date()) }),
      });
      // the prepared copies and anything downloaded are of no use to a job that will not run again
      await this.removeJobFiles(snapshot);
      this.logger.warn(`Frameleaf Cloud job ${operation.id} failed (${failure.code}): ${failure.message}`);
    }
  }

  private queuedStatus(run: Pick<JobRun, 'snapshot'>): AssetRestorationStatus {
    return run.snapshot.stage === 'preview' ? AssetRestorationStatus.PreviewQueued : AssetRestorationStatus.Accepted;
  }

  /**
   * Write the result. False when the claim is gone, or a cancel or pause arrived (then handled here):
   * a cancel stops the cloud job; a pause lands only before the cloud job was started, since a started
   * job keeps running (and metering) on Frameleaf Cloud whether this server watches it or not.
   */
  private async save(run: JobRun, options: { quiet?: boolean } = {}): Promise<boolean> {
    const progress = run.result.job?.progress;
    const counted = !!progress && progress.total > 0;
    const written = await this.mediaOperationRepository.setBulkResult(run.operation.id, run.claimToken, {
      result: run.result as unknown as Record<string, unknown>,
      processedUnits: progress?.done ?? 0,
      totalUnits: progress?.total ?? 0,
      progress: counted ? Math.min(99, Math.round((progress.done / progress.total) * 100)) : 0,
      leaseMs: CLOUD_ML_JOB_LEASE_MS,
    });
    if (!written) {
      if (!options.quiet) {
        this.logger.warn(`Frameleaf Cloud job ${run.operation.id}: claim lost, stopping`);
      }
      return false;
    }
    if (options.quiet) {
      return true;
    }
    if (written.status === MediaOperationStatus.Cancelling || written.cancelRequestedAt) {
      await this.cancel(run);
      return false;
    }
    if (written.pauseRequestedAt) {
      // an admitted job holds the AI Wallet while it uploads, so only one not yet sent can pause
      const sent = run.result.phase !== CloudMlJobPhase.Queued;
      if (!sent && (await this.mediaOperationRepository.settlePause(run.operation.id, run.claimToken))) {
        this.logger.log(`Frameleaf Cloud job ${run.operation.id} paused by its owner before it started`);
        return false;
      }
      // a started job cannot pause on Frameleaf Cloud: the request is withdrawn and the job carries on
      await this.mediaOperationRepository.resume(run.operation.id, run.operation.ownerId);
    }
    return true;
  }

  /**
   * The owner cancelled a job this worker holds. A cloud job it started is cancelled (the cloud releases
   * the hold, or settles what already ran); the cancel is acknowledged as released once the ended job
   * is acknowledged too, otherwise the cleanup pass finishes it. The version is marked cancelled.
   */
  private async cancel(run: JobRun) {
    const { operation, claimToken, snapshot } = run;
    const statuses = STAGE_STATUSES[snapshot.stage];
    // put right here, so the cleanup pass never reconciles it again (and never touches a later job)
    run.result = { ...run.result, reconciled: true };
    let released = !run.result.job;
    if (run.result.job) {
      const resolution = await resolveCloudGateway(this.gatewayDeps());
      if (resolution.state === CloudConnectionState.Ready) {
        const client = new FrameleafCloudJobClient(this.frameleafCloudMlRepository, resolution.gateway);
        const finished = await this.finishStopped(operation, run.result, client);
        run.result = finished.result;
        released = finished.released;
      }
    }
    await this.save(run, { quiet: true });
    await this.mediaOperationRepository.acknowledgeCancel(operation.id, claimToken, { released });
    const now = new Date();
    if (snapshot.stage === 'full' && !run.result.job) {
      // nothing was sent: the reviewed preview is back to be decided, as if it had not been accepted
      await this.restorationRepository.transition(snapshot.restorationId, [statuses.running, this.queuedStatus(run)], {
        status: AssetRestorationStatus.PreviewReady,
        reviewedAt: null,
        fullOperationId: null,
        previewExpiresAt: previewExpiryAfterReady(now),
      });
    } else {
      await this.restorationRepository.transition(snapshot.restorationId, [statuses.running, this.queuedStatus(run)], {
        status: statuses.cancelled,
        ...(snapshot.stage === 'full' && { resultExpiresAt: resultExpiryAfterAbandon(now) }),
      });
    }
    await this.removeJobFiles(snapshot);
    this.logger.log(`Frameleaf Cloud job ${operation.id} cancelled by its owner`);
  }

  /** Ask the cloud to stop the job, once; an ended job is left as it is. */
  private async sendCancel(run: Pick<JobRun, 'result'>, client: FrameleafCloudJobClient) {
    const job = run.result.job;
    if (!job || run.result.cancelSent) {
      return;
    }
    await client.cancel(job.jobId, job.status);
    run.result = { ...run.result, cancelSent: true };
  }

  /**
   * Stop a job's cloud job and, once it ended, record its cost, settle it and acknowledge it. `released`
   * is true when the cloud confirmed the acknowledgement; until then the cleanup pass comes back to it.
   */
  private async finishStopped(
    operation: MediaOperation,
    result: CloudMlJobResult,
    client: FrameleafCloudJobClient,
  ): Promise<{ released: boolean; result: CloudMlJobResult }> {
    const holder = { operation, result: { ...result } };
    try {
      await this.sendCancel(holder, client);
      const job = holder.result.job!;
      const read = await client.read(job.jobId, null, POLL_TIMING);
      if (!read.view || !isFinalCloudJobStatus(read.view.status)) {
        return { released: false, result: holder.result };
      }
      holder.result = { ...holder.result, job: cloudMlJobRecordOf(read.view, job, read.etag) };
      this.recordCost(holder, read.view);
      await this.acknowledge(holder, client);
      await this.settleAccounting(holder);
      holder.result = { ...holder.result, phase: CloudMlJobPhase.Finished };
      return { released: true, result: holder.result };
    } catch (error) {
      if (error instanceof FrameleafCloudError && error.status === 404) {
        // the cloud no longer knows the job: nothing is held or kept for it any more
        return { released: true, result: { ...holder.result, phase: CloudMlJobPhase.Finished, acknowledged: true } };
      }
      this.logger.warn(`Frameleaf Cloud job ${operation.id} was not released yet: ${errorMessage(error)}`);
      return { released: false, result: holder.result };
    }
  }

  /** Hand the job back to the queue until its next step is due. */
  private async wait(run: JobRun, delayMs: number) {
    await this.mediaOperationRepository.requeue(run.operation.id, run.claimToken, { delayMs, returnAttempt: true });
  }

  /* ------------------------------------------------------------------ */
  /* Passes over jobs no worker holds                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Cloud jobs whose operation was cancelled while no step held it (a cancel between two reads is
   * immediate), or that failed after they started: each is cancelled, and once it has ended its cost is
   * recorded and it is acknowledged. Until the cloud confirms, the job stays on the list.
   */
  async releaseUnwatched(): Promise<void> {
    const operations = await this.mediaOperationRepository.getUnreleasedRemoteOperations(20, [
      MediaOperationKind.CloudMlJob,
    ]);
    const unwatched = operations.filter((operation) => !operation.claimToken);
    if (unwatched.length === 0) {
      return;
    }
    const resolution = await resolveCloudGateway(this.gatewayDeps());
    if (resolution.state !== CloudConnectionState.Ready) {
      return;
    }
    const client = new FrameleafCloudJobClient(this.frameleafCloudMlRepository, resolution.gateway);
    for (const operation of unwatched) {
      const result = parseCloudMlJobResult(operation.result);
      const jobId = result.job?.jobId ?? operation.remoteJobId!;
      const known: CloudMlJobResult = {
        ...result,
        job: result.job ?? { ...this.unknownJob(jobId), admittedAt: new Date().toISOString() },
      };
      const finished = await this.finishStopped(operation, known, client);
      await this.mediaOperationRepository.setFinishedResult(
        operation.id,
        finished.result as unknown as Record<string, unknown>,
      );
      if (!finished.released) {
        continue;
      }
      // idempotent; covers a job the cloud no longer knows (404), which no acknowledgement recorded
      await this.mediaOperationRepository.markRemoteReleased(operation.id);
      try {
        const snapshot = parseCloudMlJobSnapshot(operation.snapshot);
        const statuses = STAGE_STATUSES[snapshot.stage];
        const failed = operation.status === MediaOperationStatus.Failed;
        await this.restorationRepository.transition(
          snapshot.restorationId,
          [statuses.running, this.queuedStatus({ snapshot })],
          { status: failed ? statuses.failed : statuses.cancelled },
        );
        await this.removeJobFiles(snapshot);
      } catch {
        // a job without a readable snapshot has no version to update and no files it names
      }
    }
  }

  /**
   * Jobs cancelled before anything was sent while no step held them (the cancel lands at once, without
   * a worker): a full render's reviewed preview is put back up for review, a preview's version is
   * marked cancelled, and the job's own files are removed. Each is reconciled once.
   */
  async reconcileCancelled(now: Date): Promise<void> {
    const operations = await this.mediaOperationRepository.listUnreconciledCancelledCloudMlJobs({
      limit: 20,
      since: new Date(now.getTime() - 7 * DAY_MS),
    });
    for (const operation of operations) {
      const result = parseCloudMlJobResult(operation.result);
      try {
        const snapshot = parseCloudMlJobSnapshot(operation.snapshot);
        const statuses = STAGE_STATUSES[snapshot.stage];
        const from = [statuses.running, this.queuedStatus({ snapshot })];
        // only the version this job still owns: a later accept or preview has its own job
        const row = await this.restorationRepository.get(snapshot.restorationId);
        const owner = snapshot.stage === 'full' ? row?.fullOperationId : row?.previewOperationId;
        if (owner !== operation.id) {
          await this.removeJobFiles(snapshot);
          await this.mediaOperationRepository.setFinishedResult(operation.id, {
            ...result,
            reconciled: true,
          } as unknown as Record<string, unknown>);
          continue;
        }
        await (snapshot.stage === 'full'
          ? this.restorationRepository.transition(snapshot.restorationId, from, {
              status: AssetRestorationStatus.PreviewReady,
              reviewedAt: null,
              fullOperationId: null,
              previewExpiresAt: previewExpiryAfterReady(now),
            })
          : this.restorationRepository.transition(snapshot.restorationId, from, { status: statuses.cancelled }));
        await this.removeJobFiles(snapshot);
      } catch (error) {
        this.logger.warn(`Frameleaf Cloud job ${operation.id} was not reconciled: ${errorMessage(error)}`);
      }
      await this.mediaOperationRepository.setFinishedResult(operation.id, {
        ...result,
        reconciled: true,
      } as unknown as Record<string, unknown>);
    }
  }

  /**
   * Finished jobs whose acknowledgement did not land after their result was published (a crash, or a
   * `DELETE` that failed): each is acknowledged now, so the cloud purges it, and its cost recorded.
   */
  async acknowledgeFinished(): Promise<void> {
    const operations = await this.mediaOperationRepository.listUnacknowledgedCloudMlJobs(20);
    if (operations.length === 0) {
      return;
    }
    const resolution = await resolveCloudGateway(this.gatewayDeps());
    if (resolution.state !== CloudConnectionState.Ready) {
      return;
    }
    const client = new FrameleafCloudJobClient(this.frameleafCloudMlRepository, resolution.gateway);
    for (const operation of operations) {
      const result = parseCloudMlJobResult(operation.result);
      const jobId = result.job?.jobId ?? operation.remoteJobId!;
      const holder = {
        operation,
        result: { ...result, job: result.job ?? { ...this.unknownJob(jobId), admittedAt: new Date().toISOString() } },
      };
      try {
        await this.acknowledge(holder, client);
        await this.settleAccounting(holder);
      } catch (error) {
        this.logger.warn(`Frameleaf Cloud job ${operation.id} was not acknowledged yet: ${errorMessage(error)}`);
        // counted, so a job the cloud keeps refusing never holds up the others (least-tried first)
        holder.result = { ...holder.result, ackAttempts: holder.result.ackAttempts + 1 };
      }
      await this.mediaOperationRepository.setFinishedResult(
        operation.id,
        holder.result as unknown as Record<string, unknown>,
      );
    }
  }

  /** A cloud job only known by its id: read in full on the next call. */
  private unknownJob(jobId: string): Omit<NonNullable<CloudMlJobResult['job']>, 'admittedAt'> {
    return {
      jobId,
      status: 'admitted',
      holdUsd: 0,
      ceilingUsd: 0,
      meteredUsd: 0,
      meteredSeconds: 0,
      workers: 0,
      startFees: 0,
      progress: null,
      etag: null,
      startedAt: null,
      error: null,
    };
  }

  /**
   * Finished jobs whose cost was not settled when they ended: the job is read again (it survives the
   * acknowledgement) and its cost recorded once, with `ml_workload_accounting`. A job whose cost never
   * comes is asked about `CLOUD_ML_JOB_COST_READS` times; the usage report still settles its row.
   */
  async settleFinished(now: Date): Promise<void> {
    const pending = await this.mediaOperationRepository.listCloudMlJobsAwaitingCost({
      limit: 20,
      maxReads: CLOUD_ML_JOB_COST_READS,
      since: new Date(now.getTime() - 7 * DAY_MS),
    });
    if (pending.length === 0) {
      return;
    }
    const resolution = await resolveCloudGateway(this.gatewayDeps());
    if (resolution.state !== CloudConnectionState.Ready) {
      return;
    }
    for (const operation of pending) {
      const result = parseCloudMlJobResult(operation.result);
      const jobId = result.job?.jobId ?? operation.remoteJobId;
      if (!jobId) {
        continue;
      }
      let cost: CloudMlJobCost | null = null;
      try {
        const answer = await this.frameleafCloudMlRepository.getJobView(resolution.gateway, jobId, null);
        cost = answer.notModified ? null : cloudMlJobCostOf(answer.data);
      } catch (error) {
        this.logger.warn(`The cost of Frameleaf Cloud job ${jobId} was not read: ${errorMessage(error)}`);
      }
      const next: CloudMlJobResult = { ...result, cost, costReads: result.costReads + 1 };
      await this.mediaOperationRepository.setFinishedResult(operation.id, next as unknown as Record<string, unknown>);
      if (cost && result.job) {
        await this.settleAccounting({ result: next });
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Inputs                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Prepare the input that is uploaded, and the preview's before file that is kept here. Nothing that
   * leaves the server carries metadata: a video clip or copy keeps the first video stream only with no
   * container, stream or chapter tags; a still is re-encoded from its pixels (its ICC profile kept).
   */
  private async prepareInput(
    source: Source,
    options: {
      workDir: string;
      stage: 'preview' | 'full';
      workload: CloudMlJobWorkload;
      sourceType: AssetRestorationSourceType;
      sizes: { width: number; height: number };
      durationSeconds: number | null;
      region: AssetRestorationRegion;
      crop: boolean;
      upscale: number;
    },
  ): Promise<{
    input: CloudMlJobInput;
    beforePath: string | null;
    /** The prepared input's own pixel size (what an upscale declares). */
    size: { width: number; height: number };
    output: { width: number; height: number };
    durationSeconds: number | null;
  }> {
    const { stage, sourceType } = options;
    let prepared: { file: string; contentType: string; beforePath: string | null; width: number; height: number };
    let durationSeconds = options.durationSeconds;
    if (sourceType === AssetRestorationSourceType.Video && stage === 'preview') {
      const clip = await this.prepareVideoClip(source, options);
      prepared = clip;
      durationSeconds = clip.durationSeconds;
    } else if (sourceType === AssetRestorationSourceType.Video) {
      prepared = { ...(await this.prepareFullVideo(source, options.workDir)), beforePath: null, ...options.sizes };
    } else if (stage === 'preview') {
      prepared = await this.preparePhotoCrop(source, options);
    } else {
      prepared = { ...(await this.prepareFullPhoto(source, options.workDir)), beforePath: null, ...options.sizes };
    }

    if (!CLOUD_ML_JOB_INPUT_TYPES[options.workload].includes(prepared.contentType)) {
      throw new CloudMlJobFailure(
        'cloud_ml_prepare_failed',
        `Frameleaf Cloud does not take ${prepared.contentType} for this work`,
        false,
      );
    }
    const { sha256, sizeInBytes } = await this.cryptoRepository.hashFileDigests(prepared.file);
    return {
      input: {
        inputId: 'v1',
        contentType: prepared.contentType,
        bytes: sizeInBytes,
        sha256: sha256.toString('hex'),
        path: prepared.file,
      },
      beforePath: prepared.beforePath,
      size: { width: prepared.width, height: prepared.height },
      output: cappedOutputSize(prepared.width, prepared.height, options.upscale),
      durationSeconds,
    };
  }

  /**
   * A preview clip of a video: a few seconds from where the owner chose (the preview area cropped for a
   * restoration). The before clip keeps its audio for the comparison and stays on this server; what is
   * uploaded is the same clip without audio, both without metadata.
   */
  private async prepareVideoClip(
    source: Source,
    options: {
      workDir: string;
      sizes: { width: number; height: number };
      durationSeconds: number | null;
      region: AssetRestorationRegion;
      crop: boolean;
    },
  ) {
    const { workDir, sizes, region } = options;
    const duration = options.durationSeconds ?? 0;
    const clip = duration > 0 ? Math.min(CLOUD_ML_JOB_PREVIEW_SECONDS, duration) : CLOUD_ML_JOB_PREVIEW_SECONDS;
    const latest = Math.max(0, duration - clip);
    const start = Math.max(0, Math.min(region.startSeconds ?? latest / 2, latest));
    const rect = previewRegionPixels(region, sizes.width, sizes.height);
    const crop =
      options.crop && !isFullRegion(region)
        ? ['-vf', `crop=${even(rect.width)}:${even(rect.height)}:${rect.left}:${rect.top}`]
        : [];
    const beforePath = path.join(workDir, 'before.mp4');
    await this.mediaRepository.transcode(source.originalPath, beforePath, {
      inputOptions: ['-ss', start.toFixed(3), '-t', clip.toFixed(3)],
      outputOptions: previewClipOutputOptions(crop),
      twoPass: false,
      progress: { frameCount: 0, percentInterval: 5 },
    });
    const file = path.join(workDir, 'input.mp4');
    await this.mediaRepository.transcode(beforePath, file, {
      inputOptions: [],
      outputOptions: uploadClipOutputOptions(),
      twoPass: false,
      progress: { frameCount: 0, percentInterval: 5 },
    });
    await this.requireSilentUpload(file);
    const probe = await this.mediaRepository.probe(file);
    const stream = probe.videoStreams[0];
    if (!stream) {
      throw new CloudMlJobFailure('cloud_ml_prepare_failed', 'The preview clip has no video stream', false);
    }
    return {
      file,
      contentType: 'video/mp4',
      beforePath,
      width: stream.width,
      height: stream.height,
      durationSeconds: probe.format.duration || clip,
    };
  }

  /**
   * The whole video, copied without metadata: the first video stream only, stream-copied into a
   * container Frameleaf Cloud takes when its codec allows it, otherwise re-encoded at high quality.
   */
  private async prepareFullVideo(source: Source, workDir: string): Promise<{ file: string; contentType: string }> {
    const probe = await this.mediaRepository.probe(source.originalPath);
    const codec = probe.videoStreams[0]?.codecName ?? null;
    const extension = path.extname(source.originalFileName).toLowerCase();
    const copyable: Record<string, { container: string; contentType: string; codecs: string[] }> = {
      '.mov': { container: 'mov', contentType: 'video/quicktime', codecs: ['h264', 'hevc', 'prores', 'mjpeg'] },
      '.webm': { container: 'webm', contentType: 'video/webm', codecs: ['vp8', 'vp9', 'av1'] },
    };
    const plan = copyable[extension] ?? { container: 'mp4', contentType: 'video/mp4', codecs: ['h264', 'hevc', 'av1'] };
    const copy = !!codec && plan.codecs.includes(codec);
    const container = copy ? plan.container : 'mp4';
    const file = path.join(workDir, `input.${container}`);
    // a stream copy keeps the stream's SEI messages, where cameras put their own data (serial numbers,
    // GPS, settings). Every SEI message is dropped (H.264 type 6, HEVC prefix and suffix types 39 and 40),
    // HDR mastering metadata carried there included; the colour description in the stream header stays
    const sei: Record<string, string> = {
      h264: 'filter_units=remove_types=6',
      hevc: 'filter_units=remove_types=39|40',
    };
    const filter = copy && codec ? sei[codec] : undefined;
    await this.mediaRepository.transcode(source.originalPath, file, {
      inputOptions: [],
      outputOptions: fullVideoUploadOutputOptions({ copy, bsf: filter, webm: container === 'webm' }),
      twoPass: false,
      progress: { frameCount: 0, percentInterval: 5 },
    });
    await this.requireSilentUpload(file);
    return { file, contentType: copy ? plan.contentType : 'video/mp4' };
  }

  /**
   * FC-47 (owner decision 2026-09-27): audio is never sent to Frameleaf Cloud, and its worker refuses a
   * clip that still carries an audio stream. What is uploaded is probed first, and refused here when
   * ffprobe finds any audio stream in it; the audio stays on this server and is put back afterwards.
   */
  private async requireSilentUpload(file: string) {
    const probe = await this.mediaRepository.probe(file);
    if (probe.audioStreams.length > 0) {
      throw new CloudMlJobFailure(
        'cloud_ml_input_has_audio',
        'The copy prepared for Frameleaf Cloud still carries audio, so nothing was sent. Audio never leaves this server.',
        false,
      );
    }
  }

  /**
   * A preview crop of a photo, encoded from its decoded pixels, so it carries no EXIF, XMP, IPTC or
   * GPS. It is both the before side of the comparison and what is uploaded.
   */
  private async preparePhotoCrop(source: Source, options: { workDir: string; region: AssetRestorationRegion }) {
    const { image } = await this.getConfig();
    const decoded = await this.decodeSource(source, image);
    const rect = previewRegionPixels(options.region, decoded.info.width, decoded.info.height);
    const cropped = isFullRegion(options.region)
      ? decoded
      : {
          ...(await this.mediaRepository.renderDevelopGeometry(decoded.data, decoded.info, {
            rotation: 0,
            flipHorizontal: false,
            flipVertical: false,
            oriented: { width: decoded.info.width, height: decoded.info.height },
            straighten: 0,
            extract: rect,
            output: { width: rect.width, height: rect.height },
          })),
          colorspace: decoded.colorspace,
        };
    const file = path.join(options.workDir, 'before.jpg');
    await this.mediaRepository.encodeDevelopOutput(
      cropped.data,
      cropped.info,
      {
        detail: { median: 0 },
        colorspace: decoded.colorspace,
        format: ImageFormat.Jpeg,
        quality: 95,
        size: RESTORATION_PREVIEW_EDGE,
      },
      file,
    );
    const meta = await this.mediaRepository.getImageMetadata(file);
    return { file, contentType: 'image/jpeg', beforePath: file, width: meta.width, height: meta.height };
  }

  /**
   * The whole photo: a web-native original re-encoded without EXIF, XMP, IPTC or GPS (its ICC profile
   * kept); RAW, HEIC or TIFF decoded once into a JPEG made from its pixels, which carries none either.
   */
  private async prepareFullPhoto(source: Source, workDir: string): Promise<{ file: string; contentType: string }> {
    if (mimeTypes.isWebSupportedImage(source.originalFileName)) {
      const format = strippedStillFormat(source.originalFileName);
      const file = path.join(workDir, format === 'jpeg' ? 'input.jpg' : 'input.png');
      await this.mediaRepository.writeStrippedStill(source.originalPath, file, format);
      return { file, contentType: format === 'jpeg' ? 'image/jpeg' : 'image/png' };
    }
    const { image } = await this.getConfig();
    const decoded = await this.decodeSource(source, image);
    const file = path.join(workDir, 'input.jpg');
    await this.mediaRepository.encodeDevelopOutput(
      decoded.data,
      decoded.info,
      { detail: { median: 0 }, colorspace: decoded.colorspace, format: ImageFormat.Jpeg, quality: 100 },
      file,
    );
    return { file, contentType: 'image/jpeg' };
  }

  /** The prepared inputs must still be what was estimated: the original unchanged, the copy's size the same. */
  private async checkInputs(run: JobRun) {
    const source = await this.assetJobRepository.getForGenerateThumbnailJob(run.snapshot.assetId);
    if (!source) {
      throw new CloudMlJobFailure(
        'cloud_ml_source_missing',
        'The original is no longer available; nothing was sent',
        false,
      );
    }
    if (Buffer.from(source.checksum).toString('hex') !== run.snapshot.sourceChecksumHex) {
      throw new CloudMlJobFailure(
        'cloud_ml_source_changed',
        'The original changed since the estimate; nothing was sent. Estimate it again.',
        false,
      );
    }
    for (const input of run.snapshot.inputs) {
      const stat = await this.storageRepository.stat(input.path).catch(() => null);
      if (stat?.size !== input.bytes) {
        throw new CloudMlJobFailure(
          'cloud_ml_input_missing',
          'The prepared copy of this file is gone or changed; nothing was sent. Estimate it again.',
          false,
        );
      }
      if (run.snapshot.sourceType === 'video') {
        // checked again before anything is sent: a copy prepared by an older version is never uploaded with audio
        await this.requireSilentUpload(input.path);
      }
    }
  }

  private toCloudInput(input: CloudMlJobInput) {
    return { inputId: input.inputId, contentType: input.contentType, bytes: input.bytes, sha256: input.sha256 };
  }

  private requestOf(
    workload: CloudMlJobWorkload,
    settings: { mode: AssetRestorationMode; upscale: number; factor: number | null },
    size?: { width: number; height: number },
  ): Record<string, unknown> {
    switch (workload) {
      case 'interpolation': {
        return { factor: settings.factor ?? 2 };
      }
      case 'restoration': {
        const mode = settings.mode === AssetRestorationMode.Creative ? 'creative' : 'faithful';
        return { mode, scale: settings.upscale };
      }
      case 'upscale': {
        // FC-46: the declared size prices the photo at the factor it really gets, and binds it
        return size
          ? { scale: settings.upscale, items: [{ inputId: 'v1', width: size.width, height: size.height }] }
          : { scale: settings.upscale };
      }
    }
  }

  private extensionOf(contentType: string): string {
    switch (contentType) {
      case 'image/png': {
        return '.png';
      }
      case 'image/jpeg': {
        return '.jpg';
      }
      case 'image/webp': {
        return '.webp';
      }
      case 'video/quicktime': {
        return '.mov';
      }
      case 'video/webm': {
        return '.webm';
      }
      default: {
        return contentType.startsWith('video/') ? '.mp4' : '.bin';
      }
    }
  }

  private async decodeSource(source: Source, image: SystemConfig['image']) {
    const isRaw = mimeTypes.isRaw(source.originalFileName);
    const extracted = isRaw && image.extractEmbedded ? await this.mediaRepository.extract(source.originalPath) : null;
    const colorspace = this.isSRGB(source.exifInfo) ? Colorspace.Srgb : image.colorspace;
    const input = extracted ? extracted.buffer : source.originalPath;
    const orientation = extracted && source.exifInfo.orientation ? Number(source.exifInfo.orientation) : undefined;
    const { data, info } = await this.mediaRepository.decodeImage(input, {
      colorspace,
      processInvalidImages: false,
      orientation,
    });
    return { data, info: info as RawImageInfo, colorspace };
  }

  private isSRGB(exifInfo: {
    colorspace?: string | null;
    profileDescription?: string | null;
    bitsPerSample?: number | null;
  }) {
    const { colorspace, profileDescription, bitsPerSample } = exifInfo;
    if (colorspace || profileDescription) {
      return [colorspace, profileDescription].some((value) => value?.toLowerCase().includes('srgb'));
    }
    if (bitsPerSample) {
      return bitsPerSample === 8;
    }
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Checks                                                              */
  /* ------------------------------------------------------------------ */

  private async requireSource(assetId: string): Promise<Source> {
    // no visibility filter: the owner may send a Locked photo they unlocked (access was checked)
    const source = await this.assetJobRepository.getForGenerateThumbnailJob(assetId);
    if (!source) {
      throw new NotFoundException('Asset not found');
    }
    if (source.type !== AssetType.Image && source.type !== AssetType.Video) {
      throw new BadRequestException('Only photos and videos can be sent to Frameleaf Cloud');
    }
    return source;
  }

  private sourceSize(source: Source): { width: number; height: number } {
    let width = Number(source.exifInfo?.exifImageWidth ?? 0);
    let height = Number(source.exifInfo?.exifImageHeight ?? 0);
    if (['5', '6', '7', '8'].includes(source.exifInfo?.orientation ?? '')) {
      [width, height] = [height, width];
    }
    if (!(width > 0 && height > 0)) {
      throw new BadRequestException('The dimensions of this file are not known yet; run metadata extraction first');
    }
    return { width, height };
  }

  private durationOf(source: Source): number {
    const seconds = parseDurationSeconds(source.format?.duration ?? null);
    if (seconds === null) {
      throw new BadRequestException('The length of this video is not known yet; run metadata extraction first');
    }
    return seconds;
  }

  /** The reviewed preview a full render inherits from: the owner's, on Frameleaf Cloud, ready for review. */
  private async requireReviewedPreview(auth: AuthDto, dto: CloudMlJobEstimateRequestDto): Promise<AssetRestoration> {
    if (!dto.restorationId) {
      throw new BadRequestException('Name the reviewed preview to render in full');
    }
    const row = await this.restorationRepository.getForOwner(dto.restorationId, dto.assetId, auth.user.id);
    if (!row) {
      throw new NotFoundException('Restoration not found');
    }
    if (row.status !== AssetRestorationStatus.PreviewReady) {
      throw new BadRequestException('Only a preview that is ready for review can be rendered in full');
    }
    if (row.destinationKind !== MlDestinationKind.FrameleafCloud || row.destinationId !== dto.destinationId) {
      throw new BadRequestException('This preview did not run on Frameleaf Cloud; render it where it ran');
    }
    return row;
  }

  /** The model and revision the reviewed preview ran, from its provenance. */
  private previewModel(row: AssetRestoration): { sku: string; rev: string } | null {
    const provenance = (row.provenance ?? {}) as Record<string, unknown>;
    const preview = provenance.preview as Record<string, unknown> | undefined;
    const sku = typeof preview?.modelSku === 'string' ? preview.modelSku : null;
    const rev = typeof preview?.modelRev === 'string' ? preview.modelRev : null;
    return sku && rev ? { sku, rev } : null;
  }

  private appWorkloadOf(workload: CloudMlJobWorkload, mode: AssetRestorationMode): MlWorkload {
    switch (workload) {
      case 'interpolation': {
        return MlWorkload.Interpolation;
      }
      case 'upscale': {
        return MlWorkload.Upscale;
      }
      case 'restoration': {
        return mode === AssetRestorationMode.Creative ? MlWorkload.RestorationCreative : MlWorkload.RestorationFaithful;
      }
    }
  }

  private modeLabel(mode: string): string {
    return mode === AssetRestorationMode.Creative ? 'Creative' : 'Faithful';
  }

  /**
   * The Frameleaf Cloud destination, admitted for this work now: processing on and the work allowed
   * there (never a silent move to the cloud), consent recorded, entitlement, budget and health.
   */
  private async requireCloudDestination(destinationId: string, workload: MlWorkload): Promise<MlDestinationRow> {
    const destination = await this.mlDestinationRepository.getById(destinationId);
    if (destination?.kind !== MlDestinationKind.FrameleafCloud) {
      throw new BadRequestException('Choose the Frameleaf Cloud destination for this work');
    }
    const settings = await this.cloudMlSettings();
    if (!settings.enabled) {
      throw new BadRequestException('Frameleaf Cloud processing is turned off');
    }
    if (!cloudRouteAllows(settings, workload)) {
      throw new BadRequestException(
        'Where each job runs keeps this work on this server; nothing is sent to Frameleaf Cloud',
      );
    }
    try {
      await this.admit({ destinationId, appWorkload: workload }, null, null);
    } catch (error) {
      throw this.clientError(error);
    }
    return destination;
  }

  /**
   * FL-201: before a created job's inputs leave this server, admission runs again. Only a refusal that
   * means the files may no longer be sent (`STOPS_CREATED_CLOUD_JOB`: consent missing or older than the
   * version the cloud now requires, destination gone or off, work no longer allowed, entitlement lost)
   * cancels the cloud job, releasing its hold, and fails this one with that refusal; nothing more is sent.
   * Wallet, daily cap and model refusals do not stop a job the cloud already accepted and holds funds for,
   * and a cloud that does not answer leaves the job for its retry.
   */
  private async readmit(run: JobRun, client: FrameleafCloudJobClient) {
    try {
      await this.admit(run.snapshot, null, run.operation.id);
    } catch (error) {
      const refusal = admissionRefusalOf(error);
      if (refusal && STOPS_CREATED_CLOUD_JOB.has(refusal)) {
        try {
          await this.sendCancel(run, client);
        } catch (cancelError) {
          // the refusal is what the job reports; the cancel is tried again when the job is cleaned up
          this.logger.warn(
            `Could not cancel Frameleaf Cloud job for ${run.operation.id}: ${errorMessage(cancelError)}`,
          );
        }
        throw error;
      }
      if (failureOf(error)?.retry) {
        throw error;
      }
      if (consentUnconfirmedOf(error)) {
        // the cloud refused its status check before the consent version could be compared: send nothing now
        throw new CloudMlJobFailure(
          'cloud_ml_consent_unconfirmed',
          `The consent in force could not be confirmed (${errorMessage(error)}); nothing was sent, it is tried again`,
          true,
        );
      }
      // any other refusal (wallet, cap, model), checked after consent, is for new work only: this job goes on
    }
  }

  private async admit(
    target: Pick<CloudMlJobSnapshot, 'destinationId' | 'appWorkload'>,
    holdUsd: number | null,
    jobId: string | null,
  ) {
    await selectMlDestination(
      {
        mlDestinationRepository: this.mlDestinationRepository,
        machineLearningRepository: this.machineLearningRepository,
        cloudMlSettings: () => this.cloudMlSettings(),
      },
      {
        workload: target.appWorkload,
        destinationId: target.destinationId,
        jobId,
        jobName: MediaOperationKind.CloudMlJob,
        holdUsd,
      },
    );
  }

  /**
   * The model on the slider: the one the owner chose, else the one an administrator chose for this
   * kind of work, else the one the catalogue recommends. It must be offered now for exactly this
   * group; otherwise the owner goes back to the slider (`model-mismatch`).
   */
  private async chooseModel(
    gateway: CloudMlGateway,
    workload: CloudMlJobWorkload,
    mode: AssetRestorationMode,
    requested: string | undefined,
  ): Promise<{ model: CloudCatalogEntry; offered: CloudCatalogEntry[] }> {
    let catalog: Awaited<ReturnType<FrameleafCloudMlRepository['getCatalog']>>;
    try {
      catalog = await this.frameleafCloudMlRepository.getCatalog(gateway);
    } catch (error) {
      throw this.clientError(error);
    }
    const group =
      workload === 'restoration'
        ? catalogGroupKey('restoration', mode === AssetRestorationMode.Creative ? 'creative' : 'faithful')
        : catalogGroupKey(workload, null);
    const offered = offeredCatalogModels(catalog).filter(
      (entry) => catalogGroupKey(entry.workload, entry.mode) === group,
    );
    const chosen = requested ?? (await this.mlDestinationRepository.getCloudModelChoice(group));
    const model = chosen ? offered.find((entry) => entry.sku === chosen) : offered.find((entry) => entry.default);
    if (!model) {
      throw this.modelMismatch(
        chosen
          ? 'This model is not offered for this work any more; choose another on the slider'
          : 'Frameleaf Cloud recommends no model for this work here; choose one on the slider',
      );
    }
    return { model, offered };
  }

  /** A catalogue model as the slider shows it: name, GPU class and price, never a model identity. */
  private modelOf(model: CloudCatalogEntry) {
    return {
      sku: model.sku,
      rev: model.rev,
      label: model.label,
      gpu: model.display.gpu,
      rank: model.rank,
      perSecondUsd: model.rate.perSecondUsd,
      startFeeUsd: model.rate.startFeeUsd,
    };
  }

  private modelMismatch(message: string) {
    return new ConflictException({
      message,
      error: 'Conflict',
      statusCode: HttpStatus.CONFLICT,
      code: 'model-mismatch',
    });
  }

  /** Why the AI Wallet cannot hold the job now, or null. Nothing is sent, and no lighter model is tried. */
  private walletRefusal(
    wallet: { dailyCapUsd: number | null; spentTodayUsd: number },
    availableUsd: number,
    holdUsd: number,
  ): { code: string; message: string } | null {
    if (availableUsd < holdUsd) {
      return {
        code: 'insufficient-credits',
        message: `This job needs ${holdUsd.toFixed(2)} USD held and the AI Wallet has ${availableUsd.toFixed(2)} USD available. Add credit first.`,
      };
    }
    if (wallet.dailyCapUsd !== null && wallet.spentTodayUsd + holdUsd > wallet.dailyCapUsd) {
      return {
        code: 'daily-cap',
        message: `Today's AI Wallet limit of ${wallet.dailyCapUsd.toFixed(2)} USD leaves too little for this job. Try again tomorrow or raise the limit in your Frameleaf account.`,
      };
    }
    return null;
  }

  /** A cloud or admission refusal as an answer the dialog can act on: 402 for money, 409 for the model. */
  private clientError(error: unknown): unknown {
    if (!(error instanceof FrameleafCloudError)) {
      return error;
    }
    switch (error.refusal) {
      case MlAdmissionRefusal.WalletInsufficient:
      case MlAdmissionRefusal.BudgetExceeded: {
        return new HttpException(
          {
            message: error.message,
            error: 'Payment Required',
            statusCode: HttpStatus.PAYMENT_REQUIRED,
            code: cloudErrorCode(error) ?? 'insufficient-credits',
          },
          HttpStatus.PAYMENT_REQUIRED,
        );
      }
      case MlAdmissionRefusal.ModelMismatch: {
        return this.modelMismatch(error.message);
      }
      default: {
        // FC-62: new jobs are paused in this region; the dialog shows Frameleaf Cloud's own words
        return pausedException(error) ?? new BadRequestException(error.message);
      }
    }
  }

  private async requireGateway(): Promise<CloudMlGateway> {
    const resolution = await resolveCloudGateway(this.gatewayDeps());
    if (resolution.state !== CloudConnectionState.Ready) {
      throw new BadRequestException(resolution.detail);
    }
    return resolution.gateway;
  }

  private async removeWorkDir(workDir: string) {
    await this.storageRepository.unlinkDir(workDir, { recursive: true, force: true }).catch(() => {});
  }

  /**
   * Remove a job's own files once it will not run again. A prepared whole-video copy is shared by
   * every estimate of that video, so it is left to `pruneEstimates`, which drops it once unused.
   */
  private async removeJobFiles(snapshot: Pick<CloudMlJobSnapshot, 'workDir'>) {
    await this.removeWorkDir(snapshot.workDir);
  }

  /**
   * The whole video, prepared for Frameleaf Cloud once and kept for every estimate of it (by the
   * original's checksum). Preparing a long video takes a while, so it runs in the background: until
   * the copy is ready, the estimate answers 409 `input-preparing` with `retryAfterSeconds`, and asking
   * again picks up the finished copy. One person prepares one video at a time (429 otherwise).
   */
  private async preparedWholeVideo(auth: AuthDto, source: Source): Promise<PreparedCopy> {
    const checksumHex = Buffer.from(source.checksum).toString('hex');
    const key = createHash('sha256').update(`${checksumHex}:${PREPARED_INPUT_VERSION}`).digest('hex').slice(0, 32);
    const dir = path.join(
      StorageCore.getNestedFolder(StorageFolder.Thumbnails, source.ownerId, source.id),
      `${PREPARED_INPUT_PREFIX}${key}`,
    );
    const ready = await this.readPreparedCopy(dir);
    if (ready) {
      return ready;
    }
    if (this.preparingFailed.has(dir)) {
      this.preparingFailed.delete(dir);
      throw new BadRequestException(
        'This video could not be prepared for Frameleaf Cloud. Nothing was sent; try again.',
      );
    }
    if (!this.preparing.has(dir)) {
      if (this.preparingBy.has(auth.user.id)) {
        throw new HttpException(
          {
            message: 'Another video is still being prepared for an estimate. Ask again once it is ready.',
            error: 'Too Many Requests',
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            code: 'estimate-busy',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      this.startPreparing(auth.user.id, source, dir);
    }
    throw new ConflictException({
      message: 'The video is being prepared for its estimate. A long video takes a moment.',
      error: 'Conflict',
      statusCode: HttpStatus.CONFLICT,
      code: 'input-preparing',
      retryAfterSeconds: CLOUD_ML_JOB_PREPARING_RETRY_SECONDS,
    });
  }

  private startPreparing(userId: string, source: Source, dir: string) {
    this.preparingBy.set(userId, dir);
    const work = (async () => {
      await this.removeWorkDir(dir);
      this.storageRepository.mkdirSync(dir);
      await this.notePrepared(dir, source.ownerId);
      const { file, contentType } = await this.prepareFullVideo(source, dir);
      const { sha256, sizeInBytes } = await this.cryptoRepository.hashFileDigests(file);
      const copy: PreparedCopy = { file, contentType, bytes: sizeInBytes, sha256: sha256.toString('hex') };
      // written last: a copy without its record is never used
      await this.storageRepository.createOrOverwriteFile(
        path.join(dir, PREPARED_INPUT_RECORD),
        Buffer.from(JSON.stringify(copy)),
      );
    })()
      .catch(async (error) => {
        this.logger.warn(`Preparing ${source.id} for a Frameleaf Cloud estimate failed: ${errorMessage(error)}`);
        this.preparingFailed.set(dir, error instanceof CloudMlJobFailure ? error.code : 'cloud_ml_prepare_failed');
        await this.removeWorkDir(dir);
      })
      .finally(() => {
        this.preparing.delete(dir);
        if (this.preparingBy.get(userId) === dir) {
          this.preparingBy.delete(userId);
        }
      });
    this.preparing.set(dir, work);
  }

  /** A finished prepared copy, or null when there is none, it is incomplete, or its file changed size. */
  private async readPreparedCopy(dir: string): Promise<PreparedCopy | null> {
    try {
      const copy = await this.storageRepository.readJsonFile<PreparedCopy>(path.join(dir, PREPARED_INPUT_RECORD));
      if (
        typeof copy?.file !== 'string' ||
        path.dirname(copy.file) !== dir ||
        typeof copy.contentType !== 'string' ||
        !Number.isSafeInteger(copy.bytes) ||
        !/^[\da-f]{64}$/.test(copy.sha256)
      ) {
        return null;
      }
      const stat = await this.storageRepository.stat(copy.file);
      return stat.size === copy.bytes ? copy : null;
    } catch {
      return null;
    }
  }

  /** Record a prepared-copy folder, so `pruneEstimates` removes it once nothing uses it. */
  private async notePrepared(dir: string, ownerId: string) {
    await this.databaseRepository.withLock(DatabaseLock.FrameleafCloudMlJobEstimates, async () => {
      const store = (await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafCloudMlJobEstimates)) ?? {
        records: [],
      };
      const prepared = (store.prepared ?? []).filter((entry) => entry.dir !== dir);
      await this.systemMetadataRepository.set(SystemMetadataKey.FrameleafCloudMlJobEstimates, {
        ...store,
        prepared: [...prepared, { dir, ownerId, at: new Date().toISOString() }],
      });
    });
  }

  /** An estimate's input from a prepared whole-video copy: what `prepareInput` answers for a full video. */
  private fromPreparedCopy(
    copy: PreparedCopy,
    workload: CloudMlJobWorkload,
    sizes: { width: number; height: number },
    durationSeconds: number | null,
    upscale: number,
  ): Awaited<ReturnType<CloudMlJobService['prepareInput']>> {
    if (!CLOUD_ML_JOB_INPUT_TYPES[workload].includes(copy.contentType)) {
      throw new CloudMlJobFailure(
        'cloud_ml_prepare_failed',
        `Frameleaf Cloud does not take ${copy.contentType} for this work`,
        false,
      );
    }
    return {
      input: { inputId: 'v1', contentType: copy.contentType, bytes: copy.bytes, sha256: copy.sha256, path: copy.file },
      beforePath: null,
      size: sizes,
      output: cappedOutputSize(sizes.width, sizes.height, upscale),
      durationSeconds,
    };
  }

  /** The saved Frameleaf Cloud processing settings, read fresh: the kill switch is never stale. */
  private async cloudMlSettings(): Promise<CloudMlSettings> {
    const { frameleafCloud } = await this.getConfig();
    return frameleafCloud.cloudMl;
  }

  private getConfig() {
    return getConfig(
      { configRepo: this.configRepository, metadataRepo: this.systemMetadataRepository, logger: this.logger },
      { withCache: false },
    );
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
