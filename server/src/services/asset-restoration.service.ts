import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { RestorationPhotoOperation } from 'src/dtos/restoration-inference.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent } from 'src/decorators.js';
import {
  AssetRestorationBatchRequestDto,
  AssetRestorationBatchResponseDto,
  AssetRestorationDestinationDto,
  AssetRestorationEstimateDto,
  AssetRestorationFileKind,
  AssetRestorationListResponseDto,
  AssetRestorationMode,
  AssetRestorationModelDto,
  AssetRestorationOperation,
  AssetRestorationOptionsDto,
  AssetRestorationOptionsQueryDto,
  AssetRestorationRegion,
  AssetRestorationRegionSchema,
  AssetRestorationRequestDto,
  AssetRestorationResponseDto,
  AssetRestorationSelectDto,
  AssetRestorationSourceType,
  AssetRestorationStatus,
  DEFAULT_RESTORATION_REGION,
} from 'src/dtos/asset-restoration.dto.js';
import {
  AssetType,
  CacheControl,
  JobName,
  MediaOperationKind,
  MlAdmissionRefusal,
  MlDestinationKind,
  MlProcessingSource,
  MlWorkload,
  NotificationLevel,
  NotificationType,
  Permission,
  StorageFolder,
} from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRestoration, AssetRestorationRepository } from 'src/repositories/asset-restoration.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { MlDestinationRepository, MlDestinationRow } from 'src/repositories/ml-destination.repository.js';
import { NotificationRepository } from 'src/repositories/notification.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { CloudMlJobService } from 'src/services/cloud-ml-job.service.js';
import { requireAccess } from 'src/utils/access.js';
import { getConfig } from 'src/utils/config.js';
import { asDateTimeString } from 'src/utils/date.js';
import { FileDownloadResponse } from 'src/utils/file.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import {
  ML_BUDGET_WINDOW_DAYS,
  MlDestinationRefusedError,
  hasRequiredConsent,
  isCloudDestination,
  liveCloudRouting,
  readCloudModelChoices,
  restorationRoleConflict,
  selectMlDestination,
  storedAdmission,
  storedRestorationModels,
} from 'src/utils/ml-destination.js';
import { KIND_SOURCE, sourcesFor } from 'src/utils/ml-processing-order.js';
import { HAND_TINTED, colourRefusalReason, photoColourRefusal } from 'src/utils/photo-monochrome.js';
import {
  INTERPOLATION_PREVIEW_SECONDS,
  RESTORATION_PREVIEW_SECONDS,
  RestorationSnapshot,
  type SmoothMotionFactor,
  canAcceptRestoration,
  canDiscardRestoration,
  canRejectRestoration,
  canSelectRestoration,
  cappedOutputSize,
  isActiveRestoration,
  isSmoothMotionFactor,
  mediaOperationDestinationOf,
  photoOperationLabel,
  photoOperationOf,
  previewExpiryAfterDecision,
  previewInputBytes,
  restorationEstimate,
  restorationModeLabel,
  restorationWorkDir,
  toPhotoOperation,
  workloadForMode,
} from 'src/utils/restoration.js';
/** Why work is refused on a computer at home while an administrator has set it to Frameleaf Cloud. */
const CLOUD_ONLY_DETAIL =
  'This work is set to Frameleaf Cloud under Where work runs; confirm it as a Frameleaf Cloud job';

/** The Where work runs row behind a request: Smooth motion, Enhance for a photo, or video restoration. */
const routeOf = (
  smooth: boolean,
  sourceType: AssetRestorationSourceType,
  routing: Record<'upscale' | 'restoration' | 'interpolation', 'local' | 'both' | 'cloud'>,
) => {
  if (smooth) {
    return routing.interpolation;
  }
  return sourceType === AssetRestorationSourceType.Image ? routing.upscale : routing.restoration;
};

/** Thrown inside a batch item's transaction when an earlier confirmation already queued it. */
class BatchItemAlreadyQueued extends Error {}

/** Window over which a destination's measured throughput is averaged for estimates. */
const ESTIMATE_WINDOW_DAYS = 30;

type RestorationSource = {
  id: string;
  ownerId: string;
  type: AssetType;
  originalFileName: string;
  originalPath: string;
  checksum: Buffer;
  sourceType: AssetRestorationSourceType;
  width: number;
  height: number;
  durationSeconds: number | null;
  sizeBytes: number;
};

const windowStart = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

const asIso = (value: Date | string | null | undefined): string | null => (value ? asDateTimeString(value) : null);

/** `asset.duration` arrives as seconds or as an `HH:MM:SS.fff` interval depending on the reader. */
export const parseDurationSeconds = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string') {
    const parts = value.split(':').map(Number);
    if (parts.length === 3 && parts.every((part) => Number.isFinite(part))) {
      const seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
      return seconds > 0 ? seconds : null;
    }
    const plain = Number(value);
    return Number.isFinite(plain) && plain > 0 ? plain : null;
  }
  return null;
};

const asRegion = (value: unknown): AssetRestorationRegion => {
  const parsed = AssetRestorationRegionSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_RESTORATION_REGION;
};

const isSmoothMode = (mode: AssetRestorationMode) => mode === AssetRestorationMode.SmoothMotion;

/**
 * FL-423: the models a home destination offers for this kind of work, as it reported them at its last
 * check: its Faithful and Creative models for a restoration, its Smooth motion models for Smooth motion.
 * Frameleaf Cloud offers none here; its model is chosen with its estimate.
 */
const offeredModels = (row: MlDestinationRow, mode: AssetRestorationMode): AssetRestorationModelDto[] =>
  isCloudDestination(row.kind)
    ? []
    : storedRestorationModels(row.lastProbeHardware)
        .filter((model) => isSmoothMode(model.mode) === isSmoothMode(mode))
        .map(({ id, name, family, mode, available }) => ({ id, name, family, mode, available }));

/**
 * FL-423: a chosen model must be one the destination reported it can run for the requested mode. It is
 * refused, never swapped for another. A destination that reported no models leaves the check to the
 * worker, which runs the named model exactly or refuses.
 */
const refuseUnofferedModel = (destination: MlDestinationRow, dto: AssetRestorationRequestDto) => {
  if (!dto.model) {
    return;
  }
  const offered = storedRestorationModels(destination.lastProbeHardware);
  if (offered.length === 0) {
    return;
  }
  const model = offered.find((candidate) => candidate.id === dto.model);
  if (!model || model.mode !== dto.mode) {
    throw new BadRequestException(`${destination.name} has no ${dto.model} model for this; choose another model`);
  }
  if (!model.available) {
    throw new BadRequestException(`${destination.name} can’t use ${model.name} right now; choose another model`);
  }
};

const asEstimate = (value: unknown): AssetRestorationEstimateDto | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const estimate = value as Record<string, unknown>;
  const num = (key: string) => (typeof estimate[key] === 'number' ? (estimate[key] as number) : null);
  return {
    sampleCount: num('sampleCount') ?? 0,
    bytesPerSecond: num('bytesPerSecond'),
    windowDays: num('windowDays') ?? ESTIMATE_WINDOW_DAYS,
    previewBytes: num('previewBytes') ?? 0,
    fullBytes: num('fullBytes') ?? 0,
    previewSeconds: num('previewSeconds'),
    fullSeconds: num('fullSeconds'),
  };
};

/**
 * The owner-facing side of preview-first restoration (FL-115).
 *
 * Every route re-checks asset access through the existing edit permissions, which resolve to the
 * owner (or an elevated session for a Locked asset): the same boundary the quick editor enforces.
 * There is no shared-link or partner path to a restoration; a Locked asset's previews and results
 * are only ever served to a session that could already see the asset.
 *
 * What this service decides and what it does not:
 *
 * - It admits the destination the person named, through FL-110's selection, and refuses rather
 *   than substituting. A cloud destination without recorded consent is a refusal, not a prompt.
 * - It records the request as a durable media operation (FL-104) and stops. Running the job is
 *   `RestorationWorkerService`'s; progress, cancel and retry are the media operation's.
 * - It never writes the original, and never chooses a result as the asset's playback version:
 *   `setCurrent` is the owner's explicit act.
 */
@Injectable()
export class AssetRestorationService {
  constructor(
    private logger: LoggingRepository,
    private accessRepository: AccessRepository,
    private assetRepository: AssetRepository,
    private restorationRepository: AssetRestorationRepository,
    private operationRepository: MediaOperationRepository,
    private mlDestinationRepository: MlDestinationRepository,
    private machineLearningRepository: MachineLearningRepository,
    private jobRepository: JobRepository,
    private storageRepository: StorageRepository,
    private configRepository: ConfigRepository,
    private systemMetadataRepository: SystemMetadataRepository,
    private notificationRepository: NotificationRepository,
    private mediaRepository: MediaRepository,
    private cloudMlJobService: CloudMlJobService,
  ) {
    this.logger.setContext(AssetRestorationService.name);
  }

  async list(auth: AuthDto, assetId: string): Promise<AssetRestorationListResponseDto> {
    await requireAccess(this.accessRepository, { auth, permission: Permission.AssetEditGet, ids: [assetId] });
    return this.toList(assetId);
  }

  /**
   * The choices for a restoration of this asset: the output size after the 4K cap, and every
   * destination with whether the server would admit the workload on it right now and what its
   * measured throughput says about the time. Nothing is probed here; the persisted probe state is
   * what the administrator's page shows too, so the two never disagree.
   */
  async getOptions(
    auth: AuthDto,
    assetId: string,
    dto: AssetRestorationOptionsQueryDto,
  ): Promise<AssetRestorationOptionsDto> {
    await requireAccess(this.accessRepository, { auth, permission: Permission.AssetEditGet, ids: [assetId] });
    const source = await this.requireSource(assetId);
    // FL-955: repair and colourise run as a faithful restoration that keeps the photo's size
    const photoOperation = toPhotoOperation(dto.operation);
    if (photoOperation && source.sourceType !== AssetRestorationSourceType.Image) {
      throw new BadRequestException('Repair and Suggested colours work on photos');
    }
    const mode = photoOperation ? AssetRestorationMode.Faithful : (dto.mode ?? AssetRestorationMode.Faithful);
    const smooth = mode === AssetRestorationMode.SmoothMotion;
    // Smooth motion keeps the size; only a restoration upscales.
    const upscale = smooth || photoOperation ? 1 : ((dto.upscale ?? 2) as 1 | 2 | 4);
    const workload = workloadForMode(mode);
    const output = cappedOutputSize(source.width, source.height, upscale);
    const routing = await this.routing();
    const route = routeOf(smooth, source.sourceType, routing);
    const cloudOnly = route === 'cloud';
    const rows = await this.mlDestinationRepository.getAll();
    const since = windowStart(ESTIMATE_WINDOW_DAYS);
    // FL-186: Frameleaf Cloud is judged with the model an administrator chose for this mode
    const choices = await readCloudModelChoices(this.mlDestinationRepository, rows);

    const destinations: AssetRestorationDestinationDto[] = [];
    for (const row of rows) {
      // FL-162: Frameleaf Cloud restores a photo by upscaling it, so a photo is judged by that workload there
      const judged =
        row.kind === MlDestinationKind.FrameleafCloud && source.sourceType === AssetRestorationSourceType.Image
          ? MlWorkload.Upscale
          : workload;
      let verdict = storedAdmission({
        destination: row,
        workload: judged,
        spentUsd:
          row.budgetLimitUsd === null
            ? 0
            : await this.mlDestinationRepository.getSpend(row.id, windowStart(ML_BUDGET_WINDOW_DAYS)),
        choices,
        ...(photoOperation && row.kind !== MlDestinationKind.FrameleafCloud && { photoOperation }),
      });
      if (verdict.admitted && cloudOnly && row.kind !== MlDestinationKind.FrameleafCloud) {
        // Set to Frameleaf Cloud under Where work runs, even when this computer could run it.
        verdict = { admitted: false, refusal: MlAdmissionRefusal.WorkloadNotAllowed, detail: CLOUD_ONLY_DETAIL };
      }
      if (verdict.admitted) {
        // FL-72: the rule requestPreview and accept apply before anything is created, so the
        // picker never offers an endpoint library analysis uses.
        const conflict = await restorationRoleConflict(
          {
            mlDestinationRepository: this.mlDestinationRepository,
            machineLearningRepository: this.machineLearningRepository,
          },
          row,
          workload,
        );
        if (conflict) {
          verdict = { admitted: false, refusal: MlAdmissionRefusal.RoleConflict, detail: conflict };
        }
      }
      const sample = await this.mlDestinationRepository.getThroughput(row.id, since, workload);
      destinations.push({
        id: row.id,
        kind: row.kind,
        name: row.name,
        health: row.lastProbeHealth,
        available: verdict.admitted,
        leavesNetwork: isCloudDestination(row.kind),
        consentRequired: isCloudDestination(row.kind),
        consentGranted: hasRequiredConsent(row),
        refusal: verdict.admitted ? null : verdict.refusal,
        refusalDetail: verdict.admitted ? null : verdict.detail,
        estimate: restorationEstimate(
          sample,
          this.inputBytes(source, DEFAULT_RESTORATION_REGION),
          ESTIMATE_WINDOW_DAYS,
        ),
        gpu: row.lastProbeHardware?.gpus?.[0] ?? null,
        // The worker picks its one qualified model for a photo operation.
        models: photoOperation ? [] : offeredModels(row, mode),
      });
    }

    const colourRefusal = photoOperation === 'colourise' ? await this.colourRefusal(assetId) : null;
    return {
      assetId,
      sourceType: source.sourceType,
      sourceWidth: source.width,
      sourceHeight: source.height,
      durationSeconds: source.durationSeconds,
      mode,
      workload,
      upscale,
      outputWidth: output.width,
      outputHeight: output.height,
      previewSeconds:
        source.sourceType === AssetRestorationSourceType.Video
          ? smooth
            ? INTERPOLATION_PREVIEW_SECONDS
            : RESTORATION_PREVIEW_SECONDS
          : null,
      // The adapter ships with the server (FL-114); whether a model can run is per destination.
      adapterInstalled: true,
      destinations,
      route,
      ...(photoOperation && { operation: dto.operation }),
      ...(colourRefusal && { colourRefusal, colourRefusalReason: colourRefusalReason(colourRefusal) }),
    };
  }

  /**
   * Request a preview. The destination is admitted now, with a live probe, so a person is told at
   * once that a destination cannot take the work instead of finding out from a failed job. The
   * refusal names its reason; it never picks somewhere else.
   */
  async requestPreview(
    auth: AuthDto,
    assetId: string,
    dto: AssetRestorationRequestDto,
  ): Promise<AssetRestorationResponseDto> {
    await requireAccess(this.accessRepository, { auth, permission: Permission.AssetEditCreate, ids: [assetId] });
    return this.queuePreview(
      { requestedBy: auth.user.id, sessionElevated: !!auth.session?.hasElevatedPermission },
      assetId,
      dto,
    );
  }

  /**
   * FL-162 Smooth motion after a Studio export. The export itself rendered at home; this is its own
   * job on the exported video, previewed first like any other, for the owner to review and accept.
   * A Frameleaf Cloud choice is never sent from here: the owner is told the export is ready and
   * confirms the Smooth motion job, with its estimate, from the video's Enhance panel.
   */
  async queueExportSmoothMotion(request: {
    ownerId: string;
    assetId: string;
    exportName: string;
    factor: SmoothMotionFactor;
    destinationId: string;
    model?: string;
  }): Promise<AssetRestorationResponseDto | null> {
    const destination = await this.mlDestinationRepository.getById(request.destinationId);
    const tell = (level: NotificationLevel, title: string, description: string) =>
      this.notificationRepository
        .create({
          userId: request.ownerId,
          type: NotificationType.Custom,
          level,
          title,
          description,
          data: { assetId: request.assetId, restoration: 'smooth-motion', factor: request.factor },
        })
        .catch((error: unknown) => this.logger.warn(`Could not tell ${request.ownerId} about Smooth motion: ${error}`));

    if (destination?.kind === MlDestinationKind.FrameleafCloud) {
      await tell(
        NotificationLevel.Info,
        'Confirm Smooth motion on Frameleaf Cloud',
        `${request.exportName} is in your library. Open it and choose Smooth motion to see the Frameleaf Cloud estimate; nothing is sent until you confirm.`,
      );
      return null;
    }
    try {
      const queued = await this.queuePreview(
        { requestedBy: request.ownerId, sessionElevated: false },
        request.assetId,
        {
          mode: AssetRestorationMode.SmoothMotion,
          upscale: 1,
          smoothMotionFactor: request.factor,
          keepGrain: false,
          destinationId: request.destinationId,
          ...(request.model && { model: request.model }),
          region: DEFAULT_RESTORATION_REGION,
        },
      );
      await tell(
        NotificationLevel.Info,
        'Smooth motion preview queued',
        `${request.exportName} is in your library, and a Smooth motion preview of it is being made. Review it in its Enhance panel.`,
      );
      return queued;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Smooth motion after the export of ${request.assetId} did not start: ${detail}`);
      await tell(
        NotificationLevel.Warning,
        'Smooth motion did not start',
        `${request.exportName} is in your library, but Smooth motion could not start: ${detail}`,
      );
      return null;
    }
  }

  private async queuePreview(
    provenance: { requestedBy: string; sessionElevated: boolean },
    assetId: string,
    dto: AssetRestorationRequestDto,
  ): Promise<AssetRestorationResponseDto> {
    const photoOperation = toPhotoOperation(dto.operation);
    await this.refuseCloudRequest(dto.destinationId, photoOperation);
    const source = await this.requireSource(assetId);
    if (photoOperation) {
      if (source.sourceType !== AssetRestorationSourceType.Image) {
        throw new BadRequestException('Repair and Suggested colours work on photos');
      }
      const refusal = photoOperation === 'colourise' ? await this.colourRefusal(assetId, dto.allowHandTinted) : null;
      if (refusal) {
        throw new BadRequestException(refusal);
      }
    }
    const smooth = dto.mode === AssetRestorationMode.SmoothMotion;
    if (smooth) {
      // FL-162: local Smooth motion (RIFE) on this server or a home-network restoration worker.
      if (source.sourceType !== AssetRestorationSourceType.Video) {
        throw new BadRequestException('Smooth motion needs a video');
      }
      if (!dto.smoothMotionFactor) {
        throw new BadRequestException('Smooth motion needs a factor of 2, 4 or 8');
      }
      if ((await this.routing()).interpolation === 'cloud') {
        throw new MlDestinationRefusedError(
          MlAdmissionRefusal.WorkloadNotAllowed,
          MlWorkload.Interpolation,
          dto.destinationId,
          CLOUD_ONLY_DETAIL,
        );
      }
    }
    const workload = workloadForMode(dto.mode);
    const region = dto.region ?? DEFAULT_RESTORATION_REGION;

    // Consent, allow-list, budget, health and the worker's role are all decided here, before a row exists.
    await this.admitRestoration(workload, dto.destinationId, MediaOperationKind.RestorationPreview, photoOperation);
    const destination = await this.requireDestination(dto.destinationId);
    if (
      destination.kind !== MlDestinationKind.FrameleafCloud &&
      routeOf(smooth, source.sourceType, await this.routing()) === 'cloud'
    ) {
      throw new MlDestinationRefusedError(
        MlAdmissionRefusal.WorkloadNotAllowed,
        workload,
        dto.destinationId,
        CLOUD_ONLY_DETAIL,
      );
    }
    refuseUnofferedModel(destination, dto);
    const upscale = photoOperation ? 1 : dto.upscale;
    const output = cappedOutputSize(source.width, source.height, smooth ? 1 : upscale);
    const sample = await this.mlDestinationRepository.getThroughput(
      destination.id,
      windowStart(ESTIMATE_WINDOW_DAYS),
      workload,
    );
    const estimate = restorationEstimate(sample, this.inputBytes(source, region), ESTIMATE_WINDOW_DAYS);

    const restoration = await this.restorationRepository.create({
      assetId,
      ownerId: source.ownerId,
      status: AssetRestorationStatus.PreviewQueued,
      mode: dto.mode,
      // A Smooth motion row keeps its frame-rate factor where a restoration keeps its upscale (FL-162).
      upscale: smooth ? dto.smoothMotionFactor! : upscale,
      keepGrain: dto.keepGrain,
      workload,
      destinationId: destination.id,
      destinationKind: destination.kind,
      destinationName: destination.name,
      sourceType: source.sourceType,
      sourceChecksum: source.checksum,
      sourceWidth: source.width,
      sourceHeight: source.height,
      sourceDurationSeconds: source.durationSeconds,
      previewRegion: region,
      estimate,
      provenance: {
        ...provenance,
        ...(photoOperation && { operation: photoOperation }),
        ...(photoOperation === 'colourise' && dto.allowHandTinted && { allowHandTinted: true }),
      },
    });

    try {
      let bound = restoration;
      const { operation } = await this.operationRepository.createWithin(
        () =>
          Promise.resolve({
            operation: {
              ownerId: source.ownerId,
              kind: MediaOperationKind.RestorationPreview,
              destination: mediaOperationDestinationOf(destination.kind),
              destinationDetail: destination.name,
              label: source.originalFileName,
              assetId,
              resultAssetId: null,
              retryOfId: null,
              projectId: null,
              revisionId: restoration.id,
              snapshot: this.snapshotOf(restoration, source, 'preview', output, dto.model),
              settings: this.settingsOf(restoration, destination.name, true),
              estimate:
                estimate.previewSeconds === null
                  ? null
                  : { seconds: estimate.previewSeconds, sizeBytes: null, cloudCost: null },
            },
            value: null,
          }),
        async (trx, operation) => {
          const updated = await this.restorationRepository.transition(
            restoration.id,
            [AssetRestorationStatus.PreviewQueued],
            { status: AssetRestorationStatus.PreviewQueued, previewOperationId: operation.id },
            trx,
            { stage: 'preview', id: null },
          );
          if (!updated) throw new ConflictException('This restoration was already decided');
          bound = updated;
        },
      );
      this.logger.log(
        `Restoration ${restoration.id} preview queued as operation ${operation.id} on ${destination.name}`,
      );
      return this.toDto(bound);
    } catch (error) {
      // Only an unbound preview is failed; a committed job or later owner decision wins.
      const message = error instanceof Error ? error.message : String(error);
      await this.restorationRepository.transition(
        restoration.id,
        [AssetRestorationStatus.PreviewQueued],
        {
          status: AssetRestorationStatus.PreviewFailed,
          error: message.slice(0, 500),
        },
        undefined,
        { stage: 'preview', id: null },
      );
      throw error;
    }
  }

  /**
   * FL-955: repair or colourise many photos. Without `confirm` this is the estimate: which photos would
   * run, and every destination in the processing order with its time, or its cost on Frameleaf Cloud
   * once Cloud offers a price. With `confirm` each eligible photo becomes one durable full-render job on
   * the destination the person chose, one at a time per worker. A job survives a restart on its own;
   * confirming the same `batchId` again queues only what is missing. Work at home never touches the
   * AI Wallet, and Frameleaf Cloud refuses these operations until FL-961 offers and prices them.
   */
  async batch(auth: AuthDto, dto: AssetRestorationBatchRequestDto): Promise<AssetRestorationBatchResponseDto> {
    const ids = [...new Set(dto.assetIds)];
    await requireAccess(this.accessRepository, { auth, permission: Permission.AssetEditCreate, ids });
    const photoOperation = toPhotoOperation(dto.operation)!;
    const skipped: AssetRestorationBatchResponseDto['skipped'] = [];
    const eligible: RestorationSource[] = [];
    const allowHandTinted = photoOperation === 'colourise' && !!dto.allowHandTinted;
    const tinted = { count: 0 };
    for (const assetId of ids) {
      const reason = await this.batchSkipReason(assetId, photoOperation, eligible, allowHandTinted, tinted);
      if (reason) {
        skipped.push({ assetId, reason });
      }
    }
    const destinations = await this.batchDestinations(photoOperation, eligible);
    if (allowHandTinted && tinted.count > 0) {
      // Frameleaf Cloud has no override yet, so a batch with hand-tinted prints in it stays at home.
      for (const row of destinations) {
        if (row.kind === MlDestinationKind.FrameleafCloud && row.available) {
          row.available = false;
          row.refusal = MlAdmissionRefusal.WorkloadNotServed;
          row.refusalDetail = 'Frameleaf Cloud cannot include hand-tinted prints yet';
        }
      }
    }
    const summary = {
      batchId: dto.batchId ?? randomUUID(),
      operation: dto.operation,
      total: ids.length,
      eligible: eligible.length,
      skipped,
      ...(photoOperation === 'colourise' && { handTinted: tinted.count }),
      destinations,
    };
    if (!dto.confirm) {
      await this.quoteCloud(auth, photoOperation, eligible, destinations);
      return { ...summary, queued: 0 };
    }

    const chosen = destinations.find(({ id }) => id === dto.destinationId);
    if (!chosen) {
      throw new NotFoundException(`Machine learning destination ${dto.destinationId} does not exist`);
    }
    if (!chosen.available) {
      throw new BadRequestException(
        chosen.refusalDetail ?? `${chosen.name} cannot run this right now; nothing was queued`,
      );
    }
    if (eligible.length === 0) {
      throw new BadRequestException(
        'None of these photos can be repaired or given suggested colours; nothing was queued',
      );
    }
    if (chosen.kind === MlDestinationKind.FrameleafCloud) {
      if (dto.maxCostUsd === undefined || !dto.consentVersion || dto.acknowledgeDataLeaves !== true) {
        throw new BadRequestException('Confirm the Frameleaf Cloud estimate and terms first; nothing was sent');
      }
      const queued = await this.cloudMlJobService.startPhotoBatch(auth, {
        batchId: summary.batchId,
        operation: photoOperation,
        assetIds: eligible.map(({ id }) => id),
        destinationId: chosen.id,
        maxCostUsd: dto.maxCostUsd,
        consentVersion: dto.consentVersion,
      });
      return { ...summary, queued };
    }
    await this.admitRestoration(
      MlWorkload.RestorationFaithful,
      chosen.id,
      MediaOperationKind.Restoration,
      photoOperation,
    );
    const destination = await this.requireDestination(chosen.id);
    let queued = 0;
    for (const source of eligible) {
      if (await this.queueBatchItem(auth, summary.batchId, photoOperation, source, destination, allowHandTinted)) {
        queued++;
      }
    }
    this.logger.log(
      `Restoration batch ${summary.batchId}: queued ${queued} of ${eligible.length} on ${destination.name}`,
    );
    return { ...summary, queued };
  }

  /** FL-961: Frameleaf Cloud's own estimate of the batch, or the plain reason it cannot take it. */
  private async quoteCloud(
    auth: AuthDto,
    photoOperation: RestorationPhotoOperation,
    eligible: RestorationSource[],
    destinations: AssetRestorationBatchResponseDto['destinations'],
  ) {
    const cloud = destinations.find((row) => row.kind === MlDestinationKind.FrameleafCloud && row.available);
    if (!cloud) {
      return;
    }
    const quote =
      eligible.length > 0
        ? await this.cloudMlJobService.quotePhotoBatch(
            auth,
            photoOperation,
            eligible.map(({ id }) => id),
            cloud.id,
          )
        : { refusal: 'None of these photos can be sent' };
    if ('refusal' in quote) {
      cloud.available = false;
      cloud.refusal = MlAdmissionRefusal.WorkloadNotServed;
      cloud.refusalDetail = quote.refusal;
      return;
    }
    cloud.costUsd = quote.p50Usd;
    cloud.maxCostUsd = quote.p90Usd;
    cloud.consentVersion = quote.consentVersion;
    cloud.consentSummary = quote.consentSummary;
  }

  /** Why a photo stays out of a batch, or null after adding it to `eligible`. */
  private async batchSkipReason(
    assetId: string,
    photoOperation: RestorationPhotoOperation,
    eligible: RestorationSource[],
    allowHandTinted: boolean,
    tinted: { count: number },
  ): Promise<string | null> {
    let source: RestorationSource;
    try {
      source = await this.requireSource(assetId);
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) {
        return 'unavailable';
      }
      throw error;
    }
    if (source.sourceType !== AssetRestorationSourceType.Image) {
      return 'not-a-photo';
    }
    if (photoOperation === 'colourise') {
      const refusal = await this.colourRefusal(assetId);
      if (refusal === HAND_TINTED) {
        tinted.count++;
      }
      if (refusal && !(refusal === HAND_TINTED && allowHandTinted)) {
        return colourRefusalReason(refusal);
      }
    }
    eligible.push(source);
    return null;
  }

  /** Every destination, in the order this work follows (Local, Desktops, Cloud unless reordered). */
  private async batchDestinations(
    photoOperation: RestorationPhotoOperation,
    sources: RestorationSource[],
  ): Promise<AssetRestorationBatchResponseDto['destinations']> {
    const workload = MlWorkload.RestorationFaithful;
    const [rows, order, routing] = await Promise.all([
      this.mlDestinationRepository.getAll(),
      this.mlDestinationRepository.getProcessingOrder(),
      this.routing(),
    ]);
    const places: MlProcessingSource[] = sourcesFor(order, workload);
    const rank = (kind: MlDestinationKind) => {
      const index = places.indexOf(KIND_SOURCE[kind]);
      return index === -1 ? places.length : index;
    };
    const ordered = [...rows].sort((a, b) => rank(a.kind) - rank(b.kind));
    const choices = await readCloudModelChoices(this.mlDestinationRepository, rows);
    const since = windowStart(ESTIMATE_WINDOW_DAYS);
    const bytes = sources.reduce((sum, source) => sum + source.sizeBytes, 0);

    const destinations: AssetRestorationBatchResponseDto['destinations'] = [];
    for (const row of ordered) {
      let verdict = storedAdmission({
        destination: row,
        // Frameleaf Cloud runs these on its upscale workload and answers for them at the estimate
        workload: row.kind === MlDestinationKind.FrameleafCloud ? MlWorkload.Upscale : workload,
        spentUsd:
          row.budgetLimitUsd === null
            ? 0
            : await this.mlDestinationRepository.getSpend(row.id, windowStart(ML_BUDGET_WINDOW_DAYS)),
        choices,
        ...(row.kind !== MlDestinationKind.FrameleafCloud && { photoOperation }),
      });
      if (verdict.admitted && routing.upscale === 'cloud' && row.kind !== MlDestinationKind.FrameleafCloud) {
        verdict = { admitted: false, refusal: MlAdmissionRefusal.WorkloadNotAllowed, detail: CLOUD_ONLY_DETAIL };
      }
      if (verdict.admitted && row.kind !== MlDestinationKind.FrameleafCloud) {
        const conflict = await restorationRoleConflict(
          {
            mlDestinationRepository: this.mlDestinationRepository,
            machineLearningRepository: this.machineLearningRepository,
          },
          row,
          workload,
        );
        if (conflict) {
          verdict = { admitted: false, refusal: MlAdmissionRefusal.RoleConflict, detail: conflict };
        }
      }
      const sample = await this.mlDestinationRepository.getThroughput(row.id, since, workload);
      destinations.push({
        id: row.id,
        kind: row.kind,
        name: row.name,
        available: verdict.admitted,
        refusal: verdict.admitted ? null : verdict.refusal,
        refusalDetail: verdict.admitted ? null : verdict.detail,
        leavesNetwork: isCloudDestination(row.kind),
        estimateSeconds: restorationEstimate(sample, { preview: 0, full: bytes }, ESTIMATE_WINDOW_DAYS).fullSeconds,
        // Never guessed: home work is free, and Frameleaf Cloud's comes only from its own estimate.
        costUsd: null,
        maxCostUsd: null,
        consentVersion: null,
        consentSummary: null,
      });
    }
    return destinations;
  }

  /** One photo of a batch as a full render, with no preview. False when this batch already queued it. */
  private async queueBatchItem(
    auth: AuthDto,
    batchId: string,
    photoOperation: RestorationPhotoOperation,
    source: RestorationSource,
    destination: MlDestinationRow,
    allowHandTinted: boolean,
  ): Promise<boolean> {
    const output = { width: source.width, height: source.height };
    const sample = await this.mlDestinationRepository.getThroughput(
      destination.id,
      windowStart(ESTIMATE_WINDOW_DAYS),
      MlWorkload.RestorationFaithful,
    );
    const estimate = restorationEstimate(
      sample,
      this.inputBytes(source, DEFAULT_RESTORATION_REGION),
      ESTIMATE_WINDOW_DAYS,
    );
    try {
      await this.operationRepository.createWithin(
        async (trx) => {
          if (await this.restorationRepository.hasBatchItem(batchId, source.id, trx)) {
            throw new BatchItemAlreadyQueued();
          }
          const restoration = await this.restorationRepository.create(
            {
              assetId: source.id,
              ownerId: source.ownerId,
              status: AssetRestorationStatus.Accepted,
              mode: AssetRestorationMode.Faithful,
              upscale: 1,
              keepGrain: false,
              workload: MlWorkload.RestorationFaithful,
              destinationId: destination.id,
              destinationKind: destination.kind,
              destinationName: destination.name,
              sourceType: source.sourceType,
              sourceChecksum: source.checksum,
              sourceWidth: source.width,
              sourceHeight: source.height,
              sourceDurationSeconds: null,
              previewRegion: DEFAULT_RESTORATION_REGION,
              estimate,
              reviewedAt: new Date(),
              provenance: {
                requestedBy: auth.user.id,
                sessionElevated: !!auth.session?.hasElevatedPermission,
                operation: photoOperation,
                batchId,
                ...(allowHandTinted && { allowHandTinted: true }),
              },
            },
            trx,
          );
          return {
            operation: {
              ownerId: source.ownerId,
              kind: MediaOperationKind.Restoration,
              destination: mediaOperationDestinationOf(destination.kind),
              destinationDetail: destination.name,
              label: source.originalFileName,
              assetId: source.id,
              resultAssetId: null,
              retryOfId: null,
              projectId: null,
              revisionId: restoration.id,
              snapshot: this.snapshotOf(restoration, source, 'full', output),
              settings: this.settingsOf(restoration, destination.name, false),
              estimate:
                estimate.fullSeconds === null
                  ? null
                  : { seconds: estimate.fullSeconds, sizeBytes: null, cloudCost: null },
            },
            value: restoration,
          };
        },
        async (trx, operation, restoration) => {
          const updated = await this.restorationRepository.transition(
            restoration.id,
            [AssetRestorationStatus.Accepted],
            { status: AssetRestorationStatus.Accepted, fullOperationId: operation.id },
            trx,
            { stage: 'full', id: null },
          );
          if (!updated) throw new ConflictException('This restoration was already decided');
        },
      );
      return true;
    } catch (error) {
      if (error instanceof BatchItemAlreadyQueued) {
        return false;
      }
      throw error;
    }
  }

  /**
   * FL-955: why this photo cannot get suggested colours, or null when it can (sepia counts). The same
   * rule as the worker. A photo that cannot be read is refused too, rather than guessed at.
   */
  private async colourRefusal(assetId: string, allowHandTinted = false): Promise<string | null> {
    const asset = await this.assetRepository.getById(assetId, { files: true });
    return photoColourRefusal(this.mediaRepository, this.logger, assetId, asset?.files ?? [], allowHandTinted);
  }

  /**
   * Accept the reviewed preview: the full render is bound to exactly what was previewed. The
   * source must still be the file the preview was made from, the destination must still exist
   * and must still admit the workload — consent revoked since the preview is a refusal here too.
   */
  async accept(auth: AuthDto, assetId: string, restorationId: string): Promise<AssetRestorationResponseDto> {
    await requireAccess(this.accessRepository, { auth, permission: Permission.AssetEditCreate, ids: [assetId] });
    const restoration = await this.requireOwned(auth, assetId, restorationId);
    if (!canAcceptRestoration(restoration.status as AssetRestorationStatus)) {
      throw new BadRequestException('Only a preview that is ready for review can be accepted');
    }
    const source = await this.requireSource(assetId);
    if (Buffer.compare(source.checksum, restoration.sourceChecksum) !== 0) {
      throw new ConflictException('The original has changed since this preview was made; request a new preview');
    }
    if (!restoration.destinationId) {
      throw new BadRequestException('The destination this preview ran on has been removed; request a new preview');
    }
    const photoOperation = photoOperationOf(restoration.provenance);
    await this.refuseCloudRequest(restoration.destinationId, photoOperation);

    await this.admitRestoration(
      restoration.workload as MlWorkload,
      restoration.destinationId,
      MediaOperationKind.Restoration,
      photoOperation,
    );
    const destination = await this.requireDestination(restoration.destinationId);
    // FL-955: a photo operation keeps the photo's own size, above 4K included.
    const output = photoOperation
      ? { width: restoration.sourceWidth, height: restoration.sourceHeight }
      : cappedOutputSize(
          restoration.sourceWidth,
          restoration.sourceHeight,
          restoration.mode === AssetRestorationMode.SmoothMotion ? 1 : restoration.upscale,
        );
    const sample = await this.mlDestinationRepository.getThroughput(
      destination.id,
      windowStart(ESTIMATE_WINDOW_DAYS),
      restoration.workload as MlWorkload,
    );
    const estimate = restorationEstimate(
      sample,
      this.inputBytes(source, asRegion(restoration.previewRegion)),
      ESTIMATE_WINDOW_DAYS,
    );

    let accepted = restoration;
    const { operation } = await this.operationRepository.createWithin(
      () =>
        Promise.resolve({
          operation: {
            ownerId: restoration.ownerId,
            kind: MediaOperationKind.Restoration,
            destination: mediaOperationDestinationOf(destination.kind),
            destinationDetail: destination.name,
            label: source.originalFileName,
            assetId,
            resultAssetId: null,
            retryOfId: null,
            projectId: null,
            revisionId: restoration.id,
            snapshot: this.snapshotOf(restoration, source, 'full', output),
            settings: this.settingsOf(restoration, destination.name, false),
            estimate:
              estimate.fullSeconds === null
                ? null
                : { seconds: estimate.fullSeconds, sizeBytes: null, cloudCost: null },
          },
          value: null,
        }),
      async (trx, operation) => {
        const now = new Date();
        const updated = await this.restorationRepository.transition(
          restoration.id,
          [AssetRestorationStatus.PreviewReady],
          {
            status: AssetRestorationStatus.Accepted,
            fullOperationId: operation.id,
            reviewedAt: now,
            previewExpiresAt: previewExpiryAfterDecision(now),
            estimate,
            error: null,
          },
          trx,
        );
        if (!updated) throw new ConflictException('This restoration was already decided');
        accepted = updated;
      },
    );
    this.logger.log(`Restoration ${restoration.id} accepted; full render queued as operation ${operation.id}`);
    return this.toDto(accepted);
  }

  /** Reject the preview. Its files stay for a short while so the decision can be revisited, then go. */
  async reject(auth: AuthDto, assetId: string, restorationId: string): Promise<AssetRestorationResponseDto> {
    await requireAccess(this.accessRepository, { auth, permission: Permission.AssetEditCreate, ids: [assetId] });
    const restoration = await this.requireOwned(auth, assetId, restorationId);
    if (!canRejectRestoration(restoration.status as AssetRestorationStatus)) {
      throw new BadRequestException('Only a preview that is ready for review can be rejected');
    }
    const now = new Date();
    const rejected = await this.restorationRepository.transition(
      restoration.id,
      [AssetRestorationStatus.PreviewReady],
      {
        status: AssetRestorationStatus.Rejected,
        reviewedAt: now,
        previewExpiresAt: previewExpiryAfterDecision(now),
      },
    );
    if (!rejected) {
      throw new ConflictException('This restoration was already decided');
    }
    return this.toDto(rejected);
  }

  /**
   * Discard a restoration: cancel anything still running, drop it as the playback version if it
   * was one, and remove every file it produced. The row stays as history with its paths cleared.
   */
  async discard(auth: AuthDto, assetId: string, restorationId: string): Promise<void> {
    await requireAccess(this.accessRepository, { auth, permission: Permission.AssetEditCreate, ids: [assetId] });
    const restoration = await this.requireOwned(auth, assetId, restorationId);
    const status = restoration.status as AssetRestorationStatus;
    if (!canDiscardRestoration(status)) {
      return;
    }

    const activeOperationId = this.activeOperationId(restoration);
    if (activeOperationId) {
      await this.operationRepository.requestCancel(activeOperationId, restoration.ownerId);
    }
    const discarded = await this.restorationRepository.discard(restoration.id);
    if (!discarded) return;
    const currentOperationId = this.activeOperationId(discarded);
    if (currentOperationId && currentOperationId !== activeOperationId) {
      await this.operationRepository.requestCancel(currentOperationId, discarded.ownerId);
    }

    const files = [
      discarded.previewBeforePath,
      discarded.previewAfterPath,
      discarded.resultPath,
      discarded.resultPreviewPath,
    ].filter((file): file is string => !!file);
    if (files.length > 0) {
      await this.jobRepository.queue({ name: JobName.FileDelete, data: { files } });
    }
    await this.storageRepository
      .unlinkDir(
        restorationWorkDir(
          StorageCore.getNestedFolder(StorageFolder.Thumbnails, restoration.ownerId, assetId),
          restoration.id,
        ),
        {
          recursive: true,
          force: true,
        },
      )
      .catch(() => {});
  }

  /**
   * Choose which version the asset plays back: a restored result, or the original. Explicit and
   * reversible; a finished job never makes this choice on the owner's behalf.
   */
  async setCurrent(
    auth: AuthDto,
    assetId: string,
    dto: AssetRestorationSelectDto,
  ): Promise<AssetRestorationListResponseDto> {
    await requireAccess(this.accessRepository, { auth, permission: Permission.AssetEditCreate, ids: [assetId] });
    if (dto.restorationId) {
      const restoration = await this.requireOwned(auth, assetId, dto.restorationId);
      if (!canSelectRestoration(restoration.status as AssetRestorationStatus) || !restoration.resultPath) {
        throw new BadRequestException('Only a finished restoration can be used as the playback version');
      }
    }
    await this.restorationRepository.setCurrent(assetId, dto.restorationId ?? null);
    return this.toList(assetId);
  }

  async getFile(
    auth: AuthDto,
    assetId: string,
    restorationId: string,
    kind: AssetRestorationFileKind,
  ): Promise<FileDownloadResponse> {
    await requireAccess(this.accessRepository, { auth, permission: Permission.AssetEditGet, ids: [assetId] });
    const restoration = await this.requireOwned(auth, assetId, restorationId);
    const filePath = this.fileFor(restoration, kind);
    if (!filePath) {
      throw new NotFoundException('This restoration file does not exist');
    }
    return new FileDownloadResponse({
      path: filePath,
      contentType: mimeTypes.lookup(filePath),
      cacheControl: CacheControl.PrivateWithCache,
    });
  }

  /**
   * The owner's chosen playback version (FL-115). `Use for playback` is explicit and owner-only:
   * the restored file replaces what the owner's own sessions play or view, and nobody else's — a
   * partner, a shared space or a shared link always gets the ordinary version, because an AI result
   * is the owner's derived data and choosing it never publishes it. Thumbnails and the original
   * download are never replaced. While the owner has a finished result to switch to, both versions
   * are served for revalidation rather than from a day-long cache. That cannot reach a response the
   * browser cached before the result existed (a day plus stale-while-revalidate), so the web viewer
   * also gives the video, preview and full-size URLs a fresh cache key when the choice changes
   * (web/src/lib/frameleaf/playback-revision.svelte.ts).
   *
   * `view` is what the caller serves: video playback, or a photo's preview or full-size view.
   *
   * FL-161: through the relay a full-size restored result is as large as an original. The caller says
   * whether full-size files may be sent (`fullSizeAllowed`, false through the relay unless an
   * administrator allowed originals there); when not, the restored preview is served instead.
   */
  async getPlaybackChoice(
    auth: AuthDto,
    assetId: string,
    view: 'video' | 'preview' | 'fullsize',
    fullSizeAllowed = true,
  ): Promise<{ file: FileDownloadResponse | null; revalidate: boolean }> {
    if (auth.sharedLink) {
      return { file: null, revalidate: false };
    }
    await requireAccess(this.accessRepository, { auth, permission: Permission.AssetView, ids: [assetId] });
    const sourceType = view === 'video' ? AssetRestorationSourceType.Video : AssetRestorationSourceType.Image;
    const restored = (await this.restorationRepository.listRestoredForPlayback(assetId, auth.user.id)).filter(
      (row) => row.sourceType === sourceType,
    );
    if (restored.length === 0) {
      return { file: null, revalidate: false };
    }
    const current = restored.find((row) => row.isCurrent);
    const served = view === 'fullsize' && !fullSizeAllowed ? 'preview' : view;
    const path = current && (served === 'preview' ? current.resultPreviewPath : current.resultPath);
    if (!path) {
      return { file: null, revalidate: true };
    }
    return {
      file: new FileDownloadResponse({
        path,
        contentType: mimeTypes.lookup(path),
        cacheControl: CacheControl.PrivateWithoutCache,
      }),
      revalidate: true,
    };
  }

  /**
   * Rows and files go with the asset; the original was never ours to delete. The rows cascade with the
   * asset row, so a permanent deletion releases the files inside its removal (FL-169); this only
   * catches rows another removal left behind.
   */
  @OnEvent({ name: 'AssetDelete' })
  async onAssetDelete({ assetId }: ArgOf<'AssetDelete'>) {
    const files = await this.restorationRepository.getFilePaths(assetId);
    await this.restorationRepository.deleteByAsset(assetId);
    if (files.length > 0) {
      await this.jobRepository.queue({ name: JobName.FileDelete, data: { files } });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                           */
  /* ------------------------------------------------------------------ */

  private async requireOwned(auth: AuthDto, assetId: string, restorationId: string): Promise<AssetRestoration> {
    const restoration = await this.restorationRepository.getForOwner(restorationId, assetId, auth.user.id);
    if (!restoration) {
      // Somebody else's restoration and one that never existed give the same answer on purpose.
      throw new NotFoundException('Restoration not found');
    }
    return restoration;
  }

  /**
   * FL-162: work on Frameleaf Cloud is estimated and confirmed as a cloud job (`POST /cloud/ml/jobs`),
   * with its price and consent shown first. This request path never sends anything to the cloud.
   */
  private async refuseCloudRequest(destinationId: string, photoOperation?: RestorationPhotoOperation) {
    const destination = await this.mlDestinationRepository.getById(destinationId);
    if (destination?.kind === MlDestinationKind.FrameleafCloud) {
      if (photoOperation) {
        throw new BadRequestException(
          `Frameleaf Cloud does not offer ${photoOperationLabel(photoOperation)} yet; nothing was sent.`,
        );
      }
      throw new BadRequestException(
        'Frameleaf Cloud work is estimated and confirmed first; nothing was sent. Use the Frameleaf Cloud estimate.',
      );
    }
  }

  /** Where each job runs: Local only, Both or Cloud only for each kind of work (FL-159, FL-162). */
  private async routing() {
    const config = await getConfig(
      { configRepo: this.configRepository, metadataRepo: this.systemMetadataRepository, logger: this.logger },
      { withCache: true },
    );
    return liveCloudRouting(config.frameleafCloud.cloudMl);
  }

  private async requireDestination(id: string): Promise<MlDestinationRow> {
    const destination = await this.mlDestinationRepository.getById(id);
    if (!destination) {
      throw new NotFoundException(`Machine learning destination ${id} does not exist`);
    }
    return destination;
  }

  /**
   * The asset as a restoration source. Stills and videos both qualify; what does not is anything
   * whose original cannot be read exactly (offline), or media whose edit is not meaningful here.
   */
  private async requireSource(assetId: string): Promise<RestorationSource> {
    const asset = await this.assetRepository.getById(assetId, { exifInfo: true });
    if (!asset) {
      throw new NotFoundException('Asset not found');
    }
    if (asset.type !== AssetType.Image && asset.type !== AssetType.Video) {
      throw new BadRequestException('Only photos and videos can be restored');
    }
    if (asset.isOffline) {
      throw new BadRequestException('The original file is offline and cannot be restored');
    }
    if (asset.exifInfo?.projectionType === 'EQUIRECTANGULAR') {
      throw new BadRequestException('Restoring panorama media is not supported');
    }
    const name = asset.originalFileName.toLowerCase();
    if (name.endsWith('.gif') || name.endsWith('.svg')) {
      throw new BadRequestException('Restoring GIF and SVG images is not supported');
    }

    const exif = asset.exifInfo;
    let width = Number(exif?.exifImageWidth ?? 0);
    let height = Number(exif?.exifImageHeight ?? 0);
    if (['5', '6', '7', '8'].includes(exif?.orientation ?? '')) {
      [width, height] = [height, width];
    }
    if (!(width > 0 && height > 0)) {
      throw new BadRequestException('The dimensions of this file are not known yet; run metadata extraction first');
    }
    const sourceType =
      asset.type === AssetType.Video ? AssetRestorationSourceType.Video : AssetRestorationSourceType.Image;
    const durationSeconds =
      sourceType === AssetRestorationSourceType.Video ? parseDurationSeconds(asset.duration) : null;
    if (sourceType === AssetRestorationSourceType.Video && durationSeconds === null) {
      throw new BadRequestException('The length of this video is not known yet; run metadata extraction first');
    }

    return {
      id: asset.id,
      ownerId: asset.ownerId,
      type: asset.type,
      originalFileName: asset.originalFileName,
      originalPath: asset.originalPath,
      checksum: asset.checksum,
      sourceType,
      width,
      height,
      durationSeconds,
      sizeBytes: Number(exif?.fileSizeInByte ?? 0),
    };
  }

  /**
   * Admit a restoration request up front: refused when the destination is the library-analysis
   * pod, still allows library work or shares an endpoint a library route uses (FL-72), and then
   * by the ordinary admission (consent, allow-list, budget, live health). Nothing is moved.
   */
  private async admitRestoration(
    workload: MlWorkload,
    destinationId: string,
    jobName: MediaOperationKind,
    photoOperation?: RestorationPhotoOperation,
  ) {
    const deps = {
      mlDestinationRepository: this.mlDestinationRepository,
      machineLearningRepository: this.machineLearningRepository,
    };
    const row = await this.mlDestinationRepository.getById(destinationId);
    if (row) {
      const conflict = await restorationRoleConflict(deps, row, workload);
      if (conflict) {
        throw new MlDestinationRefusedError(MlAdmissionRefusal.RoleConflict, workload, row.id, conflict);
      }
    }
    await selectMlDestination(deps, { workload, destinationId, jobName, ...(photoOperation && { photoOperation }) });
  }

  private inputBytes(source: RestorationSource, region: AssetRestorationRegion) {
    return {
      preview: previewInputBytes(
        source.sizeBytes,
        region,
        source.width,
        source.height,
        source.sourceType,
        source.durationSeconds,
      ),
      full: source.sizeBytes,
    };
  }

  private snapshotOf(
    restoration: AssetRestoration,
    source: RestorationSource,
    stage: RestorationSnapshot['stage'],
    output: { width: number; height: number },
    /** FL-423: the model the person chose for a preview; a full render is bound to the reviewed one. */
    modelId?: string,
  ): RestorationSnapshot {
    const smooth = restoration.mode === AssetRestorationMode.SmoothMotion;
    const photoOperation = photoOperationOf(restoration.provenance);
    return {
      version: 1,
      stage,
      restorationId: restoration.id,
      assetId: restoration.assetId,
      ownerId: restoration.ownerId,
      sourceType: restoration.sourceType as AssetRestorationSourceType,
      sourceChecksumHex: Buffer.from(restoration.sourceChecksum).toString('hex'),
      sourceWidth: restoration.sourceWidth,
      sourceHeight: restoration.sourceHeight,
      sourceDurationSeconds: restoration.sourceDurationSeconds ?? source.durationSeconds,
      mode: restoration.mode as AssetRestorationMode,
      upscale: smooth ? 1 : (restoration.upscale as 1 | 2 | 4),
      ...(smooth && isSmoothMotionFactor(restoration.upscale) && { interpolationFactor: restoration.upscale }),
      keepGrain: restoration.keepGrain,
      workload: restoration.workload as MlWorkload,
      destinationId: restoration.destinationId as string,
      destinationKind: restoration.destinationKind as MlDestinationKind,
      region: asRegion(restoration.previewRegion),
      output,
      // FL-115: the full render is bound to the model the reviewed preview ran.
      ...(stage === 'full' &&
        restoration.modelName && { model: { name: restoration.modelName, version: restoration.modelVersion } }),
      ...(stage === 'preview' && modelId && { modelId }),
      ...(photoOperation && { operation: photoOperation }),
      ...((restoration.provenance as { allowHandTinted?: boolean } | null)?.allowHandTinted === true && {
        allowHandTinted: true,
      }),
    };
  }

  /** What Activity shows under the job title. Customer words, not enum values. */
  private settingsOf(restoration: AssetRestoration, destinationName: string, preview: boolean) {
    const photoOperation = photoOperationOf(restoration.provenance);
    return {
      mode: photoOperation
        ? photoOperationLabel(photoOperation)
        : restorationModeLabel(restoration.mode as AssetRestorationMode),
      upscale: restoration.upscale,
      preview,
      destination: destinationName,
    };
  }

  private activeOperationId(restoration: AssetRestoration): string | null {
    const status = restoration.status as AssetRestorationStatus;
    if (!isActiveRestoration(status)) {
      return null;
    }
    return status === AssetRestorationStatus.Accepted || status === AssetRestorationStatus.Restoring
      ? restoration.fullOperationId
      : restoration.previewOperationId;
  }

  private fileFor(restoration: AssetRestoration, kind: AssetRestorationFileKind): string | null {
    switch (kind) {
      case AssetRestorationFileKind.Before: {
        return restoration.previewBeforePath;
      }
      case AssetRestorationFileKind.After: {
        return restoration.previewAfterPath;
      }
      case AssetRestorationFileKind.Result: {
        return restoration.status === AssetRestorationStatus.Restored ? restoration.resultPath : null;
      }
      case AssetRestorationFileKind.ResultPreview: {
        return restoration.status === AssetRestorationStatus.Restored ? restoration.resultPreviewPath : null;
      }
    }
  }

  private async toList(assetId: string): Promise<AssetRestorationListResponseDto> {
    const rows = await this.restorationRepository.listByAsset(assetId);
    return {
      assetId,
      currentRestorationId: rows.find((row) => row.isCurrent)?.id ?? null,
      items: rows.map((row) => this.toDto(row)),
    };
  }

  private toDto(row: AssetRestoration): AssetRestorationResponseDto {
    const status = row.status as AssetRestorationStatus;
    const photoOperation = photoOperationOf(row.provenance);
    return {
      id: row.id,
      assetId: row.assetId,
      revision: row.revision,
      status,
      mode: row.mode as AssetRestorationMode,
      // FL-162: a Smooth motion version keeps its frame-rate factor where a restoration keeps its upscale
      upscale: row.mode === AssetRestorationMode.SmoothMotion ? 1 : row.upscale,
      smoothMotionFactor: row.mode === AssetRestorationMode.SmoothMotion ? row.upscale : null,
      keepGrain: row.keepGrain,
      workload: row.workload as MlWorkload,
      destinationId: row.destinationId,
      destinationKind: row.destinationKind as MlDestinationKind,
      destinationName: row.destinationName,
      sourceType: row.sourceType as AssetRestorationSourceType,
      sourceWidth: row.sourceWidth,
      sourceHeight: row.sourceHeight,
      sourceDurationSeconds: row.sourceDurationSeconds,
      previewRegion: asRegion(row.previewRegion),
      previewOperationId: row.previewOperationId,
      fullOperationId: row.fullOperationId,
      activeOperationId: this.activeOperationId(row),
      hasPreview: !!row.previewBeforePath && !!row.previewAfterPath,
      hasResult: status === AssetRestorationStatus.Restored && !!row.resultPath,
      outputWidth: row.outputWidth,
      outputHeight: row.outputHeight,
      modelName: row.modelName,
      modelVersion: row.modelVersion,
      estimate: asEstimate(row.estimate),
      error: row.error,
      isCurrent: row.isCurrent,
      previewReadyAt: asIso(row.previewReadyAt as Date | null),
      reviewedAt: asIso(row.reviewedAt as Date | null),
      restoredAt: asIso(row.restoredAt as Date | null),
      previewExpiresAt: asIso(row.previewExpiresAt as Date | null),
      resultExpiresAt: asIso(row.resultExpiresAt as Date | null),
      createdAt: asDateTimeString(row.createdAt as Date),
      updatedAt: asDateTimeString(row.updatedAt as Date),
      // FL-955: only on repair and colourise rows, so an enhance response is what it always was
      ...(photoOperation && { operation: photoOperation as AssetRestorationOperation }),
    };
  }
}
