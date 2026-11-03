import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import type { SystemConfig } from 'src/config.js';
import { serverVersion } from 'src/constants.js';
import { StorageCore } from 'src/cores/storage.core.js';
import {
  ATTENTION_KINDS,
  type AttentionDismissDto,
  type AttentionKind,
  type AttentionResponseDto,
} from 'src/dtos/attention.dto.js';
import { QueueName, StorageFolder, SystemMetadataKey } from 'src/enum.js';
import { BuddyBackupRepository } from 'src/repositories/buddy-backup.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { isNewerRelease } from 'src/services/version.service.js';
import {
  type BackupPlaceFacts,
  type QueueFacts,
  type SignalResult,
  backupSignal,
  sortAttention,
  storageSignal,
  versionSignal,
  workSignal,
} from 'src/utils/attention.js';
import { effectiveBackupSchedule } from 'src/utils/backup-sequence.js';
import { getConfig } from 'src/utils/config.js';
import { isValidDatabaseRoutineBackupName } from 'src/utils/database-backups.js';
import { quietHoursHolds } from 'src/utils/overnight.js';
import { serverTimeZone } from 'src/utils/server-time-zone.js';

/** Queues are read a few at a time, as the queue list does, so a read never fills the database pool. */
const QUEUE_BATCH = 4;
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
  ) {
    this.logger.setContext(AttentionService.name);
  }

  private readConfig() {
    return getConfig(
      { configRepo: this.configRepository, metadataRepo: this.systemMetadataRepository, logger: this.logger },
      { withCache: true },
    );
  }

  async getAttention(): Promise<AttentionResponseDto> {
    const now = new Date();
    const config = await this.readConfig();
    const [backup, storage, work, version] = await Promise.all([
      this.check('backup', () => this.backup(config, now)),
      this.check('storage', () => this.storage(config)),
      this.check('work', () => this.work(config)),
      this.check('version', () => this.version(config)),
    ]);
    const results: Record<AttentionKind, SignalResult> = { backup, storage, work, version };
    return {
      checkedAt: now.toISOString(),
      items: sortAttention(ATTENTION_KINDS.flatMap((kind) => results[kind].items)),
      checks: ATTENTION_KINDS.map((kind) => ({ kind, state: results[kind].state })),
      dismissed: await this.dismissed(),
    };
  }

  private async dismissed(): Promise<string[]> {
    const stored = await this.systemMetadataRepository.get(SystemMetadataKey.OverviewDismissed).catch(() => null);
    return stored?.ids ?? [];
  }

  /** FL-363: dismiss an Overview item so it stops counting, or bring it back. Kept for every administrator. */
  async setDismissed({ id, dismissed }: AttentionDismissDto): Promise<AttentionResponseDto> {
    const ids = new Set(await this.dismissed());
    if (dismissed) {
      ids.add(id);
    } else {
      ids.delete(id);
    }
    await this.systemMetadataRepository.set(SystemMetadataKey.OverviewDismissed, { ids: [...ids].slice(-32) });
    return this.getAttention();
  }

  private async check(kind: AttentionKind, read: () => Promise<SignalResult>): Promise<SignalResult> {
    try {
      return await read();
    } catch (error) {
      this.logger.warn(`Could not check ${kind} for what needs attention: ${error}`);
      return { state: 'unknown', items: [] };
    }
  }

  private async storage(config: SystemConfig): Promise<SignalResult> {
    return storageSignal(
      await this.storageRepository.checkDiskUsage(StorageCore.getBaseFolder(StorageFolder.Library)),
      config.storageWarning.percent,
    );
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
