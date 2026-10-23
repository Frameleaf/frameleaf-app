import { BadRequestException, Injectable } from '@nestjs/common';
import { CronTime } from 'cron';
import { DateTime } from 'luxon';
import type { SystemConfig } from 'src/config.js';
import type { OvernightResponseDto } from 'src/dtos/overnight.dto.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import {
  DatabaseLock,
  FrameleafWorker,
  JobName,
  JobStatus,
  QueueCommand,
  QueueName,
  SystemMetadataKey,
} from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { ICloudSyncRepository } from 'src/repositories/icloud-sync.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { MediaHealthService } from 'src/services/media-health.service.js';
import { QueueService } from 'src/services/queue.service.js';
import { getConfig } from 'src/utils/config.js';
import {
  OVERNIGHT_STEPS,
  OVERNIGHT_STEP_LIMIT_MS,
  type OvernightRun,
  type OvernightState,
  type OvernightStep,
  type OvernightStepResult,
  isStepDue,
  keepNight,
  nextOvernightStep,
  overnightCron,
  overnightStopAt,
} from 'src/utils/overnight.js';
import { serverTimeZone } from 'src/utils/server-time-zone.js';

/** How often a run in progress looks whether the step it waits for has finished. */
const WATCH_INTERVAL_MS = 30_000;

/**
 * FL-363: the overnight schedule. Until now the night's work had separate timers that piled up (the
 * nightly tasks and the folder scan at midnight, the health scan at 2 AM, three file checks at 3 AM).
 * It now runs from one schedule (`nightlyTasks.startTime`, on `nightlyTasks.days`, in the server's
 * time zone), one step after another, in `OVERNIGHT_STEPS` order:
 *
 * 1. Empty Trash and tidy up (the old nightly tasks, `QueueService.handleNightlyJobs`).
 * 2. Check added folders (`library.scan.enabled`; the folder scan no longer has a timer of its own).
 * 3. Bring in new iCloud photos (every connected iCloud Photos connection is checked).
 * 4. Check files (the integrity checks and the Library care health scan, which lost their timers).
 *
 * - A step starts when the one before it has finished: its queue has nothing waiting or running. A
 *   step still busy after `OVERNIGHT_STEP_LIMIT_MS` is left to finish on its own and the run moves on.
 * - No step starts after the stop time; what is left carries on the next night.
 * - A step set to run once a week runs on `weeklyDay` only; one set to "only when I start it" runs
 *   only with "Run now", which runs every step that is on.
 * - The counts that keep Library analytics and phone backups up to date run every night.
 * - Backups keep their own schedule (FL-362). The two are independent (owner, 2026-10-10).
 *
 * One server holds the watch: the one that takes `DatabaseLock.OvernightSequence`.
 */
@Injectable()
export class OvernightService {
  private lock = false;
  private timer?: NodeJS.Timeout;
  private moving?: Promise<void>;

  constructor(
    private logger: LoggingRepository,
    private configRepository: ConfigRepository,
    private systemMetadataRepository: SystemMetadataRepository,
    private databaseRepository: DatabaseRepository,
    private jobRepository: JobRepository,
    private libraryRepository: LibraryRepository,
    private icloudRepository: ICloudSyncRepository,
    private queueService: QueueService,
    private mediaHealth: MediaHealthService,
  ) {
    this.logger.setContext(OvernightService.name);
  }

  private readConfig() {
    return getConfig(
      { configRepo: this.configRepository, metadataRepo: this.systemMetadataRepository, logger: this.logger },
      { withCache: false },
    );
  }

  @OnEvent({ name: 'ConfigInit', workers: [FrameleafWorker.Microservices] })
  async onConfigInit() {
    this.lock = await this.databaseRepository.tryLock(DatabaseLock.OvernightSequence);
    if (this.lock) {
      this.timer = setInterval(() => this.watch(), WATCH_INTERVAL_MS);
    }
  }

  @OnEvent({ name: 'AppShutdown' })
  async onShutdown() {
    if (this.timer) {
      clearInterval(this.timer);
    }
    await this.moving;
  }

  private async state(): Promise<OvernightState> {
    const stored = await this.systemMetadataRepository.get(SystemMetadataKey.OvernightSequence);
    return { run: stored?.run ?? null, nights: stored?.nights ?? [] };
  }

  private save(state: OvernightState) {
    return this.systemMetadataRepository.set(SystemMetadataKey.OvernightSequence, state);
  }

  /** The schedule's tick, or "Run now": start a run unless one is still going. */
  @OnJob({ name: JobName.OvernightSequence, queue: QueueName.BackgroundTask })
  async handleStart(data?: { manual?: boolean }): Promise<JobStatus> {
    const manual = data?.manual === true;
    return this.databaseRepository.withLock(DatabaseLock.OvernightSequenceRun, async () => {
      const state = await this.state();
      if (state.run) {
        this.logger.log('The overnight schedule came round while a run is still going; it is not started twice');
        return JobStatus.Skipped;
      }
      await this.save({
        ...state,
        run: { startedAt: new Date().toISOString(), manual, step: OVERNIGHT_STEPS[0], begunAt: null, results: {} },
      });
      await this.startRequestedRedo();
      await this.advance();
      return JobStatus.Success;
    });
  }

  /**
   * FL-521: "Save and … tonight" (read again for Visual search, group faces again, rebuild previews,
   * remake playback copies). Each starts over every photo once, on its own queue, alongside the night.
   */
  private async startRequestedRedo() {
    const queues = (await this.systemMetadataRepository.get(SystemMetadataKey.OvernightRedo))?.queues ?? [];
    if (queues.length === 0) {
      return;
    }
    await this.systemMetadataRepository.set(SystemMetadataKey.OvernightRedo, { queues: [] });
    for (const name of queues) {
      try {
        await this.queueService.runCommandLegacy(name as QueueName, { command: QueueCommand.Start, force: true });
      } catch (error) {
        // a queue that is already running carries on; what it has not reached is read the next time
        this.logger.warn(`Could not start ${name} again tonight: ${error}`);
      }
    }
  }

  /** Looks whether the step a run waits for has finished. One look at a time. */
  watch() {
    if (!this.lock || this.moving) {
      return;
    }
    this.moving = this.move()
      .catch((error: unknown) => this.logger.warn(`The overnight run could not move on: ${error}`))
      .finally(() => {
        this.moving = undefined;
      });
  }

  async move(): Promise<void> {
    return this.databaseRepository.withLock(DatabaseLock.OvernightSequenceRun, () => this.advance());
  }

  /** Whether a step is set up and switched on. A step that is not is left out of the night. */
  async isOn(step: OvernightStep, config: SystemConfig): Promise<boolean> {
    switch (step) {
      case 'cleanup': {
        return config.nightlyTasks.databaseCleanup;
      }
      case 'folders': {
        return config.library.scan.enabled && (await this.libraryRepository.getAll()).length > 0;
      }
      case 'icloud': {
        return this.icloudRepository.hasConnections();
      }
      case 'fileChecks': {
        const { untrackedFiles, missingFiles, checksumFiles } = config.integrityChecks;
        const audit = config.libraryCare.integrityAudit;
        return (
          (audit && (untrackedFiles.enabled || missingFiles.enabled)) ||
          checksumFiles.enabled ||
          config.libraryCare.healthScan
        );
      }
    }
  }

  /** Starts a step's work. */
  private async begin(step: OvernightStep, config: SystemConfig): Promise<void> {
    switch (step) {
      case 'cleanup': {
        await this.queueService.handleNightlyJobs({ cleanup: true });
        return;
      }
      case 'folders': {
        await this.jobRepository.queue({ name: JobName.LibraryScanQueueAll });
        return;
      }
      case 'icloud': {
        for (const { id, ownerId } of await this.icloudRepository.overnightConnections()) {
          await this.icloudRepository.queueOperation(id, ownerId, { trigger: 'schedule' });
        }
        return;
      }
      case 'fileChecks': {
        const { untrackedFiles, missingFiles, checksumFiles } = config.integrityChecks;
        const audit = config.libraryCare.integrityAudit;
        if (audit && untrackedFiles.enabled) {
          await this.jobRepository.queue({ name: JobName.IntegrityUntrackedFilesQueueAll, data: {} });
        }
        if (audit && missingFiles.enabled) {
          await this.jobRepository.queue({ name: JobName.IntegrityMissingFilesQueueAll, data: {} });
        }
        if (checksumFiles.enabled) {
          await this.jobRepository.queue({ name: JobName.IntegrityChecksumFiles, data: {} });
        }
        if (config.libraryCare.healthScan) {
          await this.mediaHealth.startScheduledScans();
        }
        return;
      }
    }
  }

  /** Whether a step's work is still being done. */
  private async isBusy(step: OvernightStep): Promise<boolean> {
    const queueBusy = async (name: QueueName) => {
      const counts = await this.jobRepository.getJobCounts(name);
      return counts.active + counts.waiting + counts.delayed > 0;
    };
    switch (step) {
      case 'cleanup': {
        // This job runs on the same queue and has finished its own part by now.
        const counts = await this.jobRepository.getJobCounts(QueueName.BackgroundTask);
        return counts.waiting + counts.delayed > 0 || counts.active > 1;
      }
      case 'folders': {
        return queueBusy(QueueName.Library);
      }
      case 'icloud': {
        return this.icloudRepository.hasActiveSync();
      }
      case 'fileChecks': {
        return queueBusy(QueueName.IntegrityCheck);
      }
    }
  }

  /**
   * Moves the run as far as it can go: past every step that is off, not due or finished, starting
   * each step that is due, and stopping to wait at the first one still being done.
   */
  private async advance(): Promise<void> {
    let state = await this.state();
    let run: OvernightRun | null = state.run;
    if (!run) {
      return;
    }
    const config = await this.readConfig();
    const zone = serverTimeZone(config.server);
    const stopAt = run.manual ? null : overnightStopAt(run.startedAt, config.nightlyTasks.stopTime, zone);

    while (run) {
      const step: OvernightStep = run.step;
      let result: OvernightStepResult;
      if (run.begunAt) {
        let busy = false;
        try {
          busy = await this.isBusy(step);
        } catch (error) {
          this.logger.warn(`Overnight run: could not tell whether ${step} finished: ${error}`);
        }
        if (busy && Date.now() - new Date(run.begunAt).getTime() < OVERNIGHT_STEP_LIMIT_MS) {
          return;
        }
        result = busy ? 'unfinished' : 'done';
      } else {
        try {
          const due = isStepDue(config.nightlyTasks.steps[step], {
            manual: run.manual,
            startedAt: run.startedAt,
            weeklyDay: config.nightlyTasks.weeklyDay,
            zone,
          });
          if (!due) {
            result = 'skipped';
          } else if (await this.isOn(step, config)) {
            if (stopAt && DateTime.now() >= stopAt) {
              result = 'stopped';
            } else {
              await this.begin(step, config);
              run = { ...run, begunAt: new Date().toISOString() };
              state = { ...state, run };
              await this.save(state);
              continue;
            }
          } else {
            result = 'off';
          }
        } catch (error) {
          // The next step still gets its turn.
          this.logger.warn(`Overnight run: ${step} did not start: ${error}`);
          result = 'failed';
        }
      }
      // The counts that run every night go with the first step, whether or not it runs.
      if (step === 'cleanup' && result !== 'done' && result !== 'unfinished') {
        await this.queueService.handleNightlyJobs({ cleanup: false }).catch((error: unknown) => {
          this.logger.warn(`Overnight run: the nightly counts did not start: ${error}`);
        });
      }
      const results: OvernightRun['results'] = { ...run.results, [step]: result };
      const next = nextOvernightStep(step);
      if (next) {
        run = { ...run, step: next, begunAt: null, results };
        state = { ...state, run };
      } else {
        state = {
          run: null,
          nights: keepNight(state.nights, {
            startedAt: run.startedAt,
            finishedAt: new Date().toISOString(),
            manual: run.manual,
            results,
          }),
        };
        run = null;
      }
      await this.save(state);
    }
  }

  /** "Stop": the run ends now; the steps it did not reach run on the next night. */
  async stop(): Promise<OvernightResponseDto> {
    await this.databaseRepository.withLock(DatabaseLock.OvernightSequenceRun, async () => {
      const state = await this.state();
      const run = state.run;
      if (!run) {
        return;
      }
      const results: OvernightRun['results'] = { ...run.results };
      for (const step of OVERNIGHT_STEPS.slice(OVERNIGHT_STEPS.indexOf(run.step))) {
        results[step] = step === run.step && run.begunAt ? 'unfinished' : 'stopped';
      }
      await this.save({
        run: null,
        nights: keepNight(state.nights, {
          startedAt: run.startedAt,
          finishedAt: new Date().toISOString(),
          manual: run.manual,
          results,
        }),
      });
    });
    return this.getStatus();
  }

  /** "Run now": every step that is on, one after another, starting now. */
  async runNow(): Promise<OvernightResponseDto> {
    const state = await this.state();
    if (state.run) {
      throw new BadRequestException('The overnight work is already running');
    }
    await this.jobRepository.queue({ name: JobName.OvernightSequence, data: { manual: true } });
    return this.getStatus();
  }

  /** What the Overnight schedule page shows: the next start, the run in progress and recent nights. */
  async getStatus(): Promise<OvernightResponseDto> {
    const config = await this.readConfig();
    const state = await this.state();
    const timezone = serverTimeZone(config.server);
    let nextRunAt: string | null = null;
    try {
      nextRunAt = new CronTime(overnightCron(config.nightlyTasks), timezone).sendAt().toUTC().toISO();
    } catch {
      // an expression that never fires has no next start
    }
    const steps = await Promise.all(
      OVERNIGHT_STEPS.map(async (id) => ({
        id,
        on: await this.isOn(id, config).catch(() => false),
        timing: config.nightlyTasks.steps[id],
      })),
    );
    return {
      timezone,
      nextRunAt,
      steps,
      run: state.run
        ? { startedAt: state.run.startedAt, manual: state.run.manual, step: state.run.step, results: state.run.results }
        : null,
      nights: state.nights,
    };
  }
}
