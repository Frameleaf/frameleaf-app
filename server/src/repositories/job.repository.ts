import { Injectable } from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';
import { Kysely, sql, type SelectQueryBuilder } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { MessageChannel, parentPort, Worker } from 'node:worker_threads';
import type { JobCounts, JobItem, JobOf } from 'src/types.js';
import { JOBS_NOT_RETRIED, JOBS_UNSAFE_TO_RERUN_AFTER_STOP, JOBS_WITH_SENSITIVE_DATA } from 'src/constants.js';
import { JobConfig } from 'src/decorators.js';
import { QueueJobResponseDto, QueueJobSearchDto } from 'src/dtos/queue.dto.js';
import { JobName, JobStatus, MetadataKey, QueueCleanType, QueueJobStatus, QueueName } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { SqlQueueStore } from 'src/queue/store.js';
import {
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
export type QueueRun = { active: number; waiting: number; processed: number; startedAt: Date | null };
const runSubmission = new AsyncLocalStorage<string>();
// Explicitly audited repeatable jobs. Unclassified external effects fail closed after an ambiguous stop.
const REPEATABLE_JOBS = new Set<JobName>([
  JobName.AssetGenerateThumbnails,
  JobName.AssetEncodeVideo,
  JobName.SmartSearch,
  JobName.AssetExtractMetadata,
  JobName.AssetDetectFaces,
  JobName.Ocr,
  JobName.AssetGenerateThumbnailsQueueAll,
  JobName.AssetEncodeVideoQueueAll,
  JobName.SmartSearchQueueAll,
  JobName.AssetExtractMetadataQueueAll,
  JobName.AssetDetectFacesQueueAll,
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
    parentPort.postMessage({ type: 'queue-watchdog-port', port: port1 }, [port1]);
    this.coordinator = new Worker(new URL('../workers/queue-coordinator.js', import.meta.url), {
      workerData: {
        workerId: randomUUID(),
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
      await queueExecution.run(context, () =>
        this.eventRepository.emit('JobRun', claim.queue as QueueName, toJobItem(claim)),
      );
      abort.signal.throwIfAborted();
      if (context.outcome === 'failed') {
        throw new Error('Handler returned Failed');
      }
      const accepted = await this.store.complete(claim, context.followups, async (tx) => {
        for (const adopt of context.adoptions) {
          await adopt(tx);
        }
      });
      if (accepted) {
        const buffer = (this.rollingAvgBuffers[claim.name as JobName] ??= []);
        buffer.push(Date.now() - new Date(claim.startedAt).getTime());
        if (buffer.length > 100) {
          buffer.shift();
        }
      }
    } catch (error) {
      try {
        await this.store.fail(claim, error instanceof Error ? error.message : 'Job failed');
      } catch {
        // No successful database outcome was observed. Lease recovery owns this claim.
        this.logger.error('Could not persist job outcome; lease recovery is pending');
      }
    }
  }

  stopWorkers(graceMs: number): Promise<void> {
    this.stopping ??= this.stopOnce(graceMs);
    return this.stopping;
  }

  private async stopOnce(graceMs: number) {
    this.coordinator?.postMessage({ type: 'stop' });
    await Promise.race([Promise.allSettled([...this.active.values()].map(({ finished }) => finished)), sleep(graceMs)]);
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
  watchWorkers() {} // Worker availability comes from durable heartbeat rows, not a Redis client list.

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
  hasDedupJob(name: QueueName, id: string) {
    return this.store.hasDedup(name, id);
  }
  private getQueueName(name: JobName) {
    return (this.handlers[name] as JobMapItem).queueName;
  }

  async observeQueueRun(name: QueueName): Promise<QueueRun> {
    const counts = await this.store.counts(name);
    const {
      rows: [run],
    } = await sql<{ startedAt: Date | null; processed: number }>`
      select min(j."createdAt") "startedAt", count(*) filter (where j.state in ('completed','failed','needs_attention','blocked','cancelled'))::int processed
      from job j join job_run r on r.id = j."runId" where j.queue = ${name} and r."finishedAt" is null
    `.execute(this.store.db);
    return {
      active: counts.active,
      waiting: counts.waiting + counts.paused + counts.delayed,
      processed: run.processed,
      startedAt: run.startedAt,
    };
  }

  async createRun(kind: string, selection: Record<string, unknown>, enqueue: () => Promise<void>) {
    const id = await this.store.createRun(kind, selection);
    await runSubmission.run(id, enqueue);
    await this.store.finishEnumeration(id);
    return id;
  }

  listRuns(take: number, skip: number) {
    return this.store.listRuns(take, skip);
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
        REPEATABLE_JOBS.has(item.name) &&
        !JOBS_UNSAFE_TO_RERUN_AFTER_STOP.has(item.name) &&
        !JOBS_NOT_RETRIED.has(item.name),
      sensitive: JOBS_WITH_SENSITIVE_DATA.has(item.name),
      deadlineMs: isMl ? QUEUE_TIMING.mlDeadline : QUEUE_TIMING.opaqueDeadline,
      runId,
      itemKey: runId
        ? String(data.id ?? data.assetId ?? createHash('sha256').update(JSON.stringify(data)).digest('hex'))
        : undefined,
      parentId: context?.buffering ? context.claim.id : undefined,
    };
  }

  /** Materialize the full selected ID set in PostgreSQL before workers see any item. */
  async queueSelection(name: JobName, selection: SelectQueryBuilder<any, any, { id: string }>) {
    const context = queueExecution.getStore();
    const runId = context?.claim.runId ?? runSubmission.getStore() ?? (await this.store.createRun(name, {}));
    const intent = this.intent({ name, data: {} } as JobItem);
    await this.store.db.transaction().execute(async (tx) => {
      await sql`select name from job_queue where name = ${intent.queue} for update`.execute(tx);
      if (context) {
        const claim = context.claim;
        const result = await sql`select id from job where id = ${claim.id}::uuid and token = ${claim.token}::uuid
          and state = 'active' and "leaseExpiresAt" > now() and "cancelRequestedAt" is null for update`.execute(tx);
        if (!result.rows.length) {
          throw new Error('Selection producer lost its claim');
        }
      }
      await sql`insert into job_run_item("runId", "itemKey", stage, selection)
        select ${runId}::uuid, selected.id::text, ${name}, jsonb_build_object('id', selected.id)
        from (${selection}) selected on conflict do nothing`.execute(tx);
      await sql`with added as (
        insert into job(id, queue, name, data, "safeToRetry", sensitive, "deadlineMs", "runId", "itemKey")
        select gen_random_uuid(), ${intent.queue}, ${name}, selection, ${intent.safeToRetry}, ${intent.sensitive},
          ${intent.deadlineMs}, "runId", "itemKey" from job_run_item where "runId" = ${runId}::uuid and stage = ${name}
        on conflict do nothing returning id, "runId", "itemKey", name
      ) update job_run_item i set "jobId" = a.id from added a
        where i."runId" = a."runId" and i."itemKey" = a."itemKey" and i.stage = a.name`.execute(tx);
    });
    if (!context?.claim.runId && !runSubmission.getStore()) {
      await this.store.finishEnumeration(runId);
    }
  }

  async queueAll(items: JobItem[]): Promise<void> {
    const intents = items.map((item) => this.intent(item));
    const context = queueExecution.getStore();
    context?.signal.throwIfAborted();
    if (context?.buffering) {
      context.followups.push(...intents);
      return;
    }
    if (context) {
      for (let offset = 0; offset < intents.length; offset += 250) {
        const batch = intents.slice(offset, offset + 250);
        await this.store.db.transaction().execute(async (tx) => {
          for (const queue of [...new Set(batch.map((item) => item.queue))].sort()) {
            await sql`select name from job_queue where name = ${queue} for update`.execute(tx);
          }
          const { rows } = await sql`select id from job where id = ${context.claim.id}::uuid
            and token = ${context.claim.token}::uuid and state = 'active' and "leaseExpiresAt" > now()
            and "cancelRequestedAt" is null for update`.execute(tx);
          if (!rows.length) {
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
    while (
      (await Promise.all(queues.map((queue) => this.store.counts(queue)))).some(
        (counts) => counts.active + counts.waiting + counts.paused + counts.delayed > 0,
      )
    ) {
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
        when j.state in ('pending','waiting') and j."availableAt" > now() then 'delayed'
        when j.state in ('pending','waiting') and q.paused then 'paused'
        when j.state = 'pending' then 'waiting' else j.state end status
      from job j join job_queue q on q.name = j.queue where j.queue = ${name}
      ) jobs where status = any(${statuses}::text[]) order by timestamp desc, id limit ${limit}`.execute(this.store.db);
    return rows;
  }

  async removeJob(name: JobName, jobID: string): Promise<void> {
    await sql`update job set state = 'cancelled', data = '{}'::jsonb, "finishedAt" = now()
      where queue = ${this.getQueueName(name)} and "externalId" = ${jobID} and state in ('pending','waiting')`.execute(
      this.store.db,
    );
  }

  async dispatchImportedWork(): Promise<number> {
    return this.store.db.transaction().execute(async (tx) => {
      const { rows } = await sql<{
        asset_id: string;
        kind: string;
      }>`select asset_id, kind from frameleaf_immich_import_work
        where dispatched_at is null order by asset_id, kind limit 250 for update skip locked`.execute(tx);
      const names: Record<string, JobName> = {
        metadata: JobName.AssetExtractMetadata,
        thumbnail: JobName.AssetGenerateThumbnails,
        'smart-search': JobName.SmartSearch,
        'face-detection': JobName.AssetDetectFaces,
      };
      for (const row of rows) {
        const intent = this.intent({ name: names[row.kind], data: { id: row.asset_id } } as JobItem);
        intent.options = { deduplication: { id: `import/${row.kind}/${row.asset_id}` } };
        await this.store.enqueue([intent], tx);
        await sql`update frameleaf_immich_import_work set dispatched_at = now()
          where asset_id = ${row.asset_id}::uuid and kind = ${row.kind}`.execute(tx);
      }
      return rows.length;
    });
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
      case JobName.UniversalStorageMigration: {
        // FL-326: one batch waiting at a time; the running batch queues the next itself
        return {
          deduplication: { id: JobName.UniversalStorageMigration, keepLastIfActive: true },
          ...(item.data?.delay && { delay: item.data.delay }),
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
      // ponytail: no priority for PersonGenerateThumbnail; a BullMQ priority parks jobs in the prioritized set,
      // behind every unprioritized job and outside the waiting counts (FL-71 review).
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
        // BullMQ silently dropping the second one as a duplicate of the first.
        const kind = (item.data as { kind?: string } | undefined)?.kind;
        const dedupId = kind ? `${JobName.SmartAlbumReevaluateAll}:${kind}` : JobName.SmartAlbumReevaluateAll;
        return { deduplication: { id: dedupId } };
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
