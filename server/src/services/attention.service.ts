import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import type { SystemConfig } from 'src/config.js';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { serverVersion } from 'src/constants.js';
import { StorageCore } from 'src/cores/storage.core.js';
import {
  ATTENTION_KINDS,
  type AttentionDismissDto,
  type AttentionKind,
  type AttentionResponseDto,
} from 'src/dtos/attention.dto.js';
import { QueueName, StorageFolder, SystemMetadataKey } from 'src/enum.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { BuddyBackupRepository } from 'src/repositories/buddy-backup.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaHealthRepository } from 'src/repositories/media-health.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { upgradeCheckSummary } from 'src/services/upgrade-check.service.js';
import { isNewerRelease } from 'src/services/version.service.js';
import {
  type BackupPlaceFacts,
  type QueueFacts,
  type SignalResult,
  backupSignal,
  combineStorage,
  sortAttention,
  storageSignal,
  versionSignal,
  workSignal,
} from 'src/utils/attention.js';
import { effectiveBackupSchedule } from 'src/utils/backup-sequence.js';
import { getConfig } from 'src/utils/config.js';
import { isValidDatabaseRoutineBackupName } from 'src/utils/database-backups.js';
import { getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { UPGRADE_FINGERPRINT_KEY, type UpgradeFingerprintState } from 'src/utils/library-fingerprint.js';
import { getLockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import { quietHoursHolds } from 'src/utils/overnight.js';
import { serverTimeZone } from 'src/utils/server-time-zone.js';

/** Queues are read a few at a time, as the queue list does, so a read never fills the database pool. */
const QUEUE_BATCH = 4;
/** The Overview counts what was fixed in the last week. */
const FIXED_WINDOW_DAYS = 7;
const BACKUP_STAMP = /\d{8}T\d{6}/;

/**
 * FL-421: "What needs your attention" for administrators. Each read checks the drive the library is
 * on, the backups, the background work and the version check, from what the server already
 * records, and returns what needs someone. A check that cannot be read says so without hiding the
 * others. Shared by the Notifications page and the Overview's "needs you now" list (FL-363).
 */
@Injectable()
export class AttentionService {
  constructor(
    private logger: LoggingRepository,
    private configRepository: ConfigRepository,
    private systemMetadataRepository: SystemMetadataRepository,
    private storageRepository: StorageRepository,
    private jobRepository: JobRepository,
    private buddyRepository: BuddyBackupRepository,
    private mediaHealthRepository: MediaHealthRepository,
    private assetJobRepository: AssetJobRepository,
  ) {
    this.logger.setContext(AttentionService.name);
  }

  private readConfig() {
    return getConfig(
      { configRepo: this.configRepository, metadataRepo: this.systemMetadataRepository, logger: this.logger },
      { withCache: true },
    );
  }

  async getAttention(auth: AuthDto): Promise<AttentionResponseDto> {
    const now = new Date();
    const config = await this.readConfig();
    // The three counts never throw (each has its own fallback), so they are read alongside the checks.
    const [backup, storage, work, version, dismissed, fileProblems, processingFailures, upgradeCheck] =
      await Promise.all([
        this.check('backup', () => this.backup(config, now)),
        this.check('storage', () => this.storage(config)),
        this.check('work', () => this.work(config)),
        this.check('version', () => this.version(config)),
        this.dismissed(),
        this.fileProblems(auth),
        this.processingFailures(auth),
        this.upgradeCheck(),
      ]);
    const results: Record<AttentionKind, SignalResult> = { backup, storage, work, version };
    return {
      checkedAt: now.toISOString(),
      items: sortAttention(ATTENTION_KINDS.flatMap((kind) => results[kind].items)),
      checks: ATTENTION_KINDS.map((kind) => ({ kind, state: results[kind].state })),
      dismissed,
      fileProblems,
      processingFailures,
      upgradeCheck,
    };
  }

  /**
   * FL-954: the library check after the last upgrade, in short. A field of its own, so the kinds and
   * reasons native apps decode stay as they are. It adds no item and changes no check.
   */
  private async upgradeCheck(): Promise<AttentionResponseDto['upgradeCheck']> {
    try {
      const state = await this.systemMetadataRepository.get(UPGRADE_FINGERPRINT_KEY);
      return upgradeCheckSummary(state as UpgradeFingerprintState | null);
    } catch (error) {
      this.logger.warn(`Could not read the library check after the last upgrade for what needs attention: ${error}`);
      return upgradeCheckSummary(null);
    }
  }

  /**
   * FL-1337: the Overview's damaged and missing file counts. This response is only built for administrators, so
   * the scope is every account's problems, minus other accounts' Locked photos, with the administrator's own
   * privacy settings. The tab rules are the file problems list's own. It adds no item and changes no check.
   */
  private async fileProblems(auth: AuthDto): Promise<AttentionResponseDto['fileProblems']> {
    try {
      const { fixed, needsYou, since, latest } = await this.mediaHealthRepository.fileProblemCounts({
        privacy: { ...getHiddenContentQueryOptions(auth), ...getLockedVisibilityOptions(auth) },
        days: FIXED_WINDOW_DAYS,
      });
      return {
        fixed,
        needsYou,
        since: since ? since.toISOString() : null,
        // Task 11b: the newest fix of the same window, so the Overview can tell a new one from what it showed
        latest: fixed > 0 && latest ? latest.toISOString() : null,
      };
    } catch (error) {
      // like a check that could not be read: the rest of the Overview still answers
      this.logger.warn(`Could not count damaged and missing files for what needs attention: ${error}`);
      return { fixed: 0, needsYou: 0, since: null, latest: null };
    }
  }

  /**
   * FL-862: photos and videos Frameleaf could not process (FL-845), for the Overview and Library care. Only what
   * the reader may see is counted: the same rules as the Couldn't process list. It adds no item and changes no check.
   */
  private async processingFailures(auth: AuthDto): Promise<AttentionResponseDto['processingFailures']> {
    try {
      return await this.assetJobRepository.countProcessingFailures(auth);
    } catch (error) {
      this.logger.warn(`Could not count the files Frameleaf could not process for what needs attention: ${error}`);
      return { count: 0, setAside: 0 };
    }
  }

  private async dismissed(): Promise<string[]> {
    const stored = await this.systemMetadataRepository.get(SystemMetadataKey.OverviewDismissed).catch(() => null);
    return stored?.ids ?? [];
  }

  /** FL-363: dismiss an Overview item so it stops counting, or bring it back. Kept for every administrator. */
  async setDismissed(auth: AuthDto, { id, dismissed }: AttentionDismissDto): Promise<AttentionResponseDto> {
    const ids = new Set(await this.dismissed());
    if (dismissed) {
      ids.add(id);
    } else {
      ids.delete(id);
    }
    await this.systemMetadataRepository.set(SystemMetadataKey.OverviewDismissed, { ids: [...ids].slice(-32) });
    return this.getAttention(auth);
  }

  private async check(kind: AttentionKind, read: () => Promise<SignalResult>): Promise<SignalResult> {
    try {
      return await read();
    } catch (error) {
      this.logger.warn(`Could not check ${kind} for what needs attention: ${error}`);
      return { state: 'unknown', items: [] };
    }
  }

  /**
   * The drive the library is on, and (FL-1324) the thumbnails' drive when it is another filesystem: a
   * thumbnails folder mounted from another drive fills up on its own. On one drive there is one item.
   */
  private async storage(config: SystemConfig): Promise<SignalResult> {
    const percent = config.storageWarning.percent;
    const library = StorageCore.getBaseFolder(StorageFolder.Library);
    const thumbnails = StorageCore.getBaseFolder(StorageFolder.Thumbnails);
    const read = (folder: string, name: string) =>
      this.storageRepository.checkDiskUsage(folder).catch((error) => {
        this.logger.warn(`Could not check the ${name} drive for what needs attention: ${error}`);
        return null;
      });
    const [libraryDisk, libraryDevice, thumbnailsDevice] = await Promise.all([
      read(library, 'library'),
      this.storageRepository.getDevice(library),
      this.storageRepository.getDevice(thumbnails),
    ]);
    const unknown: SignalResult = { state: 'unknown', items: [] };
    const libraryResult = libraryDisk ? storageSignal(libraryDisk, percent, 'library') : unknown;
    // Where the thumbnails are can't be told: their room is unknown, and any library warning still shows.
    if (thumbnailsDevice === null) {
      return combineStorage([libraryResult, unknown]);
    }
    const sameDrive = libraryDevice === thumbnailsDevice;
    // One drive, already read: one item.
    if (libraryDisk && sameDrive) {
      return libraryResult;
    }
    // A drive of their own, a library that couldn't be read, or a library whose device couldn't be
    // told: read the thumbnails' drive too.
    const thumbnailsDisk = await read(thumbnails, 'thumbnails');
    if (!thumbnailsDisk) {
      return combineStorage([libraryResult, unknown]);
    }
    // The library's own drive, whose library folder couldn't be read: the thumbnails folder speaks for it.
    if (sameDrive) {
      return storageSignal(thumbnailsDisk, percent, 'library');
    }
    // Only device ids prove one drive. Without the library's, the thumbnails' drive is named on its own:
    // a second warning beats a missed one.
    return combineStorage([libraryResult, storageSignal(thumbnailsDisk, percent, 'thumbnails')]);
  }

  /**
   * Each place a backup is kept, read the way the Backup page reads it: Cloud Backup from its stored
   * claim and last run, Buddy Backup from its state file, the library data copy from its files. A
   * run of the backup schedule that has reached a place counts as that place's backup being made.
   */
  private async backup(config: SystemConfig, now: Date): Promise<SignalResult> {
    const [cloud, buddy, sequence, localLastAt] = await Promise.all([
      this.systemMetadataRepository.get(SystemMetadataKey.FrameleafCloudBackup),
      this.buddyRepository.state(),
      this.systemMetadataRepository.get(SystemMetadataKey.BackupSequence),
      this.newestLibraryDataCopy(),
    ]);
    const scheduled = (place: 'local' | 'buddy' | 'cloud') =>
      sequence?.run?.place === place ? sequence.run.startedAt : null;

    const cloudSettings = config.frameleafCloud.cloudBackup;
    const cloudOn = !!cloud && cloudSettings.enabled && cloudSettings.target !== 'off';
    const lastRun = cloud?.lastRun;
    const cloudFacts: BackupPlaceFacts = {
      on: cloudOn,
      lastSuccessAt: cloud?.lastSuccessAt ?? null,
      setUpAt: cloud?.claimedAt ?? null,
      runningSince: lastRun?.status === 'running' ? lastRun.startedAt : scheduled('cloud'),
      // A run left waiting for the key the owner keeps has not finished either.
      failedAt:
        lastRun?.status === 'failed' || lastRun?.status === 'waiting-for-key'
          ? (lastRun.finishedAt ?? lastRun.startedAt)
          : null,
    };

    const pairing = buddy.pairing?.state;
    const buddyRun = buddy.run;
    const buddyFacts: BackupPlaceFacts = {
      // A pairing still waiting for the buddy, or one that was ended, is not a place backups go to.
      on:
        process.env.FRAMELEAF_BUDDY_BACKUP === 'true' &&
        !!buddy.settings &&
        (pairing === 'active' || pairing === 'blocked'),
      lastSuccessAt: buddy.lastCompleteAt,
      setUpAt: buddy.protectionStartedAt ?? buddyRun?.startedAt ?? null,
      runningSince:
        buddyRun?.state === 'capturing' || buddyRun?.state === 'sending' ? buddyRun.startedAt : scheduled('buddy'),
      failedAt: buddyRun?.state === 'incomplete' ? (buddyRun.finishedAt ?? buddyRun.startedAt) : null,
    };

    const localFacts: BackupPlaceFacts = {
      on: config.backup.database.enabled,
      lastSuccessAt: localLastAt,
      setUpAt: null,
      runningSince: scheduled('local'),
      failedAt: null,
    };

    const cronExpression = effectiveBackupSchedule(config.backup.schedule.cronExpression, {
      database: config.backup.database,
      buddy: buddy.settings?.schedule,
      cloud: cloudOn ? cloudSettings.schedule.cronExpression : null,
    });
    return backupSignal({ cloud: cloudFacts, buddy: buddyFacts, local: localFacts }, cronExpression, now);
  }

  /**
   * When the newest scheduled copy of the library data was made, from its file name, which carries
   * the server's own clock. Uploaded copies and the safety copies kept before an update or a restore
   * are not scheduled ones.
   */
  private async newestLibraryDataCopy(): Promise<string | null> {
    const files = await this.storageRepository
      .readdir(StorageCore.getBaseFolder(StorageFolder.Backups))
      .catch((error: NodeJS.ErrnoException) => {
        if (error?.code === 'ENOENT') {
          return [];
        }
        throw error;
      });
    const times = files
      .filter((file) => isValidDatabaseRoutineBackupName(file))
      .flatMap((file) => {
        const stamp = file.match(BACKUP_STAMP)?.[0];
        const at = stamp ? DateTime.fromFormat(stamp, "yyyyLLdd'T'HHmmss") : null;
        return at?.isValid ? [at.toMillis()] : [];
      });
    return times.length > 0 ? new Date(Math.max(...times)).toISOString() : null;
  }

  private async work(config: SystemConfig): Promise<SignalResult> {
    const pause = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafLibraryMovePause);
    const held = new Set(pause?.queues);
    const overnight = await this.systemMetadataRepository.get(SystemMetadataKey.OvernightSequence);
    const quiet = quietHoursHolds(overnight, config.nightlyTasks, serverTimeZone(config.server));
    const names = Object.values(QueueName);
    const queues: QueueFacts[] = [];
    for (let offset = 0; offset < names.length; offset += QUEUE_BATCH) {
      const batch = await Promise.all(
        names.slice(offset, offset + QUEUE_BATCH).map(async (name) => {
          const [counts, paused] = await Promise.all([
            this.jobRepository.getJobCounts(name),
            this.jobRepository.isPaused(name),
          ]);
          return { name, counts, paused, heldByMove: held.has(name), heldByQuietHours: quiet.has(name) };
        }),
      );
      queues.push(...batch);
    }
    return workSignal(queues);
  }

  private async version(config: SystemConfig): Promise<SignalResult> {
    const { enabled, channel } = config.newVersionCheck;
    const state = enabled ? await this.systemMetadataRepository.get(SystemMetadataKey.VersionCheckState) : null;
    return versionSignal({
      enabled,
      state,
      current: serverVersion.toString(),
      isNewer: (releaseVersion) => isNewerRelease(channel, releaseVersion),
    });
  }
}
