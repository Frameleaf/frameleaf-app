import { Injectable, OnModuleInit } from '@nestjs/common';
import { Kysely } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { JobOf } from 'src/types.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { BootstrapEventPriority, DatabaseLock, ImmichWorker, JobName, JobStatus, QueueName } from 'src/enum.js';
import { OfficialAdoptionResult } from 'src/fork-schema/official-adoption.js';
import { BestPhotosRepository } from 'src/repositories/best-photos.repository.js';
import { DuplicateRepository } from 'src/repositories/duplicate.repository.js';
import { ForkAlbumMetadataRepository } from 'src/repositories/fork-album-metadata.repository.js';
import { ForkConfigRepository } from 'src/repositories/fork-config.repository.js';
import { digestValue } from 'src/repositories/fork-derived-results.js';
import { ForkEnrichmentRepository } from 'src/repositories/fork-enrichment.repository.js';
import { ForkPrivacyRepository } from 'src/repositories/fork-privacy.repository.js';
import {
  BACKFILL_KINDS,
  BackfillClaim,
  BackfillKind,
  BackfillProgress,
  ForkState,
  InitialBackfillResult,
  ReturnConfigReconciliation,
} from 'src/repositories/fork-schema.repository.js';
import { MediaHealthRepository } from 'src/repositories/media-health.repository.js';
import { ReturnNormalizationClaim } from 'src/repositories/physical-file.repository.js';
import { SmartAlbumRepository } from 'src/repositories/smart-album.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { ForkStorageNormalizationService } from 'src/services/fork-storage-normalization.service.js';

const DEFAULT_BATCH_SIZE = 100;

/** The backfill already completed (`ready`) or the library is fully active: start/resume only report. */
const isBackfillFinished = ({ phase }: ForkState) => phase === 'ready' || phase === 'active';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export type BackfillBatchResult = { count: number; digest: string };
export type BackfillBatchHandler = (ids: string[], claim?: ReturnNormalizationClaim) => Promise<BackfillBatchResult>;
export type ForkSchemaMigrationStatus = ForkState & {
  progress: BackfillProgress[];
  verified: boolean;
};
export type ForkSchemaAdoptionStatus = ForkSchemaMigrationStatus & { adoption: OfficialAdoptionResult };
export type ReturnReconciliationHooks = {
  afterBatch?: (kind: BackfillKind, claim: BackfillClaim) => Promise<void> | void;
  afterConfigEvidence?: (evidence: ReturnConfigReconciliation) => Promise<void> | void;
  beforeConfigEvidence?: (evidence: ReturnConfigReconciliation) => Promise<void> | void;
};

@Injectable()
export class ForkSchemaMigrationService extends BaseService implements OnModuleInit {
  @InjectKysely()
  private db!: Kysely<DB>;

  private readonly handlers = new Map<BackfillKind, BackfillBatchHandler>();
  private forkConfigRepository!: ForkConfigRepository;
  private seedPromise?: Promise<void>;

  onModuleInit(): void {
    const privacyRepository = new ForkPrivacyRepository(this.db);
    const albumRepository = new ForkAlbumMetadataRepository(this.db);
    const enrichmentRepository = new ForkEnrichmentRepository(this.db);
    const automationRepository = new SmartAlbumRepository(this.db);
    this.forkConfigRepository = new ForkConfigRepository(this.db);
    const mediaHealthRepository = new MediaHealthRepository(this.db);
    const bestPhotosRepository = new BestPhotosRepository(this.db);
    const duplicateRepository = new DuplicateRepository(this.db);
    const storageNormalization = new ForkStorageNormalizationService(this.db);
    this.registerHandler('privacy', (ids) => privacyRepository.backfillPrivacy(ids));
    this.registerHandler('albums', (ids) => albumRepository.backfillAlbums(ids));
    this.registerHandler('enrichment', (ids) => enrichmentRepository.backfillEnrichment(ids));
    this.registerHandler('automation', (ids) => automationRepository.backfillAutomation(ids));
    this.registerHandler('health', async (ids) => {
      const health = await mediaHealthRepository.backfillHealth(ids);
      const scores = await bestPhotosRepository.backfillScores(ids);
      const frames = await duplicateRepository.backfillVideoDuplicateFrames(ids);
      return {
        count: ids.length,
        digest: digestValue({ health: health.tables, scores: scores.tables, frames: frames.tables }),
      };
    });
    this.registerHandler('storage', (ids, claim) => storageNormalization.normalizeBatch(ids, claim));
    this.registerHandler('checksum', (ids, claim) => storageNormalization.normalizeBatch(ids, claim));
  }

  registerHandler(kind: BackfillKind, handler: BackfillBatchHandler): void {
    if (this.handlers.has(kind)) {
      throw new Error(`Backfill handler already registered for ${kind}`);
    }
    this.handlers.set(kind, handler);
  }

  async status(): Promise<ForkSchemaMigrationStatus> {
    const [state, storedProgress] = await Promise.all([
      this.forkSchemaRepository.getState(),
      this.forkSchemaRepository.getProgress(),
    ]);
    const byKind = new Map(storedProgress.map((item) => [item.kind, item]));
    const progress = BACKFILL_KINDS.map(
      (kind): BackfillProgress =>
        byKind.get(kind) ?? {
          kind,
          cursor: null,
          processed: 0,
          remaining: 0,
          digest: null,
          lastError: null,
        },
    );
    const verified =
      storedProgress.length === BACKFILL_KINDS.length &&
      new Set(storedProgress.map(({ kind }) => kind)).size === BACKFILL_KINDS.length &&
      storedProgress.every(({ lastError, remaining }) => remaining === 0 && lastError === null);

    return { ...state, progress, verified };
  }

  verify(): Promise<ForkSchemaMigrationStatus> {
    return this.status();
  }

  async activateAfterReturnReconciliation(): Promise<ForkSchemaMigrationStatus> {
    await this.forkSchemaRepository.activateAfterReturnReconciliation();
    return this.status();
  }

  /**
   * FL-44: make a library the official server created a full Frameleaf library, ready for `start`.
   * Holds the migrations lock so no server boot migrates at the same time.
   */
  async adopt(): Promise<ForkSchemaAdoptionStatus> {
    const adoption = await this.databaseRepository.withLock(DatabaseLock.Migrations, () =>
      this.databaseRepository.adoptOfficialOrigin(),
    );
    return { ...(await this.status()), adoption };
  }

  /**
   * FL-289: swapping the container image is the whole upgrade, so the API worker starts the
   * compatibility backfill by itself once the queues exist. Only a backfill that never started is
   * started; an operator pause and every later phase are left alone. Never fails startup.
   */
  @OnEvent({ name: 'AppBootstrap', priority: BootstrapEventPriority.ForkSchemaAutoStart, workers: [ImmichWorker.Api] })
  async onBootstrap(): Promise<void> {
    let outcome: InitialBackfillResult['outcome'];
    try {
      ({ outcome } = await this.forkSchemaRepository.beginInitialBackfill());
    } catch (error) {
      this.logger.warn(
        `Could not check whether the Frameleaf backfill should start (${errorMessage(error)}); it will be checked again at the next start`,
      );
      return;
    }

    if (outcome === 'paused') {
      this.logger.log('The Frameleaf backfill is paused; run `immich-admin fork-schema resume` to continue it');
      return;
    }
    if (outcome !== 'started') {
      return;
    }

    try {
      await this.seedAllKinds(DEFAULT_BATCH_SIZE);
      this.logger.log('The Frameleaf backfill started automatically');
    } catch (error) {
      // Back to "never started" so the next start retries. A batch that already claimed (and so wrote
      // progress) makes the library read as paused instead; `fork-schema resume` continues it.
      await this.forkSchemaRepository.transitionPhase('dual-write', 'legacy').catch(() => false);
      this.logger.warn(
        `The Frameleaf backfill could not be queued (${errorMessage(error)}); it will start at the next start, or run \`immich-admin fork-schema resume\``,
      );
    }
  }

  async start(batchSize = DEFAULT_BATCH_SIZE): Promise<ForkSchemaMigrationStatus> {
    const transitioned = await this.forkSchemaRepository.transitionPhase('legacy', 'dual-write');
    const status = await this.status();
    if (!transitioned && isBackfillFinished(status)) {
      // FL-289: startup normally starts (and finishes) the backfill by itself; an explicit start then
      // reports where it is instead of failing operator scripts.
      return status;
    }
    if (!transitioned && status.phase !== 'dual-write') {
      throw new Error('Backfill can only start from legacy phase');
    }
    await this.seedAllKinds(batchSize);
    return this.status();
  }

  async pause(): Promise<ForkSchemaMigrationStatus> {
    const transitioned = await this.forkSchemaRepository.transitionPhase('dual-write', 'legacy');
    const status = await this.status();
    if (!transitioned && status.phase !== 'legacy') {
      throw new Error('Backfill can only pause from dual-write phase');
    }
    // FL-289: remembered, so startup does not start the backfill again (also a hold before it ever ran).
    await this.forkSchemaRepository.recordBackfillPause();
    this.seedPromise = undefined;
    return status;
  }

  async resume(batchSize = DEFAULT_BATCH_SIZE): Promise<ForkSchemaMigrationStatus> {
    const transitioned = await this.forkSchemaRepository.transitionPhase('legacy', 'dual-write');
    const status = await this.status();
    if (!transitioned && isBackfillFinished(status)) {
      return status;
    }
    if (!transitioned && status.phase !== 'dual-write') {
      throw new Error('Backfill can only resume from legacy phase');
    }
    await this.seedAllKinds(batchSize);
    return this.status();
  }

  async prepareOfficialHandoff(batchSize = DEFAULT_BATCH_SIZE): Promise<ForkSchemaMigrationStatus> {
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
      throw new Error('Backfill batch size must be a positive integer');
    }
    await this.forkSchemaRepository.beginOrResumeOfficialHandoffPreparation();
    // Steady-state backfills preserve physical deduplication. Handing the
    // library to the official image requires the destructive upstream form
    // (per-asset files, SHA-1 checksums, no physical links), so re-run the
    // storage and checksum handlers with handoff claim authority.
    for (const kind of ['storage', 'checksum'] as const) {
      while (true) {
        const claim = await this.forkSchemaRepository.claimOfficialHandoffBatch(kind, batchSize);
        if (!claim) {
          break;
        }
        const handler = this.handlers.get(kind);
        if (!handler) {
          await this.forkSchemaRepository.failBatch(kind, claim.cursor, `No backfill handler registered for ${kind}`);
          throw new Error(`No backfill handler registered for ${kind}`);
        }
        try {
          const result = await handler(claim.ids, { kind, claimToken: claim.cursor, claimedIds: claim.ids });
          await this.forkSchemaRepository.completeBatch(kind, claim.cursor, result.count, result.digest);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await this.forkSchemaRepository.failBatch(kind, claim.cursor, message);
          throw error;
        }
      }
    }
    await this.forkSchemaRepository.completeOfficialHandoffPreparation();
    return this.status();
  }

  async reconcileAfterOfficialReturn(
    batchSize = DEFAULT_BATCH_SIZE,
    hooks: ReturnReconciliationHooks = {},
  ): Promise<ForkSchemaMigrationStatus> {
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
      throw new Error('Backfill batch size must be a positive integer');
    }
    await this.forkSchemaRepository.beginOrResumeReturnReconciliation();
    let configEvidence = await this.forkSchemaRepository.getReturnConfigReconciliation();
    if (!configEvidence) {
      const source = this.configRepository.getEnv().configFile ? 'file' : 'database';
      const effectiveConfig = await this.getConfig({ withCache: false });
      const config = await this.forkConfigRepository.backfillConfig(effectiveConfig, source);
      configEvidence = { ...config, source };
      await hooks.beforeConfigEvidence?.(configEvidence);
      await this.forkSchemaRepository.recordReturnConfigReconciliation(configEvidence);
      await hooks.afterConfigEvidence?.(configEvidence);
    }
    for (const kind of BACKFILL_KINDS) {
      while (true) {
        const claim = await this.forkSchemaRepository.claimReturnBatch(kind, batchSize);
        if (!claim) {
          break;
        }
        const handler = this.handlers.get(kind);
        if (!handler) {
          await this.forkSchemaRepository.failBatch(kind, claim.cursor, `No backfill handler registered for ${kind}`);
          throw new Error(`No backfill handler registered for ${kind}`);
        }
        try {
          const returnClaim =
            kind === 'storage' || kind === 'checksum'
              ? { kind, claimToken: claim.cursor, claimedIds: claim.ids }
              : undefined;
          const result = returnClaim ? await handler(claim.ids, returnClaim) : await handler(claim.ids);
          await this.forkSchemaRepository.completeBatch(kind, claim.cursor, result.count, result.digest);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await this.forkSchemaRepository.failBatch(kind, claim.cursor, message);
          throw error;
        }
        await hooks.afterBatch?.(kind, claim);
      }
      if (kind === 'automation') {
        await this.forkSchemaRepository.finalizeReturnAutomationProgress(configEvidence.digest);
      }
    }
    return this.status();
  }

  @OnJob({ name: JobName.ForkSchemaBackfill, queue: QueueName.BackgroundTask })
  async handleBackfill({ kind, batchSize }: JobOf<JobName.ForkSchemaBackfill>): Promise<JobStatus> {
    return this.runBatch(kind, batchSize);
  }

  async runBatch(kind: BackfillKind, batchSize: number): Promise<JobStatus> {
    const state = await this.forkSchemaRepository.getState();
    if (state.phase !== 'dual-write') {
      return JobStatus.Skipped;
    }

    let claim: BackfillClaim | null;
    try {
      claim = await this.forkSchemaRepository.claimBatch(kind, batchSize);
    } catch (error) {
      if (error instanceof Error && error.message === 'Fork schema backfills can only run in dual-write phase') {
        return JobStatus.Skipped;
      }
      throw error;
    }
    if (!claim) {
      const status = await this.status();
      if (status.phase === 'dual-write' && status.verified) {
        await this.forkSchemaRepository.transitionPhase('dual-write', 'ready');
      }
      return JobStatus.Skipped;
    }

    try {
      const handler = this.handlers.get(kind);
      if (!handler) {
        throw new Error(`No backfill handler registered for ${kind}`);
      }

      const result = await handler(claim.ids);
      await this.forkSchemaRepository.completeBatch(kind, claim.cursor, result.count, result.digest);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.forkSchemaRepository.failBatch(kind, claim.cursor, message);
      return JobStatus.Failed;
    }

    await this.continueOrFinish(kind, batchSize);
    return JobStatus.Success;
  }

  private async seedAllKinds(batchSize: number): Promise<void> {
    if (!this.seedPromise) {
      this.seedPromise = this.jobRepository.queueAll(
        BACKFILL_KINDS.map((kind) => ({ name: JobName.ForkSchemaBackfill, data: { kind, batchSize } })),
      );
    }
    const seedPromise = this.seedPromise;
    try {
      await seedPromise;
    } finally {
      if (this.seedPromise === seedPromise) {
        this.seedPromise = undefined;
      }
    }
  }

  private async continueOrFinish(kind: BackfillKind, batchSize: number): Promise<void> {
    const status = await this.status();
    if (status.phase !== 'dual-write') {
      return;
    }
    if (status.verified) {
      await this.forkSchemaRepository.transitionPhase('dual-write', 'ready');
      return;
    }

    const progress = status.progress.find((item) => item.kind === kind);
    if (progress && progress.remaining > 0 && progress.lastError === null) {
      await this.jobRepository.queue({ name: JobName.ForkSchemaBackfill, data: { kind, batchSize } });
    }
  }
}
