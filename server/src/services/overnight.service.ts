import { BadRequestException, Injectable } from '@nestjs/common';
import { CronTime } from 'cron';
import { DateTime } from 'luxon';
import type { SystemConfig } from 'src/config.js';
import type { OvernightResponseDto } from 'src/dtos/overnight.dto.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import {
  DatabaseLock,
  FrameleafEnvironment,
  FrameleafWorker,
  JobName,
  JobStatus,
  OvernightStepTiming,
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
import { TrashRepository } from 'src/repositories/trash.repository.js';
import { MediaHealthService } from 'src/services/media-health.service.js';
import { QueueService } from 'src/services/queue.service.js';
import { getConfig } from 'src/utils/config.js';
import { nightWork } from 'src/utils/night-work.js';
import {
  OVERNIGHT_STEPS,
  OVERNIGHT_STEPS_COMPETING_WITH_BACKUP,
  OVERNIGHT_STEP_LIMIT_MS,
  type OvernightNight,
  type OvernightRun,
  type OvernightState,
  type OvernightStep,
  type OvernightStepResult,
  QUIET_HOURS_FEEDERS,
  QUIET_HOURS_IDLE_MS,
  QUIET_HOURS_NEVER,
  QUIET_HOURS_QUEUES,
  isHeavyWorkWindow,
  isStepDue,
  keepNight,
  nextOvernightStart,
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
 * 4. Check files (the integrity checks and the Library care health scan, which lost their timers; once a week, on
 *    `weeklyDay`, also the Date & Time Doctor's scan, FL-912).
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
    private trashRepository: TrashRepository,
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
    // FL-1480: the lock is tried again on every look, so a lock missed at start does not leave runs unwatched
    this.lock = await this.databaseRepository.tryLock(DatabaseLock.OvernightSequence);
    this.timer = setInterval(() => this.watch(), WATCH_INTERVAL_MS);
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
    return { run: stored?.run ?? null, nights: stored?.nights ?? [], quiet: stored?.quiet };
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
      const startedAt = new Date().toISOString();
      await this.save({
        ...state,
        run: {
          startedAt,
          manual,
          step: OVERNIGHT_STEPS[0],
          begunAt: null,
          results: {},
          trashDue: await this.trashDue(),
        },
      });
      // FL-1430: what the night starts is marked with it, so Recent work shows the night as one card
      await nightWork.run({ startedAt, manual }, async () => {
        await this.startRequestedRedo();
        await this.startRequestedRecompare();
        await this.advance();
      });
      return JobStatus.Success;
    });
  }

  /**
   * FL-518: what the tidy-up is due to remove: items in Trash past their keep time (everything in it
   * while the Trash is off). Measured again when the run ends, so a night can say what it removed.
   */
  private async trashDue(): Promise<OvernightRun['trashDue']> {
    try {
      const { trash } = await this.readConfig();
      const cutoff = new Date(Date.now() - (trash.enabled ? trash.days : 0) * 86_400_000);
      return { cutoff: cutoff.toISOString(), count: await this.trashRepository.countTrashedBefore(cutoff) };
    } catch (error) {
      this.logger.warn(`Overnight run: could not count what Trash will remove: ${error}`);
      return undefined;
    }
  }

  /** FL-518: a finished run, with what it removed from Trash and what came in while it ran. */
  private async night(run: OvernightRun, results: OvernightRun['results']): Promise<OvernightNight> {
    let removedFromTrash: number | null = null;
    let newFiles: number | null = null;
    try {
      if (run.trashDue) {
        const left = await this.trashRepository.countTrashedBefore(new Date(run.trashDue.cutoff));
        removedFromTrash = Math.max(0, run.trashDue.count - left);
      }
      newFiles = await this.trashRepository.countAddedSince(new Date(run.startedAt));
    } catch (error) {
      this.logger.warn(`Overnight run: could not count what the night did: ${error}`);
    }
    return {
      startedAt: run.startedAt,
      finishedAt: new Date().toISOString(),
      manual: run.manual,
      results,
      removedFromTrash,
      newFiles,
    };
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

  /**
   * FL-520: "Save and start tonight" on Library care › Duplicates. Look-alike photos are compared again
   * once, on its own queue, alongside the night's steps.
   */
  private async startRequestedRecompare() {
    if (!(await this.systemMetadataRepository.get(SystemMetadataKey.DuplicateRecompare))) {
      return;
    }
    await this.systemMetadataRepository.delete(SystemMetadataKey.DuplicateRecompare);
    await this.jobRepository.queue({ name: JobName.AssetDetectDuplicatesQueueAll, data: { force: true } });
  }

  /** Looks whether the step a run waits for has finished. One look at a time. */
  watch() {
    if (this.moving) {
      return;
    }
    this.moving = (async () => {
      this.lock ||= await this.databaseRepository.tryLock(DatabaseLock.OvernightSequence);
      if (this.lock) {
        await this.move();
      }
    })()
      .catch((error: unknown) => this.logger.warn(`The overnight run could not move on: ${error}`))
      .finally(() => {
        this.moving = undefined;
      });
  }

  async move(): Promise<void> {
    return this.databaseRepository.withLock(DatabaseLock.OvernightSequenceRun, async () => {
      await this.advance();
      await this.keepQuietHours();
    });
  }

  /**
   * FL-577: quiet hours. Outside the overnight window the heavy queues are closed until the next
   * overnight start (FL-1265: a schedule on the queue, never a pause, so it opens by itself even if
   * this server is down then), and the ones closed are remembered; when the window opens they are
   * opened again. A queue the administrator resumes during the day leaves `holding` and stays open
   * until the next window. A pause the administrator made is theirs and is never touched here.
   */
  private async keepQuietHours(): Promise<void> {
    const config = await this.readConfig();
    const state = await this.state();
    let quiet = state.quiet ?? { holding: null };
    const { nightlyTasks } = config;
    // E2E servers start at any hour and wait on every queue, so quiet hours never hold work there.
    const quietHours =
      nightlyTasks.quietHours && this.configRepository.getEnv().environment !== FrameleafEnvironment.Testing;
    const zone = serverTimeZone(config.server);
    if (quiet.holding === null && quietHours && !nightlyTasks.stopTime) {
      // With no stop time the window lasts until the heavy work has caught up. FL-1480: that is no single empty
      // moment. The night's steps and the queues that feed the heavy ones must be done too, and it must stay
      // that way for a while: a job waiting to be tried again is delayed, not waiting.
      const counts = state.run
        ? []
        : await Promise.all(
            [...QUIET_HOURS_QUEUES, ...QUIET_HOURS_FEEDERS].map((name) => this.jobRepository.getJobCounts(name)),
          );
      const idle = !state.run && counts.every(({ active, waiting }) => active + waiting === 0);
      const { idleSince, ...rest } = quiet;
      if (!idle) {
        quiet = rest;
      } else if (!idleSince) {
        quiet = { ...rest, idleSince: new Date().toISOString() };
      } else if (Date.now() - new Date(idleSince).getTime() >= QUIET_HOURS_IDLE_MS) {
        quiet = { ...rest, caughtUpAt: new Date().toISOString() };
      }
    }
    const open = !quietHours || isHeavyWorkWindow(DateTime.now(), nightlyTasks, zone, quiet.caughtUpAt);
    if (open && quiet.holding !== null) {
      for (const name of quiet.holding) {
        await this.jobRepository.setQueueSchedule(name, null);
      }
      const { until: _, ...rest } = quiet;
      quiet = { ...rest, holding: null };
    } else if (!open) {
      // A schedule that never fires keeps them closed until it changes.
      const until = nextOvernightStart(nightlyTasks, zone) ?? QUIET_HOURS_NEVER;
      // A changed schedule moves the opening of queues already closed.
      if (quiet.holding === null || quiet.until !== until.toISOString()) {
        const holding = quiet.holding ?? [...QUIET_HOURS_QUEUES];
        for (const name of holding) {
          await this.jobRepository.setQueueSchedule(name, until);
        }
        quiet = { ...quiet, holding, until: until.toISOString() };
      }
    }
    if (JSON.stringify(quiet) !== JSON.stringify(state.quiet ?? { holding: null })) {
      await this.save({ ...state, quiet });
    }
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

  /** FL-540: whether the backup schedule's run is going (the library data copy, Buddy or Cloud Backup). */
  private async backupRunning(): Promise<boolean> {
    try {
      return !!(await this.systemMetadataRepository.get(SystemMetadataKey.BackupSequence))?.run;
    } catch {
      return false;
    }
  }

  /** Starts a step's work. `weekly`: this is the week's day for weekly work (or Run now). */
  private async begin(step: OvernightStep, config: SystemConfig, weekly: boolean): Promise<void> {
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
        // FL-912: the Date & Time Doctor looks through every library once a week. It runs on the file checks' queue,
        // so this step waits for it. It opens no run of its own, so Recent work gives it no card: it is part of the
        // night's one card, under Check files.
        if (weekly) {
          await this.jobRepository.queue({ name: JobName.DateDoctorScanQueueAll, data: {} });
        }
        return;
      }
    }
  }

  /** Whether a step's work is still being done. */
  private async isBusy(step: OvernightStep, startedAt: string): Promise<boolean> {
    const queueBusy = async (name: QueueName) => {
      const counts = await this.jobRepository.getJobCounts(name);
      return counts.active + counts.waiting + counts.delayed > 0;
    };
    switch (step) {
      case 'cleanup': {
        // FL-1480: only what this night queued. The queue is shared with work that is not the night's and can
        // wait for hours (a Locked photo waiting for its key, an iCloud sync, a backup).
        return this.jobRepository.nightHasLiveWork(QueueName.BackgroundTask, startedAt);
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
          busy = await this.isBusy(step, run.startedAt);
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
            } else if (
              OVERNIGHT_STEPS_COMPETING_WITH_BACKUP.has(step) &&
              // FL-1480: a backup that never ends holds the night no longer than a step may take
              !(
                run.waitingForBackupSince &&
                Date.now() - new Date(run.waitingForBackupSince).getTime() >= OVERNIGHT_STEP_LIMIT_MS
              ) &&
              (await this.backupRunning())
            ) {
              // FL-540: the two schedules overlap; a step that uses the disk or the internet waits its turn
              if (!run.waitingForBackupSince) {
                run = { ...run, waitingForBackupSince: new Date().toISOString() };
                state = { ...state, run };
                await this.save(state);
              }
              return;
            } else {
              const weekly = isStepDue(OvernightStepTiming.Weekly, {
                manual: run.manual,
                startedAt: run.startedAt,
                weeklyDay: config.nightlyTasks.weeklyDay,
                zone,
              });
              await nightWork.run({ startedAt: run.startedAt, manual: run.manual }, () =>
                this.begin(step, config, weekly),
              );
              run = { ...run, begunAt: new Date().toISOString(), waitingForBackupSince: null };
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
      if (step === 'cleanup' && (result === 'done' || result === 'unfinished')) {
        this.optimizeDatabase();
      }
      // The counts that run every night go with the first step, whether or not it runs.
      if (step === 'cleanup' && result !== 'done' && result !== 'unfinished') {
        const night = { startedAt: run.startedAt, manual: run.manual };
        await nightWork
          .run(night, () => this.queueService.handleNightlyJobs({ cleanup: false }))
          .catch((error: unknown) => {
            this.logger.warn(`Overnight run: the nightly counts did not start: ${error}`);
          });
      }
      const results: OvernightRun['results'] = { ...run.results, [step]: result };
      const next = nextOvernightStep(step);
      if (next) {
        run = { ...run, step: next, begunAt: null, results, waitingForBackupSince: null };
        state = { ...state, run };
      } else {
        state = {
          ...state,
          run: null,
          nights: keepNight(state.nights, await this.night(run, results)),
        };
        run = null;
      }
      await this.save(state);
    }
  }

  /**
   * FL-1235: once the tidy-up's jobs have deleted their rows, reclaim the dead space and refresh the
   * planner statistics. Not awaited: a whole-database VACUUM can outlast any job's deadline, and the
   * run moves on meanwhile. Plain VACUUM does not lock tables, so the app keeps running.
   */
  // ponytail: whole database; per-table list if a large library makes this run too long
  private optimizeDatabase() {
    void this.databaseRepository.vacuum({ analyze: true });
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
        ...state,
        run: null,
        nights: keepNight(state.nights, await this.night(run, results)),
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
        ? {
            startedAt: state.run.startedAt,
            manual: state.run.manual,
            step: state.run.step,
            results: state.run.results,
            waitingForBackupSince: state.run.waitingForBackupSince ?? null,
          }
        : null,
      nights: state.nights,
    };
  }
}
