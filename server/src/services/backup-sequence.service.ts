import { Injectable } from '@nestjs/common';
import { CronTime } from 'cron';
import type { SystemConfig } from 'src/config.js';
import type { BackupScheduleResponseDto } from 'src/dtos/database-backup.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import {
  DatabaseLock,
  FrameleafWorker,
  JobName,
  JobStatus,
  QueueJobStatus,
  QueueName,
  SystemMetadataKey,
} from 'src/enum.js';
import { BuddyBackupRepository } from 'src/repositories/buddy-backup.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CronRepository } from 'src/repositories/cron.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { BuddyBackupService } from 'src/services/buddy-backup.service.js';
import { CloudBackupService } from 'src/services/cloud-backup.service.js';
import {
  BACKUP_SEQUENCE,
  type BackupSequencePlace,
  type BackupSequenceRun,
  type BackupSequenceState,
  effectiveBackupSchedule,
  nextBackupPlace,
} from 'src/utils/backup-sequence.js';
import { getConfig } from 'src/utils/config.js';
import { handlePromiseError } from 'src/utils/misc.js';
import { serverTimeZone } from 'src/utils/server-time-zone.js';

export const BACKUP_SEQUENCE_CRON = 'backupSequence';
/** How often a run in progress looks whether the place it waits for has finished. */
const WATCH_INTERVAL_MS = 30_000;

/**
 * FL-362: the one backup schedule. Until now the library data copy, Buddy Backup and Cloud Backup each
 * had a timer of their own and none waited for another (two of them started at 2 AM by default). They
 * now run from one schedule, in `BACKUP_SEQUENCE` order, each starting when the one before it has
 * finished.
 *
 * - **Schedule.** `backup.schedule.cronExpression`, in the server's time zone. A server that has not
 *   chosen one keeps running at the time it stored before (`effectiveBackupSchedule`).
 * - **A run.** The schedule's tick queues `JobName.BackupSequence`, which starts a run: for each place,
 *   leave it out if it is off, otherwise start its backup and wait for it. The library data copy is
 *   the queued snapshot job, the one "Take a snapshot now" uses (FL-657), so every snapshot is made one
 *   at a time and reports its outcome the same way; Buddy Backup and Cloud Backup are operations of
 *   their own. The run is kept in system metadata and a watch moves it on when the snapshot or
 *   operation it waits for has ended.
 * - **A failure never stops the run.** A place that fails, cannot start or is left waiting (a buddy
 *   that cannot be reached, a full plan, a paused upload) is recorded and the next place starts.
 * - **One run at a time.** A tick during a run is remembered and starts another when the run ends.
 * - **No stop time.** Buddy Backup has a transfer window of its own; the library data copy and Cloud
 *   Backup cannot be stopped at an hour and carried on later, so the schedule has a start and no stop.
 *
 * One server holds the schedule and the watch: the one that takes `DatabaseLock.BackupSequence`.
 */
@Injectable()
export class BackupSequenceService {
  private lock = false;
  private timer?: NodeJS.Timeout;
  private moving?: Promise<void>;

  constructor(
    private logger: LoggingRepository,
    private configRepository: ConfigRepository,
    private systemMetadataRepository: SystemMetadataRepository,
    private databaseRepository: DatabaseRepository,
    private cronRepository: CronRepository,
    private jobRepository: JobRepository,
    private buddyRepository: BuddyBackupRepository,
    private buddyBackup: BuddyBackupService,
    private cloudBackup: CloudBackupService,
  ) {
    this.logger.setContext(BackupSequenceService.name);
  }

  private readConfig() {
    return getConfig(
      { configRepo: this.configRepository, metadataRepo: this.systemMetadataRepository, logger: this.logger },
      { withCache: false },
    );
  }

  /** The schedule in force for a configuration: the one chosen, else the one stored before. */
  async scheduleFor(config: SystemConfig): Promise<string> {
    const cloud = config.frameleafCloud.cloudBackup;
    const buddy = await this.buddyRepository.state().catch(() => null);
    return effectiveBackupSchedule(config.backup.schedule.cronExpression, {
      database: config.backup.database,
      buddy: buddy?.settings?.schedule,
      cloud: cloud.enabled && cloud.target !== 'off' ? cloud.schedule.cronExpression : null,
    });
  }

  @OnEvent({ name: 'ConfigInit', workers: [FrameleafWorker.Microservices] })
  async onConfigInit({ newConfig }: ArgOf<'ConfigInit'>) {
    this.lock = await this.databaseRepository.tryLock(DatabaseLock.BackupSequence);
    if (!this.lock) {
      return;
    }
    this.cronRepository.create({
      name: BACKUP_SEQUENCE_CRON,
      expression: await this.scheduleFor(newConfig),
      onTick: () => handlePromiseError(this.jobRepository.queue({ name: JobName.BackupSequence }), this.logger),
      // Always running: which places a run visits is decided when it starts.
      start: true,
    });
    this.timer = setInterval(() => this.watch(), WATCH_INTERVAL_MS);
  }

  @OnEvent({ name: 'ConfigUpdate', server: true })
  async onConfigUpdate({ newConfig }: ArgOf<'ConfigUpdate'>) {
    if (!this.lock) {
      return;
    }
    this.cronRepository.update({ name: BACKUP_SEQUENCE_CRON, expression: await this.scheduleFor(newConfig) });
  }

  @OnEvent({ name: 'AppShutdown' })
  async onShutdown() {
    if (this.timer) {
      clearInterval(this.timer);
    }
    await this.moving;
  }

  private async state(): Promise<BackupSequenceState> {
    return (await this.systemMetadataRepository.get(SystemMetadataKey.BackupSequence)) ?? { run: null };
  }

  private save(state: BackupSequenceState) {
    return this.systemMetadataRepository.set(SystemMetadataKey.BackupSequence, state);
  }

  /** The schedule's tick: start a run, or remember that one is due when a run is still going. */
  @OnJob({ name: JobName.BackupSequence, queue: QueueName.BackgroundTask })
  async handleStart(): Promise<JobStatus> {
    return this.databaseRepository.withLock(DatabaseLock.BackupSequenceRun, async () => {
      const state = await this.state();
      if (state.run) {
        await this.save({ ...state, dueAt: new Date().toISOString() });
        this.logger.log('The backup schedule came round while a run is still going; another starts when it ends');
        return JobStatus.Skipped;
      }
      await this.save({
        ...state,
        dueAt: null,
        run: { startedAt: new Date().toISOString(), place: BACKUP_SEQUENCE[0], begun: false, results: {} },
      });
      await this.advance();
      return JobStatus.Success;
    });
  }

  /** Looks whether the place a run waits for has finished. One look at a time. */
  watch() {
    if (!this.lock || this.moving) {
      return;
    }
    this.moving = this.move()
      .catch((error: unknown) => this.logger.warn(`The backup run could not move on: ${error}`))
      .finally(() => {
        this.moving = undefined;
      });
  }

  /** Whether a place is switched on: a run leaves out a place that is not. */
  private async isOn(place: BackupSequencePlace): Promise<boolean> {
    switch (place) {
      case 'local': {
        return (await this.readConfig()).backup.database.enabled;
      }
      case 'buddy': {
        return (await this.buddyBackup.sequenceStatus()).on;
      }
      case 'cloud': {
        return (await this.cloudBackup.sequenceStatus()).on;
      }
    }
  }

  /** Starts a place's backup. Each runs on its own, and the run waits for it (`placeOutcome`, `snapshotOutcome`). */
  private async begin(place: BackupSequencePlace): Promise<'started' | 'done'> {
    switch (place) {
      case 'local': {
        // FL-657: the snapshot job is single-flight (a snapshot already queued or being made is the one
        // waited for), it retries, and its success or final failure is what the Backup page and the
        // notification report, for a scheduled snapshot as for one taken by hand.
        await this.jobRepository.queue({ name: JobName.DatabaseBackup, data: {} });
        return 'started';
      }
      case 'buddy': {
        await this.buddyBackup.startScheduled();
        return 'started';
      }
      case 'cloud': {
        await this.cloudBackup.handleSchedule();
        return 'started';
      }
    }
  }

  /** Whether Buddy or Cloud Backup is still being made. A backup left waiting or paused is not. */
  private async placeOutcome(place: 'buddy' | 'cloud'): Promise<'busy' | 'done'> {
    const status =
      place === 'buddy' ? await this.buddyBackup.sequenceStatus() : await this.cloudBackup.sequenceStatus();
    return status.busy ? 'busy' : 'done';
  }

  /** The snapshot job waiting or running now: the one the run just queued, or the one it joined. */
  private async snapshotJobId(): Promise<string | undefined> {
    const jobs = await this.jobRepository.searchJobs(QueueName.BackupDatabase, {
      status: [QueueJobStatus.Active, QueueJobStatus.Waiting, QueueJobStatus.Delayed, QueueJobStatus.Paused],
    });
    return jobs.find((job) => job.name === JobName.DatabaseBackup)?.id;
  }

  /**
   * FL-657: the library data copy's own outcome, read from the snapshot job the run waits for. A job
   * being made, or waiting for its retry, holds the run; one held in a paused queue does not, and is
   * recorded as not finished. A job the queue no longer lists finished and was cleared away.
   */
  private async snapshotOutcome(jobId: string | undefined): Promise<'busy' | 'done' | 'failed'> {
    if (!jobId) {
      return 'done';
    }
    const job = (await this.jobRepository.searchJobs(QueueName.BackupDatabase, {})).find(({ id }) => id === jobId);
    switch (job?.status) {
      case QueueJobStatus.Active:
      case QueueJobStatus.Waiting:
      case QueueJobStatus.Delayed: {
        return 'busy';
      }
      case QueueJobStatus.Failed:
      case QueueJobStatus.Paused: {
        return 'failed';
      }
      default: {
        return 'done';
      }
    }
  }

  /**
   * Moves the run as far as it can go: past every place that is off or has finished, starting each
   * place that is on, and stopping to wait at the first one whose backup is still being made.
   */
  async move(): Promise<void> {
    return this.databaseRepository.withLock(DatabaseLock.BackupSequenceRun, () => this.advance());
  }

  private async advance(): Promise<void> {
    let state = await this.state();
    let run = state.run;
    while (run) {
      const place: BackupSequencePlace = run.place;
      let result: BackupSequenceRun['results'][BackupSequencePlace];
      if (run.begun) {
        const outcome = place === 'local' ? await this.snapshotOutcome(run.jobId) : await this.placeOutcome(place);
        if (outcome === 'busy') {
          return;
        }
        result = outcome;
      } else {
        try {
          if (await this.isOn(place)) {
            if ((await this.begin(place)) === 'started') {
              const jobId = place === 'local' ? await this.snapshotJobId() : undefined;
              run = { ...run, begun: true, ...(jobId ? { jobId } : {}) };
              state = { ...state, run };
              await this.save(state);
              continue;
            }
            result = 'done';
          } else {
            result = 'off';
          }
        } catch (error) {
          // The next place still gets its turn.
          this.logger.warn(`Backup run: ${place} did not start or finish: ${error}`);
          result = 'failed';
        }
      }
      const next = nextBackupPlace(place);
      const results = { ...run.results, [place]: result };
      run = next ? { ...run, place: next, begun: false, results } : null;
      state = { ...state, run, finishedAt: run ? state.finishedAt : new Date().toISOString() };
      await this.save(state);
    }
    if (state.dueAt) {
      await this.save({ ...state, dueAt: null });
      await this.jobRepository.queue({ name: JobName.BackupSequence });
    }
  }

  /** What the Backup settings show: the schedule in force, its next start, and the run in progress. */
  async getSchedule(): Promise<BackupScheduleResponseDto> {
    const config = await this.readConfig();
    const cronExpression = await this.scheduleFor(config);
    const state = await this.state();
    const [buddy, cloud] = await Promise.all([
      this.buddyBackup.sequenceStatus().catch(() => ({ on: false, busy: false })),
      this.cloudBackup.sequenceStatus().catch(() => ({ on: false, busy: false })),
    ]);
    const on = { local: config.backup.database.enabled, buddy: buddy.on, cloud: cloud.on };
    // FL-426: the times are the server's, in the zone chosen in Server name & welcome
    const timezone = serverTimeZone(config.server);
    let nextRunAt: string | null = null;
    try {
      nextRunAt = new CronTime(cronExpression, timezone).sendAt().toUTC().toISO();
    } catch {
      // an expression that never fires has no next start
    }
    return {
      cronExpression,
      chosen: config.backup.schedule.cronExpression.trim() !== '',
      timezone,
      nextRunAt,
      places: BACKUP_SEQUENCE.map((id) => ({ id, on: on[id] })),
      run: state.run ? { startedAt: state.run.startedAt, place: state.run.place } : null,
      lastFinishedAt: state.finishedAt ?? null,
    };
  }
}
