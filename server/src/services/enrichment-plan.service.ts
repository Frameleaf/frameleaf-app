import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { SystemConfig } from 'src/config.js';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { OnEvent } from 'src/decorators.js';
import {
  EnrichmentOptionsResponseDto,
  EnrichmentPlanCreateDto,
  EnrichmentPlanResponseDto,
  EnrichmentPreviewRequestDto,
  EnrichmentPreviewResponseDto,
} from 'src/dtos/enrichment.dto.js';
import { MediaOperationDto } from 'src/dtos/media-operation.dto.js';
import {
  AssetType,
  EnrichmentItemState,
  EnrichmentPreviewStatus,
  EnrichmentStage,
  ImmichWorker,
  JobStatus,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  MlAdmissionRefusal,
  MlDestinationKind,
  MlWorkload,
  Permission,
} from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import {
  MediaOperation,
  MediaOperationRepository,
  type MediaOperationWriteState,
} from 'src/repositories/media-operation.repository.js';
import { MlDestinationRepository, MlDestinationRow } from 'src/repositories/ml-destination.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { VideoMomentRepository } from 'src/repositories/video-moment.repository.js';
import {
  EnrichmentRunOptions,
  EnrichmentStageResult,
  ImageEnrichmentService,
} from 'src/services/image-enrichment.service.js';
import { mapOperation } from 'src/services/media-operation.service.js';
import { MomentStageOutcome, VideoMomentIndexService } from 'src/services/video-moment-index.service.js';
import { checkAccess, requireAccess } from 'src/utils/access.js';
import { getConfig } from 'src/utils/config.js';
import {
  DEFAULT_ENRICHMENT_STAGES,
  ENRICHMENT_PLAN_MAX_ASSETS,
  ENRICHMENT_PREVIEW_MAX_SAMPLES,
  ENRICHMENT_STAGE_REQUIRES,
  EnrichmentPinnedConfig,
  EnrichmentPlanItem,
  EnrichmentPlanResult,
  EnrichmentPlanSnapshot,
  VIDEO_MOMENT_FRAME_COUNT,
  countEnrichmentItems,
  emptyEnrichmentPlanResult,
  enrichmentConfigHash,
  enrichmentItemStates,
  enrichmentPlanLabel,
  enrichmentPlanProgress,
  mergeEnrichmentItem,
  parseEnrichmentPlanResult,
  parseEnrichmentPlanSnapshot,
  planEnrichmentRetryPass,
  resolveEnrichmentStages,
  stageAppliesTo,
  stagesToRetry,
} from 'src/utils/enrichment-plan.js';
import { getLockedOwnerId } from 'src/utils/locked.js';
import { MEDIA_OPERATION_AUTO_RETRY_DELAY_MS } from 'src/utils/media-operation.js';
import { isImageDescriptionEnabled, isNsfwDetectionEnabled, isSmartSearchEnabled } from 'src/utils/misc.js';
import {
  CloudModelChoices,
  isCloudDestination,
  readCloudModelChoices,
  storedAdmission,
} from 'src/utils/ml-destination.js';

/** How often the worker looks for queued plans. */
export const ENRICHMENT_PLAN_TICK_MS = 5000;
/**
 * The claim lease, renewed after every stage. A video's captions are six model requests, so the
 * lease is long enough for the slowest stage of one asset, not for the plan.
 */
export const ENRICHMENT_PLAN_LEASE_MS = 10 * 60_000;

/** Stages that send requests to the description and classification workload. */
const ENRICHMENT_WORKLOAD_STAGES: ReadonlySet<EnrichmentStage> = new Set([
  EnrichmentStage.LockedCheck,
  EnrichmentStage.Description,
  EnrichmentStage.MomentCaptions,
]);

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const toState = (status: JobStatus): EnrichmentItemState => {
  switch (status) {
    case JobStatus.Success: {
      return EnrichmentItemState.Completed;
    }
    case JobStatus.Failed: {
      return EnrichmentItemState.Failed;
    }
    default: {
      return EnrichmentItemState.Skipped;
    }
  }
};

const toOperationDestination = (kind: MlDestinationKind | undefined): MediaOperationDestination => {
  switch (kind) {
    case MlDestinationKind.Lan: {
      return MediaOperationDestination.Lan;
    }
    // FL-72, FL-159: the cloud destination is never labelled local.
    case MlDestinationKind.FrameleafCloud: {
      return MediaOperationDestination.FrameleafCloud;
    }
    default: {
      return MediaOperationDestination.Local;
    }
  }
};

/** Refusals at submit that describe a passing state; the plan is still queued and admitted per request. */
const TRANSIENT_REFUSALS: ReadonlySet<MlAdmissionRefusal> = new Set([
  MlAdmissionRefusal.DestinationUnhealthy,
  MlAdmissionRefusal.EndpointUnresolved,
  MlAdmissionRefusal.WorkloadNotServed,
]);

/** What one claimed run carries from asset to asset. */
type PlanRun = {
  id: string;
  claimToken: string;
  ownerId: string;
  auth: AuthDto;
  snapshot: EnrichmentPlanSnapshot;
  total: number;
};

/**
 * Sample-first enrichment and durable enrichment plans (FL-59, `REC-101`).
 *
 * - **Preview** runs a draft model or prompt on a few samples, one at a time, and writes nothing.
 * - **A plan** is a `media_operation` of kind `enrichment_plan` over a frozen set of assets. It pins,
 *   at submit, the stages (and the ones they need), the destinations (FL-110: named, never swapped
 *   for another) and the saved model, prompt and search configuration, and records per asset and
 *   per stage what happened. It survives the browser closing and the server restarting; the
 *   workbench reads it back from the row, so a reload shows the same states.
 * - **The worker** claims plans on the microservices worker and works one asset at a time — one
 *   model request in flight per plan, so a plan cannot flood a destination — writing the result
 *   after every asset. Cancel and pause are honoured between assets. Every failure gets one
 *   automatic retry, and a retry only runs the stages that failed, so no asset's work is applied
 *   twice. Locked assets are processed like any other: backend work may reach them, and only
 *   their owner's unlocked session is ever shown them.
 */
@Injectable()
export class EnrichmentPlanService {
  private tickHandle?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private stopping = false;
  private readonly workerId = `enrichment-${randomUUID()}`;
  /** Stands in for a session on the worker's auth; nothing on these paths reads it back. */
  private readonly sessionId = randomUUID();

  constructor(
    private logger: LoggingRepository,
    private operations: MediaOperationRepository,
    private access: AccessRepository,
    private users: UserRepository,
    private enrichment: ImageEnrichmentService,
    private moments: VideoMomentIndexService,
    private momentRepository: VideoMomentRepository,
    private mlDestinations: MlDestinationRepository,
    private machineLearning: MachineLearningRepository,
    private configRepository: ConfigRepository,
    private systemMetadata: SystemMetadataRepository,
  ) {
    this.logger.setContext(EnrichmentPlanService.name);
  }

  /* ------------------------------------------------------------------ */
  /* Options and preview                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * What the workbench may choose from: every destination with whether it would take each
   * workload now (from its persisted probe, so this page and Processing destinations agree), the
   * routes, and the saved models. Destinations are named, never located: no URL or credential.
   */
  async getOptions(): Promise<EnrichmentOptionsResponseDto> {
    const { machineLearning } = await this.config();
    const [rows, routes] = await Promise.all([this.mlDestinations.getAll(), this.mlDestinations.getRoutes()]);
    // FL-186: a Frameleaf Cloud destination is judged with the model an administrator chose
    const choices = await readCloudModelChoices(this.mlDestinations, rows);

    const destinations: EnrichmentOptionsResponseDto['destinations'] = Array.from(rows, (row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      cloud: isCloudDestination(row.kind),
      health: row.lastProbeHealth,
      enrichment: this.admission(row, MlWorkload.Enrichment, choices),
      search: this.admission(row, MlWorkload.Clip, choices),
    }));

    return {
      destinations,
      routes: {
        enrichment: routes.find(({ workload }) => workload === MlWorkload.Enrichment)?.destinationId ?? null,
        search: routes.find(({ workload }) => workload === MlWorkload.Clip)?.destinationId ?? null,
      },
      descriptionEnabled: isImageDescriptionEnabled(machineLearning),
      lockedCheckEnabled: isNsfwDetectionEnabled(machineLearning),
      searchEnabled: isSmartSearchEnabled(machineLearning),
      modelName: machineLearning.imageDescription.modelName,
      searchModelName: machineLearning.clip.modelName,
      defaultStages: [...DEFAULT_ENRICHMENT_STAGES],
      maxSamples: ENRICHMENT_PREVIEW_MAX_SAMPLES,
      maxAssets: ENRICHMENT_PLAN_MAX_ASSETS,
      framesPerVideo: VIDEO_MOMENT_FRAME_COUNT,
    };
  }

  /**
   * Describe a few samples with a draft model or prompt, one at a time, writing nothing: no
   * description, tag, Locked state, embedding or frame is changed (FL-59). The samples must be the
   * caller's own (a Locked one only in the unlocked session): a partner's or an album member's
   * media is never sent to a destination by somebody else's preview, least of all a cloud one.
   * The destination is the one named, or the routed one; a cloud destination still needs its
   * recorded consent.
   */
  async preview(auth: AuthDto, dto: EnrichmentPreviewRequestDto): Promise<EnrichmentPreviewResponseDto> {
    const assetIds = [...new Set(dto.assetIds)];
    await requireAccess(this.access, { auth, permission: Permission.AssetUpdate, ids: assetIds });

    const { machineLearning } = await this.config();
    const destinationId = dto.destinationId ?? (await this.routedDestinationId(MlWorkload.Enrichment));
    const destination = await this.requireDestination(destinationId, MlWorkload.Enrichment);

    const draft: SystemConfig['machineLearning']['imageDescription'] = {
      ...machineLearning.imageDescription,
      ...(dto.modelName && { modelName: dto.modelName }),
      ...(dto.fallbackModelName !== undefined && { fallbackModelName: dto.fallbackModelName }),
      ...(dto.prompt && { prompt: dto.prompt }),
    };

    const samples: EnrichmentPreviewResponseDto['samples'] = [];
    for (const assetId of assetIds) {
      const preview = await this.enrichment.previewDescription(assetId, { imageDescription: draft, destinationId });
      switch (preview.status) {
        case 'success': {
          samples.push({
            assetId,
            status: EnrichmentPreviewStatus.Success,
            current: preview.current,
            candidate: preview.candidate,
            tags: preview.tags,
            hallucinatedNames: preview.identityFlags?.hallucinatedNames ?? [],
            ambiguousReferences: preview.identityFlags?.ambiguousReferences ?? [],
            warnings: preview.warnings,
            frameCount: preview.frameCount,
            durationMs: preview.durationMs,
            reasonKey: null,
            message: null,
          });
          break;
        }
        case 'failed': {
          samples.push({
            ...this.emptySample(assetId, EnrichmentPreviewStatus.Failed),
            current: preview.current,
            warnings: preview.warnings,
            reasonKey: 'model-error',
            message: preview.message,
          });
          break;
        }
        default: {
          samples.push({ ...this.emptySample(assetId, EnrichmentPreviewStatus.Skipped), reasonKey: preview.reasonKey });
        }
      }
    }

    return {
      destinationId,
      destinationName: destination.name,
      cloud: isCloudDestination(destination.kind),
      modelName: draft.modelName,
      samples,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Plans                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Queue a plan over a frozen set of assets.
   *
   * Checked now, while the person is still looking: every asset is theirs to change (so a Locked
   * one needs the unlocked session), and every destination the chosen stages need exists, is
   * enabled, allows the workload and — for cloud — has recorded consent. A destination that is only
   * unhealthy right now is accepted; each request is admitted again when it is made, and refused in
   * place rather than moved elsewhere. Only an administrator may name a destination other than the
   * routed one. The saved model, prompt and search model are pinned into the plan.
   */
  async createPlan(auth: AuthDto, dto: EnrichmentPlanCreateDto): Promise<EnrichmentPlanResponseDto> {
    if (auth.sharedLink) {
      throw new ForbiddenException('Enrichment is not available on a shared link');
    }
    if ((dto.destinationId || dto.searchDestinationId) && !auth.user.isAdmin) {
      throw new ForbiddenException('Only an administrator can choose a processing destination');
    }

    if (dto.requestKey) {
      const existing = await this.operations.getByRequestKey(
        auth.user.id,
        MediaOperationKind.EnrichmentPlan,
        dto.requestKey,
      );
      if (existing) {
        return this.present(auth, existing);
      }
    }

    const assetIds = [...new Set(dto.assetIds)];
    await requireAccess(this.access, { auth, permission: Permission.AssetUpdate, ids: assetIds });

    const { stages } = resolveEnrichmentStages(dto.stages);
    if (stages.length === 0) {
      throw new BadRequestException('Choose at least one stage');
    }

    const { machineLearning } = await this.config();
    const needsEnrichment = stages.some((stage) => ENRICHMENT_WORKLOAD_STAGES.has(stage));
    const needsSearch =
      stages.includes(EnrichmentStage.MomentIndex) ||
      (stages.includes(EnrichmentStage.Description) && isSmartSearchEnabled(machineLearning));

    const enrichmentDestination = needsEnrichment
      ? await this.requireDestination(
          dto.destinationId ?? (await this.routedDestinationId(MlWorkload.Enrichment)),
          MlWorkload.Enrichment,
        )
      : null;
    const searchDestination = needsSearch
      ? await this.requireDestination(
          dto.searchDestinationId ?? (await this.routedDestinationId(MlWorkload.Clip)),
          MlWorkload.Clip,
        )
      : null;

    const config: EnrichmentPinnedConfig = {
      description: {
        modelName: machineLearning.imageDescription.modelName,
        fallbackModelName: machineLearning.imageDescription.fallbackModelName,
        device: machineLearning.imageDescription.device,
        acceleration: machineLearning.imageDescription.acceleration,
        prompt: machineLearning.imageDescription.prompt as unknown as Record<string, unknown>,
      },
      lockedCheck: {
        modelName: machineLearning.nsfwDetection.modelName,
        threshold: machineLearning.nsfwDetection.threshold,
        device: machineLearning.nsfwDetection.device,
      },
      search: { modelName: machineLearning.clip.modelName },
    };

    const snapshot: EnrichmentPlanSnapshot = {
      version: 1,
      assetIds,
      requestedStages: [...new Set(dto.stages)],
      stages,
      destinations: { enrichment: enrichmentDestination?.id ?? null, search: searchDestination?.id ?? null },
      config,
      configHash: enrichmentConfigHash(config),
      requestKey: dto.requestKey ?? null,
      elevated: auth.session?.hasElevatedPermission === true,
    };

    const primary = enrichmentDestination ?? searchDestination;
    const created = await this.createOnce(auth.user.id, dto.requestKey, {
      ownerId: auth.user.id,
      kind: MediaOperationKind.EnrichmentPlan,
      destination: toOperationDestination(primary?.kind),
      destinationDetail: primary?.name ?? null,
      label: enrichmentPlanLabel(assetIds.length),
      assetId: assetIds.length === 1 ? assetIds[0] : null,
      resultAssetId: null,
      retryOfId: null,
      projectId: null,
      revisionId: null,
      snapshot: snapshot as unknown as Record<string, unknown>,
      settings: {
        stages,
        captions: stages.includes(EnrichmentStage.MomentCaptions),
        model: config.description.modelName,
        searchModel: config.search.modelName,
        destination: enrichmentDestination?.name ?? null,
        searchDestination: searchDestination?.name ?? null,
      },
      estimate: null,
      result: emptyEnrichmentPlanResult() as unknown as Record<string, unknown>,
      totalUnits: String(assetIds.length),
    });

    this.logger.log(`Enrichment plan queued as media operation ${created.id} (${assetIds.length} items, ${stages})`);
    return this.present(auth, created);
  }

  /**
   * Insert a plan, answering a concurrent submit of the same idempotency key with the plan that won.
   * The unique index on (owner, request key) is what decides the race; the loser reads the winner.
   */
  private async createOnce(
    ownerId: string,
    requestKey: string | undefined,
    values: Parameters<MediaOperationRepository['create']>[0],
  ): Promise<MediaOperation> {
    try {
      return await this.operations.create(values);
    } catch (error) {
      if (requestKey) {
        const existing = await this.operations.getByRequestKey(ownerId, MediaOperationKind.EnrichmentPlan, requestKey);
        if (existing) {
          return existing;
        }
      }
      throw error;
    }
  }

  /**
   * One plan with every asset's state and every stage's outcome, from the durable row. The
   * caller's Locked assets are left out of the list unless their session is unlocked, and counted
   * in `hiddenCount` so the totals stay honest.
   */
  async getPlan(auth: AuthDto, id: string): Promise<EnrichmentPlanResponseDto> {
    const operation = await this.operations.getForOwner(id, auth.user.id);
    if (!operation || operation.kind !== MediaOperationKind.EnrichmentPlan) {
      throw new BadRequestException('Enrichment plan not found');
    }
    return this.present(auth, operation);
  }

  /* ------------------------------------------------------------------ */
  /* The worker                                                          */
  /* ------------------------------------------------------------------ */

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  onBootstrap() {
    this.stopping = false;
    this.tickHandle ??= setInterval(() => this.tick(), ENRICHMENT_PLAN_TICK_MS);
    this.tick();
  }

  /**
   * Stop taking work and wait for the asset in hand. The plan keeps its claim; when the lease
   * lapses it returns to the queue and the next worker carries on from the cursor.
   */
  @OnEvent({ name: 'AppShutdown' })
  async onShutdown() {
    this.stopping = true;
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = undefined;
    }
    await this.active;
  }

  /** Never overlaps itself: one plan, one asset, one request at a time per worker. */
  tick() {
    if (this.active || this.stopping) {
      return;
    }
    this.active = this.drain()
      .catch((error) => this.logger.warn(`Enrichment plan worker failed: ${errorMessage(error)}`))
      .finally(() => {
        this.active = undefined;
      });
  }

  /** Work through queued plans until none is left or we are stopping. Lapsed claims are the sweep's. */
  async drain(): Promise<void> {
    while (!this.stopping) {
      const claim = await this.operations.claimNext({
        kinds: [MediaOperationKind.EnrichmentPlan],
        workerId: this.workerId,
        leaseMs: ENRICHMENT_PLAN_LEASE_MS,
      });
      if (!claim) {
        return;
      }

      try {
        await this.run(claim.operation, claim.claimToken);
      } catch (error) {
        this.logger.error(`Enrichment plan ${claim.operation.id} failed: ${errorMessage(error)}`);
        await this.operations.fail(claim.operation.id, claim.claimToken, {
          error: errorMessage(error),
          errorCode: 'enrichment_plan_failed',
        });
      }
    }
  }

  /**
   * Run one claimed plan: the frozen set from its cursor, one asset at a time, then the one
   * automatic retry of the assets that failed. A claim can find the plan anywhere on that path and
   * carries on from what the row says; the asset a previous worker had in hand is run again, but
   * only its stages that have no outcome yet or failed.
   */
  async run(operation: MediaOperation, claimToken: string): Promise<void> {
    const { id } = operation;

    let snapshot: EnrichmentPlanSnapshot;
    try {
      snapshot = parseEnrichmentPlanSnapshot(operation.snapshot);
    } catch (error) {
      await this.operations.fail(id, claimToken, {
        error: errorMessage(error),
        errorCode: 'enrichment_plan_snapshot_invalid',
      });
      return;
    }

    const total = snapshot.assetIds.length;
    let result: EnrichmentPlanResult = { ...parseEnrichmentPlanResult(operation.result), inFlight: null };
    let processed = Math.min(Math.max(0, Number(operation.processedUnits ?? 0)), total);

    if (!(await this.proceed(id, claimToken, await this.write(id, claimToken, result, processed, total)))) {
      return;
    }

    const running = await this.operations.reportProgress(id, claimToken, {
      status: MediaOperationStatus.Rendering,
      processedUnits: processed,
      totalUnits: total,
      progress: enrichmentPlanProgress(processed, total),
    });
    if (!running) {
      await this.operations.acknowledgeCancel(id, claimToken, { released: false });
      return;
    }

    const auth = await this.authFor(operation.ownerId);
    if (!auth) {
      await this.operations.fail(id, claimToken, {
        error: 'The account that queued this plan no longer exists',
        errorCode: 'enrichment_plan_owner_unavailable',
      });
      return;
    }

    const job: PlanRun = { id, claimToken, ownerId: operation.ownerId, auth, snapshot, total };

    // The first pass over the frozen set. The count of answered assets is the cursor.
    while (processed < total) {
      if (this.stopping) {
        return;
      }
      const assetId = snapshot.assetIds[processed];
      const marked = { ...result, inFlight: assetId };
      if (!(await this.proceed(id, claimToken, await this.write(id, claimToken, marked, processed, total)))) {
        return;
      }

      const existing = result.items.find((item) => item.id === assetId);
      const item = await this.runAsset(job, assetId, stagesToRetry(existing, snapshot.stages));
      result = { ...mergeEnrichmentItem(result, item), inFlight: null };
      processed++;

      if (!(await this.proceed(id, claimToken, await this.write(id, claimToken, result, processed, total)))) {
        return;
      }
    }

    // Every asset that failed gets one more attempt before it is reported (owner decision,
    // September 22, 2026), after a pause rather than straight into whatever just went wrong.
    const planned = planEnrichmentRetryPass(snapshot, result);
    if (planned) {
      result = planned;
      if (!(await this.proceed(id, claimToken, await this.write(id, claimToken, result, processed, total)))) {
        return;
      }
      if (
        await this.operations.requeue(id, claimToken, {
          delayMs: MEDIA_OPERATION_AUTO_RETRY_DELAY_MS,
          returnAttempt: true,
        })
      ) {
        this.logger.log(`Enrichment plan ${id}: retrying ${planned.retry?.ids.length ?? 0} failed items once`);
        return;
      }
      await this.operations.acknowledgeCancel(id, claimToken, { released: false });
      return;
    }

    // The retry pass, with its own cursor. What happens here is what is reported.
    while (result.retry && result.retry.processed < result.retry.ids.length) {
      if (this.stopping) {
        return;
      }
      const pass = result.retry;
      const assetId = pass.ids[pass.processed];
      const marked = { ...result, inFlight: assetId };
      if (!(await this.proceed(id, claimToken, await this.write(id, claimToken, marked, processed, total)))) {
        return;
      }

      const existing = result.items.find((item) => item.id === assetId);
      const item = await this.runAsset(job, assetId, stagesToRetry(existing, snapshot.stages));
      result = {
        ...mergeEnrichmentItem(result, item),
        inFlight: null,
        retry: { ...pass, processed: pass.processed + 1 },
      };

      if (!(await this.proceed(id, claimToken, await this.write(id, claimToken, result, processed, total)))) {
        return;
      }
    }

    if (
      (await this.operations.beginValidation(id, claimToken)) &&
      (await this.operations.complete(id, claimToken, { resultAssetId: null }))
    ) {
      const counts = countEnrichmentItems(
        enrichmentItemStates(snapshot, result, { status: MediaOperationStatus.Completed }),
      );
      this.logger.log(
        `Enrichment plan ${id} finished: ${counts.completed} completed, ${counts.skipped} skipped, ${counts.failed} failed`,
      );
      return;
    }

    await this.operations.acknowledgeCancel(id, claimToken, { released: false });
  }

  /**
   * Run the given stages of one asset, in order, and answer for every one of them. Access is
   * checked as the owner at this moment. A stage whose prerequisite failed is skipped as
   * `dependency-failed`, which a retry picks up with it. An unexpected error fails the stage, not
   * the plan.
   */
  async runAsset(job: PlanRun, assetId: string, stages: EnrichmentStage[]): Promise<EnrichmentPlanItem> {
    const item: EnrichmentPlanItem = { id: assetId, stages: {} };
    const at = () => new Date().toISOString();

    const skipAll = (reasonKey: string) => {
      for (const stage of stages) {
        item.stages[stage] = { state: EnrichmentItemState.Skipped, reasonKey, at: at() };
      }
      return item;
    };

    const kind = (await this.momentRepository.getAssetKinds([assetId])).get(assetId);
    if (!kind) {
      return skipAll('not-found');
    }
    const allowed = await checkAccess(this.access, {
      auth: job.auth,
      permission: Permission.AssetUpdate,
      ids: [assetId],
    });
    if (!allowed.has(assetId)) {
      return skipAll('no-access');
    }

    const isVideo = kind.type === AssetType.Video;
    const failed = new Set<EnrichmentStage>();
    for (const stage of stages) {
      if (!stageAppliesTo(stage, isVideo)) {
        item.stages[stage] = {
          state: EnrichmentItemState.Skipped,
          reasonKey: isVideo ? 'not-an-image' : 'not-a-video',
          at: at(),
        };
        continue;
      }
      if (ENRICHMENT_STAGE_REQUIRES[stage].some((required) => failed.has(required))) {
        item.stages[stage] = { state: EnrichmentItemState.Skipped, reasonKey: 'dependency-failed', at: at() };
        continue;
      }

      let outcome: MomentStageOutcome;
      try {
        outcome = await this.runStage(job, stage, assetId);
      } catch (error) {
        outcome = { state: EnrichmentItemState.Failed, reasonKey: 'stage-error', message: errorMessage(error) };
      }
      item.stages[stage] = {
        state: outcome.state,
        reasonKey: outcome.reasonKey ?? null,
        message: outcome.message ?? null,
        at: at(),
      };
      if (outcome.state === EnrichmentItemState.Failed) {
        failed.add(stage);
      }

      // A stage can take minutes; keep the lease while this asset is in hand. A lost claim stops
      // here: the next write fails too, and the worker that took the plan over reruns this asset.
      if (!(await this.heartbeat(job))) {
        this.logger.warn(`Enrichment plan ${job.id}: claim lost while running ${assetId}, stopping`);
        break;
      }
    }

    return item;
  }

  /** Extend the lease; false when the claim is no longer this worker's. */
  private heartbeat(job: PlanRun): Promise<boolean> {
    return this.operations.heartbeat(job.id, job.claimToken, ENRICHMENT_PLAN_LEASE_MS);
  }

  private async runStage(job: PlanRun, stage: EnrichmentStage, assetId: string): Promise<MomentStageOutcome> {
    const { snapshot } = job;
    const options: EnrichmentRunOptions = {
      enrichmentDestinationId: snapshot.destinations.enrichment,
      searchDestinationId: snapshot.destinations.search,
      imageDescription: snapshot.config.description as EnrichmentRunOptions['imageDescription'],
      nsfwDetection: snapshot.config.lockedCheck,
      clipModelName: snapshot.config.search.modelName,
      configHash: snapshot.configHash,
      jobId: job.id,
      planRun: true,
    };
    const fromResult = (result: EnrichmentStageResult): MomentStageOutcome => ({
      state: toState(result.status),
      reasonKey: result.reasonKey,
      message: result.message,
    });

    switch (stage) {
      case EnrichmentStage.Frames: {
        return this.moments.runFramesStage(assetId);
      }
      case EnrichmentStage.LockedCheck: {
        return fromResult(await this.enrichment.detectLockedContent(assetId, options));
      }
      case EnrichmentStage.Description: {
        return fromResult(await this.enrichment.describeAsset(assetId, options));
      }
      case EnrichmentStage.MomentIndex: {
        return this.moments.runIndexStage(assetId, {
          destinationId: snapshot.destinations.search,
          modelName: snapshot.config.search.modelName,
          jobId: job.id,
          heartbeat: () => this.heartbeat(job),
        });
      }
      case EnrichmentStage.MomentCaptions: {
        const { machineLearning } = await this.config();
        return this.moments.runCaptionStage(assetId, {
          destinationId: snapshot.destinations.enrichment,
          imageDescription: {
            ...machineLearning.imageDescription,
            ...(snapshot.config.description as Partial<SystemConfig['machineLearning']['imageDescription']>),
          },
          planConfigHash: snapshot.configHash,
          jobId: job.id,
          heartbeat: () => this.heartbeat(job),
        });
      }
    }
  }

  private write(id: string, claimToken: string, result: EnrichmentPlanResult, processed: number, total: number) {
    return this.operations.setBulkResult(id, claimToken, {
      result: result as unknown as Record<string, unknown>,
      processedUnits: processed,
      totalUnits: total,
      progress: enrichmentPlanProgress(processed, total),
      leaseMs: ENRICHMENT_PLAN_LEASE_MS,
    });
  }

  /**
   * Whether the worker may carry on after a write: not when the claim is gone, and not when the
   * owner asked to cancel (acknowledged here) or to pause (the claim is handed back at this asset
   * boundary; resuming carries on from the cursor).
   */
  private async proceed(
    id: string,
    claimToken: string,
    written: MediaOperationWriteState | undefined,
  ): Promise<boolean> {
    if (!written) {
      this.logger.warn(`Enrichment plan ${id}: claim lost, stopping`);
      return false;
    }
    if (written.status === MediaOperationStatus.Cancelling || written.cancelRequestedAt) {
      await this.operations.acknowledgeCancel(id, claimToken, { released: false });
      this.logger.log(`Enrichment plan ${id} cancelled by its owner`);
      return false;
    }
    if (written.pauseRequestedAt && (await this.operations.settlePause(id, claimToken))) {
      this.logger.log(`Enrichment plan ${id} paused by its owner`);
      return false;
    }
    return true;
  }

  /**
   * The owner, acting through the system worker: elevated on purpose, because backend work may
   * reach the owner's Locked items (owner decision, September 22, 2026). Ownership is still checked
   * for every asset, and this auth never leaves the worker.
   */
  async authFor(ownerId: string): Promise<AuthDto | null> {
    const user = await this.users.get(ownerId, { withDeleted: false });
    if (!user) {
      return null;
    }
    return {
      user: {
        id: user.id,
        isAdmin: user.isAdmin,
        name: user.name,
        email: user.email,
        quotaUsageInBytes: user.quotaUsageInBytes,
        quotaSizeInBytes: user.quotaSizeInBytes,
      },
      session: { id: this.sessionId, hasElevatedPermission: true },
    };
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                           */
  /* ------------------------------------------------------------------ */

  private config() {
    return getConfig(
      { configRepo: this.configRepository, metadataRepo: this.systemMetadata, logger: this.logger },
      { withCache: true },
    );
  }

  private async routedDestinationId(workload: MlWorkload): Promise<string> {
    const route = await this.mlDestinations.getRoute(workload);
    if (!route) {
      throw new BadRequestException(
        `No processing destination is chosen for ${workload}; choose one under Processing destinations`,
      );
    }
    return route.destinationId;
  }

  /**
   * The destination must exist, be enabled, allow the workload and, for cloud, carry consent.
   * Only a passing state (unhealthy, not started) is tolerated at submit.
   */
  private async requireDestination(destinationId: string, workload: MlWorkload): Promise<MlDestinationRow> {
    const destination = await this.mlDestinations.getById(destinationId);
    if (!destination) {
      throw new BadRequestException('That processing destination does not exist');
    }
    const verdict = this.admission(
      destination,
      workload,
      await readCloudModelChoices(this.mlDestinations, [destination]),
    );
    if (!verdict.admitted && !TRANSIENT_REFUSALS.has(verdict.refusal as MlAdmissionRefusal)) {
      throw new BadRequestException(`${destination.name} cannot run this work (${verdict.refusal})`);
    }
    return destination;
  }

  /**
   * The stored check, never a new one, with the Frameleaf Cloud model an administrator chose (FL-186),
   * so this page, plan creation and Processing destinations agree with what admission answers.
   */
  private admission(row: MlDestinationRow, workload: MlWorkload, choices: CloudModelChoices) {
    const verdict = storedAdmission({ destination: row, workload, spentUsd: 0, choices });
    return verdict.admitted ? { admitted: true, refusal: null } : { admitted: false, refusal: verdict.refusal };
  }

  private emptySample(
    assetId: string,
    status: EnrichmentPreviewStatus,
  ): EnrichmentPreviewResponseDto['samples'][number] {
    return {
      assetId,
      status,
      current: null,
      candidate: null,
      tags: [],
      hallucinatedNames: [],
      ambiguousReferences: [],
      warnings: [],
      frameCount: 0,
      durationMs: 0,
      reasonKey: null,
      message: null,
    };
  }

  private async present(auth: AuthDto, operation: MediaOperation): Promise<EnrichmentPlanResponseDto> {
    const snapshot = parseEnrichmentPlanSnapshot(operation.snapshot);
    const result = parseEnrichmentPlanResult(operation.result);
    const views = enrichmentItemStates(snapshot, result, {
      status: operation.status as MediaOperationStatus,
      processedUnits: operation.processedUnits,
    });

    // FL-34: a session that has not unlocked is never told which of its assets are Locked.
    const hidden = getLockedOwnerId(auth)
      ? new Set<string>()
      : await this.operations.getLockedAssetIds(auth.user.id, snapshot.assetIds);
    const visible = views.filter(({ id }) => !hidden.has(id));

    const destinationsById = new Map((await this.mlDestinations.getAll()).map((row) => [row.id, row]));
    const describe = (id: string | null) => {
      const row = id ? destinationsById.get(id) : undefined;
      return row ? { id: row.id, name: row.name, cloud: isCloudDestination(row.kind) } : null;
    };

    const operationDto: MediaOperationDto = mapOperation(operation, hidden);
    const counts = countEnrichmentItems(views);
    return {
      operation: operationDto,
      requestedStages: snapshot.requestedStages,
      stages: snapshot.stages,
      addedStages: snapshot.stages.filter((stage) => !snapshot.requestedStages.includes(stage)),
      enrichmentDestination: describe(snapshot.destinations.enrichment),
      searchDestination: describe(snapshot.destinations.search),
      modelName: snapshot.config.description.modelName,
      searchModelName: snapshot.config.search.modelName,
      configHash: snapshot.configHash,
      items: visible.map((view) => ({
        assetId: view.id,
        state: view.state,
        retryPending: view.retryPending,
        stages: snapshot.stages.map((stage) => {
          const outcome = view.stages[stage];
          const pending =
            view.state === EnrichmentItemState.Cancelled ? EnrichmentItemState.Cancelled : EnrichmentItemState.Queued;
          return {
            stage,
            state: outcome?.state ?? pending,
            reasonKey: outcome?.reasonKey ?? null,
            message: outcome?.message ?? null,
            at: outcome?.at ?? null,
          };
        }),
      })),
      counts: {
        total: counts.total,
        queued: counts[EnrichmentItemState.Queued],
        running: counts[EnrichmentItemState.Running],
        skipped: counts[EnrichmentItemState.Skipped],
        failed: counts[EnrichmentItemState.Failed],
        completed: counts[EnrichmentItemState.Completed],
        cancelled: counts[EnrichmentItemState.Cancelled],
      },
      hiddenCount: views.length - visible.length,
    };
  }
}
