import { Injectable } from '@nestjs/common';
import { hostname } from 'node:os';
import path from 'node:path';
import type { SystemConfig } from 'src/dtos/config.dto.js';
import type { RawImageInfo } from 'src/types.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent } from 'src/decorators.js';
import { AssetRestorationSourceType, AssetRestorationStatus } from 'src/dtos/asset-restoration.dto.js';
import {
  Colorspace,
  ImageFormat,
  ImmichWorker,
  JobName,
  MediaOperationKind,
  MediaOperationStatus,
  StorageFolder,
} from 'src/enum.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRestoration, AssetRestorationRepository } from 'src/repositories/asset-restoration.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { getConfig } from 'src/utils/config.js';
import { StoredChunk, mediaOperationProgress, planChunkResume } from 'src/utils/media-operation.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import { MlDestinationNotFoundError, MlDestinationRefusedError } from 'src/utils/ml-destination.js';
import {
  RESTORATION_OPERATION_KINDS,
  RESTORATION_PREVIEW_EDGE,
  RESTORATION_PREVIEW_SECONDS,
  RestorationErrorCode,
  RestorationInferenceResult,
  RestorationSelection,
  RestorationSnapshot,
  RestorationStage,
  STAGE_STATUSES,
  canRunStage,
  cappedOutputSize,
  isFullRegion,
  isReviewedModel,
  parseRestorationSnapshot,
  planRestorationChunks,
  previewExpiryAfterReady,
  previewRegionPixels,
  restorationChunkIdentity,
  restorationOutputPaths,
  restorationWorkDir,
  resultExpiryAfterAbandon,
  selectRestorationDestination,
  stageOfKind,
} from 'src/utils/restoration.js';
import { ALL_LIBRARY_ANALYSIS_QUEUES, libraryAnalysisBacklog, readQueueBacklogs } from 'src/utils/worker-inventory.js';

/** How often an idle worker asks for the next restoration job. */
export const RESTORATION_POLL_MS = 2000;
/** How often alignment and retention run. */
export const RESTORATION_SWEEP_MS = 60_000;
/** The claim lease. Heartbeats renew it at a third of this. */
export const RESTORATION_LEASE_MS = 90_000;
/** Rows one retention pass looks at. */
const RETENTION_BATCH = 200;
/** How long one reading of the library-analysis backlog is reused by the claim loop. */
export const LIBRARY_BACKLOG_FRESHNESS_MS = 10_000;

type Source = NonNullable<Awaited<ReturnType<AssetJobRepository['getForGenerateThumbnailJob']>>>;

/** A failure with a stable code Activity can translate. */
export class RestorationFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The claim was cancelled or lost. Not a failure of the work; the job record decides what it means. */
class RestorationInterrupted extends Error {
  constructor() {
    super('Restoration interrupted');
  }
}

type PublishedFile = {
  tmp: string;
  final: string;
  column: 'previewBeforePath' | 'previewAfterPath' | 'resultPath' | 'resultPreviewPath';
};

type StageOutput = {
  files: PublishedFile[];
  width: number;
  height: number;
  modelName: string;
  modelVersion: string | null;
};

type RunContext = {
  operation: MediaOperation;
  claimToken: string;
  snapshot: RestorationSnapshot;
  stage: RestorationStage;
  restoration: AssetRestoration;
  source: Source;
  selection: RestorationSelection;
  signal: AbortSignal;
  workDir: string;
  /** Temporary files to remove on failure. Published files are moved out of this list. */
  scratch: string[];
};

/** Even dimensions, as yuv420p encoders require. */
const even = (value: number) => Math.max(2, value - (value % 2));

/**
 * The restoration worker (FL-115): the only thing that runs a restoration job.
 *
 * It claims `restoration_preview` and `restoration` operations through FL-104's lease, renews the
 * lease while it works, and writes every result through the claim-guarded repository methods, so
 * a worker that was presumed dead cannot publish over the job its replacement is running.
 *
 * What it will not do:
 *
 * - **Choose a destination.** The snapshot names one; FL-110's selection admits it or the job
 *   fails with the refusal. A destination that vanished, lost consent or ran out of budget since
 *   the preview is a failure in place, never a move to somewhere else.
 * - **Touch the original.** Inputs are read; outputs are new files named by restoration id, so a
 *   re-run (an automatic retry included) lands on the same paths rather than adding a copy.
 * - **Skip a Locked asset.** The owner asked for the job; the source is read with no visibility
 *   filter and processed like any other (owner decision, FL-115). What is *shown* of a Locked
 *   asset is the API's concern and does not change.
 * - **Invent progress.** Units are real steps and chunks; the bar is indeterminate until counted.
 *
 * Idempotency for the retry-once layer: a stage may (re)start only from its own queued, running,
 * failed or cancelled status, outputs are deterministic paths, video chunks are checkpoints keyed
 * by their inputs, and the row transitions that publish are guarded by the status they expect.
 */
@Injectable()
export class RestorationWorkerService {
  private pollTimer?: ReturnType<typeof setInterval>;
  private sweepTimer?: ReturnType<typeof setInterval>;
  private busy = false;
  private readonly workerId = `restoration:${hostname()}:${process.pid}`;
  private backlogReading?: { at: number; value: number };

  constructor(
    private logger: LoggingRepository,
    private configRepository: ConfigRepository,
    private systemMetadataRepository: SystemMetadataRepository,
    private assetJobRepository: AssetJobRepository,
    private restorationRepository: AssetRestorationRepository,
    private operationRepository: MediaOperationRepository,
    private mlDestinationRepository: MlDestinationRepository,
    private machineLearningRepository: MachineLearningRepository,
    private mediaRepository: MediaRepository,
    private storageRepository: StorageRepository,
    private cryptoRepository: CryptoRepository,
    private jobRepository: JobRepository,
  ) {
    this.logger.setContext(RestorationWorkerService.name);
  }

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  onBootstrap() {
    this.start();
  }

  @OnEvent({ name: 'AppShutdown' })
  onShutdown() {
    this.stop();
  }

  start() {
    this.stop();
    this.pollTimer = setInterval(() => {
      void this.tick().catch((error) => this.logger.warn(`Restoration poll failed: ${error}`));
    }, RESTORATION_POLL_MS);
    this.sweepTimer = setInterval(() => {
      void this.sweep().catch((error) => this.logger.warn(`Restoration sweep failed: ${error}`));
    }, RESTORATION_SWEEP_MS);
    this.logger.log(`Restoration worker ${this.workerId} polling every ${RESTORATION_POLL_MS} ms`);
  }

  stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  /** Claim and run at most one job. One at a time per process: restoration is heavy work. */
  async tick(): Promise<boolean> {
    if (this.busy) {
      return false;
    }
    this.busy = true;
    try {
      const holdBack = await this.destinationsWaitingForLibraryAnalysis();
      const claim = await this.operationRepository.claimNext({
        kinds: RESTORATION_OPERATION_KINDS,
        workerId: this.workerId,
        leaseMs: RESTORATION_LEASE_MS,
        ...(holdBack.length > 0 && { holdBack: { kinds: [MediaOperationKind.Restoration], destinationIds: holdBack } }),
      });
      if (!claim) {
        return false;
      }
      await this.run(claim.operation, claim.claimToken);
      return true;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Restoration workers the administrator marked as sharing library analysis's GPU, while library
   * analysis has work (FL-72). Full restorations bound to them stay queued until that work is done,
   * so a long restoration never takes the GPU from face, CLIP, OCR or enrichment jobs. Previews are
   * short and someone is waiting for them, so they are never held. Nothing moves to another
   * destination; a held job keeps its place in the queue.
   */
  async destinationsWaitingForLibraryAnalysis(): Promise<string[]> {
    const shared = (await this.mlDestinationRepository.getAll()).filter((row) => row.sharesLibraryHardware);
    if (shared.length === 0) {
      return [];
    }
    const now = Date.now();
    if (!this.backlogReading || now - this.backlogReading.at >= LIBRARY_BACKLOG_FRESHNESS_MS) {
      const backlogs = await readQueueBacklogs(this.jobRepository, ALL_LIBRARY_ANALYSIS_QUEUES);
      this.backlogReading = { at: now, value: libraryAnalysisBacklog(backlogs) };
    }
    return this.backlogReading.value > 0 ? shared.map((row) => row.id) : [];
  }

  /**
   * Alignment and retention.
   *
   * Lapsed claims are not recovered here: `MediaOperationSweepService` owns recovery for every
   * kind of media operation, restorations included, so a lapsed claim is judged once (FL-104).
   * Alignment brings restoration rows into line with jobs that ended without a worker writing
   * back — a queued job cancelled from Activity, or one that recovery failed after its automatic
   * retry. Retention removes preview files past their date and marks a never-reviewed preview
   * expired; the row itself stays as history.
   */
  async sweep() {
    const now = new Date();
    const aligned = await this.restorationRepository.alignWithOperations(resultExpiryAfterAbandon(now));
    if (aligned.preview || aligned.full) {
      this.logger.log(
        `Aligned ${aligned.preview} preview and ${aligned.full} full restorations with their finished jobs`,
      );
    }

    let removed = 0;
    for (const row of await this.restorationRepository.listExpiredPreviews(now, RETENTION_BATCH)) {
      const files = [row.previewBeforePath, row.previewAfterPath].filter((file): file is string => !!file);
      const unreviewed = row.status === AssetRestorationStatus.PreviewReady;
      await this.restorationRepository.update(row.id, {
        previewBeforePath: null,
        previewAfterPath: null,
        previewExpiresAt: null,
        ...(unreviewed && { status: AssetRestorationStatus.Expired }),
      });
      if (files.length > 0) {
        await this.jobRepository.queue({ name: JobName.FileDelete, data: { files } });
        removed += files.length;
      }
    }
    // A failed or cancelled full render keeps its chunk checkpoints for a while so a retry can
    // resume; past that date the work folder goes. The row stays, still retryable from scratch.
    for (const row of await this.restorationRepository.listExpiredResults(now, RETENTION_BATCH)) {
      // Re-check the status in the write: a retry started since the read owns the folder now.
      const cleared = await this.restorationRepository.clearExpiredResult(
        row.id,
        row.status as AssetRestorationStatus,
        now,
      );
      if (!cleared) {
        continue;
      }
      const files = [row.resultPath, row.resultPreviewPath].filter((file): file is string => !!file);
      if (files.length > 0) {
        await this.jobRepository.queue({ name: JobName.FileDelete, data: { files } });
        removed += files.length;
      }
      const base = StorageCore.getNestedFolder(StorageFolder.Thumbnails, row.ownerId, row.assetId);
      await this.storageRepository
        .unlinkDir(restorationWorkDir(base, row.id), { recursive: true, force: true })
        .catch((error) => this.logger.warn(`Could not remove the work folder of restoration ${row.id}: ${error}`));
    }
    if (removed > 0) {
      this.logger.log(`Restoration retention removed ${removed} expired files`);
    }

    return { aligned, removed };
  }

  /* ------------------------------------------------------------------ */
  /* One job                                                             */
  /* ------------------------------------------------------------------ */

  async run(operation: MediaOperation, claimToken: string): Promise<void> {
    const snapshot = parseRestorationSnapshot(operation.snapshot);
    const stage = stageOfKind(operation.kind);
    if (!snapshot || !stage || snapshot.stage !== stage) {
      await this.operationRepository.fail(operation.id, claimToken, {
        error: 'The job does not carry a readable restoration snapshot',
        errorCode: RestorationErrorCode.SnapshotInvalid,
      });
      return;
    }

    const restoration = await this.restorationRepository.get(snapshot.restorationId);
    if (!restoration) {
      await this.operationRepository.fail(operation.id, claimToken, {
        error: 'The restoration this job belongs to no longer exists',
        errorCode: RestorationErrorCode.RestorationMissing,
      });
      return;
    }
    const status = restoration.status as AssetRestorationStatus;
    if (!canRunStage(stage, status)) {
      // A retry of a preview over an accepted restoration, or of a full render over a rejected
      // one, must do nothing. The row already says what the owner decided.
      await this.operationRepository.fail(operation.id, claimToken, {
        error: `A ${stage} render cannot run while the restoration is ${status}`,
        errorCode: RestorationErrorCode.StageNotRunnable,
      });
      return;
    }

    const statuses = STAGE_STATUSES[stage];
    // Bind this job to the row (a retry is a new job id) and mark the stage running.
    await this.restorationRepository.update(restoration.id, {
      status: statuses.running,
      error: null,
      // A retry takes the leftovers back from retention (FL-115).
      ...(stage === 'preview'
        ? { previewOperationId: operation.id }
        : { fullOperationId: operation.id, resultExpiresAt: null }),
    });

    const controller = new AbortController();
    const watch = setInterval(() => {
      void this.renew(operation, claimToken).then((alive) => {
        if (!alive) {
          controller.abort(new RestorationInterrupted());
        }
      });
    }, RESTORATION_LEASE_MS / 3);

    const base = StorageCore.getNestedFolder(StorageFolder.Thumbnails, restoration.ownerId, restoration.assetId);
    const workDir = restorationWorkDir(base, restoration.id);
    const context: Partial<RunContext> &
      Pick<
        RunContext,
        'operation' | 'claimToken' | 'snapshot' | 'stage' | 'restoration' | 'signal' | 'workDir' | 'scratch'
      > = {
      operation,
      claimToken,
      snapshot,
      stage,
      restoration: { ...restoration, status: statuses.running },
      signal: controller.signal,
      workDir,
      scratch: [],
    };

    try {
      const total =
        stage === 'full' && snapshot.sourceType === AssetRestorationSourceType.Video
          ? planRestorationChunks(snapshot.sourceDurationSeconds ?? 0).length + 3
          : 4;
      await this.progress(context, MediaOperationStatus.Preparing, 0, total);

      // No visibility filter on purpose: the owner asked for this job on this asset.
      const source = await this.assetJobRepository.getForGenerateThumbnailJob(snapshot.assetId);
      if (!source) {
        throw new RestorationFailure(RestorationErrorCode.SourceMissing, 'The original is no longer available');
      }
      if (Buffer.from(source.checksum).toString('hex') !== snapshot.sourceChecksumHex) {
        throw new RestorationFailure(
          RestorationErrorCode.SourceChanged,
          'The original has changed since the preview was made; request a new preview',
        );
      }

      let selection: RestorationSelection;
      try {
        // The owner named this destination on their own request (it is required and never
        // inferred, and the restoration panel says when it leaves the network), so that choice
        // is the per-request cloud confirmation FL-114's restore requires. Admission still needs
        // the administrator's recorded consent, budget, health and a qualified model.
        selection = await selectRestorationDestination(
          {
            mlDestinationRepository: this.mlDestinationRepository,
            machineLearningRepository: this.machineLearningRepository,
          },
          {
            mode: snapshot.mode,
            destinationId: snapshot.destinationId,
            acknowledgeCloudUpload: true,
            jobId: operation.id,
            jobName: operation.kind,
          },
        );
      } catch (error) {
        if (error instanceof MlDestinationRefusedError || error instanceof MlDestinationNotFoundError) {
          throw new RestorationFailure(RestorationErrorCode.DestinationRefused, error.message);
        }
        throw error;
      }
      await this.progress(context, MediaOperationStatus.Preparing, 1, total);

      this.storageRepository.mkdirSync(workDir);
      const full: RunContext = { ...context, source, selection } as RunContext;

      const output =
        snapshot.sourceType === AssetRestorationSourceType.Video
          ? stage === 'preview'
            ? await this.previewVideo(full, total)
            : await this.fullVideo(full, total)
          : stage === 'preview'
            ? await this.previewImage(full, total)
            : await this.fullImage(full, total);

      await this.publish(full, output, statuses);
    } catch (error) {
      await this.discard(context.scratch);
      await this.settle(context, error, statuses);
    } finally {
      clearInterval(watch);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Stages                                                              */
  /* ------------------------------------------------------------------ */

  private async previewImage(ctx: RunContext, total: number): Promise<StageOutput> {
    const { snapshot, source, workDir, operation } = ctx;
    const { image } = await this.getConfig();
    const decoded = await this.decodeSource(source, image);
    this.check(ctx);

    const rect = previewRegionPixels(snapshot.region, decoded.info.width, decoded.info.height);
    const cropped = isFullRegion(snapshot.region)
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

    const beforeTmp = this.scratch(ctx, path.join(workDir, `before-${operation.id}.jpg`));
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
      beforeTmp,
    );
    const before = await this.mediaRepository.getImageMetadata(beforeTmp);
    await this.progress(ctx, MediaOperationStatus.Rendering, 2, total);

    const cap = cappedOutputSize(before.width, before.height, snapshot.upscale);
    const afterTmp = this.scratch(ctx, path.join(workDir, `after-${operation.id}.png`));
    await this.clearStaleOutput(afterTmp);
    const result = await this.machineLearningRepository.restore(
      ctx.selection,
      { kind: 'image', path: beforeTmp, width: before.width, height: before.height },
      this.inferenceOptions(ctx, afterTmp, cap),
    );
    this.check(ctx);
    const after = await this.validateImage(result.outputPath, cap);
    await this.progress(ctx, MediaOperationStatus.Rendering, 3, total);

    const paths = restorationOutputPaths(this.base(ctx), snapshot.assetId, snapshot.restorationId);
    return {
      files: [
        { tmp: beforeTmp, final: `${paths.before}.jpg`, column: 'previewBeforePath' },
        {
          tmp: result.outputPath,
          final: `${paths.after}${path.extname(result.outputPath) || '.png'}`,
          column: 'previewAfterPath',
        },
      ],
      width: after.width,
      height: after.height,
      modelName: result.modelName,
      modelVersion: result.modelVersion,
    };
  }

  private async fullImage(ctx: RunContext, total: number): Promise<StageOutput> {
    const { snapshot, source, workDir, operation } = ctx;
    const { image } = await this.getConfig();

    // A web-native original is sent as it is. Anything else (RAW, HEIC, TIFF) is decoded once
    // into a working copy the adapter can read; the original itself is never rewritten.
    let inputPath = source.originalPath;
    if (!mimeTypes.isWebSupportedImage(source.originalFileName)) {
      const decoded = await this.decodeSource(source, image);
      inputPath = this.scratch(ctx, path.join(workDir, `input-${operation.id}.jpg`));
      await this.mediaRepository.encodeDevelopOutput(
        decoded.data,
        decoded.info,
        { detail: { median: 0 }, colorspace: decoded.colorspace, format: ImageFormat.Jpeg, quality: 100 },
        inputPath,
      );
    }
    const input = await this.mediaRepository.getImageMetadata(inputPath);
    this.check(ctx);
    await this.progress(ctx, MediaOperationStatus.Rendering, 2, total);

    const cap = { width: snapshot.output.width, height: snapshot.output.height };
    const resultTmp = this.scratch(ctx, path.join(workDir, `result-${operation.id}.png`));
    await this.clearStaleOutput(resultTmp);
    const result = await this.machineLearningRepository.restore(
      ctx.selection,
      { kind: 'image', path: inputPath, width: input.width, height: input.height },
      this.inferenceOptions(ctx, resultTmp, cap),
    );
    this.check(ctx);
    this.assertReviewedModel(ctx, result);
    const restored = await this.validateImage(result.outputPath, cap);

    const previewTmp = this.scratch(ctx, path.join(workDir, `result-preview-${operation.id}.jpg`));
    await this.mediaRepository.generateThumbnail(
      result.outputPath,
      {
        format: ImageFormat.Jpeg,
        quality: image.preview.quality,
        size: image.preview.size,
        colorspace: image.colorspace,
        processInvalidImages: false,
      },
      previewTmp,
    );
    await this.progress(ctx, MediaOperationStatus.Rendering, 3, total);

    const paths = restorationOutputPaths(this.base(ctx), snapshot.assetId, snapshot.restorationId);
    return {
      files: [
        {
          tmp: result.outputPath,
          final: `${paths.result}${path.extname(result.outputPath) || '.png'}`,
          column: 'resultPath',
        },
        { tmp: previewTmp, final: paths.resultPreview, column: 'resultPreviewPath' },
      ],
      width: restored.width,
      height: restored.height,
      modelName: result.modelName,
      modelVersion: result.modelVersion,
    };
  }

  private async previewVideo(ctx: RunContext, total: number): Promise<StageOutput> {
    const { snapshot, source, workDir, operation } = ctx;
    const duration = snapshot.sourceDurationSeconds ?? 0;
    const clipSeconds = duration > 0 ? Math.min(RESTORATION_PREVIEW_SECONDS, duration) : RESTORATION_PREVIEW_SECONDS;
    const defaultStart = Math.max(0, (duration - clipSeconds) / 2);
    const start = Math.max(
      0,
      Math.min(snapshot.region.startSeconds ?? defaultStart, Math.max(0, duration - clipSeconds)),
    );
    const rect = previewRegionPixels(snapshot.region, snapshot.sourceWidth, snapshot.sourceHeight);
    const crop = isFullRegion(snapshot.region)
      ? []
      : ['-vf', `crop=${even(rect.width)}:${even(rect.height)}:${rect.left}:${rect.top}`];

    // The clip keeps its audio so the before and after previews play in step.
    const beforeTmp = this.scratch(ctx, path.join(workDir, `before-${operation.id}.mp4`));
    await this.mediaRepository.transcode(source.originalPath, beforeTmp, {
      inputOptions: ['-ss', start.toFixed(3), '-t', clipSeconds.toFixed(3)],
      outputOptions: [
        ...crop,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '16',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-movflags',
        '+faststart',
      ],
      twoPass: false,
      progress: { frameCount: 0, percentInterval: 5 },
    });
    this.check(ctx);
    const before = await this.mediaRepository.probe(beforeTmp);
    const beforeStream = before.videoStreams[0];
    if (!beforeStream) {
      throw new RestorationFailure(RestorationErrorCode.OutputInvalid, 'The preview clip has no video stream');
    }
    await this.progress(ctx, MediaOperationStatus.Rendering, 2, total);

    const cap = cappedOutputSize(beforeStream.width, beforeStream.height, snapshot.upscale);
    const afterTmp = this.scratch(ctx, path.join(workDir, `after-${operation.id}.mp4`));
    await this.clearStaleOutput(afterTmp);
    const result = await this.machineLearningRepository.restore(
      ctx.selection,
      {
        kind: 'video',
        path: beforeTmp,
        width: beforeStream.width,
        height: beforeStream.height,
        durationSeconds: before.format.duration,
      },
      this.inferenceOptions(ctx, afterTmp, cap),
    );
    this.check(ctx);
    const after = await this.validateVideo(result.outputPath, cap, before.format.duration);
    await this.progress(ctx, MediaOperationStatus.Rendering, 3, total);

    const paths = restorationOutputPaths(this.base(ctx), snapshot.assetId, snapshot.restorationId);
    return {
      files: [
        { tmp: beforeTmp, final: `${paths.before}.mp4`, column: 'previewBeforePath' },
        {
          tmp: result.outputPath,
          final: `${paths.after}${path.extname(result.outputPath) || '.mp4'}`,
          column: 'previewAfterPath',
        },
      ],
      width: after.width,
      height: after.height,
      modelName: result.modelName,
      modelVersion: result.modelVersion,
    };
  }

  /**
   * A full video is restored in chunks, each a checkpoint (FL-104). A resumed or retried render
   * keeps the chunks whose identity still matches and whose output is still on disk, renders the
   * rest, then concatenates and muxes the original audio back in. Timing is the source's own:
   * chunks are cut on wall-clock seconds from the same file and joined with a stream copy.
   */
  private async fullVideo(ctx: RunContext, total: number): Promise<StageOutput> {
    const { snapshot, source, workDir, operation, claimToken } = ctx;
    const duration = snapshot.sourceDurationSeconds ?? 0;
    const chunks = planRestorationChunks(duration);
    if (chunks.length === 0) {
      throw new RestorationFailure(RestorationErrorCode.SourceMissing, 'The length of this video is not known');
    }
    const cap = { width: snapshot.output.width, height: snapshot.output.height };
    const planned = chunks.map((chunk) => ({ ...restorationChunkIdentity(snapshot, chunk), chunk }));

    // Checkpoints of this job and of the job it retries: a retry is a new row with the same
    // snapshot, so its predecessor's completed chunks describe exactly this work.
    const stored: StoredChunk[] = [];
    for (const id of [operation.id, operation.retryOfId]) {
      if (!id) {
        continue;
      }
      for (const checkpoint of await this.operationRepository.getCheckpoints(id)) {
        if (stored.some((existing) => existing.sequence === checkpoint.sequence)) {
          continue;
        }
        stored.push({
          sequence: checkpoint.sequence,
          state: checkpoint.state,
          chunkKey: checkpoint.chunkKey,
          inputDigest: checkpoint.inputDigest,
          historyDigest: checkpoint.historyDigest,
          configDigest: checkpoint.configDigest,
          seed: checkpoint.seed,
          timebase: checkpoint.timebase,
          startTicks: BigInt(checkpoint.startTicks),
          endTicks: BigInt(checkpoint.endTicks),
          requiresSequentialContext: checkpoint.requiresSequentialContext,
          outputPath: checkpoint.outputPath,
        });
      }
    }
    const resume = planChunkResume(stored, planned);
    const reusable = new Map<number, string>();
    for (const chunk of resume.reusable) {
      const outputPath = stored.find((existing) => existing.sequence === chunk.sequence)?.outputPath;
      if (outputPath && (await this.storageRepository.checkFileExists(outputPath))) {
        reusable.set(chunk.sequence, outputPath);
      }
    }
    // A chunk after a missing one cannot be reused either; the resume plan already ends at the
    // first break, and a missing file is such a break.
    let boundary = planned.length;
    for (const chunk of planned) {
      if (!reusable.has(chunk.sequence)) {
        boundary = chunk.sequence;
        break;
      }
    }
    for (const key of reusable.keys()) {
      if (key >= boundary) {
        reusable.delete(key);
      }
    }

    let processed = 2;
    const outputs: string[] = [];
    // Every chunk reused from a checkpoint ran the reviewed model, so it names the result.
    let modelName = snapshot.model?.name ?? 'unknown';
    let modelVersion: string | null = snapshot.model?.version ?? null;
    for (const plan of planned) {
      const kept = reusable.get(plan.sequence);
      if (kept) {
        outputs.push(kept);
        processed += 1;
        await this.progress(ctx, MediaOperationStatus.Rendering, processed, total);
        continue;
      }
      const recorded = await this.operationRepository.upsertCheckpoint(operation.id, claimToken, {
        operationId: operation.id,
        sequence: plan.sequence,
        chunkKey: plan.chunkKey,
        inputDigest: plan.inputDigest,
        historyDigest: plan.historyDigest,
        configDigest: plan.configDigest,
        seed: plan.seed,
        timebase: plan.timebase,
        startTicks: String(plan.startTicks),
        endTicks: String(plan.endTicks),
        prerollTicks: '0',
        requiresSequentialContext: false,
      });
      if (!recorded) {
        throw new RestorationInterrupted();
      }
      await this.operationRepository.invalidateCheckpointsFrom(operation.id, plan.sequence + 1);

      const chunkIn = this.scratch(ctx, path.join(workDir, `chunk-${plan.sequence}-in-${operation.id}.mp4`));
      await this.mediaRepository.transcode(source.originalPath, chunkIn, {
        inputOptions: [
          '-ss',
          plan.chunk.startSeconds.toFixed(3),
          '-t',
          (plan.chunk.endSeconds - plan.chunk.startSeconds).toFixed(3),
        ],
        outputOptions: ['-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '10', '-pix_fmt', 'yuv420p'],
        twoPass: false,
        progress: { frameCount: 0, percentInterval: 5 },
      });
      this.check(ctx);
      const probe = await this.mediaRepository.probe(chunkIn);
      const stream = probe.videoStreams[0];
      if (!stream) {
        throw new RestorationFailure(RestorationErrorCode.OutputInvalid, `Chunk ${plan.sequence} has no video stream`);
      }

      // Chunk outputs are not scratch: they are the checkpoints a resume reuses.
      const chunkOut = path.join(workDir, `chunk-${plan.sequence}-${plan.chunkKey.slice(0, 12)}.mp4`);
      await this.clearStaleOutput(chunkOut);
      const result = await this.machineLearningRepository.restore(
        ctx.selection,
        {
          kind: 'video',
          path: chunkIn,
          width: stream.width,
          height: stream.height,
          durationSeconds: probe.format.duration,
        },
        this.inferenceOptions(ctx, chunkOut, cap),
      );
      this.check(ctx);
      this.assertReviewedModel(ctx, result);
      await this.validateVideo(result.outputPath, cap, probe.format.duration);
      modelName = result.modelName;
      modelVersion = result.modelVersion;

      const checksum = await this.cryptoRepository.hashFile(result.outputPath, 'sha256');
      const { size } = await this.storageRepository.stat(result.outputPath);
      const completed = await this.operationRepository.completeCheckpoint(operation.id, claimToken, {
        sequence: plan.sequence,
        chunkKey: plan.chunkKey,
        outputPath: result.outputPath,
        outputChecksum: checksum,
        sizeInBytes: size,
      });
      if (!completed) {
        throw new RestorationInterrupted();
      }
      await this.storageRepository.unlink(chunkIn).catch(() => {});
      outputs.push(result.outputPath);
      processed += 1;
      await this.progress(ctx, MediaOperationStatus.Rendering, processed, total);
    }

    // Join the chunks with a stream copy, then put the original audio back.
    const listPath = this.scratch(ctx, path.join(workDir, `concat-${operation.id}.txt`));
    await this.storageRepository.createOrOverwriteFile(
      listPath,
      Buffer.from(outputs.map((file) => `file '${file.replaceAll("'", String.raw`'\''`)}'`).join('\n') + '\n'),
    );
    const joined = this.scratch(ctx, path.join(workDir, `joined-${operation.id}.mp4`));
    await this.mediaRepository.transcode(listPath, joined, {
      inputOptions: ['-f', 'concat', '-safe', '0'],
      outputOptions: ['-c', 'copy'],
      twoPass: false,
      progress: { frameCount: 0, percentInterval: 5 },
    });
    this.check(ctx);
    const resultTmp = this.scratch(ctx, path.join(workDir, `result-${operation.id}.mp4`));
    // ffmpeg reads `-i` wherever it appears before the output, so the original becomes the second
    // input here; the media repository's command builder only knows one input.
    await this.mediaRepository.transcode(joined, resultTmp, {
      inputOptions: [],
      outputOptions: [
        '-i',
        source.originalPath,
        '-map',
        '0:v:0',
        '-map',
        '1:a?',
        '-c:v',
        'copy',
        '-c:a',
        'copy',
        '-shortest',
        '-movflags',
        '+faststart',
      ],
      twoPass: false,
      progress: { frameCount: 0, percentInterval: 5 },
    });
    this.check(ctx);
    const restored = await this.validateVideo(resultTmp, cap, duration);
    await this.progress(ctx, MediaOperationStatus.Rendering, total - 1, total);

    const paths = restorationOutputPaths(this.base(ctx), snapshot.assetId, snapshot.restorationId);
    return {
      files: [{ tmp: resultTmp, final: `${paths.result}.mp4`, column: 'resultPath' }],
      width: restored.width,
      height: restored.height,
      modelName,
      modelVersion,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Publish and settle                                                  */
  /* ------------------------------------------------------------------ */

  /**
   * Atomic publish (FL-43). Validation is recorded on the job; then, with the job's row locked under
   * this claim, every file is moved into place, the restoration row changes — guarded by the running
   * status, so an owner who discarded the restoration meanwhile wins — and the job completes, all in
   * one transaction.
   *
   * Nothing is moved into place unless the claim still holds the job at that moment. A cancel that
   * arrived while the output was being checked, or a lease that lapsed and was handed to another
   * worker, leaves the files where they are as scratch: the cancel is settled and nothing is
   * published, and a replacement worker's output (or the previous valid one) is never overwritten or
   * removed by a stale one.
   */
  private async publish(
    ctx: RunContext,
    output: StageOutput,
    statuses: (typeof STAGE_STATUSES)[RestorationStage],
  ): Promise<void> {
    const { operation, claimToken, snapshot, stage, restoration } = ctx;
    if (!(await this.operationRepository.beginValidation(operation.id, claimToken))) {
      throw new RestorationInterrupted();
    }

    const now = new Date();
    const provenance = {
      ...(typeof restoration.provenance === 'object' && restoration.provenance),
      [stage]: {
        operationId: operation.id,
        destinationId: snapshot.destinationId,
        destinationKind: snapshot.destinationKind,
        workload: snapshot.workload,
        mode: snapshot.mode,
        upscale: snapshot.upscale,
        keepGrain: snapshot.keepGrain,
        modelName: output.modelName,
        modelVersion: output.modelVersion,
        sourceChecksumHex: snapshot.sourceChecksumHex,
        finishedAt: now.toISOString(),
      },
    };

    const columns: Partial<Record<PublishedFile['column'], string>> = {};
    const placed: string[] = [];
    let outcome: Awaited<ReturnType<MediaOperationRepository['publishValidated']>>;
    try {
      outcome = await this.operationRepository.publishValidated(operation.id, claimToken, async (trx) => {
        for (const file of output.files) {
          this.storageRepository.mkdirSync(path.dirname(file.final));
          await this.storageRepository.rename(file.tmp, file.final);
          placed.push(file.final);
          const index = ctx.scratch.indexOf(file.tmp);
          if (index !== -1) {
            ctx.scratch.splice(index, 1);
          }
          columns[file.column] = file.final;
        }

        const updated = await this.restorationRepository.transition(
          restoration.id,
          [statuses.running],
          {
            status: statuses.done,
            ...columns,
            modelName: output.modelName,
            modelVersion: output.modelVersion,
            provenance,
            error: null,
            ...(stage === 'preview'
              ? { previewReadyAt: now, previewExpiresAt: previewExpiryAfterReady(now) }
              : { restoredAt: now, outputWidth: output.width, outputHeight: output.height }),
          },
          trx,
        );
        return !!updated;
      });
    } catch (error) {
      // Nothing was recorded; the files this attempt moved into place belong to no row.
      await this.discard(placed);
      throw error;
    }

    if (outcome === 'lost') {
      // Cancelled while the output was checked, or the claim is gone: `settle` decides which.
      throw new RestorationInterrupted();
    }

    if (outcome === 'rejected') {
      // Discarded while rendering. The result has no owner decision behind it any more.
      await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: placed } });
      await this.operationRepository.fail(operation.id, claimToken, {
        error: 'The restoration was discarded while the render was running',
        errorCode: RestorationErrorCode.StageNotRunnable,
      });
      return;
    }

    if (stage === 'full') {
      await this.storageRepository.unlinkDir(ctx.workDir, { recursive: true, force: true }).catch(() => {});
    }
    this.logger.log(
      `Restoration ${restoration.id} ${stage} finished on ${snapshot.destinationKind} destination ${snapshot.destinationId}`,
    );
  }

  /**
   * Decide what a thrown error means for the job record.
   *
   * An interruption is the owner's cancel (acknowledged here, the row says cancelled), the owner's
   * pause (the claim is handed back and the job waits, paused, to be resumed; FL-104) or a lost
   * lease (recovery owns the job; the row stays running and the next claim resumes). Anything
   * else fails the job with a stable code; the row mirrors it so the editor can show why.
   */
  private async settle(
    ctx: Pick<RunContext, 'operation' | 'claimToken' | 'restoration' | 'signal'>,
    error: unknown,
    statuses: (typeof STAGE_STATUSES)[RestorationStage],
  ): Promise<void> {
    const { operation, claimToken, restoration } = ctx;
    if (error instanceof RestorationInterrupted || ctx.signal.aborted) {
      const current = await this.operationRepository.getForOwner(operation.id, operation.ownerId);
      if (current?.status === MediaOperationStatus.Cancelling) {
        await this.operationRepository.acknowledgeCancel(operation.id, claimToken, { released: true });
        await this.restorationRepository.transition(restoration.id, [statuses.running], {
          status: statuses.cancelled,
          ...this.abandonedRetention(statuses),
        });
        this.logger.log(`Restoration ${restoration.id} cancelled by its owner`);
      } else if (current?.pauseRequestedAt && (await this.operationRepository.settlePause(operation.id, claimToken))) {
        // The owner paused it (FL-104). The restoration row stays running: resuming requeues the
        // job, and the next claim carries on from the chunks already checkpointed.
        this.logger.log(`Restoration ${restoration.id} paused by its owner`);
      } else if (
        await this.operationRepository.requeue(operation.id, claimToken, { delayMs: 0, returnAttempt: true })
      ) {
        // Stopped for a pause the owner withdrew before it landed: the claim is still ours, so the
        // job goes straight back to the queue instead of waiting for its lease to lapse.
        this.logger.log(`Restoration ${restoration.id} resumed before its pause landed; requeued`);
      } else {
        this.logger.warn(
          `Restoration ${restoration.id} lost its claim on job ${operation.id}; recovery will requeue it`,
        );
      }
      return;
    }

    const code = error instanceof RestorationFailure ? error.code : RestorationErrorCode.Failed;
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    this.logger.error(`Restoration ${restoration.id} failed (${code}): ${message}`);
    const outcome = await this.operationRepository.fail(operation.id, claimToken, { error: message, errorCode: code });
    if (outcome === 'failed') {
      await this.restorationRepository.transition(restoration.id, [statuses.running], {
        status: statuses.failed,
        error: message,
        ...this.abandonedRetention(statuses),
      });
    } else if (outcome === 'retrying') {
      // Every job gets one automatic retry before a failure is reported (FL-104, owner decision
      // September 22, 2026). The row stays running: the stage is runnable from there, and the next
      // claim resumes from the checkpoints.
      this.logger.log(`Restoration ${restoration.id} ${code}; job ${operation.id} will be retried once`);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * The full render must run the model the owner reviewed in the preview (FL-115). A destination
   * whose model or weights changed since then refuses; the owner requests a new preview.
   */
  private assertReviewedModel(
    ctx: Pick<RunContext, 'snapshot'>,
    result: Pick<RestorationInferenceResult, 'modelName' | 'modelVersion'>,
  ) {
    if (isReviewedModel(ctx.snapshot, result)) {
      return;
    }

    const reviewed = ctx.snapshot.model!;
    throw new RestorationFailure(
      RestorationErrorCode.ModelChanged,
      `The destination now runs ${result.modelName} ${result.modelVersion ?? ''}`.trim() +
        `, not the ${reviewed.name} ${reviewed.version ?? ''}`.trimEnd() +
        ' the preview was reviewed with; request a new preview',
    );
  }

  /** A full render that stops without a result starts its leftovers' retention clock (FL-115). */
  private abandonedRetention(statuses: (typeof STAGE_STATUSES)[RestorationStage]) {
    return statuses === STAGE_STATUSES.full ? { resultExpiresAt: resultExpiryAfterAbandon(new Date()) } : {};
  }

  /**
   * Renew the lease and notice a cancel or a pause. False means stop: the claim is gone, or the
   * owner asked to cancel or to pause (FL-104). `settle` then decides which of those it was.
   */
  private async renew(operation: MediaOperation, claimToken: string): Promise<boolean> {
    const alive = await this.operationRepository.heartbeat(operation.id, claimToken, RESTORATION_LEASE_MS);
    if (!alive) {
      return false;
    }
    const current = await this.operationRepository.getForOwner(operation.id, operation.ownerId);
    if (current?.cancelRequestedAt) {
      return false;
    }
    // A pause lands before validation starts; once the output is being checked it is let finish.
    return !current?.pauseRequestedAt || current.status === MediaOperationStatus.Validating;
  }

  private async progress(
    ctx: Pick<RunContext, 'operation' | 'claimToken' | 'signal'>,
    status: MediaOperationStatus,
    processed: number,
    total: number,
  ): Promise<void> {
    this.check(ctx);
    const ok = await this.operationRepository.reportProgress(ctx.operation.id, ctx.claimToken, {
      status,
      processedUnits: processed,
      totalUnits: total,
      progress: mediaOperationProgress(processed, total) ?? 0,
    });
    if (!ok) {
      // Either the lease is gone or the owner cancelled (`cancelling` is not a reportable state).
      throw new RestorationInterrupted();
    }
  }

  private check(ctx: Pick<RunContext, 'signal'>): void {
    if (ctx.signal.aborted) {
      throw new RestorationInterrupted();
    }
  }

  private scratch(ctx: Pick<RunContext, 'scratch'>, file: string): string {
    ctx.scratch.push(file);
    return file;
  }

  /**
   * Remove a scratch output an interrupted attempt of this same job left behind. The adapter
   * creates its output exclusively and refuses to replace any file, so a requeued job would
   * otherwise fail on its own leftover. Only paths inside this job's work directory reach here.
   */
  private async clearStaleOutput(file: string): Promise<void> {
    await this.storageRepository.unlink(file).catch(() => {});
  }

  private async discard(files: string[]): Promise<void> {
    for (const file of files) {
      await this.storageRepository.unlink(file).catch(() => {});
    }
  }

  private base(ctx: Pick<RunContext, 'restoration'>) {
    return StorageCore.getNestedFolder(StorageFolder.Thumbnails, ctx.restoration.ownerId, ctx.restoration.assetId);
  }

  private inferenceOptions(ctx: RunContext, outputPath: string, cap: { width: number; height: number }) {
    return {
      mode: ctx.snapshot.mode,
      upscale: ctx.snapshot.upscale,
      keepGrain: ctx.snapshot.keepGrain,
      maxWidth: cap.width,
      maxHeight: cap.height,
      outputPath,
      jobId: ctx.operation.id,
      signal: ctx.signal,
    };
  }

  /** A restored still must exist, decode, and fit inside the cap the adapter was given. */
  private async validateImage(file: string, cap: { width: number; height: number }) {
    if (!(await this.storageRepository.checkFileExists(file))) {
      throw new RestorationFailure(RestorationErrorCode.OutputInvalid, 'The adapter produced no output file');
    }
    const meta = await this.mediaRepository.getImageMetadata(file);
    if (!(meta.width > 0 && meta.height > 0)) {
      throw new RestorationFailure(RestorationErrorCode.OutputInvalid, 'The restored image could not be decoded');
    }
    if (meta.width > cap.width + 1 || meta.height > cap.height + 1) {
      throw new RestorationFailure(
        RestorationErrorCode.OutputInvalid,
        `The restored image is ${meta.width}×${meta.height}, above the ${cap.width}×${cap.height} cap`,
      );
    }
    return meta;
  }

  /** A restored clip must have a video stream, fit the cap, and keep (nearly) the source length. */
  private async validateVideo(file: string, cap: { width: number; height: number }, expectedSeconds: number) {
    if (!(await this.storageRepository.checkFileExists(file))) {
      throw new RestorationFailure(RestorationErrorCode.OutputInvalid, 'The adapter produced no output file');
    }
    const probe = await this.mediaRepository.probe(file);
    const stream = probe.videoStreams[0];
    if (!stream || !(stream.width > 0 && stream.height > 0)) {
      throw new RestorationFailure(
        RestorationErrorCode.OutputInvalid,
        'The restored video has no decodable video stream',
      );
    }
    if (stream.width > cap.width + 1 || stream.height > cap.height + 1) {
      throw new RestorationFailure(
        RestorationErrorCode.OutputInvalid,
        `The restored video is ${stream.width}×${stream.height}, above the ${cap.width}×${cap.height} cap`,
      );
    }
    if (expectedSeconds > 0 && probe.format.duration < expectedSeconds * 0.9) {
      throw new RestorationFailure(
        RestorationErrorCode.OutputInvalid,
        `The restored video is ${probe.format.duration.toFixed(2)} s long; the source was ${expectedSeconds.toFixed(2)} s`,
      );
    }
    return { width: stream.width, height: stream.height, duration: probe.format.duration };
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

  private getConfig() {
    return getConfig(
      { configRepo: this.configRepository, metadataRepo: this.systemMetadataRepository, logger: this.logger },
      { withCache: true },
    );
  }
}
