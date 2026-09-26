import { BadRequestException, Injectable } from '@nestjs/common';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SystemConfig } from 'src/config.js';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { CloudMlGateway } from 'src/repositories/frameleaf-cloud-ml.repository.js';
import type { MlSelection } from 'src/repositories/machine-learning.repository.js';
import type { MediaOperation } from 'src/repositories/media-operation.repository.js';
import type { MlDestinationRow } from 'src/repositories/ml-destination.repository.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import {
  CloudMlDescriptionBatchCreateDto,
  CloudMlDescriptionBatchesResponseDto,
  CloudMlDescriptionEstimateResponseDto,
} from 'src/dtos/cloud-ml.dto.js';
import {
  AssetStatus,
  AssetType,
  DatabaseLock,
  ImmichWorker,
  JobName,
  JobStatus,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  MlAdmissionRefusal,
  MlDestinationKind,
  MlWorkload,
  NotificationLevel,
  NotificationType,
  QueueName,
  SystemMetadataKey,
} from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import {
  CLOUD_DESCRIPTION_AUTO_MAX_WAIT_MS,
  CLOUD_DESCRIPTION_AUTO_MIN_BATCH,
  CLOUD_DESCRIPTION_BACKFILL_MAX,
  CLOUD_DESCRIPTION_CONTRACT,
  CLOUD_DESCRIPTION_DEADLINE_SECONDS,
  CLOUD_DESCRIPTION_ESTIMATES_KEPT,
  CLOUD_DESCRIPTION_ESTIMATE_TTL_MS,
  CLOUD_DESCRIPTION_LEASE_MS,
  CLOUD_DESCRIPTION_PASS_CRON,
  CLOUD_DESCRIPTION_POLL_MS,
  CLOUD_DESCRIPTION_PRICE_TOLERANCE,
  CLOUD_DESCRIPTION_REQUEST,
  CLOUD_DESCRIPTION_SAMPLE_SIZE,
  CLOUD_DESCRIPTION_SETTLE_INTERVAL_MS,
  CLOUD_DESCRIPTION_STEPS_PER_PASS,
  CLOUD_DESCRIPTION_TRANSIENT_REFUSALS,
  CLOUD_DESCRIPTION_UPLOADS_UNPUBLISHED,
  CloudDescriptionEstimateRecord,
  CloudDescriptionItem,
  CloudDescriptionOrigin,
  CloudDescriptionPhase,
  CloudDescriptionResult,
  CloudDescriptionSnapshot,
  cloudDescriptionIdempotencyKey,
  cloudDescriptionPackKey,
  emptyCloudDescriptionResult,
  groupCloudDescriptionBatches,
  heavyModelGuidance,
  nextServerDay,
  parseCloudDescriptionResult,
  parseCloudDescriptionSnapshot,
  projectCloudDescriptionCost,
  serverDay,
  serverDayStart,
} from 'src/utils/cloud-description-batch.js';
import { CloudConnectionState, CloudMlGatewayDeps, resolveCloudGateway } from 'src/utils/frameleaf-cloud-gateway.js';
import {
  CloudCatalogEntry,
  CloudEstimate,
  CloudJobAdmitted,
  CloudJobStatus,
  CloudUsage,
  FrameleafCloudError,
  catalogGroupKey,
  estimateUsable,
  offeredCatalogModels,
} from 'src/utils/frameleaf-cloud.js';
import { TERMINAL_MEDIA_OPERATION_STATUSES } from 'src/utils/media-operation.js';
import { handlePromiseError } from 'src/utils/misc.js';
import {
  ML_BUDGET_WINDOW_DAYS,
  MlDestinationNotFoundError,
  MlDestinationRefusedError,
  cloudRouteAllows,
  hasRequiredConsent,
  selectMlDestination,
} from 'src/utils/ml-destination.js';

type CloudMlSettings = SystemConfig['frameleafCloud']['cloudMl'];

const DAY_MS = 24 * 60 * 60 * 1000;

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const micros = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

/** Why a step stopped: the refusal it met and whether waiting can help. */
class BatchRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly transient: boolean,
  ) {
    super(message);
  }
}

/** A batch that has to wait (today's budget or cap is spent): it is handed back until `until`. */
class WaitUntil extends Error {
  constructor(
    readonly until: Date,
    message: string,
  ) {
    super(message);
  }
}

/** A refusal from admission or from the gateway, as a batch step reports it. */
const batchRefusalOf = (error: unknown): BatchRefusal | null => {
  if (error instanceof BatchRefusal) {
    return error;
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
    `cloud_description_${refusal.replaceAll('-', '_')}`,
    errorMessage(error),
    CLOUD_DESCRIPTION_TRANSIENT_REFUSALS.has(refusal),
  );
};

/** Descriptions may go to Frameleaf Cloud: processing is on and descriptions are Both or Cloud only. */
const descriptionsOnCloud = (cloudMl: Pick<CloudMlSettings, 'enabled' | 'routing'>) =>
  cloudMl.enabled && cloudRouteAllows(cloudMl, MlWorkload.Enrichment);

/** Why queued batches stop when the kill switch is off (FL-163 review P1). */
const TURNED_OFF =
  'Frameleaf Cloud processing is turned off, or Where each job runs keeps descriptions on this server. The batch stopped and nothing more is sent.';

/** One claimed batch in hand. */
type BatchRun = {
  operation: MediaOperation;
  claimToken: string;
  snapshot: CloudDescriptionSnapshot;
  result: CloudDescriptionResult;
  now: Date;
};

const total = (run: BatchRun) => run.snapshot.assetIds.length;

/**
 * Frameleaf Cloud description batches (FL-163, `CLD-203`).
 *
 * - When the description stage is routed to the Frameleaf Cloud destination, photos are never sent
 *   one by one. A batch is a `media_operation` of kind `cloud_description_batch`: one owner's photos
 *   (at most `CLOUD_DESCRIPTION_BATCH_SIZE`), sent as one cloud job with the model's `packKey`.
 * - A backfill (`POST admin/cloud/ml/descriptions/estimate`, then `…/batches` with only the estimate's
 *   id) shows its estimate from metered GPU time before anything is queued, and queues exactly what
 *   the server kept for that estimate.
 * - "Describe new photos automatically" (`frameleafCloud.cloudMl.autoDescribe`, off by default)
 *   batches new photos under `DatabaseLock.FrameleafCloudMlBatch` within its daily budget, counted per
 *   calendar day in the server's time zone; a spent budget stops new batches until the next day and
 *   tells administrators once.
 * - Every batch is estimated (sealed estimate), checked against the wallet, the daily cap, the
 *   destination's budget with its open holds and its approval, then submitted with one idempotency
 *   key per estimate, read until its job ends, released (`DELETE /v2/jobs/{id}`) and settled into
 *   `ml_workload_accounting`.
 * - No cloud job is created until the contract publishes uploads (`CLOUD_DESCRIPTION_CONTRACT`).
 * - Turning processing off, or keeping descriptions on this server, stops every batch.
 * - Every failure fails closed: a batch is never moved to this server or to another destination.
 *   Locked media never leaves the server, and the uploaded copy carries no EXIF or location.
 */
@Injectable()
export class CloudMlBatchService extends BaseService {
  private readonly workerId = `cloud-descriptions-${process.pid}-${Date.now()}`;
  private lastSettledAt = 0;

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  onBootstrap() {
    this.cronRepository.create({
      name: 'frameleafCloudDescriptionBatches',
      expression: CLOUD_DESCRIPTION_PASS_CRON,
      onTick: () =>
        handlePromiseError(this.jobRepository.queue({ name: JobName.CloudMlDescriptionBatch, data: {} }), this.logger),
      start: !!this.configRepository.getEnv().frameleafCloud.url,
    });
  }

  @OnJob({ name: JobName.CloudMlDescriptionBatch, queue: QueueName.BackgroundTask })
  async handleBatchPass(): Promise<JobStatus> {
    await this.databaseRepository.withLock(DatabaseLock.FrameleafCloudMlBatch, () => this.runPass());
    return JobStatus.Success;
  }

  /**
   * One pass: automatic batching of new photos (when turned on), the release of cloud jobs whose batch
   * was cancelled or failed while nobody held it, then the next step of up to
   * `CLOUD_DESCRIPTION_STEPS_PER_PASS` batches (each stops if processing was turned off), then
   * settlement.
   */
  async runPass(now = new Date()): Promise<void> {
    const cloudMl = await this.cloudMlSettings();
    if (descriptionsOnCloud(cloudMl) && cloudMl.autoDescribe.enabled) {
      try {
        await this.batchNewPhotos(now, cloudMl.autoDescribe.dailyBudgetUsd);
      } catch (error) {
        this.logger.warn(`Automatic Frameleaf Cloud description batching did not run: ${errorMessage(error)}`);
      }
    }
    await this.releaseAbandoned(now);

    let finished = false;
    for (let step = 0; step < CLOUD_DESCRIPTION_STEPS_PER_PASS; step++) {
      const claim = await this.mediaOperationRepository.claimNext({
        kinds: [MediaOperationKind.CloudDescriptionBatch],
        workerId: this.workerId,
        leaseMs: CLOUD_DESCRIPTION_LEASE_MS,
      });
      if (!claim) {
        break;
      }
      try {
        finished = (await this.step(claim.operation, claim.claimToken, now)) || finished;
      } catch (error) {
        this.logger.error(`Description batch ${claim.operation.id} failed: ${errorMessage(error)}`);
        await this.mediaOperationRepository.fail(claim.operation.id, claim.claimToken, {
          error: errorMessage(error),
          errorCode: 'cloud_description_failed',
        });
      }
    }

    await this.settle(now, finished, cloudMl.enabled);
  }

  /* ------------------------------------------------------------------ */
  /* Backfill                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * `POST admin/cloud/ml/descriptions/estimate`: what describing every photo still without a
   * description would cost on Frameleaf Cloud, before anything is queued. Admission, consent included,
   * is checked first. The cost is scaled from a sealed estimate of a few of the photos (the cloud's
   * measured GPU time for this model), so it is GPU time at the model's rate plus one start fee per
   * batch, shown as a p50–p90 range with a per-photo figure and the wallet balance. The server keeps
   * the estimate, with the photos it covers, under the id it answers with.
   */
  async estimateBackfill(auth: AuthDto, now = new Date()): Promise<CloudMlDescriptionEstimateResponseDto> {
    const { gateway, destination } = await this.requireCloud();
    const { model, offered } = await this.resolveModel(gateway);
    const { candidates, truncated } = await this.collectCandidates(CLOUD_DESCRIPTION_BACKFILL_MAX);
    const batches = groupCloudDescriptionBatches(candidates);
    const wallet = await this.callCloud(() => this.frameleafCloudMlRepository.getWallet(gateway));
    const availableUsd = Math.max(0, wallet.balanceUsd - wallet.heldUsd);

    const empty = {
      photos: 0,
      batches: 0,
      truncated,
      modelId: model.sku,
      modelName: model.label,
      p50Usd: 0,
      p90Usd: 0,
      holdUsd: 0,
      startupUsd: model.rate.startFeeUsd,
      perPhotoP50Usd: 0,
      perPhotoP90Usd: 0,
      basis: 'modelled',
      availableUsd,
      dailyCapUsd: wallet.dailyCapUsd,
      spentTodayUsd: wallet.spentTodayUsd,
      guidance: null,
      refusal: null,
      estimateId: null,
      expiresAt: null,
    };
    if (batches.length === 0) {
      return empty;
    }

    const sampleIds = batches[0].assetIds.slice(0, CLOUD_DESCRIPTION_SAMPLE_SIZE);
    const sample = await this.estimateSample(gateway, model.sku, sampleIds);
    const projection = projectCloudDescriptionCost(sample.estimate, sample.photos, batches);
    const guidance = heavyModelGuidance(
      model,
      batches.map(({ assetIds }) => assetIds.length),
      offered,
    );
    const spentInWindowUsd = await this.spentInWindow(destination.id, now);

    const owners: Record<string, string[]> = {};
    for (const { assetId, ownerId } of candidates) {
      (owners[ownerId] ??= []).push(assetId);
    }
    const record: CloudDescriptionEstimateRecord = {
      id: this.cryptoRepository.randomUUID(),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + CLOUD_DESCRIPTION_ESTIMATE_TTL_MS).toISOString(),
      modelSku: model.sku,
      perPhotoP50Usd: projection.perPhotoP50Usd,
      perPhotoP90Usd: projection.perPhotoP90Usd,
      startupUsd: projection.startupUsd,
      photos: projection.photos,
      p90Usd: projection.p90Usd,
      owners,
      createdBy: auth.user.id,
      started: null,
    };
    await this.keepEstimate(record, now);

    return {
      ...empty,
      photos: projection.photos,
      batches: batches.length,
      p50Usd: projection.p50Usd,
      p90Usd: projection.p90Usd,
      holdUsd: projection.holdUsd,
      startupUsd: projection.startupUsd,
      perPhotoP50Usd: projection.perPhotoP50Usd,
      perPhotoP90Usd: projection.perPhotoP90Usd,
      basis: projection.basis,
      guidance,
      refusal: CLOUD_DESCRIPTION_CONTRACT.uploadsPublished
        ? this.spendingRefusal(
            destination,
            wallet,
            availableUsd,
            projection.p90Usd,
            projection.batches[0].holdUsd,
            spentInWindowUsd,
          )
        : CLOUD_DESCRIPTION_UPLOADS_UNPUBLISHED,
      estimateId: record.id,
      expiresAt: record.expiresAt,
    };
  }

  /**
   * `POST admin/cloud/ml/descriptions/batches`: queue the backfill of a kept estimate. Only its id is
   * read from the request: the model, the photos, the per-photo p90 and the ceiling come from the
   * record the server kept, so nothing the browser sends can raise what is approved. Photos that are
   * Locked, gone or already in an unfinished batch now are left out. One request at a time, and a
   * second request for the same estimate is answered with what the first queued.
   */
  async startBackfill(
    dto: CloudMlDescriptionBatchCreateDto,
    now = new Date(),
  ): Promise<CloudMlDescriptionBatchesResponseDto> {
    if (!CLOUD_DESCRIPTION_CONTRACT.uploadsPublished) {
      throw new BadRequestException(CLOUD_DESCRIPTION_UPLOADS_UNPUBLISHED);
    }
    return this.databaseRepository.withLock(DatabaseLock.FrameleafCloudMlBackfill, async () => {
      const store = (await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafCloudDescriptionEstimates)) ?? {
        records: [],
      };
      const record = store.records.find(({ id }) => id === dto.estimateId);
      if (!record) {
        throw new BadRequestException('This estimate is not known any more; estimate again');
      }
      if (record.started) {
        const { batches, photos, operationIds } = record.started;
        return { batches, photos, operationIds };
      }
      if (Date.parse(record.expiresAt) <= now.getTime()) {
        throw new BadRequestException('This estimate expired; estimate again');
      }

      const { gateway, destination } = await this.requireCloud();
      const { model } = await this.resolveModel(gateway);
      if (model.sku !== record.modelSku) {
        throw new BadRequestException('The description model changed since the estimate; estimate again');
      }

      // Lock order: the backfill lock (962), then the automatic queue's (961), which automatic batching
      // also holds while it checks open batches and creates its own; so the two never batch one photo.
      const { batches, operationIds } = await this.databaseRepository.withLock(
        DatabaseLock.FrameleafCloudMlBatchQueue,
        () => this.queueBackfill(record, gateway, destination, now),
      );
      const started = {
        at: now.toISOString(),
        batches: operationIds.length,
        photos: batches.reduce((sum, { assetIds }) => sum + assetIds.length, 0),
        operationIds,
      };
      await this.systemMetadataRepository.set(SystemMetadataKey.FrameleafCloudDescriptionEstimates, {
        records: store.records.map((entry) => (entry.id === record.id ? { ...entry, owners: {}, started } : entry)),
      });
      if (operationIds.length > 0) {
        await this.jobRepository.queue({ name: JobName.CloudMlDescriptionBatch, data: {} });
      }
      return { batches: started.batches, photos: started.photos, operationIds };
    });
  }

  /** The part of a backfill that must not race automatic batching: open batches, then the new ones. */
  private async queueBackfill(
    record: CloudDescriptionEstimateRecord,
    gateway: CloudMlGateway,
    destination: MlDestinationRow,
    now: Date,
  ): Promise<{ batches: Array<{ ownerId: string; assetIds: string[] }>; operationIds: string[] }> {
    const open = await this.mediaOperationRepository.getOpenCloudDescriptionAssetIds();
    const items = Object.entries(record.owners).flatMap(([ownerId, assetIds]) =>
      assetIds.filter((assetId) => !open.has(assetId)).map((assetId) => ({ assetId, ownerId })),
    );
    const batches = groupCloudDescriptionBatches(await this.describable(items));
    const approvals = batches.map(({ assetIds }) =>
      micros(record.startupUsd + assetIds.length * record.perPhotoP90Usd),
    );
    const approvedTotal = micros(approvals.reduce((sum, value) => sum + value, 0));
    // a subset of the estimated photos never costs more than the estimate's ceiling; checked anyway
    if (approvedTotal > record.p90Usd + 1e-6) {
      throw new BadRequestException('These photos would cost more than the estimate; estimate again');
    }

    let operationIds: string[] = [];
    if (batches.length > 0) {
      const wallet = await this.callCloud(() => this.frameleafCloudMlRepository.getWallet(gateway));
      const refusal = this.spendingRefusal(
        destination,
        wallet,
        Math.max(0, wallet.balanceUsd - wallet.heldUsd),
        approvedTotal,
        approvals[0],
        await this.spentInWindow(destination.id, now),
      );
      if (refusal) {
        throw new BadRequestException(refusal);
      }
      operationIds = await this.createBatches('backfill', destination, record.modelSku, batches, approvals);
    }
    return { batches, operationIds };
  }

  /**
   * Keep an estimate for queueing. Unstarted estimates expire after `CLOUD_DESCRIPTION_ESTIMATE_TTL_MS`
   * and at most `CLOUD_DESCRIPTION_ESTIMATES_KEPT` are kept (they hold their photo ids); a started one
   * keeps only its answer, for a day, so a repeated request is answered the same.
   */
  private async keepEstimate(record: CloudDescriptionEstimateRecord, now: Date) {
    await this.databaseRepository.withLock(DatabaseLock.FrameleafCloudMlBackfill, async () => {
      const store = (await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafCloudDescriptionEstimates)) ?? {
        records: [],
      };
      const started = store.records.filter(
        (entry) => entry.started && now.getTime() - Date.parse(entry.started.at) < DAY_MS,
      );
      const waiting = store.records
        .filter((entry) => !entry.started && Date.parse(entry.expiresAt) > now.getTime())
        .slice(-(CLOUD_DESCRIPTION_ESTIMATES_KEPT - 1));
      await this.systemMetadataRepository.set(SystemMetadataKey.FrameleafCloudDescriptionEstimates, {
        records: [...started, ...waiting, record],
      });
    });
  }

  /**
   * Why a backfill of this cost cannot start now, in words an administrator can act on; null when it
   * can. The destination's budget counts what was already spent in its window and what running
   * batches hold.
   */
  private spendingRefusal(
    destination: MlDestinationRow,
    wallet: { dailyCapUsd: number | null; spentTodayUsd: number },
    availableUsd: number,
    p90Usd: number,
    firstHoldUsd: number,
    spentInWindowUsd: number,
  ): string | null {
    if (availableUsd < p90Usd) {
      return `The AI Wallet has ${availableUsd.toFixed(2)} USD available and these descriptions may cost up to ${p90Usd.toFixed(2)} USD. Add credit first.`;
    }
    if (wallet.dailyCapUsd !== null && wallet.spentTodayUsd + firstHoldUsd > wallet.dailyCapUsd) {
      return `Today's AI Wallet limit of ${wallet.dailyCapUsd.toFixed(2)} USD leaves too little for the first batch. Try again tomorrow or raise the limit in your Frameleaf account.`;
    }
    if (destination.budgetLimitUsd !== null && spentInWindowUsd + p90Usd > destination.budgetLimitUsd) {
      return `${destination.name} has ${Math.max(0, destination.budgetLimitUsd - spentInWindowUsd).toFixed(2)} USD left of its ${destination.budgetLimitUsd.toFixed(2)} USD spending limit, less than these descriptions may cost.`;
    }
    return null;
  }

  /** The destination's spend in its budget window, with what running description batches hold. */
  private async spentInWindow(destinationId: string, now: Date): Promise<number> {
    const since = new Date(now.getTime() - ML_BUDGET_WINDOW_DAYS * DAY_MS);
    const [spent, held] = await Promise.all([
      this.mlDestinationRepository.getSpend(destinationId, since),
      this.mediaOperationRepository.sumCloudDescriptionOpenHolds(destinationId, since),
    ]);
    return spent + held;
  }

  /* ------------------------------------------------------------------ */
  /* Automatic batches                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Batch the new photos waiting in the automatic queue: an owner's photos become batches once there
   * are `CLOUD_DESCRIPTION_AUTO_MIN_BATCH` of them, or once the oldest has waited
   * `CLOUD_DESCRIPTION_AUTO_MAX_WAIT_MS`. Nothing is batched while the contract has no uploads, and
   * nothing new once today's automatic spend reached the daily budget; administrators are told once
   * that day, and batching resumes the next day.
   */
  async batchNewPhotos(now: Date, dailyBudgetUsd: number): Promise<void> {
    if (!CLOUD_DESCRIPTION_CONTRACT.uploadsPublished) {
      return;
    }
    if ((await this.automaticSpentToday(now)) >= dailyBudgetUsd) {
      await this.budgetSpent(now, dailyBudgetUsd);
      return;
    }

    await this.databaseRepository.withLock(DatabaseLock.FrameleafCloudMlBatchQueue, async () => {
      const queue = (await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafCloudDescriptionQueue)) ?? {
        items: [],
        lastBatchAt: {},
      };
      if (queue.items.length === 0) {
        return;
      }
      const resolution = await resolveCloudGateway(this.gatewayDeps());
      const destination = await this.routedCloudDestination();
      if (resolution.state !== CloudConnectionState.Ready || !destination) {
        return;
      }
      const { model } = await this.resolveModel(resolution.gateway);

      const perOwner = new Map<string, typeof queue.items>();
      for (const item of queue.items) {
        const items = perOwner.get(item.ownerId) ?? [];
        items.push(item);
        perOwner.set(item.ownerId, items);
      }
      const ready = [...perOwner.values()].filter(
        (items) =>
          items.length >= CLOUD_DESCRIPTION_AUTO_MIN_BATCH ||
          now.getTime() - Date.parse(items[0].queuedAt) >= CLOUD_DESCRIPTION_AUTO_MAX_WAIT_MS,
      );
      if (ready.length === 0) {
        return;
      }

      const taken = new Set(ready.flat().map(({ assetId }) => assetId));
      const inBatches = await this.mediaOperationRepository.getOpenCloudDescriptionAssetIds();
      const describable = await this.describable(ready.flat().filter(({ assetId }) => !inBatches.has(assetId)));
      const batches = groupCloudDescriptionBatches(describable);
      await this.createBatches(
        'automatic',
        destination,
        model.sku,
        batches,
        batches.map(() => null),
      );
      const lastBatchAt = { ...queue.lastBatchAt };
      for (const items of ready) {
        lastBatchAt[items[0].ownerId] = now.toISOString();
      }
      await this.systemMetadataRepository.set(SystemMetadataKey.FrameleafCloudDescriptionQueue, {
        items: queue.items.filter(({ assetId }) => !taken.has(assetId)),
        lastBatchAt,
      });
    });
  }

  /**
   * What automatic batches admitted on the server's calendar day of `now` cost: each settled charge
   * once known, else what the wallet holds for it (one SQL sum over every such batch).
   */
  private automaticSpentToday(now: Date): Promise<number> {
    return this.mediaOperationRepository.sumCloudDescriptionSpend({
      origin: 'automatic',
      from: serverDayStart(now),
      to: nextServerDay(now),
    });
  }

  /** Tell administrators once a day that automatic descriptions stopped for the day. */
  private async budgetSpent(now: Date, dailyBudgetUsd: number) {
    await this.eventRepository.emit('AdminNotify', {
      type: NotificationType.SystemMessage,
      level: NotificationLevel.Info,
      title: 'Automatic descriptions paused for today',
      description: `Describing new photos with Frameleaf Cloud reached today's budget of ${dailyBudgetUsd.toFixed(2)} USD. New photos wait and are described from tomorrow; nothing is sent to another destination.`,
      dedupeKey: `frameleaf-cloud:description-budget:${serverDay(now)}`,
      dedupeDays: 1,
    });
  }

  /* ------------------------------------------------------------------ */
  /* Batches                                                             */
  /* ------------------------------------------------------------------ */

  private async createBatches(
    origin: CloudDescriptionOrigin,
    destination: MlDestinationRow,
    modelSku: string,
    batches: Array<{ ownerId: string; assetIds: string[] }>,
    approvals: Array<number | null>,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const [index, { ownerId, assetIds }] of batches.entries()) {
      const approvedP90Usd = approvals[index] ?? null;
      const snapshot: CloudDescriptionSnapshot = {
        version: 1,
        origin,
        destinationId: destination.id,
        assetIds,
        modelSku,
        packKey: cloudDescriptionPackKey(modelSku),
        approvedP90Usd,
      };
      const operation = await this.mediaOperationRepository.create({
        ownerId,
        kind: MediaOperationKind.CloudDescriptionBatch,
        destination: MediaOperationDestination.FrameleafCloud,
        destinationDetail: destination.name,
        label: `Describe ${assetIds.length} ${assetIds.length === 1 ? 'photo' : 'photos'} with Frameleaf Cloud`,
        assetId: assetIds.length === 1 ? assetIds[0] : null,
        resultAssetId: null,
        retryOfId: null,
        projectId: null,
        revisionId: null,
        snapshot: snapshot as unknown as Record<string, unknown>,
        settings: { origin, photos: assetIds.length, model: modelSku },
        estimate: approvedP90Usd === null ? null : { cloudCost: { p90Usd: approvedP90Usd } },
        result: emptyCloudDescriptionResult(assetIds) as unknown as Record<string, unknown>,
        totalUnits: String(assetIds.length),
      });
      ids.push(operation.id);
    }
    if (ids.length > 0) {
      this.logger.log(
        `Queued ${ids.length} Frameleaf Cloud description ${ids.length === 1 ? 'batch' : 'batches'} (${origin})`,
      );
    }
    return ids;
  }

  /**
   * The next step of one claimed batch. Returns true when its cloud job ended in this step, so the
   * pass settles right away. A batch stops here when processing was turned off.
   */
  async step(operation: MediaOperation, claimToken: string, now: Date): Promise<boolean> {
    let snapshot: CloudDescriptionSnapshot;
    try {
      snapshot = parseCloudDescriptionSnapshot(operation.snapshot);
    } catch (error) {
      await this.mediaOperationRepository.fail(
        operation.id,
        claimToken,
        { error: errorMessage(error), errorCode: 'cloud_description_snapshot_invalid' },
        { retry: false },
      );
      return false;
    }
    const run: BatchRun = {
      operation,
      claimToken,
      snapshot,
      result: parseCloudDescriptionResult(operation.result, snapshot.assetIds),
      now,
    };

    if (!descriptionsOnCloud(await this.cloudMlSettings())) {
      await this.stopTurnedOff(run);
      return false;
    }

    const resolution = await resolveCloudGateway(this.gatewayDeps());
    if (resolution.state !== CloudConnectionState.Ready) {
      const transient = resolution.state === CloudConnectionState.Unavailable;
      // a job already running in the cloud is read again later rather than given up on
      if (transient && run.result.phase === CloudDescriptionPhase.Submitted) {
        run.result = {
          ...run.result,
          waiting: { refusal: 'cloud_description_unavailable', detail: resolution.detail, at: now.toISOString() },
        };
        if (await this.save(run)) {
          await this.wait(run, CLOUD_DESCRIPTION_POLL_MS);
        }
        return false;
      }
      await this.refuse(run, new BatchRefusal('cloud_description_unavailable', resolution.detail, transient));
      return false;
    }
    const gateway = resolution.gateway;

    try {
      switch (run.result.phase) {
        case CloudDescriptionPhase.Queued: {
          await this.estimate(run, gateway);
          return false;
        }
        case CloudDescriptionPhase.Estimated: {
          await this.resume(run, gateway);
          return false;
        }
        case CloudDescriptionPhase.Submitted: {
          return await this.poll(run, gateway);
        }
        case CloudDescriptionPhase.Finished: {
          // the job ended and was released; the batch itself was settled as failed or completed
          await this.mediaOperationRepository.fail(
            operation.id,
            claimToken,
            { error: 'This batch had already ended', errorCode: 'cloud_description_ended' },
            { retry: false },
          );
          return false;
        }
      }
    } catch (error) {
      const refusal = error instanceof WaitUntil ? error : batchRefusalOf(error);
      if (!refusal) {
        throw error;
      }
      await this.refuse(run, refusal);
      return false;
    }
  }

  /**
   * The kill switch: processing turned off, or descriptions kept on this server. A cloud job the batch
   * started is cancelled and released (the cleanup pass retries when the cloud cannot be reached), and
   * the batch fails with the reason. Nothing is submitted.
   */
  private async stopTurnedOff(run: BatchRun) {
    const job = run.result.job;
    if (job) {
      const resolution = await resolveCloudGateway(this.gatewayDeps());
      if (resolution.state === CloudConnectionState.Ready) {
        await this.release(resolution.gateway, run.operation.id, job.jobId, true);
      }
    }
    await this.mediaOperationRepository.fail(
      run.operation.id,
      run.claimToken,
      { error: TURNED_OFF, errorCode: 'cloud_description_turned_off' },
      { retry: false },
    );
  }

  /**
   * Prepare the batch's photos and ask for a sealed estimate. Each photo is checked again first: a
   * photo that was Locked, deleted or moved since the batch was made is left out and never sent. The
   * copy that is digested (and that an upload would send) is the preview written again without EXIF,
   * XMP or IPTC, so no location or camera data leaves the server.
   */
  private async estimate(run: BatchRun, gateway: CloudMlGateway) {
    const { operation, snapshot } = run;
    const locked = await this.mediaOperationRepository.getLockedAssetIds(operation.ownerId, snapshot.assetIds);
    const folder = join(tmpdir(), 'frameleaf-cloud-descriptions', operation.id);
    this.storageRepository.mkdirSync(folder);
    const items: CloudDescriptionItem[] = [];
    try {
      for (const item of run.result.items) {
        items.push(await this.prepareItem(item, operation.ownerId, locked, folder));
      }
    } finally {
      await this.storageRepository.unlinkDir(folder, { recursive: true, force: true });
    }
    run.result = { ...run.result, items };
    const inputs = items.filter((item) => !item.refused);
    if (inputs.length === 0) {
      await this.finishEmpty(run);
      return;
    }

    // admission: the kill switch, consent, entitlement, wallet, daily cap and the model, from a live
    // check; the job is refused in place, never moved to another destination
    await this.admitBatch(run);
    const destination = await this.mlDestinationRepository.getById(snapshot.destinationId);

    const estimate = await this.frameleafCloudMlRepository.createEstimate(gateway, {
      workload: 'descriptions',
      modelSku: snapshot.modelSku,
      inputs: inputs.map((item) => this.toInput(item)),
      request: { ...CLOUD_DESCRIPTION_REQUEST },
    });
    const estimates = run.result.estimates + 1;
    run.result = {
      ...run.result,
      phase: CloudDescriptionPhase.Estimated,
      features: destination?.lastProbeCloud?.features ?? null,
      estimates,
      submission: {
        idempotencyKey: cloudDescriptionIdempotencyKey(operation.id, estimates),
        estimate: estimate.estimate,
        expiresAt: estimate.expiresAt,
        modelRev: estimate.modelRev,
        computeSku: estimate.computeSku,
        p50Usd: estimate.cost.p50,
        p90Usd: estimate.cost.p90,
        holdUsd: estimate.cost.hold,
        startupUsd: estimate.cost.startup,
        attemptedAt: null,
      },
      waiting: null,
    };

    await this.preflight(run, gateway, { p90Usd: estimate.cost.p90, holdUsd: estimate.cost.hold }, destination ?? null);
    if (!(await this.save(run))) {
      return;
    }
    await this.submit(run, gateway);
  }

  /**
   * A batch that was estimated earlier (a retry after 503 `capacity`, a lost claim). A submission that
   * was already sent is replayed first with its own key and body, so a job created before a crash is
   * adopted, never duplicated. Otherwise everything is checked again before anything is sent: the
   * photos (Locked, deleted, no longer a photo: the batch is estimated again without them), admission
   * and the full pre-flight.
   */
  private async resume(run: BatchRun, gateway: CloudMlGateway) {
    const submission = run.result.submission;
    if (!submission) {
      await this.reestimate(run);
      return;
    }
    if (await this.inputsChanged(run)) {
      // an attempted submission may have created a job: it is never estimated again, the batch stops
      // with its attempt kept, and the cleanup pass stops any job it created (`releasePending`)
      if (submission.attemptedAt) {
        throw new BatchRefusal(
          'cloud_description_photos_changed',
          'A photo of this batch was Locked, removed or changed after the batch was sent; nothing more is sent',
          false,
        );
      }
      await this.reestimate(run);
      return;
    }
    await this.admitBatch(run);
    const destination = await this.mlDestinationRepository.getById(run.snapshot.destinationId);
    await this.preflight(run, gateway, { p90Usd: submission.p90Usd, holdUsd: submission.holdUsd }, destination ?? null);
    await this.submit(run, gateway);
  }

  /** Whether a photo the batch would send is Locked, gone or no longer a photo of its owner now. */
  private async inputsChanged(run: BatchRun): Promise<boolean> {
    const sent = run.result.items.filter((item) => !item.refused);
    const locked = await this.mediaOperationRepository.getLockedAssetIds(
      run.operation.ownerId,
      sent.map(({ assetId }) => assetId),
    );
    for (const { assetId } of sent) {
      if (locked.has(assetId)) {
        return true;
      }
      const asset = await this.assetJobRepository.getForImageEnrichment(assetId);
      if (
        !asset ||
        asset.ownerId !== run.operation.ownerId ||
        asset.deletedAt ||
        asset.status !== AssetStatus.Active ||
        asset.type !== AssetType.Image ||
        !asset.previewFile
      ) {
        return true;
      }
    }
    return false;
  }

  /** Admission for this batch's destination, with the kill switch; never another destination. */
  private async admitBatch(run: BatchRun): Promise<MlSelection> {
    const selection = await this.admit(run.snapshot.destinationId, run.operation.id);
    if (selection.kind !== MlDestinationKind.FrameleafCloud) {
      throw new BatchRefusal(
        'cloud_description_not_cloud',
        'The destination this batch was made for is not Frameleaf Cloud any more; nothing was sent',
        false,
      );
    }
    return selection;
  }

  private async prepareItem(
    item: CloudDescriptionItem,
    ownerId: string,
    locked: Set<string>,
    folder: string,
  ): Promise<CloudDescriptionItem> {
    const base = { assetId: item.assetId, inputId: item.inputId };
    // Locked media never goes to Frameleaf Cloud, whoever queued the batch
    if (locked.has(item.assetId)) {
      return { ...base, refused: 'locked' };
    }
    const asset = await this.assetJobRepository.getForImageEnrichment(item.assetId);
    if (!asset || asset.ownerId !== ownerId || asset.deletedAt || asset.status !== AssetStatus.Active) {
      return { ...base, refused: 'not-found' };
    }
    if (asset.type !== AssetType.Image) {
      return { ...base, refused: 'not-an-image' };
    }
    if (!asset.previewFile) {
      return { ...base, refused: 'no-preview' };
    }
    const output = join(folder, `${item.inputId}.jpeg`);
    try {
      await this.mediaRepository.writeCloudUpload(asset.previewFile, output);
      const { sha256, sizeInBytes } = await this.cryptoRepository.hashFileDigests(output);
      return { ...base, sha256: sha256.toString('hex'), bytes: sizeInBytes, contentType: 'image/jpeg' };
    } catch (error) {
      this.logger.warn(`Could not prepare photo ${item.assetId} for Frameleaf Cloud: ${errorMessage(error)}`);
      return { ...base, refused: 'prepare-failed' };
    }
  }

  private toInput(item: CloudDescriptionItem) {
    return { inputId: item.inputId, contentType: item.contentType!, bytes: item.bytes!, sha256: item.sha256! };
  }

  /**
   * The checks every batch passes before it is submitted (hold ≤ balance), run again whenever a batch
   * resumes: the AI Wallet can hold the estimate, the account's daily cap and the destination's
   * budget (with what running batches hold) leave room for it, a backfill batch is not estimated
   * above what was approved, and an automatic batch fits today's budget. An automatic batch that does
   * not fit today waits for tomorrow; anything else is refused and nothing is sent.
   */
  private async preflight(
    run: BatchRun,
    gateway: CloudMlGateway,
    cost: { p90Usd: number; holdUsd: number },
    destination: MlDestinationRow | null,
  ) {
    const { snapshot, now } = run;
    const hold = cost.holdUsd;
    if (snapshot.approvedP90Usd !== null && cost.p90Usd > snapshot.approvedP90Usd * CLOUD_DESCRIPTION_PRICE_TOLERANCE) {
      throw new BatchRefusal(
        'cloud_description_estimate_increased',
        `Frameleaf Cloud now estimates this batch at up to ${cost.p90Usd.toFixed(2)} USD, above the ${snapshot.approvedP90Usd.toFixed(2)} USD it was approved at. Nothing was sent; estimate again.`,
        false,
      );
    }
    const wallet = await this.frameleafCloudMlRepository.getWallet(gateway);
    const available = wallet.balanceUsd - wallet.heldUsd;
    if (hold > available) {
      throw new BatchRefusal(
        'cloud_description_wallet_insufficient',
        `This batch needs ${hold.toFixed(2)} USD held and the AI Wallet has ${Math.max(0, available).toFixed(2)} USD available. Nothing was sent.`,
        false,
      );
    }
    const automatic = snapshot.origin === 'automatic';
    if (wallet.dailyCapUsd !== null && wallet.spentTodayUsd + hold > wallet.dailyCapUsd) {
      if (automatic) {
        throw new WaitUntil(nextServerDay(now), "Today's AI Wallet limit is reached; this batch waits for tomorrow");
      }
      throw new BatchRefusal(
        'cloud_description_daily_cap',
        `Today's AI Wallet limit of ${wallet.dailyCapUsd.toFixed(2)} USD leaves too little for this batch. Nothing was sent.`,
        false,
      );
    }
    if (destination && destination.budgetLimitUsd !== null) {
      const spent = await this.spentInWindow(destination.id, now);
      if (spent + hold > destination.budgetLimitUsd) {
        throw new BatchRefusal(
          'cloud_description_budget_exceeded',
          `${destination.name} has ${Math.max(0, destination.budgetLimitUsd - spent).toFixed(2)} USD left of its spending limit, less than this batch needs held. Nothing was sent.`,
          false,
        );
      }
    }
    if (automatic) {
      const budget = (await this.cloudMlSettings()).autoDescribe.dailyBudgetUsd;
      if ((await this.automaticSpentToday(now)) + hold > budget) {
        await this.budgetSpent(now, budget);
        throw new WaitUntil(
          nextServerDay(now),
          "Today's budget for automatic descriptions is reached; this batch waits for tomorrow",
        );
      }
    }
  }

  /**
   * Submit the estimated batch: one cloud job for all its photos, with its pack key and the
   * submission's idempotency key. Nothing is sent while the contract has no uploads. The attempt is
   * recorded before `POST /v2/jobs`, so a retry after a lost answer or a crash replays the same key and
   * body and is answered with the same admission rather than a second job. An expired, spent or
   * mismatched estimate is asked for again under a new key.
   */
  private async submit(run: BatchRun, gateway: CloudMlGateway) {
    if (!CLOUD_DESCRIPTION_CONTRACT.uploadsPublished) {
      throw new BatchRefusal('cloud_description_uploads_unpublished', CLOUD_DESCRIPTION_UPLOADS_UNPUBLISHED, false);
    }
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
    const inputs = run.result.items.filter((item) => !item.refused);

    let admitted: CloudJobAdmitted;
    try {
      admitted = await this.frameleafCloudMlRepository.createJob(
        gateway,
        this.jobBody(operation.id, snapshot, run.result, submission),
        submission.idempotencyKey,
      );
    } catch (error) {
      // a spent, expired or mismatched estimate (409) created no job under this key: estimate again
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
      // the claim is gone: keep the job's id on the row first, so the cleanup pass can always find it,
      // then stop it rather than leave it holding the wallet unwatched
      this.logger.warn(`Description batch ${operation.id}: claim lost after its job ${admitted.jobId} was admitted`);
      await this.mediaOperationRepository.recordRemoteJobId(operation.id, admitted.jobId);
      await this.release(gateway, operation.id, admitted.jobId, true);
      return;
    }
    const bytesSent = inputs.reduce((sum, item) => sum + (item.bytes ?? 0), 0);
    // one row per cloud job, which its settlement fills (`applySettlements`); a replay adds none
    await this.mlDestinationRepository.recordCloudJobAccounting({
      destinationId: snapshot.destinationId,
      destinationKind: MlDestinationKind.FrameleafCloud,
      workload: MlWorkload.Enrichment,
      jobId: operation.id,
      jobName: JobName.CloudMlDescriptionBatch,
      bytesSent,
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
      phase: CloudDescriptionPhase.Submitted,
      job: {
        jobId: admitted.jobId,
        status: admitted.status,
        holdUsd: admitted.hold.amountUsd,
        ceilingUsd: admitted.hold.ceilingUsd,
        admittedAt: admitted.createdAt,
        meteredSeconds: null,
      },
      waiting: null,
    };
    if (await this.save(run)) {
      await this.wait(run, CLOUD_DESCRIPTION_POLL_MS);
    }
  }

  /** The `POST /v2/jobs` body of a submission, the same every time it is sent or replayed. */
  private jobBody(
    operationId: string,
    snapshot: CloudDescriptionSnapshot,
    result: CloudDescriptionResult,
    submission: NonNullable<CloudDescriptionResult['submission']>,
  ) {
    return {
      estimate: submission.estimate,
      workload: 'descriptions' as const,
      modelSku: snapshot.modelSku,
      modelRev: submission.modelRev,
      clientRef: `batch-${operationId}`,
      packKey: snapshot.packKey,
      deadlineSeconds: CLOUD_DESCRIPTION_DEADLINE_SECONDS,
      inputs: result.items.filter((item) => !item.refused).map((item) => this.toInput(item)),
      request: { ...CLOUD_DESCRIPTION_REQUEST },
    };
  }

  private async reestimate(run: BatchRun) {
    run.result = { ...run.result, phase: CloudDescriptionPhase.Queued, submission: null };
    if (await this.save(run)) {
      await this.wait(run, 0);
    }
  }

  /**
   * Read the batch's cloud job and act on where it is. Uploads and results belong to the cloud's job
   * broker (FC-39), whose contract is not published: a job that waits for its upload is cancelled
   * (this server cannot send it yet), and a completed job's results cannot be read yet, so nothing is
   * written. Either way the job is released so the cloud keeps no copy, and the batch fails closed.
   */
  private async poll(run: BatchRun, gateway: CloudMlGateway): Promise<boolean> {
    const job = run.result.job;
    if (!job) {
      throw new BatchRefusal('cloud_description_no_job', 'This batch has no cloud job to read', false);
    }
    let status: CloudJobStatus;
    try {
      status = await this.frameleafCloudMlRepository.getJob(gateway, job.jobId);
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
        await this.wait(run, CLOUD_DESCRIPTION_POLL_MS);
      }
      return false;
    }

    run.result = {
      ...run.result,
      job: { ...job, status: status.status, meteredSeconds: status.run?.meteredSeconds ?? job.meteredSeconds },
      waiting: null,
    };
    switch (status.status) {
      case 'admitted':
      case 'queued':
      case 'starting':
      case 'running': {
        if (await this.save(run)) {
          await this.mediaOperationRepository.reportProgress(run.operation.id, run.claimToken, {
            status: MediaOperationStatus.Rendering,
            processedUnits: 0,
            totalUnits: total(run),
            progress: 0,
          });
          await this.wait(run, CLOUD_DESCRIPTION_POLL_MS);
        }
        return false;
      }
      case 'awaiting_upload': {
        await this.release(gateway, run.operation.id, job.jobId, true);
        await this.end(run, {
          errorCode: 'cloud_description_upload_unavailable',
          error:
            'Frameleaf Cloud is waiting for this batch’s photos, and this server cannot send them yet. The job was stopped and nothing was described.',
        });
        return true;
      }
      case 'completed': {
        await this.release(gateway, run.operation.id, job.jobId, false);
        await this.end(run, {
          errorCode: 'cloud_description_results_unreadable',
          error:
            'Frameleaf Cloud finished this batch, but this server cannot read description results yet. Nothing was written; the photos can be described again.',
        });
        return true;
      }
      case 'failed':
      case 'cancelled':
      case 'cancelled_budget':
      case 'expired': {
        await this.release(gateway, run.operation.id, job.jobId, false);
        await this.end(run, {
          errorCode: `cloud_description_job_${status.status}`,
          error: `Frameleaf Cloud ended this batch (${status.status.replaceAll('_', ' ')}). Nothing was written.`,
        });
        return true;
      }
    }
  }

  /**
   * Stop a batch its owner cancelled. A cloud job it started is cancelled and released; the cancel is
   * acknowledged as released only when the cloud confirmed both, otherwise the cleanup pass retries.
   */
  private async cancel(run: BatchRun, gateway: CloudMlGateway) {
    const job = run.result.job;
    const released = job ? await this.release(gateway, run.operation.id, job.jobId, true) : true;
    await this.mediaOperationRepository.acknowledgeCancel(run.operation.id, run.claimToken, {
      released: !!job && released,
    });
  }

  /**
   * Cancel (when asked) and release a cloud job: `DELETE /v2/jobs/{id}` acknowledges it, so the cloud
   * purges what it holds for it. True when the cloud confirmed the release.
   */
  private async release(
    gateway: CloudMlGateway,
    operationId: string,
    jobId: string,
    cancel: boolean,
  ): Promise<boolean> {
    try {
      if (cancel) {
        await this.frameleafCloudMlRepository.cancelJob(gateway, jobId);
      }
      await this.frameleafCloudMlRepository.deleteJob(gateway, jobId);
      await this.mediaOperationRepository.markRemoteReleased(operationId);
      return true;
    } catch (error) {
      this.logger.warn(`Frameleaf Cloud job ${jobId} was not released yet: ${errorMessage(error)}`);
      return false;
    }
  }

  /**
   * Release cloud jobs of batches that were cancelled or failed while no step held them (a cancel of a
   * waiting batch is immediate). Until the cloud confirms, the batch stays on the list.
   */
  private async releaseAbandoned(now: Date) {
    const unreleased = await this.mediaOperationRepository.getUnreleasedRemoteOperations(100, [
      MediaOperationKind.CloudDescriptionBatch,
    ]);
    const pending = CLOUD_DESCRIPTION_CONTRACT.uploadsPublished
      ? await this.mediaOperationRepository.listCloudDescriptionPendingReleases(20)
      : [];
    if (unreleased.length === 0 && pending.length === 0) {
      return;
    }
    const resolution = await resolveCloudGateway(this.gatewayDeps());
    if (resolution.state !== CloudConnectionState.Ready) {
      return;
    }
    await this.releasePending(resolution.gateway, pending, now);
    for (const operation of unreleased) {
      await this.release(resolution.gateway, operation.id, operation.remoteJobId!, true);
    }
  }

  /**
   * FL-163 re-check: a batch that ended after its `POST /v2/jobs` was sent (retries ran out, a photo
   * changed, processing was turned off) but before its job was recorded. Its saved submission (the
   * idempotency key and body, written before the POST) is the pending-release marker. Once its sealed
   * estimate expired, so a replay can no longer create a job, the same key and body are replayed: an
   * admission names the job that was created, which is recorded and then stopped and released; a 409
   * means none was, and the marker is cleared.
   */
  private async releasePending(gateway: CloudMlGateway, pending: MediaOperation[], now: Date) {
    for (const operation of pending) {
      let snapshot: CloudDescriptionSnapshot;
      try {
        snapshot = parseCloudDescriptionSnapshot(operation.snapshot);
      } catch {
        continue;
      }
      const result = parseCloudDescriptionResult(operation.result, snapshot.assetIds);
      const submission = result.submission;
      if (!submission?.attemptedAt || estimateUsable({ expiresAt: submission.expiresAt }, now.getTime())) {
        continue;
      }
      const cleared = { ...result, submission: { ...submission, attemptedAt: null } };
      try {
        const admitted = await this.frameleafCloudMlRepository.createJob(
          gateway,
          this.jobBody(operation.id, snapshot, result, submission),
          submission.idempotencyKey,
        );
        await this.mediaOperationRepository.recordRemoteJobId(operation.id, admitted.jobId);
        await this.release(gateway, operation.id, admitted.jobId, true);
      } catch (error) {
        if (!(error instanceof FrameleafCloudError && error.refusal === MlAdmissionRefusal.ModelMismatch)) {
          this.logger.warn(
            `Description batch ${operation.id}: its submission could not be checked yet: ${errorMessage(error)}`,
          );
          continue;
        }
      }
      await this.mediaOperationRepository.setFinishedResult(
        operation.id,
        cleared as unknown as Record<string, unknown>,
      );
    }
  }

  /** A batch whose photos were all left out: it ends here, and nothing was sent. */
  private async finishEmpty(run: BatchRun) {
    run.result = { ...run.result, phase: CloudDescriptionPhase.Finished };
    if (!(await this.save(run))) {
      return;
    }
    if (await this.mediaOperationRepository.beginValidation(run.operation.id, run.claimToken)) {
      await this.mediaOperationRepository.complete(run.operation.id, run.claimToken, { resultAssetId: null });
    }
  }

  /** The cloud job ended without results this server can write: the batch fails, and is not retried. */
  private async end(run: BatchRun, failure: { errorCode: string; error: string }) {
    run.result = { ...run.result, phase: CloudDescriptionPhase.Finished };
    if (await this.save(run)) {
      await this.mediaOperationRepository.fail(run.operation.id, run.claimToken, failure, { retry: false });
    }
  }

  /** A step met a refusal: wait and retry once when it may pass (the job is never sent elsewhere), else fail. */
  private async refuse(run: BatchRun, refusal: BatchRefusal | WaitUntil) {
    if (refusal instanceof WaitUntil) {
      // an attempted submission is kept (and replayed later with its key), never estimated again
      const attempted = !!run.result.submission?.attemptedAt && !run.result.job;
      run.result = {
        ...run.result,
        phase: attempted ? CloudDescriptionPhase.Estimated : CloudDescriptionPhase.Queued,
        submission: attempted ? run.result.submission : null,
        waiting: { refusal: 'cloud_description_waiting', detail: refusal.message, at: run.now.toISOString() },
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
      await this.mediaOperationRepository.fail(
        run.operation.id,
        run.claimToken,
        { error: refusal.message, errorCode: refusal.code },
        { retry: refusal.transient },
      );
    }
  }

  /** Write the batch's result; false when the claim is gone or a cancel arrived (then it is handled). */
  private async save(run: BatchRun): Promise<boolean> {
    const processed = run.result.phase === CloudDescriptionPhase.Finished ? total(run) : 0;
    const written = await this.mediaOperationRepository.setBulkResult(run.operation.id, run.claimToken, {
      result: run.result as unknown as Record<string, unknown>,
      processedUnits: processed,
      totalUnits: total(run),
      progress: processed === total(run) ? 100 : 0,
      leaseMs: CLOUD_DESCRIPTION_LEASE_MS,
    });
    if (!written) {
      this.logger.warn(`Description batch ${run.operation.id}: claim lost, stopping`);
      return false;
    }
    if (written.status === MediaOperationStatus.Cancelling || written.cancelRequestedAt) {
      const resolution = await resolveCloudGateway(this.gatewayDeps());
      if (resolution.state === CloudConnectionState.Ready) {
        await this.cancel(run, resolution.gateway);
      }
      return false;
    }
    return true;
  }

  /** Hand the batch back to the queue until its next step is due. */
  private async wait(run: BatchRun, delayMs: number) {
    await this.mediaOperationRepository.requeue(run.operation.id, run.claimToken, { delayMs, returnAttempt: true });
  }

  /* ------------------------------------------------------------------ */
  /* Settlement                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Apply Frameleaf Cloud's settlements (`GET /v2/usage`) to `ml_workload_accounting` and to the batches
   * they belong to (found by `clientRef`), with each photo's share of the charge. Runs right after a
   * batch's job ended, else at most every `CLOUD_DESCRIPTION_SETTLE_INTERVAL_MS`. With processing turned
   * off the cloud is only asked while an admitted batch still waits for its settlement.
   */
  async settle(now: Date, force: boolean, enabled = true): Promise<void> {
    if (!force && now.getTime() - this.lastSettledAt < CLOUD_DESCRIPTION_SETTLE_INTERVAL_MS) {
      return;
    }
    const since = new Date(now.getTime() - ML_BUDGET_WINDOW_DAYS * DAY_MS);
    if (!enabled && !(await this.mediaOperationRepository.hasUnsettledCloudDescriptionJobs(since))) {
      return;
    }
    const resolution = await resolveCloudGateway(this.gatewayDeps());
    if (resolution.state !== CloudConnectionState.Ready) {
      return;
    }
    this.lastSettledAt = now.getTime();
    let usage: CloudUsage;
    try {
      usage = await this.frameleafCloudMlRepository.getUsage(resolution.gateway, since);
    } catch (error) {
      this.logger.warn(`Frameleaf Cloud settlements were not read: ${errorMessage(error)}`);
      return;
    }
    await this.mlDestinationRepository.applySettlements(
      usage.items.map((item) => ({ cloudJobId: item.jobId, costUsd: item.settledUsd, credits: item.credits })),
    );

    const byOperation = new Map<string, (typeof usage.items)[number]>();
    for (const item of usage.items) {
      if (item.clientRef?.startsWith('batch-')) {
        byOperation.set(item.clientRef.slice('batch-'.length), item);
      }
    }
    const operations = await this.mediaOperationRepository.getManyForWorker([...byOperation.keys()]);
    for (const operation of operations) {
      const item = byOperation.get(operation.id);
      if (
        !item ||
        operation.kind !== MediaOperationKind.CloudDescriptionBatch ||
        operation.remoteJobId !== item.jobId ||
        !TERMINAL_MEDIA_OPERATION_STATUSES.includes(operation.status as MediaOperationStatus)
      ) {
        continue;
      }
      const snapshot = operation.snapshot as Partial<CloudDescriptionSnapshot>;
      const result = parseCloudDescriptionResult(operation.result, snapshot.assetIds ?? []);
      if (result.settledUsd === item.settledUsd) {
        continue;
      }
      const sent = result.items.filter((entry) => !entry.refused);
      const share = sent.length > 0 ? micros(item.settledUsd / sent.length) : 0;
      await this.mediaOperationRepository.setFinishedResult(operation.id, {
        ...result,
        settledUsd: item.settledUsd,
        items: result.items.map((entry) => (entry.refused ? entry : { ...entry, costShareUsd: share })),
      } as unknown as Record<string, unknown>);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                           */
  /* ------------------------------------------------------------------ */

  /** The saved Frameleaf Cloud processing settings, read fresh (the kill switch must never be stale). */
  private async cloudMlSettings(): Promise<CloudMlSettings> {
    const { frameleafCloud } = await this.getConfig({ withCache: false });
    return frameleafCloud.cloudMl;
  }

  /** Admission with the kill switch: processing on and descriptions allowed, then consent and the rest. */
  private admit(destinationId: string, jobId: string | null): Promise<MlSelection> {
    return selectMlDestination(
      {
        mlDestinationRepository: this.mlDestinationRepository,
        machineLearningRepository: this.machineLearningRepository,
        cloudMlSettings: () => this.cloudMlSettings(),
      },
      { workload: MlWorkload.Enrichment, destinationId, jobId, jobName: JobName.CloudMlDescriptionBatch },
    );
  }

  /**
   * The Frameleaf Cloud destination a backfill uses, admitted, and a ready gateway. Descriptions must be
   * allowed on Frameleaf Cloud (Both or Cloud only in Where each job runs) with processing on, and the
   * recorded consent and admission come before anything else is asked of the cloud.
   */
  private async requireCloud(): Promise<{ gateway: CloudMlGateway; destination: MlDestinationRow }> {
    if (!descriptionsOnCloud(await this.cloudMlSettings())) {
      throw new BadRequestException(
        'Turn on Frameleaf Cloud processing and allow descriptions on it in Where each job runs first',
      );
    }
    const destination = (await this.mlDestinationRepository.getAll()).find(
      (row) => row.kind === MlDestinationKind.FrameleafCloud,
    );
    if (!destination) {
      throw new BadRequestException('Add Frameleaf Cloud as a processing destination first');
    }
    if (!hasRequiredConsent(destination)) {
      throw new BadRequestException('Review and accept the Frameleaf Cloud processing terms first');
    }
    try {
      await this.admit(destination.id, null);
    } catch (error) {
      const refusal = batchRefusalOf(error);
      if (refusal) {
        throw new BadRequestException(refusal.message);
      }
      throw error;
    }
    const resolution = await resolveCloudGateway(this.gatewayDeps());
    if (resolution.state !== CloudConnectionState.Ready) {
      throw new BadRequestException(resolution.detail);
    }
    return { gateway: resolution.gateway, destination };
  }

  /** The Frameleaf Cloud destination the description stage is routed to, or undefined when it is routed elsewhere. */
  private async routedCloudDestination(): Promise<MlDestinationRow | undefined> {
    const route = await this.mlDestinationRepository.getRoute(MlWorkload.Enrichment);
    if (!route) {
      return;
    }
    const destination = await this.mlDestinationRepository.getById(route.destinationId);
    if (destination?.kind === MlDestinationKind.FrameleafCloud) {
      return destination;
    }
  }

  /**
   * The description model: the one an administrator chose for the `descriptions` group (FL-186), else
   * the one the catalogue marks as its default. None is guessed.
   */
  private async resolveModel(
    gateway: CloudMlGateway,
  ): Promise<{ model: CloudCatalogEntry; offered: CloudCatalogEntry[] }> {
    const catalog = await this.callCloud(() => this.frameleafCloudMlRepository.getCatalog(gateway));
    const offered = offeredCatalogModels(catalog).filter(
      (entry) => catalogGroupKey(entry.workload, entry.mode) === 'descriptions',
    );
    const chosen = await this.mlDestinationRepository.getCloudModelChoice('descriptions');
    const model = chosen ? offered.find((entry) => entry.sku === chosen) : offered.find((entry) => entry.default);
    if (!model) {
      throw new BadRequestException(
        chosen
          ? `The description model ${chosen} is not in the Frameleaf Cloud catalogue any more; choose another in Where each job runs`
          : 'Frameleaf Cloud recommends no description model in this region; choose one in Where each job runs',
      );
    }
    return { model, offered };
  }

  /**
   * Photos that still need a description and may go to Frameleaf Cloud, newest first: photos (a video
   * is described from its frames on this server's destinations only), not deleted, with a preview, not
   * Locked, and not already in an unfinished batch.
   */
  private async collectCandidates(
    limit: number,
  ): Promise<{ candidates: Array<{ assetId: string; ownerId: string }>; truncated: boolean }> {
    const inBatches = await this.mediaOperationRepository.getOpenCloudDescriptionAssetIds();
    const found: Array<{ assetId: string; ownerId: string }> = [];
    let truncated = false;
    for await (const { id } of this.assetJobRepository.streamForImageDescriptionJob(false)) {
      if (inBatches.has(id)) {
        continue;
      }
      if (found.length >= limit) {
        truncated = true;
        break;
      }
      const asset = await this.assetJobRepository.getForImageEnrichment(id);
      if (
        !asset ||
        asset.type !== AssetType.Image ||
        asset.status !== AssetStatus.Active ||
        asset.deletedAt ||
        !asset.previewFile
      ) {
        continue;
      }
      found.push({ assetId: id, ownerId: asset.ownerId });
    }
    return { candidates: await this.withoutLocked(found), truncated };
  }

  /** The queued photos that are still photos of the same owner, with a preview, and not Locked. */
  private async describable(
    items: ReadonlyArray<{ assetId: string; ownerId: string }>,
  ): Promise<Array<{ assetId: string; ownerId: string }>> {
    const found: Array<{ assetId: string; ownerId: string }> = [];
    for (const { assetId, ownerId } of items) {
      const asset = await this.assetJobRepository.getForImageEnrichment(assetId);
      if (
        asset?.ownerId === ownerId &&
        asset.type === AssetType.Image &&
        asset.status === AssetStatus.Active &&
        !asset.deletedAt &&
        asset.previewFile
      ) {
        found.push({ assetId, ownerId });
      }
    }
    return this.withoutLocked(found);
  }

  /** Locked media never goes to Frameleaf Cloud (FL-34): checked per owner against the lock record. */
  private async withoutLocked(
    items: Array<{ assetId: string; ownerId: string }>,
  ): Promise<Array<{ assetId: string; ownerId: string }>> {
    const perOwner = new Map<string, string[]>();
    for (const { assetId, ownerId } of items) {
      const ids = perOwner.get(ownerId) ?? [];
      ids.push(assetId);
      perOwner.set(ownerId, ids);
    }
    const locked = new Set<string>();
    for (const [ownerId, assetIds] of perOwner) {
      for (let start = 0; start < assetIds.length; start += 1000) {
        const ids = await this.mediaOperationRepository.getLockedAssetIds(ownerId, assetIds.slice(start, start + 1000));
        for (const id of ids) {
          locked.add(id);
        }
      }
    }
    return items.filter(({ assetId }) => !locked.has(assetId));
  }

  /** A sealed estimate for a few photos, from which a backfill's cost is scaled. The copies are removed at once. */
  private async estimateSample(
    gateway: CloudMlGateway,
    modelSku: string,
    assetIds: string[],
  ): Promise<{ estimate: CloudEstimate; photos: number }> {
    const folder = join(tmpdir(), 'frameleaf-cloud-descriptions', `sample-${Date.now()}`);
    this.storageRepository.mkdirSync(folder);
    const items: CloudDescriptionItem[] = [];
    try {
      for (const [index, assetId] of assetIds.entries()) {
        const asset = await this.assetJobRepository.getForImageEnrichment(assetId);
        if (asset) {
          items.push(await this.prepareItem({ assetId, inputId: `s${index + 1}` }, asset.ownerId, new Set(), folder));
        }
      }
    } finally {
      await this.storageRepository.unlinkDir(folder, { recursive: true, force: true });
    }
    const inputs = items.filter((item) => !item.refused);
    if (inputs.length === 0) {
      throw new BadRequestException('None of the photos could be prepared for an estimate');
    }
    return { estimate: await this.sealSample(gateway, modelSku, inputs), photos: inputs.length };
  }

  private sealSample(
    gateway: CloudMlGateway,
    modelSku: string,
    inputs: CloudDescriptionItem[],
  ): Promise<CloudEstimate> {
    return this.callCloud(() =>
      this.frameleafCloudMlRepository.createEstimate(gateway, {
        workload: 'descriptions',
        modelSku,
        inputs: inputs.map((item) => this.toInput(item)),
        request: { ...CLOUD_DESCRIPTION_REQUEST },
      }),
    );
  }

  private async callCloud<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof FrameleafCloudError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
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
