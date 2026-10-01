import { DateTime } from 'luxon';
import { join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { StorageFolder } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { DatabaseBackupService } from 'src/services/database-backup.service.js';
import {
  PRE_UPGRADE_BACKUP_LABEL,
  getDatabaseBackupTime,
  isDatabaseBackupDumpName,
  isPreUpgradeBackupName,
} from 'src/utils/database-backups.js';

/** A database backup newer than this makes the safety copy unnecessary. */
export const RECENT_BACKUP_HOURS = 24;

/** Room left over on top of the estimated dump size. */
const SPACE_MARGIN_BYTES = 64 * 1024 * 1024;

/** A name timestamp this far ahead of the clock is not trusted (a different time zone or clock). */
const FUTURE_TOLERANCE_MINUTES = 5;

export type FirstLaunchBackupInfo = { filename: string; takenAt: string };

export type FirstLaunchOutcome =
  /** A fresh install, an adopted library or a Frameleaf library: nothing to do. */
  | { kind: 'not-needed' }
  /** A complete database backup of the last 24 hours already exists. */
  | { kind: 'skipped'; backup: FirstLaunchBackupInfo }
  /** The pre-upgrade copy was taken and verified. */
  | { kind: 'created'; backup: FirstLaunchBackupInfo };

export type FirstLaunchProgress = 'checking' | 'backing-up';

export type FirstLaunchFailureReason = 'disk-space' | 'backup-failed';

/** The safety copy could not be taken; nothing was upgraded. */
export class FirstLaunchBackupError extends Error {
  constructor(
    readonly reason: FirstLaunchFailureReason,
    message: string,
    readonly details: { requiredBytes?: number; availableBytes?: number; folder?: string } = {},
  ) {
    super(message);
    this.name = 'FirstLaunchBackupError';
  }

  get requiredBytes() {
    return this.details.requiredBytes;
  }

  get availableBytes() {
    return this.details.availableBytes;
  }
}

type Repos = {
  logger: LoggingRepository;
  database: DatabaseRepository;
  storage: StorageRepository;
  config: ConfigRepository;
};

const isNoSpace = (error: unknown) =>
  (error as NodeJS.ErrnoException | undefined)?.code === 'ENOSPC' || /no space left on device/i.test(String(error));

const formatGiB = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

/**
 * FL-295: the first Frameleaf start on a library the official server created takes a safety copy of
 * the database before anything changes it. The copy is a full dump made by the existing database-backup
 * path (`<media>/backups/immich-db-backup-<timestamp>-pre-upgrade-v<version>-pg<version>.sql.gz`), written
 * to a `.tmp` file, verified, then renamed. It is skipped when the newest database backup there was taken
 * in the last 24 hours and is a complete dump.
 *
 * {@link run} must be called with `DatabaseLock.Migrations` held, so only one process copies and every
 * other one waits, then finds the fresh copy and skips.
 */
export class FirstLaunchBackup {
  private readonly now: () => Date;

  constructor(
    private readonly repos: Repos,
    private readonly backups: Pick<DatabaseBackupService, 'createDatabaseBackup' | 'verifyDatabaseBackup'>,
    { now = () => new Date() }: { now?: () => Date } = {},
  ) {
    this.now = now;
  }

  isNeeded(): Promise<boolean> {
    return this.repos.database.isFirstLaunchOnOfficialLibrary();
  }

  async run({ onProgress }: { onProgress?: (state: FirstLaunchProgress) => void } = {}): Promise<FirstLaunchOutcome> {
    if (!(await this.isNeeded())) {
      return { kind: 'not-needed' };
    }

    onProgress?.('checking');
    const folder = this.backupsFolder();
    this.repos.storage.mkdirSync(folder);
    const files = await this.readFolder(folder);

    const recent = await this.findRecentBackup(folder, files);
    if (recent) {
      this.repos.logger.log(
        `The database backup ${recent.filename} (taken ${recent.takenAt}) is less than ${RECENT_BACKUP_HOURS} hours old and complete, so no safety copy is needed before upgrading`,
      );
      return { kind: 'skipped', backup: recent };
    }

    // An earlier start stopped part-way through its copy: the unfinished file never counts, and goes.
    for (const filename of files) {
      if (!(filename.endsWith('.tmp') && isPreUpgradeBackupName(filename.slice(0, -4)))) {
        continue;
      }

      await this.repos.storage.unlink(join(folder, filename));
      this.repos.logger.log(`Removed the unfinished safety copy ${filename} left by an earlier start`);
    }

    await this.checkFreeSpace(folder);

    onProgress?.('backing-up');
    this.repos.logger.log('Making a safety copy of the library database before upgrading');
    let path: string;
    try {
      path = await this.backups.createDatabaseBackup('', { label: PRE_UPGRADE_BACKUP_LABEL, verify: true });
    } catch (error) {
      if (isNoSpace(error)) {
        throw new FirstLaunchBackupError('disk-space', `The backups folder ran out of space: ${error}`, { folder });
      }
      throw new FirstLaunchBackupError('backup-failed', `The safety copy failed: ${error}`, { folder });
    }

    const filename = path.slice(path.lastIndexOf('/') + 1);
    this.repos.logger.log(`Safety copy saved before upgrading: ${path}`);
    return {
      kind: 'created',
      backup: { filename, takenAt: (getDatabaseBackupTime(filename) ?? DateTime.fromJSDate(this.now())).toISO()! },
    };
  }

  private backupsFolder() {
    try {
      StorageCore.getMediaLocation();
    } catch {
      // DatabaseService runs before StorageService sets it; this is the same detection
      StorageCore.setMediaLocation(this.detectMediaLocation());
    }
    return StorageCore.getBaseFolder(StorageFolder.Backups);
  }

  private detectMediaLocation(): string {
    const { storage } = this.repos.config.getEnv();
    if (storage.mediaLocation) {
      return storage.mediaLocation;
    }
    const targets = ['/data', '/usr/src/app/upload'].filter((candidate) => this.repos.storage.existsSync(candidate));
    return targets.length === 1 ? targets[0] : '/usr/src/app/upload';
  }

  private async readFolder(folder: string): Promise<string[]> {
    try {
      return await this.repos.storage.readdir(folder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  /** The newest database backup, when it is less than 24 hours old and a complete dump. */
  private async findRecentBackup(folder: string, files: string[]): Promise<FirstLaunchBackupInfo | null> {
    const now = DateTime.fromJSDate(this.now());
    let newest: { filename: string; takenAt: DateTime } | undefined;
    for (const filename of files) {
      if (!isDatabaseBackupDumpName(filename)) {
        continue;
      }
      let takenAt = getDatabaseBackupTime(filename);
      if (!takenAt || takenAt > now.plus({ minutes: FUTURE_TOLERANCE_MINUTES })) {
        const { mtime } = await this.repos.storage.stat(join(folder, filename));
        takenAt = DateTime.fromJSDate(mtime);
      }
      if (!newest || takenAt > newest.takenAt) {
        newest = { filename, takenAt };
      }
    }

    if (!newest) {
      this.repos.logger.log('No earlier database backup was found');
      return null;
    }

    if (now.diff(newest.takenAt, 'hours').hours > RECENT_BACKUP_HOURS) {
      this.repos.logger.log(
        `The newest database backup, ${newest.filename}, is more than ${RECENT_BACKUP_HOURS} hours old`,
      );
      return null;
    }

    try {
      await this.backups.verifyDatabaseBackup(join(folder, newest.filename));
    } catch (error) {
      this.repos.logger.warn(`The newest database backup, ${newest.filename}, cannot be relied on: ${error}`);
      return null;
    }

    return { filename: newest.filename, takenAt: newest.takenAt.toISO()! };
  }

  private async checkFreeSpace(folder: string) {
    const estimate = await this.repos.database.getDumpSizeEstimate();
    const requiredBytes = estimate + SPACE_MARGIN_BYTES;
    const { available: availableBytes } = await this.repos.storage.checkDiskUsage(folder);
    if (availableBytes < requiredBytes) {
      throw new FirstLaunchBackupError(
        'disk-space',
        `The safety copy needs up to ${formatGiB(requiredBytes)} in ${folder}, but only ${formatGiB(availableBytes)} is free`,
        { requiredBytes, availableBytes, folder },
      );
    }
  }
}
