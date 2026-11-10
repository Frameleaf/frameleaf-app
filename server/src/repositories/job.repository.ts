import { Injectable } from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';
import { Kysely, type SelectQueryBuilder, type Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { MessageChannel, Worker, parentPort } from 'node:worker_threads';
import type { ImportConfig, ImportDatabase } from 'src/immich-import/types.js';
import type { DB } from 'src/schema/index.js';
import type { JobCounts, JobItem, JobOf } from 'src/types.js';
import { JOBS_NOT_RETRIED, JOBS_UNSAFE_TO_RERUN_AFTER_STOP, JOBS_WITH_SENSITIVE_DATA } from 'src/constants.js';
import { JobConfig } from 'src/decorators.js';
import { QueueJobResponseDto, QueueJobSearchDto } from 'src/dtos/queue.dto.js';
import {
  JobName,
  JobNameSchema,
  JobStatus,
  MediaOperationKind,
  MetadataKey,
  QueueCleanType,
  QueueJobStatus,
  QueueName,
} from 'src/enum.js';
import { transferImportedWork } from 'src/immich-import/derived-work.js';
import { validatePreparedLibraryImportWork } from 'src/library-import/activation-work.js';
import { type ManagerLibrarySetup, prepareLibraryImportWork } from 'src/library-import/derived-work.js';
import { ReviewedImportContext } from 'src/library-import/reviewed-inputs.js';
import { queueAdmission } from 'src/queue/admission.js';
import { retryLockContention } from 'src/queue/catalogue.js';
import { automaticJobCapacity, clampJobCapacity, readJobCapacity } from 'src/queue/configuration.js';
import { deferJobAdoption, queueExecution } from 'src/queue/context.js';
import { deliverJobObservers } from 'src/queue/observers.js';
import { reportedQueueJobs } from 'src/queue/run-query.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { assertPublicationSource, publicationTransaction } from 'src/queue/transaction.js';
import {
  JobDependencyReason,
  type LibrarySourceIdentity,
  QUEUE_BATCH,
  QUEUE_TIMING,
  QueueClaim,
  QueueDispatch,
  QueueExecution,
  QueueIntent,
  QueueOptions,
  type RunHolds,
  toJobItem,
} from 'src/queue/types.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { ANALYTICS_AUTO_RETRY_DELAY_MS } from 'src/utils/analytics.js';
import { assertAssetSource, readAssetSource } from 'src/utils/asset-source-authority.js';
import { recordStoppedAttempt } from 'src/utils/attempt-evidence.js';
import { DATABASE_POOL_SIZE } from 'src/utils/execution-database.js';
import { FIX_SEARCH_DELAY_MS } from 'src/utils/file-fix.js';
import { forgetLockedClaim, lockedKeyLoadedSinceDeferral } from 'src/utils/locked-read.js';
import { FrameleafStartupError, getKeyByValue } from 'src/utils/misc.js';
import { inheritWorkflowCausation } from 'src/utils/workflow-context.js';

export type QueueJobRow = Omit<QueueJobResponseDto, 'name' | 'account' | 'worker'> & {
  name: JobName;
  status: QueueJobStatus;
};
type JobMapItem = {
  jobName: JobName;
  queueName: QueueName;
  handler: (job: JobOf<any>) => Promise<JobStatus>;
  label: string;
};
export type QueueRun = Awaited<ReturnType<SqlQueueStore['observeQueueRun']>>;
const runSubmission = new AsyncLocalStorage<string>();
const runAdmission = new AsyncLocalStorage<{ intents: QueueIntent[]; open: boolean }>();
const PUBLICATION_FAILURE_REASONS = new Map([
  ['Prepared output source changed', 'prepared_output_source_changed'],
  ['Thumbnail source changed before publication', 'thumbnail_source_changed'],
  ['Video version changed before publication', 'video_version_changed'],
  ['video_version_invalid_paths', 'video_version_invalid_paths'],
  ['Edit operation lost its claim before publication', 'edit_operation_claim_lost'],
  ['Publication lease expired before commit', 'publication_lease_expired'],
]);
/**
 * Producers whose work must commit with the database change it follows, even from inside a queue job: a duplicate
 * decision, and FL-1300's date healing from the cleanup apply job (the sidecar and partner copies of a healed photo).
 */
const COMMITTED_EFFECT_JOBS = new Set<JobName>([
  JobName.DuplicateResolutionLifecycle,
  JobName.SidecarWrite,
  JobName.PartnerPropagate,
]);
// Explicitly audited repeatable jobs. Unclassified external effects fail closed after an ambiguous stop.
const REPEATABLE_JOBS = new Set<JobName>([
  // FL-1300: a scan rewrites its whole snapshot, and an apply resumes from the last change it committed.
  JobName.AlbumCleanupScan,
  JobName.AlbumCleanupApply,
  JobName.DuplicateResolutionLifecycle,
  JobName.DatabaseBackup,
  JobName.AssetGenerateThumbnails,
  JobName.AssetGenerateThumbnailsQueueAll,
  JobName.AssetPaletteExtract,
  JobName.AssetPaletteQueueAll,
  JobName.AssetEditThumbnailGeneration,
  JobName.OcrQueueAll,
  JobName.PetRecognitionQueueAll,
  JobName.PetRecognitionNearest,
  JobName.SmartSearchPostprocess,
  JobName.ImageEnrichmentPostprocess,
  JobName.ImageDescriptionQueueAll,
  JobName.NsfwDetectionQueueAll,
  JobName.AssetEncodeVideo,
  JobName.AssetWarmFilmstrip,
  JobName.SmartSearch,
  JobName.Ocr,
  JobName.BestPhotosScore,
  JobName.AssetExtractMetadata,
  JobName.AssetDetectFaces,
  JobName.FacialRecognition,
  JobName.FacialRecognitionQueueAll,
  JobName.PersonGenerateThumbnail,
  JobName.AssetDetectFacesQueueAll,
  JobName.AssetDetectDuplicates,
  JobName.AssetGenerateVideoDuplicateFrames,
  JobName.AssetDetectDuplicatesQueueAll,
  JobName.AssetGenerateVideoDuplicateFramesQueueAll,
  JobName.AssetVideoFingerprint,
  JobName.AssetVideoFingerprintQueueAll,
  JobName.PetRecognition,
  JobName.VideoMomentCaptions,
  JobName.ImageDescription,
  JobName.NsfwDetection,
  JobName.AssetEncodeVideoQueueAll,
  JobName.SmartSearchQueueAll,
  JobName.AssetExtractMetadataQueueAll,
  JobName.SmartAlbumReevaluateAll,
  JobName.SmartAlbumReevaluate,
  JobName.LandmarkMatchAll,
  JobName.LandmarkInfer,
  // FL-1094: outfits are upserted per face, and only faces without one are encoded
  JobName.AlbumSuggestionOutfit,
  // FL-413: every batch saves the run's cursor; a retry carries on from it
  JobName.IdenticalFilesCheck,
  // a restart mid-batch must not leave the partner card "queued" forever; copies are keyed by
  // source and recipient, so a re-run batch copies nothing twice
  JobName.PartnerBackfill,
  // FL-667: removing a filler tag that is already gone changes nothing, so a re-run is harmless
  JobName.DescriptionFillerTagCleanup,
  // FL-721: every step reads the file's header first (`FLLK`) and replaces it through a temporary file
  JobName.LockedSeal,
  JobName.LockedUnseal,
  JobName.LockedRewrap,
  JobName.LockedSweep,
  // FL-1337: every write checks the asset and finding it read are unchanged, and a repair, relink or
  // kept file is published under a name fixed by the asset and finding, so a re-run reuses its own
  JobName.MediaHealthFixAsset,
]);
/**
 * Requests that are repeatable although their job name is not (the rest of that job's work is unaudited).
 * FL-1337: the fixes' shared search claims its findings under its own search id, so a rerun of a step
 * claims the same ones again; a step only replaces candidate lists and feeds fixes under their own keys.
 */
const isRepeatableRequest = (item: JobItem) =>
  item.name === JobName.MediaHealthLocateMissing && item.data?.pending === true;
/** Rows a selection producer inserts per fenced transaction. */
const SELECTION_PAGE = 2000;
// A dependency that stays down defers every job behind it; say so once per queue and reason, not per job.
const DEFERRAL_WARNING_INTERVAL_MS = 10 * 60_000;

/** Queues whose jobs each name one asset as `data.id`. */
const ASSET_WORK_QUEUES = [
  QueueName.ThumbnailGeneration,
  QueueName.MetadataExtraction,
  QueueName.VideoConversion,
  QueueName.Sidecar,
  QueueName.FaceDetection,
  QueueName.SmartSearch,
  QueueName.Ocr,
  QueueName.DuplicateDetection,
  QueueName.VideoDuplicateDetection,
  QueueName.ImageEnrichment,
  QueueName.ImageDescription,
  QueueName.NsfwDetection,
  QueueName.PetRecognition,
];

@Injectable()
export class JobRepository {
  private handlers: Partial<Record<JobName, JobMapItem>> = {};
  private coordinator?: Worker;
  private stopping?: Promise<void>;
  private active = new Map<string, { abort: AbortController; finished: Promise<void> }>();
  private observerDeliveries = new Set<Promise<void>>();
  private rollingAvgBuffers: Partial<Record<JobName, number[]>> = {};
  private deferralWarnedAt = new Map<string, number>();
  private store: SqlQueueStore;
  /** System config `job.capacity`: 0 is automatic. */
  private capacitySetting = 0;

  constructor(
    private moduleRef: ModuleRef,
    private configRepository: ConfigRepository,
    private eventRepository: EventRepository,
    private logger: LoggingRepository,
    @InjectKysely() db: Kysely<DB>,
  ) {
    this.logger.setContext(JobRepository.name);
    this.store = new SqlQueueStore(db);
  }
  setup(services: (new (...args: any[]) => unknown)[]) {
    const reflector = this.moduleRef.get(Reflector, { strict: false });

    // discovery
    for (const Service of services) {
      const instance = this.moduleRef.get<any>(Service);
      const prototype = Object.getPrototypeOf(instance);
      for (const methodName of Object.getOwnPropertyNames(prototype)) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, methodName);
        if (!descriptor || descriptor.get || descriptor.set) {
          continue;
        }
        const handler = instance[methodName];
        if (typeof handler !== 'function') {
          continue;
        }
        const config = reflector.get<JobConfig>(MetadataKey.JobConfig, handler);
        if (!config) {
          continue;
        }

        const { name: jobName, queue: queueName } = config;
        const label = `${Service.name}.${handler.name}`;

        // one handler per job
        if (Object.hasOwn(this.handlers, jobName)) {
          const jobKey = getKeyByValue(JobName, jobName);
          const errorMessage = `Failed to add job handler for ${label}`;
          this.logger.error(
            `${errorMessage}. JobName.${jobKey} is already handled by ${this.handlers[jobName]!.label}.`,
          );
          throw new FrameleafStartupError(errorMessage);
        }

        this.handlers[jobName] = {
          label,
          jobName,
          queueName,
          handler: handler.bind(instance),
        };

        this.logger.verbose(`Added job handler: ${jobName} => ${label}`);
      }
    }

    // no missing handlers
    for (const [jobKey, jobName] of Object.entries(JobName)) {
      const item = this.handlers[jobName];
      if (!item) {
        const errorMessage = `Failed to find job handler for Job.${jobKey} ("${jobName}")`;
        this.logger.error(
          `${errorMessage}. Make sure to add the @OnJob({ name: JobName.${jobKey}, queue: QueueName.XYZ }) decorator for the new job.`,
        );
        throw new FrameleafStartupError(errorMessage);
      }
    }
  }

  startWorkers() {
    if (this.coordinator) {
      return;
    }
    if (!parentPort) {
      throw new Error('Job execution requires the supervised microservices worker');
    }
    const { port1, port2 } = new MessageChannel();
    const workerId = randomUUID();
    parentPort.postMessage({ type: 'queue-watchdog-port', workerId, port: port1 }, [port1]);
    const capacity = this.getExecutionCapacity();
    this.logger.log(
      `Queue execution capacity: ${capacity.value} jobs across all queues (${capacity.source}; up to ${DATABASE_POOL_SIZE} database sessions)`,
    );
    this.coordinator = new Worker(new URL('../workers/queue-coordinator.js', import.meta.url), {
      workerData: {
        workerId,
        capacity: capacity.value,
        queues: Object.values(QueueName),
        connection: this.configRepository.getEnv().database.config,
        supervisor: port2,
      },
      transferList: [port2],
    });
    this.coordinator.on('message', (message: QueueDispatch | { type: 'unavailable' }) => {
      switch (message.type) {
        case 'execute': {
          const abort = new AbortController();
          const finished = this.execute(message.claim, abort).finally(() => {
            this.active.delete(message.claim.id);
            this.coordinator?.postMessage({ type: 'settled', id: message.claim.id });
          });
          this.active.set(message.claim.id, { abort, finished });
          break;
        }
        case 'cancel': {
          this.active.get(message.id)?.abort.abort(new Error('Job deadline or lease expired'));
          break;
        }
        case 'holdsFailing': {
          this.logger.warn(
            `Held and released jobs are not being updated: ${message.failures} failed attempts in a row` +
              (message.code ? ` (database error ${message.code})` : ''),
          );
          break;
        }
        case 'unavailable': {
          // The coordinator's watchdog owns the outage decision.
          break;
        }
      }
    });
    this.coordinator.on('error', () =>
      this.logger.error('Queue coordinator failed; supervisor will recover the worker'),
    );
  }

  private async execute(claim: QueueClaim, abort: AbortController) {
    const admission = queueAdmission(this.store.db);
    let releaseExecution: (() => void) | undefined;
    let releaseObservers: (() => void) | undefined;
    let started = false;
    let settled = false;
    const context: QueueExecution = {
      claim,
      signal: abort.signal,
      followups: [],
      adoptions: [],
      buffering: false,
      progressUnits: 0,
      progress: (units) => this.coordinator?.postMessage({ type: 'progress', id: claim.id, units }),
    };
    try {
      try {
        if (this.stopping) abort.abort(new Error('Worker stopped'));
        // Backpressure before media work so every committed callback has reserved delivery capacity.
        releaseObservers = await deliverJobObservers.reserve(abort.signal);
        releaseExecution = await admission.execution.acquire(abort.signal);
        abort.signal.throwIfAborted();
        started = true;
        await queueExecution.run(context, () =>
          this.eventRepository.emit('JobRun', claim.queue as QueueName, toJobItem(claim)),
        );
      } finally {
        // Handler/native work has returned; lease expiry alone cannot attest this.
        // Keep this before durable completion, while the watchdog still owns the claim.
        try {
          await recordStoppedAttempt(this.store.db, claim.id, claim.token);
        } catch {
          this.logger.warn('Could not persist stopped-attempt evidence; output cleanup will retain it');
        }
      }
      abort.signal.throwIfAborted();
      if (context.dependencyReason) {
        this.warnDeferral(claim, context.dependencyReason);
        settled = await this.store.defer(claim, context.dependencyReason);
        await this.wakeIfLockedKeyLoaded(claim, context.dependencyReason, settled);
        return;
      }
      if (context.outcome === 'failed') {
        throw new Error('Handler returned Failed');
      }
      // FL-1265: completions run side by side; one that loses a deadlock runs again with its adoption's
      // in-memory effects undone.
      const followups = context.followups.length;
      const afterCommit = context.afterCommit?.length ?? 0;
      settled = await retryLockContention(
        abort.signal,
        () =>
          queueExecution.run(context, () =>
            this.store.complete(claim, context.followups, async (tx) => {
              await publicationTransaction.run(tx, async () => {
                context.buffering = true;
                for (const adopt of context.adoptions) {
                  await adopt(tx);
                }
                abort.signal.throwIfAborted();
              });
            }),
          ),
        () => {
          context.followups.length = followups;
          if (context.afterCommit) context.afterCommit.length = afterCommit;
        },
      );
      if (settled) {
        // Native execution can settle while the reserved callback chain drains independently.
        const release = releaseObservers;
        releaseObservers = undefined;
        const drained = Promise.withResolvers<void>();
        this.observerDeliveries.add(drained.promise);
        void deliverJobObservers(
          context.afterCommit ?? [],
          () => this.logger.warn('Accepted job observer delivery unavailable'),
          () => {
            release();
            this.observerDeliveries.delete(drained.promise);
            drained.resolve();
          },
        ).catch(() => {});
        const buffer = (this.rollingAvgBuffers[claim.name as JobName] ??= []);
        buffer.push(Date.now() - new Date(claim.startedAt).getTime());
        if (buffer.length > 100) {
          buffer.shift();
        }
      }
    } catch (error) {
      if (context.dependencyReason) {
        // A dependency refusal is a wait, not a failure, and repeats for every job behind it.
        this.warnDeferral(claim, context.dependencyReason);
      } else {
        this.logExecutionFailure(claim, context, abort, error);
      }
      try {
        if (!started || context.dependencyReason) {
          // No handler ran on an admission refusal, even for unsafe/operation-owned jobs.
          // A rejected fence can only settle below with matching stop proof; never invent a new claim.
          settled = await this.store.defer(claim, context.dependencyReason ?? 'local-capacity');
          await this.wakeIfLockedKeyLoaded(claim, context.dependencyReason, settled);
          return;
        }
        settled = await retryLockContention(undefined, () =>
          this.store.fail(
            claim,
            error instanceof Error ? error.message : 'Job failed',
            context.failureDiagnostics?.length
              ? async (tx) =>
                  publicationTransaction.run(tx, async () => {
                    for (const publish of context.failureDiagnostics!) await publish(tx);
                  })
              : undefined,
            { settlements: context.failureSettlements, interrupted: !!this.stopping && abort.signal.aborted },
          ),
        );
      } catch {
        // No successful database outcome was observed. Lease recovery owns this claim.
        this.logger.error('Could not persist job outcome; lease recovery is pending');
      }
    } finally {
      if (!settled) {
        try {
          // The database fence can observe cancellation before the coordinator's abort arrives.
          // Settle only this stopped claim, never publish its rejected output or rerun its handler.
          // A deferred operation also needs this handoff when expiry alone rejected publication.
          await retryLockContention(undefined, () =>
            this.store.fail(claim, 'Job deadline or cancellation requested', undefined, {
              stopRequestedOnly: !context.failureSettlements?.length,
              interrupted: !!this.stopping && abort.signal.aborted,
              settlements: context.failureSettlements,
            }),
          );
        } catch {
          this.logger.error('Could not persist stopped job outcome; lease recovery is pending');
        }
      }
      // FL-721 M2: the Locked wait this execution recorded ends with it
      forgetLockedClaim(claim.id);
      releaseExecution?.();
      releaseObservers?.();
    }
  }

  private logExecutionFailure(claim: QueueClaim, context: QueueExecution, abort: AbortController, error: unknown) {
    try {
      const code =
        error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
      const message =
        error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'message')?.value : undefined;
      const sqlState = typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
      this.logger.error('Queue execution failed', {
        jobName: Object.values(JobName).includes(claim.name as JobName) ? claim.name : 'unknown',
        queue: Object.values(QueueName).includes(claim.queue as QueueName) ? claim.queue : 'unknown',
        attempt: Number.isSafeInteger(claim.attempt) && claim.attempt >= 0 ? claim.attempt : null,
        jobId: /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(claim.id) ? claim.id : null,
        phase: context.buffering ? 'deferred_publication' : 'handler',
        category: sqlState ? 'database' : error instanceof Error ? 'error' : 'unknown',
        reasonCode:
          typeof message === 'string' ? (PUBLICATION_FAILURE_REASONS.get(message) ?? 'other_error') : 'other_error',
        sqlState,
        aborted: abort.signal.aborted,
      });
    } catch {
      // A diagnostic failure must not replace the original durable job outcome.
    }
  }

  /**
   * FL-721 (spec §15, "jobs run on the next unlock"): a job deferred for a Locked key whose owner's key
   * loaded while it ran (before or after it recorded the wait) missed that load's wake-up, so it is
   * woken now that its deferral is written. A key that loads after this point wakes it itself.
   */
  private async wakeIfLockedKeyLoaded(claim: QueueClaim, reason: JobDependencyReason | undefined, settled: boolean) {
    if (reason !== 'locked-key-unavailable' || !lockedKeyLoadedSinceDeferral(claim.id) || !settled) {
      return;
    }
    try {
      await this.store.wakeDeferred([claim.id], 'locked-key-unavailable');
    } catch {
      this.logger.warn('Could not wake a job whose Locked key loaded while it ran; it runs within the hour');
    }
  }

  private warnDeferral(claim: QueueClaim, reason: JobDependencyReason) {
    const queue = Object.values(QueueName).includes(claim.queue as QueueName) ? claim.queue : 'unknown';
    const key = `${queue}:${reason}`;
    const now = Date.now();
    if (now - (this.deferralWarnedAt.get(key) ?? 0) < DEFERRAL_WARNING_INTERVAL_MS) {
      return;
    }
    this.deferralWarnedAt.set(key, now);
    try {
      this.logger.warn(`Jobs in the ${queue} queue are waiting (${reason}); they retry automatically`);
    } catch {
      // A diagnostic failure must not replace the deferral.
    }
  }

  stopWorkers(graceMs: number): Promise<void> {
    this.stopping ??= this.stopOnce(graceMs);
    return this.stopping;
  }

  private async stopOnce(graceMs: number) {
    this.coordinator?.postMessage({ type: 'stop' });
    await Promise.race([
      Promise.allSettled(this.active.values().map(({ finished }) => finished)).then(() =>
        Promise.allSettled(this.observerDeliveries),
      ),
      sleep(graceMs),
    ]);
    for (const { abort } of this.active.values()) {
      abort.abort(new Error('Worker stopped'));
    }
    // A still-running handler retains its claim until the supervisor terminates this worker.
    // Never release a live handler's lease and allow a second execution owner.
    if (this.active.size === 0) {
      await this.coordinator?.terminate();
      this.coordinator = undefined;
    }
  }

  teardown() {}
  watchWorkers() {} // Worker availability comes from durable PostgreSQL heartbeat rows.

  async run({ name, data }: JobItem) {
    const handler = this.handlers[name];
    if (!handler) {
      throw new Error(`No handler for ${name}`);
    }
    const response = await handler.handler(data);
    const context = queueExecution.getStore();
    if (context) {
      context.outcome = response === JobStatus.Failed ? 'failed' : 'completed';
    }
    return response;
  }

  /** Metadata extraction of an import's own run keeps what the import brought. */
  async isImportedMetadataJob(): Promise<boolean> {
    const claim = queueExecution.getStore()?.claim;
    if (!claim || claim.name !== JobName.AssetExtractMetadata) return false;
    const {
      rows: [row],
    } = await sql<{ preserve: boolean }>`select exists (select 1 from job_run r where r.id=${claim.runId}::uuid
        and r.kind in ('immich-import-derived','library-import-derived')) as preserve`.execute(
      publicationTransaction.getStore() ?? this.store.db,
    );
    if (typeof row?.preserve !== 'boolean') throw new Error('Imported metadata context unavailable');
    return row.preserve;
  }

  async collectFollowups(action: () => Promise<void>) {
    const context = queueExecution.getStore();
    if (!context) {
      return action();
    }
    const collection = (context.followupCollection ??= { active: 0, buffering: context.buffering });
    collection.active++;
    context.buffering = true;
    try {
      await action();
    } finally {
      if (--collection.active === 0) {
        context.buffering = collection.buffering;
        delete context.followupCollection;
      }
    }
  }

  getRollingAvgMs(name: JobName) {
    const buffer = this.rollingAvgBuffers[name];
    return buffer?.length ? buffer.reduce((sum, value) => sum + value, 0) / buffer.length : null;
  }

  setConcurrency(name: QueueName, concurrency: number) {
    void this.store
      .setConcurrency(name, concurrency)
      .catch(() => this.logger.error(`Unable to configure queue ${name}`));
  }
  async isActive(name: QueueName) {
    return (await this.store.counts(name)).active > 0;
  }
  isPaused(name: QueueName) {
    return this.store.isPaused(name);
  }
  pause(name: QueueName) {
    return this.store.pause(name, true);
  }
  /** Clears the pause only; quiet hours and holds are separate (queue.service emits `QueueResumed`). */
  resume(name: QueueName) {
    return this.store.pause(name, false);
  }
  /** FL-1265 quiet hours: the queue claims nothing new until `closedUntil`; null opens it. */
  setQueueSchedule(name: QueueName, closedUntil: Date | null) {
    return this.store.setSchedule(name, closedUntil);
  }
  getQueueSchedule(name: QueueName) {
    return this.store.getSchedule(name);
  }
  /** FL-1265: `FRAMELEAF_JOB_CAPACITY` wins; otherwise the `job.capacity` setting, 0 meaning automatic. */
  getExecutionCapacity(): { value: number; source: 'environment' | 'setting' | 'automatic' } {
    const environment = readJobCapacity();
    if (environment !== undefined) return { value: environment, source: 'environment' };
    if (this.capacitySetting > 0) return { value: clampJobCapacity(this.capacitySetting), source: 'setting' };
    return { value: automaticJobCapacity(), source: 'automatic' };
  }
  /** Applies at once, without a restart: running jobs finish, then at most the new capacity runs. */
  setExecutionCapacity(setting: number) {
    this.capacitySetting = Number.isFinite(setting) && setting > 0 ? setting : 0;
    const { value } = this.getExecutionCapacity();
    queueAdmission(this.store.db).execution.resize(value);
    this.coordinator?.postMessage({ type: 'capacity', value });
  }
  empty(name: QueueName) {
    return this.store.clear(name, ['pending', 'waiting']);
  }
  /** Removed items' waiting work in the queues that process one item at a time: none of it can run any more. */
  async cancelAssetJobs(assetIds: string[]) {
    if (assetIds.length === 0) {
      return;
    }
    for (const queue of ASSET_WORK_QUEUES) {
      await this.store.clear(queue, ['pending', 'waiting'], assetIds);
    }
    // facial recognition names a face, and the items' faces go with them
    const { rows: faces } = await sql<{ id: string }>`select id from asset_face
      where "assetId" = any(${assetIds}::uuid[])`.execute(this.store.db);
    await this.store.clear(
      QueueName.FacialRecognition,
      ['pending', 'waiting'],
      faces.map((face) => face.id),
    );
  }
  clear(name: QueueName, _type: QueueCleanType) {
    return this.store.clear(name, ['failed', 'needs_attention', 'blocked']);
  }
  /** Generic run retry (the import Retry). The caller commits, then calls `forgetRunReads`. */
  retryImportedWork(runId: string, db: Kysely<DB>) {
    return this.store.retryRun(runId, db);
  }
  /** Writes the run's holds; the coordinator applies them to its jobs after commit. */
  setRunHolds(runId: string, holds: RunHolds, db: Kysely<DB> = this.store.db) {
    return this.store.setRunHolds(runId, holds, db);
  }
  releaseRun(runId: string) {
    return this.store.releaseRun(runId);
  }
  runHasLiveWork(runId: string, options?: { ignoreParked?: boolean }, db?: Kysely<DB>) {
    return this.store.runHasLiveWork(runId, options, db);
  }
  async getRunStageProgress(
    runId: string,
  ): Promise<Array<{ name: JobName; queue: QueueName; total: number; done: number }>> {
    return (await this.store.runStageProgress(runId)).flatMap(({ name, total, done }) => {
      const handler = this.handlers[name as JobName];
      return handler ? [{ name: name as JobName, queue: handler.queueName, total, done }] : [];
    });
  }

  forgetRunReads() {
    this.store.forgetRunReads();
  }
  /** Every failed job of the queue, or only `jobId`; returns how many went back. */
  retryFailed(name: QueueName, jobId?: string) {
    return this.store.retryFailed(name, jobId);
  }
  /** Start now: the job is claimed at the next pass, even while its queue is paused or full. */
  startNow(name: QueueName, jobId: string) {
    return this.store.startNow(name, jobId);
  }
  findOpenJob(queue: QueueName, name: JobName, itemId: string) {
    return this.store.findOpenJob(queue, name, itemId);
  }
  /** FL-721: jobs deferred for a Locked key run now; their owner's key has just been loaded. */
  wakeLockedDeferrals(ids: string[]) {
    return this.store.wakeDeferred(ids, 'locked-key-unavailable');
  }
  getJobCounts(name: QueueName): Promise<JobCounts> {
    return this.store.counts(name);
  }
  /** Held work counts unless `includeHeld` is false. */
  hasUnfinishedWork(name: QueueName, options: { includeHeld?: boolean } = {}): Promise<boolean> {
    return this.store.hasUnfinishedWork(name, options.includeHeld ?? true);
  }
  /** The paused queues, read once for a snapshot of every queue. */
  getPausedQueues(): Promise<Set<string>> {
    return this.store.pausedQueues();
  }
  /** Which of these queues have unfinished work, in one round trip. */
  async getQueuesWithUnfinishedWork(names: readonly QueueName[]): Promise<Set<string>> {
    return new Set(await this.store.queuesWithUnfinishedWork(names));
  }
  hasDedupJob(name: QueueName, id: string) {
    return this.store.hasDedup(name, id);
  }
  getQueueName(name: JobName): QueueName {
    return (this.handlers[name] as JobMapItem).queueName;
  }

  observeQueueRun(name: QueueName): Promise<QueueRun> {
    return this.store.observeQueueRun(name);
  }

  /**
   * Prepare queue()/queueAll() intents without holding a database transaction during validation or I/O.
   * Only their admission is atomic; callbacks must not publish other effects or start detached work.
   */
  async createRun(kind: string, selection: Record<string, unknown>, enqueue: () => Promise<void>) {
    if (runAdmission.getStore()) throw new Error('Run admission cannot be nested');
    const id = randomUUID();
    const admission = { intents: [] as QueueIntent[], open: true };
    try {
      await runSubmission.run(id, () => runAdmission.run(admission, enqueue));
    } finally {
      admission.open = false;
    }
    const context = queueExecution.getStore();
    context?.signal.throwIfAborted();
    const admit = (tx: Transaction<DB>) => this.store.admitRun(id, kind, selection, admission.intents, tx);
    if (context?.buffering) {
      // The run and its parent-dependent intents become visible only with successful publication.
      context.adoptions.push(async (tx) => void (await admit(tx)));
      return id;
    }
    // Work already queued for these intents answers with its own run.
    return (await this.fenced(context, admit)).runId;
  }

  /**
   * One transaction fenced by the current claim (when inside a job): the claim is locked before `work` and still
   * held after it, or nothing commits.
   */
  private fenced<T>(context: QueueExecution | undefined, work: (tx: Transaction<DB>) => Promise<T>): Promise<T> {
    context?.signal.throwIfAborted();
    const claimHeld = (tx: Transaction<DB>, lock: boolean) =>
      sql`select id from job where id = ${context!.claim.id}::uuid and token = ${context!.claim.token}::uuid
        and state = 'active' and "leaseExpiresAt" > clock_timestamp() and "cancelRequestedAt" is null
        ${lock ? sql`for update` : sql``}`.execute(tx);
    return this.store.db.transaction().execute(async (tx) => {
      if (context && (await claimHeld(tx, true)).rows.length === 0) throw new Error('Producer lost its claim');
      const value = await work(tx);
      if (context) {
        context.signal.throwIfAborted();
        if ((await claimHeld(tx, false)).rows.length === 0) throw new Error('Producer lost its claim');
      }
      return value;
    });
  }

  listRuns(take: number, skip: number) {
    return this.store.listRuns(take, skip);
  }

  getRun(runId: string) {
    return this.store.getRun(runId);
  }

  listRunItems(runId: string, take: number, skip: number) {
    return this.store.listRunItems(runId, take, skip);
  }

  private intent(item: JobItem): QueueIntent {
    const context = queueExecution.getStore();
    const runId = runSubmission.getStore() ?? context?.claim.runId ?? undefined;
    const data = inheritWorkflowCausation((item.data ?? {}) as Record<string, unknown>);
    const queue = this.getQueueName(item.name);
    const isMl = [
      QueueName.SmartSearch,
      QueueName.FaceDetection,
      QueueName.ImageDescription,
      QueueName.ImageEnrichment,
      QueueName.NsfwDetection,
      QueueName.Ocr,
      QueueName.PetRecognition,
    ].includes(queue);
    const options = this.getNamedJobOptions(item) ?? undefined;
    const subject = String(data.id ?? data.assetId ?? createHash('sha256').update(JSON.stringify(data)).digest('hex'));
    // A job with its own identity (one per workflow execution, one per album recipient) is its own run item:
    // keyed by subject alone, the second one would hit job_run_stage and be dropped.
    const identity =
      options?.deduplication?.id ??
      options?.jobId ??
      (item.name === JobName.LandmarkInfer ? item.data?.trigger : undefined);
    // One run can publish an asset's files more than once. A completed seal must not consume a
    // later publication's obligation; live deduplication still coalesces sealing by asset.
    const publication =
      item.name === JobName.LockedSeal && context
        ? `/publication/${createHash('sha256')
            .update(JSON.stringify([context.claim.id, context.claim.token]))
            .digest('hex')}`
        : '';
    return {
      name: item.name,
      data,
      queue,
      options,
      safeToRetry:
        !data.operationId &&
        !(
          item.name === JobName.ImageEnrichmentPostprocess &&
          (data.cloudDescription || (Array.isArray(data.lockedIds) && data.lockedIds.length > 0))
        ) &&
        (REPEATABLE_JOBS.has(item.name) || isRepeatableRequest(item)) &&
        !JOBS_UNSAFE_TO_RERUN_AFTER_STOP.has(item.name) &&
        !JOBS_NOT_RETRIED.has(item.name),
      sensitive: JOBS_WITH_SENSITIVE_DATA.has(item.name),
      deadlineMs: isMl ? QUEUE_TIMING.mlDeadline : QUEUE_TIMING.opaqueDeadline,
      runId,
      itemKey: runId
        ? subject +
          (identity && identity !== subject ? `/${identity}` : '') +
          publication +
          (item.name === JobName.FacialRecognition && data.deferred ? '/deferred' : '')
        : undefined,
      rootItemKey: context?.claim.rootItemKey ?? null,
      parentId: context?.buffering ? context.claim.id : undefined,
    };
  }

  /** The run of the current producer job; a producer started outside a run gets one of its own. */
  async ensureProducerRun(): Promise<string | undefined> {
    const context = queueExecution.getStore();
    if (!context) return;
    if (context.claim.runId) return context.claim.runId;
    const runId = randomUUID();
    const itemKey = `producer/${context.claim.id}`;
    await this.fenced(context, async (tx) => {
      await sql`insert into job_run(id, kind, selection, "enumerationDone")
        values (${runId}::uuid, ${context.claim.name}, '{}'::jsonb, true)`.execute(tx);
      await sql`update job set "runId" = ${runId}::uuid, "itemKey" = ${itemKey}
        where id = ${context.claim.id}::uuid and token = ${context.claim.token}::uuid`.execute(tx);
    });
    context.claim.runId = runId;
    context.claim.itemKey = itemKey;
    return runId;
  }

  /** Persist small database-only producer setup with its claim. No network or file I/O may enter this callback. */
  async prepareCheckpoint<T>(key: string, prepare: () => Promise<T>): Promise<T> {
    const context = queueExecution.getStore();
    if (!context) return prepare();
    const { claim } = context;
    return this.store.db.transaction().execute(async (tx) => {
      const {
        rows: [job],
      } = await sql<{ checkpoints: Record<string, T> | null }>`select data->'_producerCheckpoints' checkpoints
        from job where id = ${claim.id}::uuid and token = ${claim.token}::uuid and state = 'active'
        and "leaseExpiresAt" > clock_timestamp() and "cancelRequestedAt" is null for update`.execute(tx);
      if (!job) throw new Error('Producer checkpoint lost its claim');
      if (job.checkpoints && Object.hasOwn(job.checkpoints, key)) return job.checkpoints[key];
      const value = await publicationTransaction.run(tx, prepare);
      const { rows } = await sql`update job set data = jsonb_set(data, '{_producerCheckpoints}',
        coalesce(data->'_producerCheckpoints', '{}'::jsonb) || jsonb_build_object(${key}::text, ${JSON.stringify(value)}::text::jsonb))
        where id = ${claim.id}::uuid and token = ${claim.token}::uuid and "leaseExpiresAt" > clock_timestamp()
          and "cancelRequestedAt" is null returning id`.execute(tx);
      if (rows.length === 0) throw new Error('Producer checkpoint lost its claim');
      return value;
    });
  }

  /** A library scan's run (its operation id) exists before its first batch; idempotent. */
  private async openLibraryScanRun(tx: Transaction<DB>, identity: LibrarySourceIdentity) {
    await sql`insert into job_run(id, kind, selection, "enumerationDone") values (${identity.operationId}::uuid,
      ${MediaOperationKind.LibraryScan}, ${JSON.stringify({ libraryId: identity.libraryId })}::text::jsonb, false)
      on conflict do nothing`.execute(tx);
  }

  /** A queue producer cannot leave a new domain scan behind after losing its own acceptance fence. */
  async prepareLibraryScanSource<T>(
    libraryId: string,
    create: (tx: Transaction<DB>) => Promise<{ operationId: string; value: T }>,
  ): Promise<T> {
    if (runAdmission.getStore() || publicationTransaction.getStore())
      throw new Error('Library submission requires its own fenced transaction');
    return this.fenced(queueExecution.getStore(), async (tx) => {
      const { operationId, value } = await create(tx);
      await this.openLibraryScanRun(tx, { operationId, libraryId });
      return value;
    });
  }

  /** The scan's run, for an operation that is still active. */
  async ensureLibraryScanSource(identity: LibrarySourceIdentity, _attachOrigin = true): Promise<void> {
    if (runAdmission.getStore() || publicationTransaction.getStore())
      throw new Error('Library source setup requires its own fenced transaction');
    await this.fenced(queueExecution.getStore(), async (tx) => {
      const { rows } = await sql`select id from media_operation where id = ${identity.operationId}::uuid
        and kind = ${MediaOperationKind.LibraryScan} and snapshot->>'libraryId' = ${identity.libraryId}
        and status not in ('completed','failed','cancelled') for update`.execute(tx);
      if (rows.length === 0) throw new Error('Library source operation is no longer active');
      await this.openLibraryScanRun(tx, identity);
    });
  }

  /**
   * Assets a scan batch imports and their processing jobs commit together (FL-1265: they run at once, before the scan
   * ends). `close` marks the scan's enumeration done.
   */
  async commitLibraryScanBatch<T>(
    identity: LibrarySourceIdentity,
    examined: number,
    work: (tx: Transaction<DB>) => Promise<{ value: T; assetIds: string[]; accepted: boolean }>,
    close = false,
  ): Promise<T> {
    if (!Number.isSafeInteger(examined) || examined < 0 || examined > QUEUE_BATCH)
      throw new Error('Library acceptance is limited to 250 examined items');
    if (runAdmission.getStore() || publicationTransaction.getStore())
      throw new Error('Library acceptance cannot nest publication transactions');
    return this.fenced(queueExecution.getStore(), async (tx) => {
      const { value, assetIds, accepted } = await work(tx);
      if (!accepted) return value;
      if (assetIds.length > QUEUE_BATCH) throw new Error('Library acceptance is limited to 250 source intents');
      await this.openLibraryScanRun(tx, identity);
      const intents = assetIds.map((id) => ({
        ...this.intent({ name: JobName.SidecarCheck, data: { id, source: 'upload' } }),
        runId: identity.operationId,
        itemKey: id,
        rootItemKey: id,
        parentId: undefined,
      }));
      await this.store.enqueue(intents, tx, identity.operationId);
      if (close && value) await this.store.finishEnumeration(identity.operationId, tx);
      return value;
    });
  }

  /** Terminal control: the update callback must fence the exact domain claim. Jobs already queued keep running. */
  async settleLibraryScanSource<T>(operationId: string, update: (tx: Transaction<DB>) => Promise<T>): Promise<T> {
    return this.store.db.transaction().execute(async (tx) => {
      const outcome = await update(tx);
      await this.store.finishEnumeration(operationId, tx);
      return outcome;
    });
  }

  /** Scans ended by domain recovery or cancellation without a live worker: their runs may finish. */
  settleTerminalLibrarySources(): Promise<number> {
    return this.store.settleTerminalLibrarySources();
  }

  /**
   * FL-1265: inserts the selected items as jobs of the producer's run, a keyset page per fenced transaction; the page
   * cursor is saved with the producer, so a retried producer carries on. Identical requests coalesce into live jobs.
   */
  async queueSelection(
    name: JobName,
    selection:
      | SelectQueryBuilder<any, any, { id: string }>
      | ((after: string | null) => SelectQueryBuilder<any, any, { id: string }>),
    data: Record<string, unknown> = {},
    pageSize = SELECTION_PAGE,
  ): Promise<{ runId: string; inserted: number }> {
    if (runAdmission.getStore()) throw new Error('Run admission supports queue/queueAll, not queueSelection');
    const context = queueExecution.getStore();
    const submitted = runSubmission.getStore();
    const producerRun = submitted ?? (await this.ensureProducerRun());
    const intent = this.intent({ name, data } as JobItem);
    let inserted = 0;
    const selectPage = (after: string | null) => (typeof selection === 'function' ? selection(after) : selection);
    if (!context) {
      // Nothing would resume a partial selection: it is inserted in one transaction.
      return this.store.db.transaction().execute(async (tx) => {
        const runId = producerRun ?? randomUUID();
        if (!producerRun) {
          await sql`insert into job_run(id, kind, selection, "enumerationDone")
            values (${runId}::uuid, ${name}, '{}'::jsonb, true)`.execute(tx);
        }
        for (let after: string | null = null; ;) {
          const page = await this.store.insertSelectionPage(
            { ...intent, runId },
            selectPage(after),
            after,
            pageSize,
            tx,
          );
          inserted += page.inserted;
          after = page.last;
          if (after === null) return { runId, inserted };
        }
      });
    }
    const runId = producerRun!;
    const cursors = context.claim.data._selectionCursor as
      Record<string, { after: string | null; done: boolean; inserted?: number }> | undefined;
    const checkpoint = cursors?.[name];
    inserted = checkpoint?.inserted ?? 0;
    if (checkpoint?.done) return { runId, inserted };
    let after = checkpoint?.after ?? null;
    do {
      const page = await this.fenced(context, async (tx) => {
        const page = await this.store.insertSelectionPage({ ...intent, runId }, selectPage(after), after, pageSize, tx);
        await sql`update job set data = jsonb_set(data, '{_selectionCursor}', coalesce(data->'_selectionCursor', '{}'::jsonb)
          || jsonb_build_object(${name}::text, jsonb_build_object('after', ${page.last}::text, 'done', ${page.last === null},
            'inserted', ${inserted + page.inserted}::int)))
          where id = ${context.claim.id}::uuid and token = ${context.claim.token}::uuid`.execute(tx);
        return page;
      });
      inserted += page.inserted;
      after = page.last;
      context.progress(++context.progressUnits);
    } while (after !== null);
    return { runId, inserted };
  }

  /**
   * Snapshot source identity before I/O, then recheck it under the accepted publication lock.
   *
   * `derivatives: false` fences only the asset's original, owner, privacy and lock. It is for a
   * publication that owns its derived files and recipe and re-validates them in its own
   * transaction (a retained video version): another save or a regenerated thumbnail while it
   * renders is decided there (superseded or published), not refused here and rendered again.
   */
  async guardAssetSource(assetId: string, { derivatives = true }: { derivatives?: boolean } = {}) {
    if (!queueExecution.getStore()) {
      return;
    }
    const context = queueExecution.getStore()!;
    const source = await readAssetSource(publicationTransaction.getStore() ?? this.store.db, assetId, derivatives);
    if (!source) return;
    const assertCurrent = (tx?: Transaction<DB>) =>
      assertAssetSource(tx ?? publicationTransaction.getStore() ?? this.store.db, source);
    (context.sourceAuthorities ??= new Map()).set(assetId, {
      ownerId: source.ownerId,
      snapshot: source,
      assertCurrent,
    });
    deferJobAdoption(async () => {
      await assertPublicationSource(assetId, Buffer.from(source.checksum, 'hex'));
      await assertCurrent();
    });
  }

  /**
   * Whether the preview a job waits for can still arrive. A job of a run whose own thumbnail item for the asset
   * has ended waits for nothing: that original made no preview (damaged or unsupported) and never will, so it
   * fails like any other per-item failure instead of waiting forever and keeping the run, and an import's setup,
   * open. Outside a run, or with no thumbnail item in it, the job keeps waiting.
   */
  async previewMayArrive(assetId: string): Promise<boolean> {
    const runId = queueExecution.getStore()?.claim.runId;
    if (!runId) return true;
    const { rows } = await sql<{
      live: boolean;
    }>`select state in ('pending','waiting','active') live from job
      where "runId" = ${runId}::uuid and "itemKey" = ${assetId} and name = ${JobName.AssetGenerateThumbnails}`.execute(
      publicationTransaction.getStore() ?? this.store.db,
    );
    return rows[0]?.live ?? true;
  }

  /** Persist before admission. A retry keeps its original destination even if routing changes. */
  /**
   * FL-456: the destination this job already pinned for `workload`, if any, without pinning one. Outside
   * a queued job there is none.
   */
  async pinnedDestination(workload: string): Promise<string | null> {
    const context = queueExecution.getStore();
    if (!context) {
      return null;
    }
    context.signal.throwIfAborted();
    const {
      rows: [row],
    } = await sql<{ destination: string | null }>`select data->'_queueDestinations'->>${workload}::text as destination
      from job where id = ${context.claim.id}::uuid and token = ${context.claim.token}::uuid`.execute(this.store.db);
    return row?.destination ?? null;
  }

  async pinDestination(workload: string, destinationId: string): Promise<string> {
    const context = queueExecution.getStore();
    if (!context) {
      return destinationId;
    }
    context.signal.throwIfAborted();
    const {
      rows: [row],
    } = await sql<{ destination: string }>`update job set data = jsonb_set(data,
      '{_queueDestinations}', coalesce(data->'_queueDestinations', '{}'::jsonb) ||
      jsonb_build_object(${workload}::text, coalesce(data->'_queueDestinations'->>${workload}, ${destinationId})))
      where id = ${context.claim.id}::uuid and token = ${context.claim.token}::uuid and state = 'active'
      and "leaseExpiresAt" > clock_timestamp() and "cancelRequestedAt" is null
      returning data->'_queueDestinations'->>${workload} as destination`.execute(this.store.db);
    if (!row) {
      throw new Error('Destination admission lost its claim');
    }
    return row.destination;
  }

  /** Database-only producer already holding its domain claim; admission commits with that publication. */
  async queueInTransaction(tx: Transaction<DB>, item: JobItem, runId?: string): Promise<void> {
    if (runAdmission.getStore()) throw new Error('Run admission cannot use an independent transaction');
    const context = queueExecution.getStore();
    const committedEffect = COMMITTED_EFFECT_JOBS.has(item.name);
    if (context && !committedEffect) throw new Error('Queue-owned producers must use their completion transaction');
    if (context) {
      context.signal.throwIfAborted();
      const { rows } =
        await sql`select id from job where id = ${context.claim.id}::uuid and token = ${context.claim.token}::uuid and state = 'active' and "leaseExpiresAt" > clock_timestamp() and "cancelRequestedAt" is null for update`.execute(
          tx,
        );
      if (rows.length === 0) throw new Error('Duplicate decision lost its claim');
    }
    const intent = committedEffect
      ? queueExecution.exit(() => runSubmission.exit(() => this.intent(item)))
      : runId
        ? runSubmission.run(runId, () => this.intent(item))
        : this.intent(item);
    await this.store.enqueue([intent], tx);
  }

  async queueAll(items: JobItem[]): Promise<void> {
    const intents = items.map((item) => this.intent(item));
    const context = queueExecution.getStore();
    context?.signal.throwIfAborted();
    const admission = runAdmission.getStore();
    if (admission) {
      if (!admission.open) throw new Error('Run admission callback has already returned');
      if (admission.intents.length + intents.length > QUEUE_BATCH) {
        throw new Error('Run admission is limited to 250 initial intents; use a manifest for bulk selections');
      }
      admission.intents.push(...(JSON.parse(JSON.stringify(intents)) as QueueIntent[]));
      return;
    }
    if (context?.buffering) {
      context.followups.push(...intents);
      return;
    }
    if (context) {
      for (let offset = 0; offset < intents.length; offset += QUEUE_BATCH) {
        const batch = intents.slice(offset, offset + QUEUE_BATCH);
        await this.fenced(context, (tx) => this.store.enqueueFollowups(context.claim, batch, tx));
      }
    } else {
      await this.store.enqueue(intents);
    }
  }
  queue(item: JobItem): Promise<void> {
    return this.queueAll([item]);
  }

  /**
   * FL-1337: queue work that belongs to no job run, even when a job of a run asks for it, such as a person's shared
   * search by contents and the fixes it feeds. A run keeps one job row per item and stage (`job_run_stage`), so a
   * second request inside the same run would be dropped silently and its findings would wait for ever. Outside a
   * run, the work's own keys decide what collapses. It is not tied to the asking job's claim: it is safe to run
   * twice. During a job's completion it is written in that completion's transaction.
   */
  async queueOutsideRun(items: JobItem[]): Promise<void> {
    if (runAdmission.getStore()) throw new Error('Run admission cannot queue work outside its run');
    const intents = queueExecution.exit(() => runSubmission.exit(() => items.map((item) => this.intent(item))));
    const completion = queueExecution.getStore()?.buffering ? publicationTransaction.getStore() : undefined;
    await this.store.enqueue(intents, completion);
  }

  /** Held work (an import waiting for setup) is not waited for. */
  async waitForQueueCompletion(...queues: QueueName[]): Promise<void> {
    while ((await Promise.all(queues.map((queue) => this.store.hasUnfinishedWork(queue, false)))).some(Boolean)) {
      queueExecution.getStore()?.signal.throwIfAborted();
      await sleep(QUEUE_TIMING.scan);
    }
  }

  async searchJobs(name: QueueName, dto: QueueJobSearchDto, limit = 1000, publicOnly = false): Promise<QueueJobRow[]> {
    const statuses = dto.status ?? Object.values(QueueJobStatus);
    const { rows } = await sql<QueueJobRow>`select * from (
      select j.id, j.name, case when j.sensitive then '{}'::jsonb else j.data end data,
      (extract(epoch from j."createdAt") * 1000)::bigint::float8 timestamp, j.attempt "attemptsMade", j.error "failedReason",
      case when j.state in ('failed','needs_attention','blocked') then 'failed'
        when j."operationPaused" then 'paused'
        when j.state in ('pending','waiting') and j."availableAt" = 'infinity'::timestamptz then 'paused'
        when j.state in ('pending','waiting') and j."availableAt" > now() then 'delayed'
        when j.state in ('pending','waiting') and (q.paused or coalesce(q."closedUntil" > now(), false)) then 'paused'
        when j.state = 'pending' then 'waiting' else j.state end status
      from (${reportedQueueJobs(name)}) j join job_queue q on q.name = j.queue
      ) jobs where status = any(${statuses}::text[])
      and (${!publicOnly} or name = any(${JobNameSchema.options}::text[]))
      order by timestamp desc, id limit ${limit}`.execute(this.store.db);
    return rows;
  }

  /**
   * The `job/token` pairs among `claims` whose attempt is proven stopped, by the same evidence the queue
   * uses: it completed, or its attempt or worker recorded a stop. A cleared token alone is not proof.
   */
  async getStoppedClaims(claims: { jobId: string; token: string }[]): Promise<Set<string>> {
    if (claims.length === 0) {
      return new Set();
    }
    const { rows } = await sql<{ jobId: string; token: string }>`select a."jobId", a.token from job_attempt a
      join unnest(${claims.map((claim) => claim.jobId)}::uuid[], ${claims.map((claim) => claim.token)}::uuid[])
        as c("jobId", token) on a."jobId" = c."jobId" and a.token = c.token
      where (a.outcome = 'completed' and a."finishedAt" is not null)
        or exists (select 1 from system_metadata m where m.key = 'frameleaf-attempt-evidence:' || a.token::text
          and m.value->>'jobId' = a."jobId"::text and m.value ? 'stoppedAt')
        or exists (select 1 from system_metadata m where m.key = 'frameleaf-worker-stopped:' || a."workerId"::text
          and m.value->>'workerId' = a."workerId"::text and m.value ? 'stoppedAt')`.execute(this.store.db);
    return new Set(rows.map((row) => `${row.jobId}/${row.token}`));
  }

  /** Cancels like `clear` (items, dependents, runs settle); a replacement in the same run re-arms the row. */
  removeJob(name: JobName, jobID: string): Promise<void> {
    return this.store.cancelQueued(this.getQueueName(name), jobID);
  }

  /**
   * FL-1337: a person's Try again supersedes the fix of a photo that put itself back to wait (`fix-<id>/rN`) and
   * the shared search's feed for it (`fix-<id>/searched`): they are cancelled while they wait. A person's own
   * fix waiting its turn (`fix-<id>/pN`) is kept: it may be the fix this Try again just queued. A running one is
   * left to settle; the per-photo guard (`isOtherFixRunning`) holds Try again back until it has.
   */
  async cancelWaitingFixes(assetId: string): Promise<void> {
    const queue = this.getQueueName(JobName.MediaHealthFixAsset);
    await this.store.cancelQueuedWithPrefix(queue, `fix-${assetId}/r`);
    await this.store.cancelQueuedWithPrefix(queue, `fix-${assetId}/searched`);
  }

  /**
   * FL-1337: whether a fix of this photo other than the calling job's is running, and started first (by start time,
   * then id, so of two that start together exactly one waits). One fix runs per photo at a time.
   */
  async isOtherFixRunning(assetId: string): Promise<boolean> {
    const own = queueExecution.getStore()?.claim.id ?? null;
    const { rows } = await sql`select 1 from job j
      where j.queue = ${this.getQueueName(JobName.MediaHealthFixAsset)} and j.name = ${JobName.MediaHealthFixAsset}
        and j.state = 'active' and j.data->>'id' = ${assetId}
        and (${own}::uuid is null or (j."startedAt", j.id) < (
          select coalesce(o."startedAt", now()), o.id from job o where o.id = ${own}::uuid))
      limit 1`.execute(this.store.db);
    return rows.length > 0;
  }

  async dispatchImportedWork(config?: ImportConfig): Promise<string> {
    const runId = await transferImportedWork(
      this.store.db,
      (name) => this.intent({ name, data: {} } as JobItem),
      config,
    );
    await this.store.finishEnumeration(runId);
    return runId;
  }
  /** Generic import preparation stays held until separately verified activation. */
  prepareImportedLibraryWork(context: ReviewedImportContext, manager?: ManagerLibrarySetup): Promise<string> {
    return prepareLibraryImportWork(
      this.store.db,
      (name) => this.intent({ name, data: {} } as JobItem),
      context,
      manager,
    );
  }
  async dispatchImportedLibraryWork(context: ReviewedImportContext, manager?: ManagerLibrarySetup): Promise<string> {
    const runId = await this.prepareImportedLibraryWork(context, manager);
    await this.store.finishEnumeration(runId);
    return runId;
  }
  validateImportedLibraryWork(
    tx: ImportDatabase,
    context: ReviewedImportContext,
    manager?: ManagerLibrarySetup,
  ): Promise<string> {
    return validatePreparedLibraryImportWork(
      tx,
      (name) => this.intent({ name, data: {} } as JobItem),
      context,
      manager,
    );
  }
  private getNamedJobOptions(item: JobItem): QueueOptions | null {
    switch (item.name) {
      case JobName.LandmarkInfer: {
        return item.data?.id ? null : { deduplication: { id: JobName.LandmarkInfer, keepLastIfActive: true } };
      }
      case JobName.AlbumSuggestionOutfit: {
        // every load of an album's suggestions asks again until the crops exist; one waiting job is enough
        return { deduplication: { id: `${JobName.AlbumSuggestionOutfit}:${item.data.id}`, keepLastIfActive: true } };
      }
      case JobName.AlbumCleanupScan: {
        // One scan per person: opening Albums again while one is waiting asks for nothing new.
        return { deduplication: { id: `${JobName.AlbumCleanupScan}:${item.data.userId}`, keepLastIfActive: true } };
      }
      case JobName.AlbumCleanupApply: {
        return { deduplication: { id: `${JobName.AlbumCleanupApply}:${item.data.id}` } };
      }
      case JobName.ICloudSync: {
        return { deduplication: { id: `${JobName.ICloudSync}:${item.data.id}`, keepLastIfActive: true } };
      }
      case JobName.IdenticalFilesCheck: {
        // FL-413: one run at a time; a check asked for while one runs is the same run carrying on
        return { deduplication: { id: JobName.IdenticalFilesCheck, keepLastIfActive: true } };
      }
      case JobName.LibraryScanRun: {
        // FL-78: one waiting wake-up is enough; a scan queued while one drains is picked up after it
        return { deduplication: { id: JobName.LibraryScanRun, keepLastIfActive: true } };
      }
      case JobName.NotifyAlbumUpdate: {
        return {
          jobId: `${item.data.id}/${item.data.recipientId}`,
          delay: item.data?.delay,
        };
      }
      case JobName.StorageTemplateMigrationSingle: {
        return { jobId: item.data.id };
      }
      case JobName.MediaHealthFixAsset: {
        // FL-1337: one fix per photo at a time, so the feeds of one photo collapse while it is queued or
        // running. A fix that puts itself back carries its own key: the store drops a job whose key
        // matches a live row, and the live row is the fix that is queuing it.
        // The shared search's feed has its own key too, so a fix queued meanwhile cannot swallow it.
        // A person's fix that puts itself back has a key of its own too (`/p<its Try again>-N`): a later Try
        // again's cancellation of the waiting fixes never matches it, and it never collides with the put-back of
        // an earlier Try again's fix that is still running.
        const jobId = item.data.requeue
          ? item.data.from === 'person'
            ? `fix-${item.data.id}/p${item.data.retry ?? ''}-${item.data.requeue}`
            : `fix-${item.data.id}/r${item.data.requeue}`
          : item.data.searched
            ? `fix-${item.data.id}/searched`
            : `fix-${item.data.id}`;
        if (item.data.from === 'person' && !item.data.requeue && !item.data.searched) {
          // A person's Try again is never dropped for a feed already queued: it takes that waiting job's place,
          // or runs once the one that is running settles.
          return { jobId, deduplication: { id: jobId, keepLastIfActive: true } };
        }
        return item.data.delay ? { jobId, delay: item.data.delay } : { jobId };
      }
      case JobName.MediaHealthLocateMissing: {
        // FL-1337: one shared search per owner for the fixes waiting on it. It waits a little so a burst of
        // them is one walk, and one asked for while a walk runs gets its pass after it. The walk carries on
        // under no key, so a later request can never overwrite where it was.
        return item.data.pending && !item.data.ids
          ? {
              delay: FIX_SEARCH_DELAY_MS,
              deduplication: {
                id: `${JobName.MediaHealthLocateMissing}:pending:${item.data.userId}`,
                keepLastIfActive: true,
              },
            }
          : null;
      }
      case JobName.AssetDetectDuplicates: {
        // FL-651: a recheck after each group mate's fingerprint is its own run item, so one queued
        // before the mate's own fingerprint existed does not swallow the later ones
        return item.data.recheckAfter ? { jobId: `${item.data.id}/after/${item.data.recheckAfter}` } : null;
      }
      case JobName.StudioHdrProxyGenerate: {
        // FL-97: every project read asks for missing intermediates; one per video is enough
        return { deduplication: { id: `${JobName.StudioHdrProxyGenerate}:${item.data.id}` } };
      }
      case JobName.WorkflowAssetTrigger: {
        // FL-179: one job per execution, so a replayed run that queues its automatic retry again adds none
        return item.data.executionId ? { jobId: `workflow-${item.data.executionId}` } : null;
      }
      case JobName.PhotographyWorkflowRender: {
        return {
          delay: item.data.delay ?? 0,
          deduplication: { id: `${JobName.PhotographyWorkflowRender}:${item.data.id}`, keepLastIfActive: true },
        };
      }
      case JobName.AssetPaletteExtract: {
        return { deduplication: { id: `${item.name}:${item.data.id}:${item.data.sourceRevision}` } };
      }
      case JobName.AssetPaletteQueueAll: {
        return { deduplication: { id: `${item.name}:${item.data.afterId ?? 'root'}:${!!item.data.force}` } };
      }
      case JobName.AssetDevelopRender: {
        // The automatic retry of a failed render waits before it is claimed (FL-64).
        return item.data.delay ? { delay: item.data.delay } : null;
      }
      case JobName.FacialRecognitionQueueAll: {
        return { deduplication: { id: JobName.FacialRecognitionQueueAll } };
      }
      case JobName.ImageDescriptionQueueAll: {
        return { deduplication: { id: JobName.ImageDescriptionQueueAll } };
      }
      case JobName.DescriptionFillerTagCleanup: {
        // FL-667: a restart while it is still queued or running adds no second run
        return { deduplication: { id: JobName.DescriptionFillerTagCleanup } };
      }
      case JobName.SmartAlbumReevaluateAll: {
        // Kind-scoped dispatches get their own dedup namespace so they don't
        // collide with each other OR with the all-kinds dispatch. This lets
        // an admin queue (e.g.) "food" and "pets" simultaneously without
        // PostgreSQL queue deduplication coalescing the second request with the first.
        const kind = (item.data as { kind?: string } | undefined)?.kind;
        const dedupId = kind ? `${JobName.SmartAlbumReevaluateAll}:${kind}` : JobName.SmartAlbumReevaluateAll;
        return { deduplication: { id: dedupId } };
      }
      case JobName.SmartAlbumReevaluate: {
        // An asset's food evaluation must never coalesce with another asset or its travel evaluation.
        return { deduplication: { id: `${item.name}:${item.data.id}:${item.data.kind ?? 'all'}` } };
      }
      case JobName.AnalyticsCollect: {
        // FL-79: the nightly run is one per night; its one automatic retry waits a few minutes.
        return item.data?.attempt
          ? { delay: ANALYTICS_AUTO_RETRY_DELAY_MS }
          : { deduplication: { id: JobName.AnalyticsCollect } };
      }
      case JobName.VersionCheck: {
        return { deduplication: { id: JobName.VersionCheck } };
      }
      case JobName.FrameleafHeartbeat: {
        return { deduplication: { id: JobName.FrameleafHeartbeat } };
      }
      case JobName.FrameleafLicenseRefresh: {
        return { deduplication: { id: JobName.FrameleafLicenseRefresh } };
      }
      case JobName.CloudMlDescriptionBatch: {
        // A backfill submitted while a cron pass is active still needs a wake after that pass.
        return { deduplication: { id: JobName.CloudMlDescriptionBatch, keepLastIfActive: true } };
      }
      case JobName.CloudMlLibraryBatch: {
        return { deduplication: { id: JobName.CloudMlLibraryBatch } };
      }
      // FL-362: one start of the backup schedule at a time
      case JobName.BackupSequence: {
        return { deduplication: { id: JobName.BackupSequence } };
      }
      // FL-363: one start of the overnight schedule at a time
      case JobName.OvernightSequence: {
        return { deduplication: { id: JobName.OvernightSequence } };
      }
      // FL-164: one schedule tick and one verification check at a time
      case JobName.CloudBackupSchedule: {
        return { deduplication: { id: JobName.CloudBackupSchedule } };
      }
      case JobName.CloudBackupVerify: {
        return { deduplication: { id: JobName.CloudBackupVerify } };
      }
      case JobName.PushDeliver: {
        // FL-228: a burst about the same thing (photos added one by one) waits and goes out once
        const { dedupeKey, delayMs } = item.data.notice;
        if (!dedupeKey && !delayMs) {
          return null;
        }
        return { ...(dedupeKey && { jobId: `push/${dedupeKey}` }), ...(delayMs && { delay: delayMs }) };
      }
      // FL-326: one backfill per partnership and one copy per source and library at a time
      case JobName.PartnerBackfill: {
        return { deduplication: { id: `partner-backfill/${item.data.sharedById}/${item.data.sharedWithId}` } };
      }
      case JobName.PartnerCopyAsset: {
        return { deduplication: { id: `partner-copy/${item.data.sourceAssetId}/${item.data.targetOwnerId}` } };
      }
      case JobName.PartnerCopyAlbum: {
        return { deduplication: { id: `partner-album/${item.data.sourceAlbumId}/${item.data.targetOwnerId}` } };
      }
      // FL-721: one waiting job per item and step, and one sweep per person (or of everyone); a
      // request while one runs (a new derived file, a key load) is picked up after it
      case JobName.LockedSeal:
      case JobName.LockedUnseal:
      case JobName.LockedRewrap: {
        return { deduplication: { id: `${item.name}:${item.data.id}`, keepLastIfActive: true } };
      }
      case JobName.LockedSweep: {
        const id = `${item.name}:${item.data.userId ?? 'all'}`;
        return item.data.delay
          ? { delay: item.data.delay, deduplication: { id: `${id}:later`, keepLastIfActive: true } }
          : { deduplication: { id, keepLastIfActive: true } };
      }
      case JobName.PushBackupStaleCheck: {
        return { deduplication: { id: JobName.PushBackupStaleCheck } };
      }
      case JobName.DatabaseBackup: {
        return { deduplication: { id: JobName.DatabaseBackup } };
      }
      default: {
        return null;
      }
    }
  }
}
