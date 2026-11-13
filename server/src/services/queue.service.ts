import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { QueueJobRow } from 'src/repositories/job.repository.js';
import type { ConcurrentQueueName, JobItem } from 'src/types.js';
import { OnEvent } from 'src/decorators.js';
import { SystemConfig } from 'src/dtos/config.dto.js';
import {
  QueueResponseLegacyDto,
  QueuesResponseLegacyDto,
  mapQueueLegacy,
  mapQueuesLegacy,
} from 'src/dtos/queue-legacy.dto.js';
import {
  QueueCommandDto,
  QueueDeleteDto,
  QueueJobResponseDto,
  QueueJobSearchDto,
  QueueOverviewResponseDto,
  QueueOwnerStatisticsResponseDto,
  QueueProblemActionDto,
  QueueProblemActionResponseDto,
  QueueResponseDto,
  QueueRetryFailedResponseDto,
  QueueRunOneDto,
  QueueUpdateDto,
} from 'src/dtos/queue.dto.js';
import {
  AssetType,
  BootstrapEventPriority,
  CronJob,
  DatabaseLock,
  FrameleafWorker,
  JobName,
  JobNameSchema,
  MlDestinationKind,
  MlWorkload,
  QueueCleanType,
  QueueCommand,
  QueueJobStatus,
  QueueJobWorkerKind,
  QueueName,
  SystemMetadataKey,
} from 'src/enum.js';
import { publishJobResult } from 'src/queue/context.js';
import { BaseService } from 'src/services/base.service.js';

/** The tasks that can run on one photo or video, and the job each queues for it. */
const RUN_ONE_JOBS: Partial<Record<QueueName, JobName>> = {
  [QueueName.ThumbnailGeneration]: JobName.AssetGenerateThumbnails,
  [QueueName.MetadataExtraction]: JobName.AssetExtractMetadata,
  [QueueName.FaceDetection]: JobName.AssetDetectFaces,
  [QueueName.Ocr]: JobName.Ocr,
  [QueueName.VideoConversion]: JobName.AssetEncodeVideo,
  // Library care's "Redo one…" and "Check one photo…" (approved design, 2026-11-04).
  [QueueName.SmartSearch]: JobName.SmartSearch,
  [QueueName.DuplicateDetection]: JobName.AssetDetectDuplicates,
  [QueueName.ImageDescription]: JobName.ImageDescription,
  [QueueName.NsfwDetection]: JobName.NsfwDetection,
};
import { getHiddenContentQueryOptions, getOthersRulesQueryOptions } from 'src/utils/hidden-content.js';
import { getLockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import {
  handlePromiseError,
  isDuplicateDetectionEnabled,
  isFacialRecognitionEnabled,
  isImageDescriptionEnabled,
  isNsfwDetectionEnabled,
  isOcrEnabled,
  isSmartSearchEnabled,
} from 'src/utils/misc.js';
import { overnightCron } from 'src/utils/overnight.js';
import { unfinishedProcessing } from 'src/utils/unfinished-processing.js';

/**
 * Recognising people runs this many faces at once (within the server's total). Creating a person stays one at a time
 * per cluster group (`PersonRepository.lockPersonCreation`), so parallel faces never start two people for one.
 */
// ponytail: fixed, no setting; add job.facialRecognition.concurrency to Settings if someone needs to tune it
const FACIAL_RECOGNITION_CONCURRENCY = 4;

/** FL-71: the machine-learning workload whose routed destination runs a queue's jobs. */
const QUEUE_ML_WORKLOADS: Partial<Record<QueueName, MlWorkload>> = {
  [QueueName.FaceDetection]: MlWorkload.Face,
  [QueueName.SmartSearch]: MlWorkload.Clip,
  [QueueName.Ocr]: MlWorkload.Ocr,
  [QueueName.ImageEnrichment]: MlWorkload.Enrichment,
  [QueueName.ImageDescription]: MlWorkload.Enrichment,
  [QueueName.NsfwDetection]: MlWorkload.Enrichment,
  [QueueName.PetRecognition]: MlWorkload.PetRecognition,
};

type MachineLearning = SystemConfig['machineLearning'];
/** FL-1486: the queues that do nothing while their feature is off (the web's `JOB_QUEUES` features). */
const QUEUE_FEATURES: Partial<Record<QueueName, (machineLearning: MachineLearning) => boolean>> = {
  [QueueName.FaceDetection]: isFacialRecognitionEnabled,
  [QueueName.FacialRecognition]: isFacialRecognitionEnabled,
  [QueueName.SmartSearch]: isSmartSearchEnabled,
  [QueueName.PetRecognition]: isSmartSearchEnabled,
  [QueueName.DuplicateDetection]: isDuplicateDetectionEnabled,
  [QueueName.VideoDuplicateDetection]: isDuplicateDetectionEnabled,
  [QueueName.Ocr]: isOcrEnabled,
  [QueueName.ImageDescription]: isImageDescriptionEnabled,
  [QueueName.NsfwDetection]: isNsfwDetectionEnabled,
  [QueueName.ImageEnrichment]: (machineLearning) =>
    isImageDescriptionEnabled(machineLearning) || isNsfwDetectionEnabled(machineLearning),
};

/** FL-1486: what each action may be used on. Missing and damaged files are Library care's; other is looked at. */
const PROBLEM_ACTIONS: Record<QueueProblemActionDto['action'], QueueProblemActionDto['cause'][]> = {
  retry: ['drive', 'writeDenied', 'mlUnavailable', 'tooLong', 'other'],
  stop: ['unsupported'],
};

/** Statuses whose job has been claimed by a worker, so its accounting names where it ran. */
const RAN_STATUSES = new Set<QueueJobStatus>([QueueJobStatus.Active, QueueJobStatus.Complete, QueueJobStatus.Failed]);

const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

const workerKindOf = (kind: MlDestinationKind): QueueJobWorkerKind => {
  switch (kind) {
    case MlDestinationKind.Local: {
      return QueueJobWorkerKind.Local;
    }
    case MlDestinationKind.Lan: {
      return QueueJobWorkerKind.Lan;
    }
    default: {
      return QueueJobWorkerKind.FrameleafCloud;
    }
  }
};

/** The ids a job's data names, in the order the owner lookup prefers them. */
const subjectIdsOf = (data: Record<string, unknown> | undefined): string[] =>
  ['id', 'assetId', 'personId', 'libraryId', 'ownerId', 'userId'].flatMap((key) => {
    const value = data?.[key];
    return typeof value === 'string' && UUID_PATTERN.test(value) ? [value.toLowerCase()] : [];
  });

/** FL-363: the overnight schedule's start, on the days it runs. */
const asNightlyTasksCron = (config: SystemConfig) => overnightCron(config.nightlyTasks);

@Injectable()
export class QueueService extends BaseService {
  private services: (new (...args: any[]) => unknown)[] = [];
  private nightlyJobsLock = false;

  @OnEvent({ name: 'ConfigInit' })
  async onConfigInit({ newConfig: config }: ArgOf<'ConfigInit'>) {
    this.jobRepository.setExecutionCapacity(config.job.capacity);
    if (this.worker === FrameleafWorker.Microservices) {
      this.updateConcurrency(config);
      return;
    }

    this.nightlyJobsLock = await this.databaseRepository.tryLock(DatabaseLock.NightlyJobs);
    if (this.nightlyJobsLock) {
      const cronExpression = asNightlyTasksCron(config);
      this.logger.debug(`Scheduling nightly jobs for ${cronExpression}`);
      this.cronRepository.create({
        name: CronJob.NightlyJobs,
        expression: cronExpression,
        start: true,
        // FL-363: the tick starts an overnight run, which runs each step after the one before it
        onTick: () => handlePromiseError(this.jobRepository.queue({ name: JobName.OvernightSequence }), this.logger),
      });
    }
  }

  @OnEvent({ name: 'ConfigUpdate', server: true })
  onConfigUpdate({ newConfig: config }: ArgOf<'ConfigUpdate'>) {
    // FL-1265: applies live; FRAMELEAF_JOB_CAPACITY, when set, wins over the setting.
    this.jobRepository.setExecutionCapacity(config.job.capacity);
    if (this.worker === FrameleafWorker.Microservices) {
      this.updateConcurrency(config);
      return;
    }

    if (this.nightlyJobsLock) {
      const cronExpression = asNightlyTasksCron(config);
      this.logger.debug(`Scheduling nightly jobs for ${cronExpression}`);
      this.cronRepository.update({ name: CronJob.NightlyJobs, expression: cronExpression, start: true });
    }
  }

  @OnEvent({ name: 'AppBootstrap', priority: BootstrapEventPriority.JobService })
  onBootstrap() {
    this.jobRepository.setup(this.services);
    if (this.worker === FrameleafWorker.Microservices) {
      this.jobRepository.startWorkers();
    } else if (this.worker === FrameleafWorker.Api) {
      this.jobRepository.watchWorkers();
    }
  }

  /**
   * FL-291: the graceful stop has already stopped the workers by now; this covers anything else that
   * closes the application, so a running job is never left active.
   */
  @OnEvent({ name: 'AppShutdown' })
  async onShutdown() {
    this.jobRepository.teardown();
    await this.jobRepository.stopWorkers(this.configRepository.getEnv().shutdown.graceMs);
  }

  private updateConcurrency(config: SystemConfig) {
    this.logger.debug(`Updating queue concurrency settings`);
    for (const queueName of Object.values(QueueName)) {
      const concurrency = this.isConcurrentQueue(queueName)
        ? config.job[queueName].concurrency
        : queueName === QueueName.FacialRecognition
          ? FACIAL_RECOGNITION_CONCURRENCY
          : 1;
      this.logger.debug(`Setting ${queueName} concurrency to ${concurrency}`);
      this.jobRepository.setConcurrency(queueName, concurrency);
    }
  }

  setServices(services: (new (...args: any[]) => unknown)[]) {
    this.services = services;
  }

  async runCommandLegacy(name: QueueName, dto: QueueCommandDto): Promise<QueueResponseLegacyDto> {
    this.logger.debug(`Handling command: queue=${name},command=${dto.command},force=${dto.force}`);

    let runId: string | undefined;
    switch (dto.command) {
      case QueueCommand.Start: {
        runId = await this.jobRepository.createRun(name, { force: dto.force ?? false }, () => this.start(name, dto));
        break;
      }

      case QueueCommand.Pause: {
        await this.pauseByPerson(name);
        break;
      }

      case QueueCommand.Resume: {
        await this.resumeAndReleaseQuietHold(name);
        break;
      }

      case QueueCommand.Empty: {
        await this.jobRepository.empty(name);
        break;
      }

      case QueueCommand.ClearFailed: {
        const failedJobs = await this.jobRepository.clear(name, QueueCleanType.Failed);
        this.logger.debug(`Cleared failed jobs: ${failedJobs}`);
        break;
      }
    }

    const response = await this.getByName(name);

    return { ...mapQueueLegacy(response), ...(runId && { runId }) };
  }

  async getAll(_auth: AuthDto): Promise<QueueResponseDto[]> {
    const names = Object.values(QueueName);
    // The Jobs page asks for every queue every few seconds: whether each is paused or has
    // unfinished work is read once for all of them, and only the counts are per queue.
    const paused = await this.jobRepository.getPausedQueues();
    const unfinished = await this.jobRepository.getQueuesWithUnfinishedWork(names);
    const queues: QueueResponseDto[] = [];
    for (let offset = 0; offset < names.length; offset += 4) {
      // Wait for this batch to settle on failure too, so a failed request cannot leave
      // its sibling snapshots consuming the database pool after the response ends.
      const results = await Promise.allSettled(
        names.slice(offset, offset + 4).map(async (name) => ({
          name,
          isPaused: paused.has(name),
          statistics: await this.jobRepository.getJobCounts(name),
          hasUnfinishedWork: unfinished.has(name),
        })),
      );
      for (const result of results) {
        if (result.status === 'rejected') throw result.reason;
        queues.push(result.value);
      }
    }
    return queues;
  }

  async getAllLegacy(auth: AuthDto): Promise<QueuesResponseLegacyDto> {
    const responses = await this.getAll(auth);
    const queues = mapQueuesLegacy(responses);
    const summary = await this.systemMetadataRepository.get(SystemMetadataKey.ProcessingReconcileLastRun);
    if (summary) queues[QueueName.BackgroundTask].processingReconcileLastRun = summary;
    return queues;
  }

  get(auth: AuthDto, name: QueueName): Promise<QueueResponseDto> {
    return this.getByName(name);
  }

  async update(auth: AuthDto, name: QueueName, dto: QueueUpdateDto): Promise<QueueResponseDto> {
    if (dto.isPaused === true) {
      if (name === QueueName.BackgroundTask) {
        throw new BadRequestException(`The BackgroundTask queue cannot be paused`);
      }
      await this.pauseByPerson(name);
    } else if (dto.isPaused === false) {
      await this.resumeAndReleaseQuietHold(name);
    }

    return this.getByName(name);
  }

  /**
   * FL-711: a queue the administrator resumes is theirs again: its pause and its quiet-hours schedule
   * are cleared and quiet hours stop holding it until the next window. FL-1265: Resume also releases
   * that queue's held import work (setup listens for `QueueResumed`). The schedule is cleared under the
   * lock quiet hours take to close and record it, so the overnight runner cannot close it in between.
   */
  private async resumeAndReleaseQuietHold(name: QueueName): Promise<void> {
    await this.databaseRepository.withLock(DatabaseLock.OvernightSequenceRun, async () => {
      await this.jobRepository.resume(name);
      await this.jobRepository.setQueueSchedule(name, null);
      const state = await this.systemMetadataRepository.get(SystemMetadataKey.OvernightSequence);
      const holding = state?.quiet?.holding;
      if (!state || !holding?.includes(name)) {
        return;
      }
      const quiet = { ...state.quiet, holding: holding.filter((held) => held !== name) };
      await this.systemMetadataRepository.set(SystemMetadataKey.OvernightSequence, { ...state, quiet });
    });
    await this.notePaused(name, false);
    await this.eventRepository.emit('QueueResumed', { queue: name });
  }

  /** FL-1486: a pause someone asked for is dated, so the task can say since when; a pause already dated keeps its date. */
  private async pauseByPerson(name: QueueName): Promise<void> {
    await this.jobRepository.pause(name);
    await this.notePaused(name, true);
  }

  private async notePaused(name: QueueName, paused: boolean): Promise<void> {
    const { [name]: since, ...others } =
      (await this.systemMetadataRepository.get(SystemMetadataKey.QueuePausedAt)) ?? {};
    if (paused ? since !== undefined : since === undefined) {
      return;
    }
    await this.systemMetadataRepository.set(
      SystemMetadataKey.QueuePausedAt,
      paused ? { ...others, [name]: new Date().toISOString() } : others,
    );
  }

  /**
   * FL-1486: Background work › Advanced. Failures by what went wrong across every queue (counts cover every account;
   * the one raw message follows Library care's privacy), and why each queue is not running. One reason per queue, the
   * one a person can act on first: feature off, then paused, then quiet hours, then waiting for another queue.
   */
  async getOverview(auth: AuthDto): Promise<QueueOverviewResponseDto> {
    const [problems, holds, pausedAt, { machineLearning }] = await Promise.all([
      this.jobRepository.listQueueProblems({
        ...getHiddenContentQueryOptions(auth),
        ...getLockedVisibilityOptions(auth),
        ...getOthersRulesQueryOptions(auth),
      }),
      this.jobRepository.getQueueHolds(),
      this.systemMetadataRepository.get(SystemMetadataKey.QueuePausedAt),
      this.getConfig({ withCache: true }),
    ]);
    const names = new Set<string>(Object.values(QueueName));
    const held = new Map(holds.map((hold) => [hold.name, hold]));
    return {
      problems: problems.map((problem) => ({
        ...problem,
        queues: problem.queues.filter((queue): queue is QueueName => names.has(queue)),
      })),
      tasks: Object.values(QueueName).map((name) => {
        const hold = held.get(name);
        if (QUEUE_FEATURES[name]?.(machineLearning) === false) {
          return { name, reason: 'featureOff' as const };
        }
        if (hold?.paused) {
          return { name, reason: 'paused' as const, ...(pausedAt?.[name] && { pausedAt: pausedAt[name] }) };
        }
        if (hold?.closedUntil) {
          return { name, reason: 'quietHours' as const, closedUntil: new Date(hold.closedUntil).toISOString() };
        }
        if (hold?.waitingFor && names.has(hold.waitingFor)) {
          return { name, reason: 'waitingFor' as const, waitingFor: hold.waitingFor as QueueName };
        }
        return { name, reason: null };
      }),
    };
  }

  /** FL-1486: Try again or Stop trying on every failed job with one problem. */
  async actOnProblem(_auth: AuthDto, { cause, action }: QueueProblemActionDto): Promise<QueueProblemActionResponseDto> {
    if (!PROBLEM_ACTIONS[action].includes(cause)) {
      throw new BadRequestException(`This problem can't be handled with ${action}`);
    }
    return { count: await this.jobRepository.actOnQueueProblem(cause, action) };
  }

  /**
   * The jobs of one queue, with the Job manager's Account and Worker columns (FL-71,
   * `JobsManager.jsx` 758-796). The account is the owner of the asset, person, library or account
   * the job's data names. The worker is the server itself for queues that do not call machine
   * learning; for those that do, a job that has run names the destination its latest accounted
   * request went to, and any other job the destination its workload is routed to now.
   */
  async searchJobs(auth: AuthDto, name: QueueName, dto: QueueJobSearchDto): Promise<QueueJobResponseDto[]> {
    // Filter the actual response as well as its schema: older clients cannot decode internal job names.
    const jobs = (await this.jobRepository.searchJobs(name, dto, undefined, true)).filter(
      (job): job is QueueJobRow & Pick<QueueJobResponseDto, 'name'> => JobNameSchema.safeParse(job.name).success,
    );
    if (jobs.length === 0) {
      return [];
    }

    const subjects = jobs.map((job) => subjectIdsOf(job.data));
    const ids = [...new Set(subjects.flat())];
    const owners = new Map((await this.userRepository.getJobSubjectOwners(ids)).map((row) => [row.subjectId, row]));

    const workload = QUEUE_ML_WORKLOADS[name];
    let routed: QueueJobResponseDto['worker'] = { kind: QueueJobWorkerKind.Server, name: null };
    const ran = new Map<string, QueueJobResponseDto['worker']>();
    if (workload) {
      const route = await this.mlDestinationRepository.getRoute(workload);
      const destination = route ? await this.mlDestinationRepository.getById(route.destinationId) : undefined;
      routed = destination
        ? { kind: workerKindOf(destination.kind), name: destination.name }
        : { kind: QueueJobWorkerKind.Server, name: null };

      const claimed = jobs.filter((job, index) => RAN_STATUSES.has(job.status) && subjects[index].length > 0);
      const accounted =
        claimed.length === 0
          ? []
          : await this.mlDestinationRepository.getLatestJobDestinations(
              [...new Set(claimed.map((job) => subjectIdsOf(job.data)[0]))],
              [...new Set(claimed.map((job) => job.name))],
            );
      for (const row of accounted) {
        ran.set(`${row.jobName}:${row.jobId.toLowerCase()}`, {
          kind: workerKindOf(row.destinationKind),
          name: row.destinationName,
        });
      }
    }

    const result = jobs.map(({ status, ...job }, index) => {
      const owner = subjects[index].map((id) => owners.get(id)).find(Boolean);
      const subject = subjects[index][0];
      const worker = (RAN_STATUSES.has(status) && subject && ran.get(`${job.name}:${subject}`)) || routed;
      return {
        ...job,
        ...(owner && { account: { id: owner.ownerId, name: owner.ownerName } }),
        worker,
      };
    });
    // the repository already kept only `dto.ownerId`'s jobs
    return result;
  }

  /**
   * FL-71 (J-1): how many of a queue's jobs, per state, work on one account's items, counted in the database
   * over the whole queue. `truncated` stays in the response for older apps; a count is never a lower bound now.
   */
  async getOwnerStatistics(auth: AuthDto, name: QueueName, ownerId: string): Promise<QueueOwnerStatisticsResponseDto> {
    return { ...(await this.jobRepository.getJobCounts(name, ownerId)), truncated: false };
  }

  /**
   * FL-71 "Retry failed" (`jobs-data.mjs` 906-919): put every failed job of the queue back in it
   * with its saved data. Returns how many were failed when the command ran.
   */
  async retryFailedJobs(auth: AuthDto, name: QueueName): Promise<QueueRetryFailedResponseDto> {
    return { count: await this.jobRepository.retryFailed(name) };
  }

  /** Retry one failed job with its saved data (approved design, 2026-11-04). */
  async retryJob(auth: AuthDto, name: QueueName, id: string): Promise<void> {
    if ((await this.jobRepository.retryFailed(name, id)) === 0) {
      throw new BadRequestException('This job has not failed, or it cannot be run again');
    }
  }

  /** Start one waiting job now, even while its task is paused or busy (approved design, 2026-11-04). */
  async startJob(auth: AuthDto, name: QueueName, id: string): Promise<void> {
    if (!(await this.jobRepository.startNow(name, id))) {
      throw new BadRequestException('This job is not waiting to run');
    }
  }

  /**
   * Run on one item (approved design, 2026-11-04): the task's job for one photo or video, started at
   * once, even while the task is paused or busy. Only the tasks that work on one item at a time,
   * with the same jobs as the asset page's refresh actions.
   */
  async runOne(auth: AuthDto, name: QueueName, { assetId }: QueueRunOneDto): Promise<void> {
    const jobName = RUN_ONE_JOBS[name];
    if (!jobName) {
      throw new BadRequestException('This task does not run on one item');
    }
    const asset = await this.assetRepository.getById(assetId);
    if (!asset) {
      throw new NotFoundException('Asset not found');
    }
    if (name === QueueName.VideoConversion && asset.type !== AssetType.Video) {
      throw new BadRequestException('Playback videos are made for videos only');
    }
    if (name === QueueName.NsfwDetection && asset.type !== AssetType.Image) {
      throw new BadRequestException('Locked content is reread for photos only');
    }
    // FL-1249: the item's job already running counts as started, and one already waiting is started now;
    // queueing another while one runs would run the item twice at once (these jobs have no dedupe key).
    // ponytail: check-then-queue, so two clicks at the same instant can still queue two; a dedupe key if that matters
    let job = await this.jobRepository.findOpenJob(name, jobName, assetId);
    if (!job) {
      await this.jobRepository.queue({ name: jobName, data: { id: assetId } } as JobItem);
      job = await this.jobRepository.findOpenJob(name, jobName, assetId);
    }
    if (!job || (!job.active && !(await this.jobRepository.startNow(name, job.id)))) {
      throw new BadRequestException('This item’s job could not be started now');
    }
  }

  async emptyQueue(auth: AuthDto, name: QueueName, dto: QueueDeleteDto) {
    await this.jobRepository.empty(name);
    if (dto.failed) {
      await this.jobRepository.clear(name, QueueCleanType.Failed);
    }
  }

  private async getByName(name: QueueName): Promise<QueueResponseDto> {
    const statistics = await this.jobRepository.getJobCounts(name);
    const isPaused = await this.jobRepository.isPaused(name);
    const hasUnfinishedWork = await this.jobRepository.hasUnfinishedWork(name);
    return { name, isPaused, statistics, hasUnfinishedWork };
  }

  private async start(name: QueueName, { force, includeSetAside }: QueueCommandDto): Promise<void> {
    const isActive = await this.jobRepository.isActive(name);
    if (isActive) {
      throw new BadRequestException(`Job is already running`);
    }

    await this.eventRepository.emit('QueueStart', { name });
    const processing = { force, ...(force && includeSetAside && { includeSetAside: true }) };

    switch (name) {
      case QueueName.VideoConversion: {
        return this.jobRepository.queue({ name: JobName.AssetEncodeVideoQueueAll, data: processing });
      }

      case QueueName.StorageTemplateMigration: {
        return this.jobRepository.queue({ name: JobName.StorageTemplateMigration });
      }

      case QueueName.Migration: {
        return this.jobRepository.queue({ name: JobName.FileMigrationQueueAll });
      }

      case QueueName.SmartSearch: {
        return this.jobRepository.queue({ name: JobName.SmartSearchQueueAll, data: processing });
      }

      case QueueName.DuplicateDetection: {
        return this.jobRepository.queue({ name: JobName.AssetDetectDuplicatesQueueAll, data: { force } });
      }

      case QueueName.VideoDuplicateDetection: {
        return this.jobRepository.queue({ name: JobName.AssetVideoFingerprintQueueAll, data: { force } });
      }

      case QueueName.MetadataExtraction: {
        return this.jobRepository.queue({ name: JobName.AssetExtractMetadataQueueAll, data: processing });
      }

      case QueueName.Sidecar: {
        return this.jobRepository.queue({ name: JobName.SidecarQueueAll, data: { force } });
      }

      case QueueName.ThumbnailGeneration: {
        return this.jobRepository.queue({ name: JobName.AssetGenerateThumbnailsQueueAll, data: processing });
      }

      case QueueName.FaceDetection: {
        return this.jobRepository.queue({ name: JobName.AssetDetectFacesQueueAll, data: processing });
      }

      case QueueName.FacialRecognition: {
        return this.jobRepository.queue({ name: JobName.FacialRecognitionQueueAll, data: { force } });
      }

      case QueueName.Library: {
        return this.jobRepository.queue({ name: JobName.LibraryScanQueueAll, data: { force } });
      }

      case QueueName.BackupDatabase: {
        return this.jobRepository.queue({ name: JobName.DatabaseBackup, data: { force } });
      }

      case QueueName.Ocr: {
        return this.jobRepository.queue({ name: JobName.OcrQueueAll, data: processing });
      }

      case QueueName.NsfwDetection: {
        const { machineLearning } = await this.getConfig({ withCache: false });
        if (!isNsfwDetectionEnabled(machineLearning)) {
          throw new BadRequestException(`NSFW detection is not enabled`);
        }

        return this.jobRepository.queue({ name: JobName.NsfwDetectionQueueAll, data: { force } });
      }

      case QueueName.MediaHealth: {
        return this.jobRepository.queue({ name: JobName.MediaHealthScanMissing, data: { force } });
      }

      case QueueName.PetRecognition: {
        const { machineLearning } = await this.getConfig({ withCache: false });
        if (!isSmartSearchEnabled(machineLearning)) {
          throw new BadRequestException(`Pet recognition needs smart search, which is not enabled`);
        }

        return this.jobRepository.queue({ name: JobName.PetRecognitionQueueAll, data: { force } });
      }

      case QueueName.ImageDescription: {
        const { machineLearning } = await this.getConfig({ withCache: false });
        if (!isImageDescriptionEnabled(machineLearning)) {
          throw new BadRequestException(`Image descriptions and tags are not enabled`);
        }

        return this.jobRepository.queue({ name: JobName.ImageDescriptionQueueAll, data: { force } });
      }

      case QueueName.ImageEnrichment: {
        const { machineLearning } = await this.getConfig({ withCache: false });
        const jobs: JobItem[] = [];

        if (isNsfwDetectionEnabled(machineLearning)) {
          jobs.push({ name: JobName.NsfwDetectionQueueAll, data: { force } });
        }

        if (isImageDescriptionEnabled(machineLearning)) {
          jobs.push({ name: JobName.ImageDescriptionQueueAll, data: { force } });
        }

        if (jobs.length === 0) {
          throw new BadRequestException(`Image enrichment is not enabled`);
        }

        return this.jobRepository.queueAll(jobs);
      }

      default: {
        throw new BadRequestException(`Invalid job name: ${name}`);
      }
    }
  }

  private isConcurrentQueue(name: QueueName): name is ConcurrentQueueName {
    return ![
      QueueName.FacialRecognition,
      QueueName.StorageTemplateMigration,
      QueueName.DuplicateDetection,
      QueueName.BackupDatabase,
    ].includes(name);
  }

  /**
   * The overnight schedule's first step, "Empty Trash and tidy up" (FL-363), and the counts that run
   * every night whatever the step's timing. `cleanup` is false on a night the step does not run.
   */
  async handleNightlyJobs({ cleanup = true }: { cleanup?: boolean } = {}) {
    const config = await this.getConfig({ withCache: false });
    const jobs: JobItem[] = [];
    const tidy = cleanup && config.nightlyTasks.databaseCleanup;

    if (tidy) {
      // FL-363: Trash is emptied, and deleted accounts removed, only while that choice is on
      if (config.nightlyTasks.emptyTrash) {
        jobs.push({ name: JobName.AssetDeleteCheck }, { name: JobName.UserDeleteCheck });
      }
      jobs.push(
        { name: JobName.PersonCleanup },
        { name: JobName.MemoryCleanup },
        { name: JobName.SessionCleanup },
        { name: JobName.HlsSessionCleanup },
        { name: JobName.AuditTableCleanup },
      );
      // FL-32: cleanups that are not queue jobs, so the public job names stay as they are
      await this.eventRepository.emit('NightlyDatabaseCleanup');
    }

    // FL-363: switching the tidy-up step off also stops these catching up (the page says so)
    if (tidy && config.nightlyTasks.generateMemories) {
      jobs.push({ name: JobName.MemoryGenerate });
    }

    if (tidy && config.nightlyTasks.syncQuotaUsage) {
      jobs.push({ name: JobName.UserSyncUsage });
    }

    if (tidy && config.nightlyTasks.missingThumbnails) {
      jobs.push({ name: JobName.AssetGenerateThumbnailsQueueAll, data: { force: false } });
    }

    if (tidy && config.nightlyTasks.clusterNewFaces) {
      jobs.push({ name: JobName.FacialRecognitionQueueAll, data: { force: false, nightly: true } });
    }

    // FL-79: the local analytics collector runs every night. It only reads counts and sizes and
    // writes them to this server's database, never elsewhere. FL-71: an administrator can turn it
    // off ("Collect local metrics"); the collector also checks the setting when it runs.
    if (config.analytics.enabled) {
      jobs.push({ name: JobName.AnalyticsCollect });
    }

    // FL-228: wake devices whose phone backup went stale; does nothing unless the server is linked
    jobs.push({ name: JobName.PushBackupStaleCheck });

    await this.jobRepository.queueAll(jobs);
    if (config.nightlyTasks.reprocessUnfinished) {
      await this.reconcileUnfinished(config);
    }
  }

  /** Let the existing processing queues apply their usual privacy and overnight holds. */
  private async reconcileUnfinished(config: SystemConfig) {
    const { selections, options } = unfinishedProcessing(config);
    const counts = { metadata: 0, thumbnails: 0, video: 0, search: 0, faces: 0, text: 0 };
    for (const step of Object.keys(selections) as Array<keyof typeof selections>) {
      const [name, enabled] = selections[step];
      if (enabled) {
        const queue = this.jobRepository.getQueueName(name);
        const selection = (after: string | null) =>
          this.assetJobRepository.selectionForUnfinished(name, { ...options, queue, after });
        const data = step === 'metadata' || step === 'thumbnails' ? { reconcileUnfinished: true } : {};
        const { inserted } = await this.jobRepository.queueSelection(name, selection, data, 1000);
        counts[step] = inserted;
      }
    }
    await publishJobResult(() =>
      this.systemMetadataRepository.set(SystemMetadataKey.ProcessingReconcileLastRun, {
        ...counts,
        completedAt: new Date().toISOString(),
      }),
    );
  }
}
