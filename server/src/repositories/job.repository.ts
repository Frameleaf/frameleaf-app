import { Injectable } from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';
import { Kysely, type SelectQueryBuilder, type Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { MessageChannel, Worker, parentPort } from 'node:worker_threads';
import type { ImportConfig } from 'src/immich-import/types.js';
import type { DB } from 'src/schema/index.js';
import type { JobCounts, JobItem, JobOf } from 'src/types.js';
import { JOBS_NOT_RETRIED, JOBS_UNSAFE_TO_RERUN_AFTER_STOP, JOBS_WITH_SENSITIVE_DATA } from 'src/constants.js';
import { JobConfig } from 'src/decorators.js';
import { QueueJobResponseDto, QueueJobSearchDto } from 'src/dtos/queue.dto.js';
import { JobName, JobStatus, MetadataKey, QueueCleanType, QueueJobStatus, QueueName } from 'src/enum.js';
import { transferImportedWork } from 'src/immich-import/derived-work.js';
import { QUEUE_EXECUTION_CAPACITY, queueAdmission } from 'src/queue/admission.js';
import { deferJobAdoption, queueExecution } from 'src/queue/context.js';
import {
  type LibrarySourceIdentity,
  appendLibraryInitialSources,
  closeLibrarySource,
  ensureLibrarySource,
  markLibrarySourceOutcome,
  settleTerminalLibrarySources,
  withLibraryQueueFence,
} from 'src/queue/library-admission.js';
import { attachProducerRun, freezeSelection, getManifestJobOptions } from 'src/queue/manifest.js';
import { deliverJobObservers } from 'src/queue/observers.js';
import { reportedQueueJobs } from 'src/queue/run-query.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { assertPublicationSource, publicationTransaction } from 'src/queue/transaction.js';
import {
  QUEUE_BATCH,
  QUEUE_TIMING,
  QueueClaim,
  QueueDispatch,
  QueueExecution,
  QueueIntent,
  QueueOptions,
  toJobItem,
} from 'src/queue/types.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { ANALYTICS_AUTO_RETRY_DELAY_MS } from 'src/utils/analytics.js';
import { recordStoppedAttempt } from 'src/utils/attempt-evidence.js';
import { DATABASE_ACQUIRE_TIMEOUT_MS, DATABASE_POOL_SIZE } from 'src/utils/execution-database.js';
import { ImmichStartupError, getKeyByValue, getMethodNames } from 'src/utils/misc.js';

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
// Explicitly audited repeatable jobs. Unclassified external effects fail closed after an ambiguous stop.
const REPEATABLE_JOBS = new Set<JobName>([
  JobName.DuplicateResolutionLifecycle,
  JobName.DatabaseBackup,
  JobName.AssetGenerateThumbnails,
  JobName.AssetGenerateThumbnailsQueueAll,
  JobName.AssetEditThumbnailGeneration,
  JobName.OcrQueueAll,
  JobName.PetRecognitionQueueAll,
  JobName.PetRecognitionNearest,
  JobName.SmartSearchPostprocess,
  JobName.ImageEnrichmentPostprocess,
  JobName.ImageDescriptionQueueAll,
  JobName.NsfwDetectionQueueAll,
  JobName.AssetEncodeVideo,
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
  JobName.PetRecognition,
  JobName.VideoMomentCaptions,
  JobName.ImageDescription,
  JobName.NsfwDetection,
  JobName.AssetEncodeVideoQueueAll,
  JobName.SmartSearchQueueAll,
  JobName.AssetExtractMetadataQueueAll,
  JobName.SmartAlbumReevaluateAll,
  JobName.SmartAlbumReevaluate,
]);

@Injectable()
export class JobRepository {
  private handlers: Partial<Record<JobName, JobMapItem>> = {};
  private coordinator?: Worker;
  private stopping?: Promise<void>;
  private active = new Map<string, { abort: AbortController; finished: Promise<void> }>();
  private rollingAvgBuffers: Partial<Record<JobName, number[]>> = {};
  private store: SqlQueueStore;

  constructor(
    private moduleRef: ModuleRef,
    private configRepository: ConfigRepository,
    private eventRepository: EventRepository,
    private logger: LoggingRepository,
    @InjectKysely() db: Kysely<any>,
  ) {
    this.logger.setContext(JobRepository.name);
    this.store = new SqlQueueStore(db);
  }
  setup(services: (new (...args: any[]) => unknown)[]) {
    const reflector = this.moduleRef.get(Reflector, { strict: false });

    // discovery
    for (const Service of services) {
      const instance = this.moduleRef.get<any>(Service);
      for (const methodName of getMethodNames(instance)) {
        const handler = instance[methodName];
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
          throw new ImmichStartupError(errorMessage);
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
        throw new ImmichStartupError(errorMessage);
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
    this.logger.log(
      `Queue execution capacity: ${QUEUE_EXECUTION_CAPACITY} jobs across all queues (${DATABASE_POOL_SIZE} database sessions)`,
    );
    this.coordinator = new Worker(new URL('../workers/queue-coordinator.js', import.meta.url), {
      workerData: {
        workerId,
        queues: Object.values(QueueName),
        connection: this.configRepository.getEnv().database.config,
        supervisor: port2,
      },
      transferList: [port2],
    });
    this.coordinator.on('message', (message: QueueDispatch | { type: 'unavailable' }) => {
      if (message.type === 'execute') {
        const abort = new AbortController();
        const finished = this.execute(message.claim, abort).finally(() => {
          this.active.delete(message.claim.id);
          this.coordinator?.postMessage({ type: 'settled', id: message.claim.id });
        });
        this.active.set(message.claim.id, { abort, finished });
      } else if (message.type === 'cancel') {
        this.active.get(message.id)?.abort.abort(new Error('Job deadline or lease expired'));
      }
    });
    this.coordinator.on('error', () =>
      this.logger.error('Queue coordinator failed; supervisor will recover the worker'),
    );
  }

  private async execute(claim: QueueClaim, abort: AbortController) {
    const admission = queueAdmission(this.store.db);
    let releaseExecution: (() => void) | undefined;
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
          await admission.publication.run(AbortSignal.timeout(DATABASE_ACQUIRE_TIMEOUT_MS), () =>
            recordStoppedAttempt(this.store.db, claim.id, claim.token),
          );
        } catch {
          this.logger.warn('Could not persist stopped-attempt evidence; output cleanup will retain it');
        }
      }
      abort.signal.throwIfAborted();
      if (context.dependencyReason) {
        settled = await admission.publication.run(abort.signal, () =>
          this.store.defer(claim, context.dependencyReason!),
        );
        return;
      }
      if (context.outcome === 'failed') {
        throw new Error('Handler returned Failed');
      }
      settled = await queueExecution.run(context, () =>
        this.store.complete(
          claim,
          context.followups,
          async (tx) => {
            await publicationTransaction.run(tx, async () => {
              context.buffering = true;
              for (const adopt of context.adoptions) {
                await adopt(tx);
              }
              abort.signal.throwIfAborted();
            });
          },
          (publish) => admission.publication.run(abort.signal, publish),
        ),
      );
      if (settled) {
        // Notification failure cannot change an already committed outcome or replay media work.
        await deliverJobObservers(context.afterCommit ?? [], () =>
          this.logger.warn('Accepted job observer delivery unavailable'),
        );
        const buffer = (this.rollingAvgBuffers[claim.name as JobName] ??= []);
        buffer.push(Date.now() - new Date(claim.startedAt).getTime());
        if (buffer.length > 100) {
          buffer.shift();
        }
      }
    } catch (error) {
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
      try {
        if (!started || context.dependencyReason) {
          // No handler ran on an admission refusal, even for unsafe/operation-owned jobs.
          // A rejected fence can only settle below with matching stop proof; never invent a new claim.
          settled = await admission.publication.run(AbortSignal.timeout(DATABASE_ACQUIRE_TIMEOUT_MS), () =>
            this.store.defer(claim, context.dependencyReason ?? 'local-capacity'),
          );
          return;
        }
        settled = await this.store.fail(
          claim,
          error instanceof Error ? error.message : 'Job failed',
          context.failureDiagnostics?.length
            ? async (tx) =>
                publicationTransaction.run(tx, async () => {
                  for (const publish of context.failureDiagnostics!) await publish(tx);
                })
            : undefined,
          {
            settlements: context.failureSettlements,
            publication: (publish) =>
              admission.publication.run(AbortSignal.timeout(DATABASE_ACQUIRE_TIMEOUT_MS), publish),
          },
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
          await this.store.fail(claim, 'Job deadline or cancellation requested', undefined, {
            stopRequestedOnly: !context.failureSettlements?.length,
            settlements: context.failureSettlements,
            publication: (publish) =>
              admission.publication.run(AbortSignal.timeout(DATABASE_ACQUIRE_TIMEOUT_MS), publish),
          });
        } catch {
          this.logger.error('Could not persist stopped job outcome; lease recovery is pending');
        }
      }
      releaseExecution?.();
    }
  }

  stopWorkers(graceMs: number): Promise<void> {
    this.stopping ??= this.stopOnce(graceMs);
    return this.stopping;
  }

  private async stopOnce(graceMs: number) {
    this.coordinator?.postMessage({ type: 'stop' });
    await Promise.race([Promise.allSettled(this.active.values().map(({ finished }) => finished)), sleep(graceMs)]);
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

  async collectFollowups(action: () => Promise<void>) {
    const context = queueExecution.getStore();
    if (!context) {
      return action();
    }
    context.buffering = true;
    try {
      await action();
    } finally {
      context.buffering = false;
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
  resume(name: QueueName) {
    return this.store.pause(name, false);
  }
  empty(name: QueueName) {
    return this.store.clear(name, ['pending', 'waiting']);
  }
  clear(name: QueueName, _type: QueueCleanType) {
    return this.store.clear(name, ['failed', 'needs_attention', 'blocked']);
  }
  retryFailed(name: QueueName) {
    return this.store.retryFailed(name);
  }
  getJobCounts(name: QueueName): Promise<JobCounts> {
    return this.store.counts(name);
  }
  hasUnfinishedWork(name: QueueName): Promise<boolean> {
    return this.store.hasUnfinishedWork(name);
  }
  hasDedupJob(name: QueueName, id: string) {
    return this.store.hasDedup(name, id);
  }
  private getQueueName(name: JobName) {
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
    const admit = (tx: Transaction<any>) => this.store.admitRun(id, kind, selection, admission.intents, tx);
    if (context?.buffering) {
      // The run and its parent-dependent intents become visible only with successful publication.
      context.adoptions.push(admit);
    } else {
      await this.store.db.transaction().execute(async (tx) => {
        // Keep the established queue -> parent job -> run/item lock order across every captured batch.
        await sql`select name from job_queue order by name for no key update`.execute(tx);
        if (context) {
          const { rows } = await sql`select id from job where id = ${context.claim.id}::uuid
            and token = ${context.claim.token}::uuid and state = 'active' and "leaseExpiresAt" > clock_timestamp()
            and "cancelRequestedAt" is null for update`.execute(tx);
          if (rows.length === 0) throw new Error('Producer lost its claim');
        }
        await admit(tx);
        if (context) {
          context.signal.throwIfAborted();
          const { rows } = await sql`select id from job where id = ${context.claim.id}::uuid
            and token = ${context.claim.token}::uuid and state = 'active' and "leaseExpiresAt" > clock_timestamp()
            and "cancelRequestedAt" is null`.execute(tx);
          if (rows.length === 0) throw new Error('Producer lost its claim during admission');
          context.signal.throwIfAborted();
        }
      });
    }
    return id;
  }

  listRuns(take: number, skip: number) {
    return this.store.listRuns(take, skip);
  }

  listRunItems(runId: string, take: number, skip: number) {
    return this.store.listRunItems(runId, take, skip);
  }

  private intent(item: JobItem): QueueIntent {
    const context = queueExecution.getStore();
    const runId = runSubmission.getStore() ?? context?.claim.runId ?? undefined;
    const data = (item.data ?? {}) as Record<string, unknown>;
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
    return {
      name: item.name,
      data,
      queue,
      options: this.getNamedJobOptions(item) ?? undefined,
      safeToRetry:
        !data.operationId &&
        !(
          item.name === JobName.ImageEnrichmentPostprocess &&
          (data.cloudDescription || (Array.isArray(data.lockedIds) && data.lockedIds.length > 0))
        ) &&
        REPEATABLE_JOBS.has(item.name) &&
        !JOBS_UNSAFE_TO_RERUN_AFTER_STOP.has(item.name) &&
        !JOBS_NOT_RETRIED.has(item.name),
      sensitive: JOBS_WITH_SENSITIVE_DATA.has(item.name),
      deadlineMs: isMl ? QUEUE_TIMING.mlDeadline : QUEUE_TIMING.opaqueDeadline,
      runId,
      itemKey: runId
        ? String(data.id ?? data.assetId ?? createHash('sha256').update(JSON.stringify(data)).digest('hex')) +
          (item.name === JobName.FacialRecognition && data.deferred ? '/deferred' : '')
        : undefined,
      rootItemKey: context?.claim.rootItemKey ?? null,
      parentId: context?.buffering ? context.claim.id : undefined,
    };
  }

  /** Give setup checkpoints a retained canonical outcome before any domain setup can commit. */
  async ensureProducerRun(): Promise<string | undefined> {
    const context = queueExecution.getStore();
    if (!context) return;
    const result = await this.store.db.transaction().execute(async (tx) => {
      await sql`select name from job_queue order by name for no key update`.execute(tx);
      return attachProducerRun(tx, context.claim);
    });
    context.claim.runId = result.runId;
    context.claim.itemKey = result.producerItemKey;
    return result.runId;
  }

  /** Persist small database-only producer setup with its claim. No network or file I/O may enter this callback. */
  async prepareCheckpoint<T>(key: string, prepare: () => Promise<T>): Promise<T> {
    const context = queueExecution.getStore();
    if (!context) return prepare();
    const { claim } = context;
    return this.store.db.transaction().execute(async (tx) => {
      await sql`select name from job_queue order by name for no key update`.execute(tx);
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

  /** A queue producer cannot leave a new domain scan behind after losing its own acceptance fence. */
  async prepareLibraryScanSource<T>(
    libraryId: string,
    create: (tx: Transaction<DB>) => Promise<{ operationId: string; value: T }>,
  ): Promise<T> {
    if (runAdmission.getStore() || publicationTransaction.getStore())
      throw new Error('Library submission requires its own fenced transaction');
    const context = queueExecution.getStore();
    return withLibraryQueueFence(this.store.db, context, async (tx) => {
      const { operationId, value } = await create(tx as Transaction<DB>);
      const intent = this.intent({ name: JobName.SidecarCheck, data: { id: operationId, source: 'upload' } });
      await ensureLibrarySource(tx, { operationId, libraryId }, intent, context);
      return value;
    });
  }

  /** Bind the operation's source to its submitter, never to a later deduplicated drain wake. */
  async ensureLibraryScanSource(identity: LibrarySourceIdentity, attachOrigin = true): Promise<void> {
    if (runAdmission.getStore() || publicationTransaction.getStore())
      throw new Error('Library source setup requires its own fenced transaction');
    const context = queueExecution.getStore();
    const intent = this.intent({ name: JobName.SidecarCheck, data: { id: identity.operationId, source: 'upload' } });
    await withLibraryQueueFence(this.store.db, context, (tx) =>
      ensureLibrarySource(tx, identity, intent, attachOrigin ? context : undefined),
    );
  }

  /** Only library scans may publish bounded assets, durable sources and a checkpoint before completion. */
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
    return withLibraryQueueFence(this.store.db, queueExecution.getStore(), async (tx) => {
      const { value, assetIds, accepted } = await work(tx as Transaction<DB>);
      if (!accepted) return value;
      if (assetIds.length > QUEUE_BATCH) throw new Error('Library acceptance is limited to 250 source intents');
      const intents = assetIds.map((id) => ({
        ...this.intent({ name: JobName.SidecarCheck, data: { id, source: 'upload' } }),
        runId: identity.operationId,
        rootItemKey: id,
        parentId: undefined,
      }));
      await appendLibraryInitialSources(tx, identity.operationId, intents);
      if (close && value) await closeLibrarySource(tx, identity.operationId);
      return value;
    });
  }

  /** Mandatory terminal control only: the update callback must fence the exact domain claim. */
  async settleLibraryScanSource<T>(operationId: string, update: (tx: Transaction<DB>) => Promise<T>): Promise<T> {
    return withLibraryQueueFence(this.store.db, undefined, async (tx) => {
      const outcome = await update(tx as Transaction<DB>);
      await markLibrarySourceOutcome(tx, operationId);
      return outcome;
    });
  }

  /** Domain recovery may fail a scan without a live worker; retained open sources remain non-runnable. */
  settleTerminalLibrarySources(): Promise<number> {
    return withLibraryQueueFence(this.store.db, undefined, settleTerminalLibrarySources);
  }

  /** Materialize the full selected ID set in PostgreSQL before workers see any item. */
  async queueSelection(
    name: JobName,
    selection: SelectQueryBuilder<any, any, { id: string }>,
    data: Record<string, unknown> = {},
  ) {
    if (runAdmission.getStore()) throw new Error('Run admission supports queue/queueAll, not queueSelection');
    await freezeSelection(
      this.store.db,
      this.intent({ name, data } as JobItem),
      selection,
      queueExecution.getStore(),
      runSubmission.getStore(),
    );
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
    const read = async () => {
      const {
        rows: [row],
      } = await sql<{ checksum: Buffer; revision: unknown }>`select a.checksum,
        jsonb_build_object('originalPath', a."originalPath", 'modifiedAt', a."fileModifiedAt", 'ownerId', a."ownerId",
          'visibility', a.visibility, 'deletedAt', a."deletedAt",
          'lock', (select to_jsonb(l) from asset_lock l where l."assetId" = a.id),
          'files', (select jsonb_agg(jsonb_build_array(f.id, f.path, f.type, f."isEdited") order by f.id)
            from asset_file f where f."assetId" = a.id and ${derivatives}::boolean),
          'edits', (select jsonb_agg(jsonb_build_array(e.sequence, e.action, e.parameters) order by e.sequence, e.id)
            from asset_edit e where e."assetId" = a.id and ${derivatives}::boolean)) revision
        from asset a where a.id = ${assetId}::uuid`.execute(publicationTransaction.getStore() ?? this.store.db);
      return row;
    };
    const source = await read();
    if (!source) {
      return;
    }
    deferJobAdoption(async () => {
      await assertPublicationSource(assetId, source.checksum);
      const current = await read();
      if (!current || JSON.stringify(current.revision) !== JSON.stringify(source.revision)) {
        throw new Error('Asset inputs changed before publication');
      }
    });
  }

  /** Persist before admission. A retry keeps its original destination even if routing changes. */
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
  async queueInTransaction(tx: Transaction<any>, item: JobItem, runId?: string): Promise<void> {
    if (runAdmission.getStore()) throw new Error('Run admission cannot use an independent transaction');
    const context = queueExecution.getStore();
    const committedEffect = item.name === JobName.DuplicateResolutionLifecycle;
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
      for (let offset = 0; offset < intents.length; offset += 250) {
        const batch = intents.slice(offset, offset + 250);
        await this.store.db.transaction().execute(async (tx) => {
          for (const queue of [...new Set(batch.map((item) => item.queue))].sort()) {
            await sql`select name from job_queue where name = ${queue} for no key update`.execute(tx);
          }
          const { rows } = await sql`select id from job where id = ${context.claim.id}::uuid
            and token = ${context.claim.token}::uuid and state = 'active' and "leaseExpiresAt" > clock_timestamp()
            and "cancelRequestedAt" is null for update`.execute(tx);
          if (rows.length === 0) {
            throw new Error('Producer lost its claim');
          }
          await this.store.enqueue(batch, tx);
        });
      }
    } else {
      await this.store.enqueue(intents);
    }
  }
  queue(item: JobItem): Promise<void> {
    return this.queueAll([item]);
  }

  async waitForQueueCompletion(...queues: QueueName[]): Promise<void> {
    while ((await Promise.all(queues.map((queue) => this.store.hasUnfinishedWork(queue)))).some(Boolean)) {
      queueExecution.getStore()?.signal.throwIfAborted();
      await sleep(QUEUE_TIMING.scan);
    }
  }

  async searchJobs(name: QueueName, dto: QueueJobSearchDto, limit = 1000): Promise<QueueJobRow[]> {
    const statuses = dto.status ?? Object.values(QueueJobStatus);
    const { rows } = await sql<QueueJobRow>`select * from (
      select j.id, j.name, case when j.sensitive then '{}'::jsonb else j.data end data,
      (extract(epoch from j."createdAt") * 1000)::bigint::float8 timestamp, j.attempt "attemptsMade", j.error "failedReason",
      case when j.state in ('failed','needs_attention','blocked') then 'failed'
        when j."operationPaused" then 'paused'
        when j.state in ('pending','waiting') and j."availableAt" > now() then 'delayed'
        when j.state in ('pending','waiting') and q.paused then 'paused'
        when j.state = 'pending' then 'waiting' else j.state end status
      from (${reportedQueueJobs(name)}) j join job_queue q on q.name = j.queue
      ) jobs where status = any(${statuses}::text[]) order by timestamp desc, id limit ${limit}`.execute(this.store.db);
    return rows;
  }

  async removeJob(name: JobName, jobID: string): Promise<void> {
    await sql`update job set state = 'cancelled', data = '{}'::jsonb, "finishedAt" = now()
      where queue = ${this.getQueueName(name)} and "externalId" = ${jobID} and state in ('pending','waiting')`.execute(
      this.store.db,
    );
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
  private getNamedJobOptions(item: JobItem): QueueOptions | null {
    switch (item.name) {
      case JobName.ICloudSync: {
        return { deduplication: { id: `${JobName.ICloudSync}:${item.data.id}`, keepLastIfActive: true } };
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
        return getManifestJobOptions(item.name, { id: item.data.id, kind: item.data.kind }) ?? null;
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
        return { deduplication: { id: JobName.CloudMlDescriptionBatch } };
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
