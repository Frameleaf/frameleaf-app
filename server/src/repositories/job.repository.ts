import { getQueueToken } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';
import { Job, JobsOptions, Queue, Worker, type WorkerOptions } from 'bullmq';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Redis } from 'ioredis';
import type { JobCounts, JobItem, JobOf } from 'src/types.js';
import { JOBS_NOT_RETRIED, JOBS_WITH_SENSITIVE_DATA } from 'src/constants.js';
import { JobConfig } from 'src/decorators.js';
import { QueueJobResponseDto, QueueJobSearchDto } from 'src/dtos/queue.dto.js';
import { ImmichWorker, JobName, JobStatus, MetadataKey, QueueCleanType, QueueJobStatus, QueueName } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { ANALYTICS_AUTO_RETRY_DELAY_MS } from 'src/utils/analytics.js';
import { ImmichStartupError, getKeyByValue, getMethodNames } from 'src/utils/misc.js';

/** A queue job as bullmq has it, before the Job manager's account and worker are added (FL-71). */
export type QueueJobRow = Omit<QueueJobResponseDto, 'account' | 'worker'> & { status: QueueJobStatus };

type JobMapItem = {
  jobName: JobName;
  queueName: QueueName;
  handler: (job: JobOf<any>) => Promise<JobStatus>;
  label: string;
};

export const getForkSchemaBackfillJobOptions = (kind: JobOf<JobName.ForkSchemaBackfill>['kind']): JobsOptions => ({
  deduplication: { id: `${JobName.ForkSchemaBackfill}:${kind}`, keepLastIfActive: true },
});

const DATABASE_BACKUP_LOCK_DURATION = 30 * 60_000;

/**
 * Size of the per-job-name ring buffer used to compute a rolling average of
 * job completion duration. Sized for steady-state image-description workloads
 * (~10s/job, 100 samples ≈ last ~16 minutes of activity) — large enough to
 * smooth out outliers, small enough that fresh hardware/model changes are
 * reflected in the estimate within a few minutes of activity.
 */
const ROLLING_AVG_BUFFER_SIZE = 100;
const WORKER_WATCH_INTERVAL_MS = 30_000;

/**
 * How long after a job finishes the worker looks at whether its queue has drained (FL-72). While a
 * queue is busy the look happens at most this often; after its last job it happens once, this long
 * after, which is what closes the run.
 */
export const QUEUE_RUN_IDLE_CHECK_MS = 2000;

/**
 * How long a queue must stay empty before its run is over (FL-72). Work often arrives in bursts —
 * metadata extraction feeds thumbnail generation one asset at a time — and a queue that empties for
 * a moment between two of them is still the same run: its bar must carry on, not restart at zero.
 */
export const QUEUE_RUN_IDLE_GRACE_MS = 10_000;

/** What the running-jobs summary shows for one queue's current run (FL-72). */
export type QueueRun = {
  active: number;
  /** Waiting to start: queued, prioritized, or held by a paused queue. Delayed jobs are not counted. */
  waiting: number;
  /** Finished, completed or failed, since the run started. */
  processed: number;
  /** When the run was first seen with work in it; null when the queue is idle. */
  startedAt: Date | null;
};

/**
 * One queue's run window, kept in Redis beside the queue itself so the API process that answers the
 * summary sees what the microservices worker counted (FL-72).
 *
 * `processed` only ever goes up: the worker adds one for every job that finishes. `base` is where
 * the current run started counting from, and `startedAt` when it was first seen with work. A queue
 * found empty starts its grace period (`idleSince`); once it has stayed empty for the whole grace
 * period the run closes: `base` catches up with `processed` and `startedAt` is removed, so the next
 * job to arrive starts a new run at zero. Work arriving during the grace period continues the run.
 * Everything happens in one script, so two observers — the worker's idle check and an
 * administrator's poll — can never interleave half an update.
 *
 * The clock is Redis's own, so an API process and a worker on different hosts agree on it.
 *
 * KEYS[1] the run hash; ARGV[1] active + waiting now; ARGV[2] the grace period in ms.
 * Returns `{processed in this run, startedAt}`; startedAt is an empty string for a closed run.
 */
const QUEUE_RUN_SCRIPT = `
local key = KEYS[1]
local pending = tonumber(ARGV[1])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local processed = tonumber(redis.call('HGET', key, 'processed') or '0')
local base = tonumber(redis.call('HGET', key, 'base') or '0')
if base > processed then
  base = processed
  redis.call('HSET', key, 'base', base)
end
local startedAt = redis.call('HGET', key, 'startedAt')
if pending == 0 then
  if not startedAt then
    redis.call('HSET', key, 'base', processed)
    return {0, ''}
  end
  local idleSince = tonumber(redis.call('HGET', key, 'idleSince') or '')
  if not idleSince then
    redis.call('HSET', key, 'idleSince', now)
    return {processed - base, startedAt}
  end
  if now - idleSince >= tonumber(ARGV[2]) then
    redis.call('HSET', key, 'base', processed)
    redis.call('HDEL', key, 'startedAt', 'idleSince')
    return {0, ''}
  end
  return {processed - base, startedAt}
end
redis.call('HDEL', key, 'idleSince')
if not startedAt then
  startedAt = tostring(now)
  redis.call('HSET', key, 'startedAt', startedAt)
end
return {processed - base, startedAt}
`;

@Injectable()
export class JobRepository {
  private workers: Partial<Record<QueueName, Worker>> = {};
  private handlers: Partial<Record<JobName, JobMapItem>> = {};
  private workerWatcher?: ReturnType<typeof setInterval>;
  private microservicesPresent = true;

  /**
   * In-memory ring buffer of per-job-name completion durations (ms).
   *
   * - Populated by the BullMQ Worker `completed` event (finishedOn - processedOn).
   * - Bounded to ROLLING_AVG_BUFFER_SIZE entries; oldest entries are dropped first.
   * - Resets on process restart — acceptable for v1. A persistent store would
   *   require schema churn for marginal value (admin only consults this when
   *   estimating the cost of a one-shot re-queue).
   * - Not shared across workers; each Node process keeps its own buffer. The
   *   single-process default deployment means the API process happens to see
   *   every completion event it owns, which is good enough for an estimate.
   */
  private rollingAvgBuffers: Partial<Record<JobName, number[]>> = {};

  /** Pending "has this queue drained?" looks, one per queue at most (FL-72). */
  private queueRunChecks: Partial<Record<QueueName, ReturnType<typeof setTimeout>>> = {};

  constructor(
    private moduleRef: ModuleRef,
    private configRepository: ConfigRepository,
    private eventRepository: EventRepository,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(JobRepository.name);
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
    const { bull } = this.configRepository.getEnv();
    for (const queueName of Object.values(QueueName)) {
      this.logger.debug(`Starting worker for queue: ${queueName}`);
      this.workers[queueName] = new Worker(
        queueName,
        (job) => this.processJob(queueName, job),
        this.getWorkerOptions(queueName, bull.config as WorkerOptions),
      );
      this.registerWorkerEvents(queueName, this.workers[queueName]);
    }
  }

  private getWorkerOptions(queueName: QueueName, bullConfig: WorkerOptions): WorkerOptions {
    const workerOptions: WorkerOptions = { ...bullConfig, concurrency: 1, name: ImmichWorker.Microservices };

    if (queueName === QueueName.BackupDatabase) {
      workerOptions.lockDuration = DATABASE_BACKUP_LOCK_DURATION;
      workerOptions.lockRenewTime = DATABASE_BACKUP_LOCK_DURATION / 2;
    }

    return workerOptions;
  }

  private async processJob(queueName: QueueName, job: Job): Promise<void> {
    try {
      await this.eventRepository.emit('JobRun', queueName, job as JobItem);
    } catch (error: any) {
      this.logger.error(`Unable to process job ${job.name} in queue ${queueName}: ${error}`, error?.stack);
      throw error;
    }
  }

  private registerWorkerEvents(queueName: QueueName, worker?: Worker) {
    worker?.on('error', (error) => {
      this.logger.error(`Queue worker error in ${queueName}: ${error}`, error?.stack);
    });

    worker?.on('failed', (job, error) => {
      this.logger.error(`Job ${job?.name || 'unknown'} failed in queue ${queueName}: ${error}`, error?.stack);
      // Jobs make one attempt, so a failure is final and counts towards the run like a completion.
      this.recordQueueRunJob(queueName);
    });

    worker?.on('stalled', (jobId, previous) => {
      this.logger.warn(`Job ${jobId} stalled in queue ${queueName} from ${previous}`);
    });

    worker?.on('completed', (job) => {
      this.recordQueueRunJob(queueName);

      // BullMQ sets processedOn when the worker picks the job up and
      // finishedOn when the handler resolves. Both are present on `completed`
      // events; guard defensively to avoid crashing on any future BullMQ
      // changes.
      const startedAt = job.processedOn;
      const finishedAt = job.finishedOn;
      if (startedAt === undefined || finishedAt === undefined || finishedAt < startedAt) {
        return;
      }
      const duration = finishedAt - startedAt;
      this.recordRollingAvgSample(job.name as JobName, duration);
    });
  }

  private recordRollingAvgSample(name: JobName, durationMs: number) {
    let buffer = this.rollingAvgBuffers[name];
    if (!buffer) {
      buffer = [];
      this.rollingAvgBuffers[name] = buffer;
    }
    buffer.push(durationMs);
    if (buffer.length > ROLLING_AVG_BUFFER_SIZE) {
      // Drop the oldest sample. shift() is O(n) but n is bounded at 100, so
      // even a hot description queue won't notice. If this gets hot we can
      // swap in a true ring buffer with a write index.
      buffer.shift();
    }
  }

  /**
   * Returns the rolling-average completion duration (ms) for the given job
   * name, or `null` if no samples have been recorded since process start.
   * Used by the admin re-queue cost estimator to show a realistic wall-clock
   * estimate that reflects the user's actual hardware.
   */
  getRollingAvgMs(name: JobName): number | null {
    const buffer = this.rollingAvgBuffers[name];
    if (!buffer || buffer.length === 0) {
      return null;
    }
    let sum = 0;
    for (const sample of buffer) {
      sum += sample;
    }
    return sum / buffer.length;
  }

  /* ------------------------------------------------------------------ */
  /* Queue runs (FL-72)                                                  */
  /* ------------------------------------------------------------------ */

  /**
   * Count one finished job towards its queue's run, and make sure somebody looks at whether the
   * queue has drained shortly afterwards. Called from the worker's own events; a Redis hiccup here
   * only makes a progress bar less exact, so it is logged and never allowed to fail the job.
   */
  private recordQueueRunJob(queueName: QueueName) {
    // a count that cannot be made (no queue yet, Redis away) never breaks the listener that records it
    void Promise.try(() => this.queueRunClient(queueName))
      .then((client) => client.hincrby(this.queueRunKey(queueName), 'processed', 1))
      .catch((error) => this.logger.debug(`Unable to count a finished ${queueName} job: ${error}`));

    this.scheduleQueueRunCheck(queueName, QUEUE_RUN_IDLE_CHECK_MS);
  }

  /**
   * Look at the queue once, `delayMs` from now, unless a look is already pending. A queue found empty
   * with its run still open is in its grace period, so it is looked at again once that has passed;
   * that second look is what closes a run nobody is watching.
   */
  private scheduleQueueRunCheck(queueName: QueueName, delayMs: number) {
    this.queueRunChecks[queueName] ??= setTimeout(() => {
      this.queueRunChecks[queueName] = undefined;
      this.observeQueueRun(queueName)
        .then((run) => {
          if (run.active + run.waiting === 0 && run.startedAt) {
            this.scheduleQueueRunCheck(queueName, QUEUE_RUN_IDLE_GRACE_MS);
          }
        })
        .catch((error) => this.logger.debug(`Unable to check whether ${queueName} drained: ${error}`));
    }, delayMs);
    this.queueRunChecks[queueName]?.unref?.();
  }

  /**
   * The queue's current run: how much is active and waiting now, and how much has finished since
   * the run started. Looking also moves the window: a queue with work and no open run starts one,
   * and one that has stayed empty through the grace period closes it. `total = processed + active +
   * waiting` therefore grows as work is added and holds steady as work finishes; it never goes
   * backwards within a run.
   */
  async observeQueueRun(name: QueueName): Promise<QueueRun> {
    const counts: Record<string, number | undefined> = await this.getQueue(name).getJobCounts(
      'active',
      'waiting',
      'prioritized',
      'paused',
    );
    const active = counts.active ?? 0;
    const waiting = (counts.waiting ?? 0) + (counts.prioritized ?? 0) + (counts.paused ?? 0);

    const client = await this.queueRunClient(name);
    const [processed, startedAt] = (await client.eval(
      QUEUE_RUN_SCRIPT,
      1,
      this.queueRunKey(name),
      String(active + waiting),
      String(QUEUE_RUN_IDLE_GRACE_MS),
    )) as [number, string];

    return {
      active,
      waiting,
      processed: Math.max(0, Number(processed) || 0),
      startedAt: startedAt ? new Date(Number(startedAt)) : null,
    };
  }

  private queueRunKey(name: QueueName) {
    const { bull } = this.configRepository.getEnv();
    return `${bull.config.prefix ?? 'bull'}:frameleaf:queue-run:${name}`;
  }

  private queueRunClient(name: QueueName) {
    return this.getQueue(name).client as unknown as Promise<Redis>;
  }

  watchWorkers() {
    this.workerWatcher ??= setInterval(() => void this.checkWorkers(), WORKER_WATCH_INTERVAL_MS);
  }

  teardown() {
    if (!this.workerWatcher) {
      return;
    }

    clearInterval(this.workerWatcher);
    this.workerWatcher = undefined;
  }

  private async checkWorkers() {
    let isPresent: boolean;
    try {
      const suffix = `:w:${ImmichWorker.Microservices}`;
      const workers = await this.getQueue(QueueName.BackgroundTask).getWorkers();
      isPresent = workers.some((worker) => worker.rawname?.endsWith(suffix));
    } catch {
      return;
    }

    if (this.microservicesPresent !== isPresent) {
      if (isPresent) {
        this.logger.log('Microservices worker connected.');
      } else {
        this.logger.warn(
          'No microservices worker is connected. Background jobs will not be processed until one is running.',
        );
      }
    }
    this.microservicesPresent = isPresent;
  }

  async run({ name, data }: JobItem) {
    const item = this.handlers[name as JobName];
    if (!item) {
      this.logger.warn(`Skipping unknown job: "${name}"`);
      return JobStatus.Skipped;
    }

    return item.handler(data);
  }

  setConcurrency(queueName: QueueName, concurrency: number) {
    const worker = this.workers[queueName];
    if (!worker) {
      this.logger.warn(`Unable to set queue concurrency, worker not found: '${queueName}'`);
      return;
    }

    worker.concurrency = concurrency;
  }

  async isActive(name: QueueName): Promise<boolean> {
    const queue = this.getQueue(name);
    const count = await queue.getActiveCount();
    return count > 0;
  }

  async isPaused(name: QueueName): Promise<boolean> {
    return this.getQueue(name).isPaused();
  }

  pause(name: QueueName) {
    return this.getQueue(name).pause();
  }

  resume(name: QueueName) {
    return this.getQueue(name).resume();
  }

  empty(name: QueueName) {
    return this.getQueue(name).drain();
  }

  clear(name: QueueName, type: QueueCleanType) {
    return this.getQueue(name).clean(0, 1000, type);
  }

  /**
   * FL-71 "Retry failed" (`JobsManager.jsx` 715-727): every failed job of the queue goes back to
   * waiting (or paused, when the queue is paused) with its saved data, in batches of 1,000.
   */
  retryFailed(name: QueueName) {
    return this.getQueue(name).retryJobs({ state: 'failed', count: 1000 });
  }

  getJobCounts(name: QueueName): Promise<JobCounts> {
    return this.getQueue(name).getJobCounts(
      'active',
      'completed',
      'failed',
      'delayed',
      'waiting',
      'paused',
    ) as unknown as Promise<JobCounts>;
  }

  /**
   * Check whether a deduplicated job (via BullMQ dedup id) is currently
   * in-flight on the given queue. Used to surface the "already running"
   * state for one-shot admin-triggered jobs that share a queue with others
   * (e.g. SmartAlbumReevaluateAll on BackgroundTask).
   */
  async hasDedupJob(name: QueueName, dedupId: string): Promise<boolean> {
    const jobId = await this.getQueue(name).getDeduplicationJobId(dedupId);
    return jobId !== null && jobId !== undefined;
  }

  private getQueueName(name: JobName) {
    return (this.handlers[name] as JobMapItem).queueName;
  }

  async queueAll(items: JobItem[]): Promise<void> {
    if (items.length === 0) {
      return;
    }

    const promises = [];
    const itemsByQueue = {} as Record<string, { name: JobName; data: any; opts?: JobsOptions }[]>;
    for (const item of items) {
      const queueName = this.getQueueName(item.name);
      const job = {
        name: item.name,
        data: item.data || {},
        options: this.getJobOptions(item) || undefined,
      } as JobItem & { data: any; options: JobsOptions | undefined };

      if (job.options?.jobId || job.options?.deduplication) {
        // need to use add() instead of addBulk() for jobId/deduplication to take effect
        promises.push(this.getQueue(queueName).add(item.name, item.data, job.options));
      } else {
        itemsByQueue[queueName] ||= [];
        // addBulk reads a job's options from `opts`
        itemsByQueue[queueName].push({ name: job.name, data: job.data, opts: job.options });
      }
    }

    for (const [queueName, jobs] of Object.entries(itemsByQueue)) {
      const queue = this.getQueue(queueName as QueueName);
      promises.push(queue.addBulk(jobs));
    }

    await Promise.all(promises);
  }

  async queue(item: JobItem): Promise<void> {
    return this.queueAll([item]);
  }

  async waitForQueueCompletion(...queues: QueueName[]): Promise<void> {
    const getPending = async () => {
      const results = await Promise.all(queues.map(async (name) => ({ pending: await this.isActive(name), name })));
      return results.filter(({ pending }) => pending).map(({ name }) => name);
    };

    let pending = await getPending();

    while (pending.length > 0) {
      this.logger.verbose(`Waiting for ${pending[0]} queue to stop...`);
      await sleep(1000);
      pending = await getPending();
    }
  }

  async searchJobs(name: QueueName, dto: QueueJobSearchDto, limit = 1000): Promise<QueueJobRow[]> {
    const jobs = await this.getQueue(name).getJobs(dto.status ?? Object.values(QueueJobStatus), 0, limit - 1);
    const only = dto.status?.length === 1 ? dto.status[0] : undefined;
    return jobs.map((job) => {
      const { id, name, timestamp, data, attemptsMade, failedReason, finishedOn, processedOn, delay } = job;
      // FL-71: the status decides whether the job's worker is where it ran or where it will run.
      const status =
        only ??
        (finishedOn
          ? failedReason
            ? QueueJobStatus.Failed
            : QueueJobStatus.Complete
          : processedOn
            ? QueueJobStatus.Active
            : delay > 0 && timestamp + delay > Date.now()
              ? QueueJobStatus.Delayed
              : QueueJobStatus.Waiting);
      return {
        status,
        id,
        name: name as JobName,
        timestamp,
        // FL-71: the signup notice and its mail carry a password, which the Job manager never shows
        data: JOBS_WITH_SENSITIVE_DATA.has(name as JobName) ? {} : data,
        attemptsMade,
        // FL-71: the Job manager shows a failed job's last error; bullmq keeps it on the job. A
        // stack-sized message is cut to the 500 characters the manager has room for.
        ...(failedReason && { failedReason: failedReason.slice(0, 500) }),
      };
    });
  }

  private getJobOptions(item: JobItem): JobsOptions | null {
    const options = this.getNamedJobOptions(item);
    // FL-71: a job that must never be retried, or whose data is sensitive, is not kept once it has
    // failed, however it failed (a handler error is not rethrown for these, but a stalled job still fails)
    return JOBS_NOT_RETRIED.has(item.name) ? { ...options, removeOnFail: true } : options;
  }

  private getNamedJobOptions(item: JobItem): JobsOptions | null {
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
      case JobName.WorkflowAssetTrigger: {
        // FL-179: one job per execution, so a replayed run that queues its automatic retry again adds none
        return item.data.executionId ? { jobId: `workflow-${item.data.executionId}` } : null;
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
      case JobName.ForkSchemaBackfill: {
        return getForkSchemaBackfillJobOptions(item.data.kind);
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
      case JobName.DatabaseBackup: {
        return { deduplication: { id: JobName.DatabaseBackup } };
      }
      default: {
        return null;
      }
    }
  }

  private getQueue(queue: QueueName): Queue {
    return this.moduleRef.get<Queue>(getQueueToken(queue), { strict: false });
  }

  /** @deprecated */
  // todo: remove this when asset notifications no longer need it.
  public async removeJob(name: JobName, jobID: string): Promise<void> {
    const existingJob = await this.getQueue(this.getQueueName(name)).getJob(jobID);
    if (existingJob) {
      await existingJob.remove();
    }
  }
}
