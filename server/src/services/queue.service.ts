import { BadRequestException, Injectable } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
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
  QueueOwnerStatisticsResponseDto,
  QueueResponseDto,
  QueueRetryFailedResponseDto,
  QueueUpdateDto,
} from 'src/dtos/queue.dto.js';
import {
  BootstrapEventPriority,
  CronJob,
  DatabaseLock,
  ImmichWorker,
  JobName,
  MlDestinationKind,
  MlWorkload,
  QueueCleanType,
  QueueCommand,
  QueueJobStatus,
  QueueJobWorkerKind,
  QueueName,
} from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import {
  handlePromiseError,
  isImageDescriptionEnabled,
  isNsfwDetectionEnabled,
  isSmartSearchEnabled,
} from 'src/utils/misc.js';

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

/** FL-71 (J-1): the most jobs of one state read to count an account's share of a queue. */
export const QUEUE_OWNER_SCAN_LIMIT = 1000;

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
      return QueueJobWorkerKind.RunPod;
    }
  }
};

/** The ids a job's data names, in the order the owner lookup prefers them. */
const subjectIdsOf = (data: Record<string, unknown> | undefined): string[] =>
  ['id', 'assetId', 'personId', 'libraryId', 'ownerId', 'userId'].flatMap((key) => {
    const value = data?.[key];
    return typeof value === 'string' && UUID_PATTERN.test(value) ? [value.toLowerCase()] : [];
  });

const asNightlyTasksCron = (config: SystemConfig) => {
  const [hours, minutes] = config.nightlyTasks.startTime.split(':').map(Number);
  return `${minutes} ${hours} * * *`;
};

@Injectable()
export class QueueService extends BaseService {
  private services: (new (...args: any[]) => unknown)[] = [];
  private nightlyJobsLock = false;

  @OnEvent({ name: 'ConfigInit' })
  async onConfigInit({ newConfig: config }: ArgOf<'ConfigInit'>) {
    if (this.worker === ImmichWorker.Microservices) {
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
        onTick: () => handlePromiseError(this.handleNightlyJobs(), this.logger),
      });
    }
  }

  @OnEvent({ name: 'ConfigUpdate', server: true })
  onConfigUpdate({ newConfig: config }: ArgOf<'ConfigUpdate'>) {
    if (this.worker === ImmichWorker.Microservices) {
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
    if (this.worker === ImmichWorker.Microservices) {
      this.jobRepository.startWorkers();
    } else if (this.worker === ImmichWorker.Api) {
      this.jobRepository.watchWorkers();
    }
  }

  @OnEvent({ name: 'AppShutdown' })
  onShutdown() {
    this.jobRepository.teardown();
  }

  private updateConcurrency(config: SystemConfig) {
    this.logger.debug(`Updating queue concurrency settings`);
    for (const queueName of Object.values(QueueName)) {
      const concurrency = this.isConcurrentQueue(queueName) ? config.job[queueName].concurrency : 1;
      this.logger.debug(`Setting ${queueName} concurrency to ${concurrency}`);
      this.jobRepository.setConcurrency(queueName, concurrency);
    }
  }

  setServices(services: (new (...args: any[]) => unknown)[]) {
    this.services = services;
  }

  async runCommandLegacy(name: QueueName, dto: QueueCommandDto): Promise<QueueResponseLegacyDto> {
    this.logger.debug(`Handling command: queue=${name},command=${dto.command},force=${dto.force}`);

    switch (dto.command) {
      case QueueCommand.Start: {
        await this.start(name, dto);
        break;
      }

      case QueueCommand.Pause: {
        await this.jobRepository.pause(name);
        break;
      }

      case QueueCommand.Resume: {
        await this.jobRepository.resume(name);
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

    return mapQueueLegacy(response);
  }

  async getAll(_auth: AuthDto): Promise<QueueResponseDto[]> {
    return Promise.all(Object.values(QueueName).map((name) => this.getByName(name)));
  }

  async getAllLegacy(auth: AuthDto): Promise<QueuesResponseLegacyDto> {
    const responses = await this.getAll(auth);
    return mapQueuesLegacy(responses);
  }

  get(auth: AuthDto, name: QueueName): Promise<QueueResponseDto> {
    return this.getByName(name);
  }

  async update(auth: AuthDto, name: QueueName, dto: QueueUpdateDto): Promise<QueueResponseDto> {
    if (dto.isPaused === true) {
      if (name === QueueName.BackgroundTask) {
        throw new BadRequestException(`The BackgroundTask queue cannot be paused`);
      }
      await this.jobRepository.pause(name);
    } else if (dto.isPaused === false) {
      await this.jobRepository.resume(name);
    }

    return this.getByName(name);
  }

  /**
   * The jobs of one queue, with the Job manager's Account and Worker columns (FL-71,
   * `JobsManager.jsx` 758-796). The account is the owner of the asset, person, library or account
   * the job's data names. The worker is the server itself for queues that do not call machine
   * learning; for those that do, a job that has run names the destination its latest accounted
   * request went to, and any other job the destination its workload is routed to now.
   */
  async searchJobs(auth: AuthDto, name: QueueName, dto: QueueJobSearchDto): Promise<QueueJobResponseDto[]> {
    const jobs = await this.jobRepository.searchJobs(name, dto);
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
    return dto.ownerId ? result.filter((job) => job.account?.id === dto.ownerId) : result;
  }

  /**
   * FL-71 (J-1): how many of a queue's jobs, per state, work on one account's items. BullMQ keeps no
   * owner, so up to QUEUE_OWNER_SCAN_LIMIT jobs of each state are read and attributed through the
   * items they name (as the Account column is); `truncated` marks counts that are lower bounds.
   */
  async getOwnerStatistics(auth: AuthDto, name: QueueName, ownerId: string): Promise<QueueOwnerStatisticsResponseDto> {
    const totals = await this.jobRepository.getJobCounts(name);
    const states = [
      QueueJobStatus.Active,
      QueueJobStatus.Complete,
      QueueJobStatus.Failed,
      QueueJobStatus.Delayed,
      QueueJobStatus.Waiting,
      QueueJobStatus.Paused,
    ] as const;
    const lists = await Promise.all(
      states.map((status) => this.jobRepository.searchJobs(name, { status: [status] }, QUEUE_OWNER_SCAN_LIMIT)),
    );
    const subjects = lists.map((jobs) => jobs.map((job) => subjectIdsOf(job.data)));
    const owners = new Map(
      (await this.userRepository.getJobSubjectOwners([...new Set(subjects.flat().flat())])).map((row) => [
        row.subjectId,
        row.ownerId,
      ]),
    );
    const count = (index: number) =>
      subjects[index].filter((ids) => ids.map((id) => owners.get(id)).find(Boolean) === ownerId).length;
    return {
      active: count(0),
      completed: count(1),
      failed: count(2),
      delayed: count(3),
      waiting: count(4),
      paused: count(5),
      // A full page may hide jobs added since the counts were read, so it is a lower bound too.
      truncated: states.some(
        (status, index) => (totals[status] ?? 0) > lists[index].length || lists[index].length >= QUEUE_OWNER_SCAN_LIMIT,
      ),
    };
  }

  /**
   * FL-71 "Retry failed" (`jobs-data.mjs` 906-919): put every failed job of the queue back in it
   * with its saved data. Returns how many were failed when the command ran.
   */
  async retryFailedJobs(auth: AuthDto, name: QueueName): Promise<QueueRetryFailedResponseDto> {
    const { failed } = await this.jobRepository.getJobCounts(name);
    if (failed > 0) {
      await this.jobRepository.retryFailed(name);
    }
    return { count: failed };
  }

  async emptyQueue(auth: AuthDto, name: QueueName, dto: QueueDeleteDto) {
    await this.jobRepository.empty(name);
    if (dto.failed) {
      await this.jobRepository.clear(name, QueueCleanType.Failed);
    }
  }

  private async getByName(name: QueueName): Promise<QueueResponseDto> {
    const [statistics, isPaused] = await Promise.all([
      this.jobRepository.getJobCounts(name),
      this.jobRepository.isPaused(name),
    ]);
    return { name, isPaused, statistics };
  }

  private async start(name: QueueName, { force }: QueueCommandDto): Promise<void> {
    const isActive = await this.jobRepository.isActive(name);
    if (isActive) {
      throw new BadRequestException(`Job is already running`);
    }

    await this.eventRepository.emit('QueueStart', { name });

    switch (name) {
      case QueueName.VideoConversion: {
        return this.jobRepository.queue({ name: JobName.AssetEncodeVideoQueueAll, data: { force } });
      }

      case QueueName.StorageTemplateMigration: {
        return this.jobRepository.queue({ name: JobName.StorageTemplateMigration });
      }

      case QueueName.Migration: {
        return this.jobRepository.queue({ name: JobName.FileMigrationQueueAll });
      }

      case QueueName.SmartSearch: {
        return this.jobRepository.queue({ name: JobName.SmartSearchQueueAll, data: { force } });
      }

      case QueueName.DuplicateDetection: {
        return this.jobRepository.queue({ name: JobName.AssetDetectDuplicatesQueueAll, data: { force } });
      }

      case QueueName.VideoDuplicateDetection: {
        return this.jobRepository.queue({ name: JobName.AssetGenerateVideoDuplicateFramesQueueAll, data: { force } });
      }

      case QueueName.MetadataExtraction: {
        return this.jobRepository.queue({ name: JobName.AssetExtractMetadataQueueAll, data: { force } });
      }

      case QueueName.Sidecar: {
        return this.jobRepository.queue({ name: JobName.SidecarQueueAll, data: { force } });
      }

      case QueueName.ThumbnailGeneration: {
        return this.jobRepository.queue({ name: JobName.AssetGenerateThumbnailsQueueAll, data: { force } });
      }

      case QueueName.FaceDetection: {
        return this.jobRepository.queue({ name: JobName.AssetDetectFacesQueueAll, data: { force } });
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
        return this.jobRepository.queue({ name: JobName.OcrQueueAll, data: { force } });
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

  async handleNightlyJobs() {
    const config = await this.getConfig({ withCache: false });
    const jobs: JobItem[] = [];

    if (config.nightlyTasks.databaseCleanup) {
      jobs.push(
        { name: JobName.AssetDeleteCheck },
        { name: JobName.UserDeleteCheck },
        { name: JobName.PersonCleanup },
        { name: JobName.MemoryCleanup },
        { name: JobName.SessionCleanup },
        { name: JobName.HlsSessionCleanup },
        { name: JobName.AuditTableCleanup },
      );
      // FL-32: cleanups that are not queue jobs, so the public job names stay as they are
      await this.eventRepository.emit('NightlyDatabaseCleanup');
    }

    if (config.nightlyTasks.generateMemories) {
      jobs.push({ name: JobName.MemoryGenerate });
    }

    if (config.nightlyTasks.syncQuotaUsage) {
      jobs.push({ name: JobName.UserSyncUsage });
    }

    if (config.nightlyTasks.missingThumbnails) {
      jobs.push({ name: JobName.AssetGenerateThumbnailsQueueAll, data: { force: false } });
    }

    if (config.nightlyTasks.clusterNewFaces) {
      jobs.push({ name: JobName.FacialRecognitionQueueAll, data: { force: false, nightly: true } });
    }

    // FL-79: the local analytics collector runs every night. It only reads counts and sizes and
    // writes them to this server's database, never elsewhere. FL-71: an administrator can turn it
    // off ("Collect local metrics"); the collector also checks the setting when it runs.
    if (config.analytics.enabled) {
      jobs.push({ name: JobName.AnalyticsCollect });
    }

    await this.jobRepository.queueAll(jobs);
  }
}
