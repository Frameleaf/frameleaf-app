import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { debounce } from 'lodash-es';
import { DateTime } from 'luxon';
import { randomUUID } from 'node:crypto';
import path, { basename } from 'node:path';
import { Duplex, PassThrough, Readable, Writable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { coerce, gt, satisfies } from 'semver';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import { serverVersion } from 'src/constants.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import {
  BackupRestoreVerificationRecordDto,
  BackupRestoreVerificationResponseDto,
  DatabaseBackupListResponseDto,
} from 'src/dtos/database-backup.dto.js';
import {
  CacheControl,
  DatabaseLock,
  ImmichWorker,
  JobName,
  JobStatus,
  QueueName,
  StorageFolder,
  SystemMetadataKey,
} from 'src/enum.js';
import { MaintenanceHealthRepository } from 'src/maintenance/maintenance-health.repository.js';
import { advanceJobProgress, jobSignal } from 'src/queue/context.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CronRepository } from 'src/repositories/cron.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { ProcessRepository } from 'src/repositories/process.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { appendConfigHistory, readConfigHistory, reviewHistoryTitle } from 'src/utils/config-history.js';
import { getConfig } from 'src/utils/config.js';
import {
  UnsupportedPostgresError,
  findDatabaseBackupVersion,
  isCloudBackupDumpName,
  isFailedDatabaseBackupName,
  isValidDatabaseBackupName,
  isValidDatabaseRoutineBackupName,
} from 'src/utils/database-backups.js';
import { advanceExecutionProgress, executionSignal } from 'src/utils/execution-signal.js';
import { ImmichFileResponse } from 'src/utils/file.js';
import { handlePromiseError } from 'src/utils/misc.js';

/** FL-71 (CC-9): how often a backup should be proved to restore before the Overview asks again. */
export const RESTORE_VERIFICATION_INTERVAL_DAYS = 90;

/**
 * When the next restore test is due and whether it is overdue: never proved (either part) is due
 * now; otherwise the older of the two records plus the interval.
 */
export const restoreVerificationDue = (
  record: { metadataVerifiedAt?: string | null; originalsVerifiedAt?: string | null },
  now: Date,
): { dueAt: string | null; overdue: boolean } => {
  if (!record.metadataVerifiedAt || !record.originalsVerifiedAt) {
    return { dueAt: null, overdue: true };
  }
  const oldest = Math.min(Date.parse(record.metadataVerifiedAt), Date.parse(record.originalsVerifiedAt));
  const dueAt = new Date(oldest + RESTORE_VERIFICATION_INTERVAL_DAYS * 24 * 60 * 60 * 1000);
  return { dueAt: dueAt.toISOString(), overdue: dueAt.getTime() <= now.getTime() };
};

/** The final marker written by pg_dump only after the database dump finishes. */
const DUMP_COMPLETE = /-- PostgreSQL database dump complete/;
/** Newer `pg_dump` versions write an `unrestrict` meta-command line after it; this much of the end is checked. */
const DUMP_TAIL_BYTES = 4096;

export class DatabaseBackupVerificationError extends Error {
  constructor(reason: string) {
    super(`The backup is not a complete dump: ${reason}`);
    this.name = 'DatabaseBackupVerificationError';
  }
}

@Injectable()
export class DatabaseBackupService {
  constructor(
    private readonly logger: LoggingRepository,
    private readonly storageRepository: StorageRepository,
    private readonly configRepository: ConfigRepository,
    private readonly systemMetadataRepository: SystemMetadataRepository,
    private readonly processRepository: ProcessRepository,
    private readonly databaseRepository: DatabaseRepository,
    private readonly userRepository: UserRepository,
    @Optional()
    private readonly cronRepository: CronRepository,
    @Optional()
    private readonly jobRepository: JobRepository,
    @Optional()
    private readonly maintenanceHealthRepository: MaintenanceHealthRepository,
  ) {
    this.logger.setContext(this.constructor.name);
  }

  private backupLock = false;

  @OnEvent({ name: 'ConfigInit', workers: [ImmichWorker.Microservices] })
  async onConfigInit({
    newConfig: {
      backup: { database },
    },
  }: ArgOf<'ConfigInit'>) {
    if (!this.cronRepository || !this.jobRepository) {
      return;
    }

    this.backupLock = await this.databaseRepository.tryLock(DatabaseLock.BackupDatabase);

    if (this.backupLock) {
      this.cronRepository.create({
        name: 'backupDatabase',
        expression: database.cronExpression,
        onTick: () => handlePromiseError(this.jobRepository.queue({ name: JobName.DatabaseBackup }), this.logger),
        start: database.enabled,
      });
    }
  }

  @OnEvent({ name: 'ConfigUpdate', server: true })
  onConfigUpdate({ newConfig: { backup } }: ArgOf<'ConfigUpdate'>) {
    if (!this.cronRepository || !this.jobRepository || !this.backupLock) {
      return;
    }

    this.cronRepository.update({
      name: 'backupDatabase',
      expression: backup.database.cronExpression,
      start: backup.database.enabled,
    });
  }

  @OnJob({ name: JobName.DatabaseBackup, queue: QueueName.BackupDatabase })
  async handleBackupDatabase(): Promise<JobStatus> {
    try {
      // An interrupted attempt may already have published a verified dump. Never overwrite it on replay.
      await this.createDatabaseBackup('', { label: randomUUID() });
    } catch (error) {
      if (error instanceof UnsupportedPostgresError) {
        return JobStatus.Failed;
      }

      throw error;
    }

    await this.cleanupDatabaseBackups();
    return JobStatus.Success;
  }

  async buildPostgresLaunchArguments(
    bin: 'pg_dump' | 'pg_dumpall' | 'psql',
    options: {
      singleTransaction?: boolean;
    } = {},
  ): Promise<{
    bin: string;
    args: string[];
    databaseUsername: string;
    databasePassword: string;
    databaseVersion: string;
    databaseMajorVersion?: number;
  }> {
    const {
      database: { config: databaseConfig },
    } = this.configRepository.getEnv();
    const isUrlConnection = databaseConfig.connectionType === 'url';

    const databaseVersion = await this.databaseRepository.getPostgresVersion();
    const databaseSemver = coerce(databaseVersion);
    const databaseMajorVersion = databaseSemver?.major;

    const args: string[] = [];
    let databaseUsername;
    let databasePassword;

    if (isUrlConnection) {
      if (bin !== 'pg_dump') {
        args.push('--dbname');
      }

      let url = databaseConfig.url;
      if (URL.canParse(databaseConfig.url)) {
        const parsedUrl = new URL(databaseConfig.url);
        // remove known bad parameters
        parsedUrl.searchParams.delete('uselibpqcompat');

        databaseUsername = parsedUrl.username || parsedUrl.searchParams.get('user');
        databasePassword = parsedUrl.password;

        url = parsedUrl.href;
      }

      // assume typical values if we can't parse URL or not present
      databaseUsername ??= 'postgres';
      databasePassword ??= '';

      args.push(url);
    } else {
      databaseUsername = databaseConfig.username;
      databasePassword = databaseConfig.password;

      args.push(
        '--username',
        databaseUsername,
        '--host',
        databaseConfig.host,
        '--port',
        databaseConfig.port.toString(),
      );

      switch (bin) {
        case 'pg_dump': {
          break;
        }
        case 'pg_dumpall': {
          args.push('--database');
          break;
        }
        case 'psql': {
          args.push('--dbname');
          break;
        }
      }

      args.push(databaseConfig.database);
    }

    switch (bin) {
      case 'pg_dump':
      case 'pg_dumpall': {
        args.push('--clean', '--if-exists');
        break;
      }
      case 'psql': {
        if (options.singleTransaction) {
          args.push(
            // don't commit any transaction on failure
            '--single-transaction',
            // exit with non-zero code on error
            '--set',
            'ON_ERROR_STOP=on',
          );
        }

        args.push(
          // used for progress monitoring
          '--echo-all',
          '--output=/dev/null',
        );
        break;
      }
    }

    if (!databaseMajorVersion || !databaseSemver || !satisfies(databaseSemver, '>=19.0.0 <20.0.0')) {
      this.logger.error(`Database Restore Failure: Unsupported PostgreSQL version: ${databaseVersion}`);
      throw new UnsupportedPostgresError(databaseVersion);
    }

    return {
      bin: `/usr/lib/postgresql/${databaseMajorVersion}/bin/${bin}`,
      args,
      databaseUsername,
      databasePassword,
      databaseVersion,
      databaseMajorVersion,
    };
  }

  /**
   * A full `pg_dump` of the database, gzipped into `<media>/backups`, written to a `.tmp` file and renamed
   * once complete. FL-295: `label` goes between the timestamp and the version (the pre-upgrade copy), and
   * `verify` checks the temporary file is a complete dump before it is renamed. FL-298: every backup is
   * verified by default (routine, restore point, cloud dump), so an empty or partial file never counts.
   */
  async createDatabaseBackup(
    filenamePrefix: string = '',
    {
      label,
      verify = true,
      snapshot,
      signal = executionSignal(),
      progress = advanceExecutionProgress,
    }: {
      label?: string;
      verify?: boolean;
      snapshot?: string;
      signal?: AbortSignal;
      progress?: (bytes: number) => void;
    } = {},
  ): Promise<string> {
    this.logger.debug(`Database Backup Started`);

    const { bin, args, databasePassword, databaseVersion, databaseMajorVersion } =
      await this.buildPostgresLaunchArguments('pg_dump');
    if (snapshot !== undefined) {
      if (!/^[\da-f]+-[\da-f]+-\d+$/i.test(snapshot)) throw new Error('Invalid PostgreSQL backup snapshot');
      args.push(`--snapshot=${snapshot}`);
    }

    this.logger.log(`Database Backup Starting. Database Version: ${databaseMajorVersion}`);

    const timestamp = DateTime.now().toFormat("yyyyLLdd'T'HHmmss");
    const filename = `${filenamePrefix}frameleaf-db-backup-${timestamp}${label ? `-${label}` : ''}-v${serverVersion.toString()}-pg${databaseVersion.split(' ', 1)[0]}.sql.gz`;
    const backupFilePath = path.join(StorageCore.getBaseFolder(StorageFolder.Backups), filename);
    const temporaryFilePath = `${backupFilePath}.tmp`;

    let pgdump: Duplex | undefined;
    let gzip: Duplex | undefined;

    try {
      pgdump = this.processRepository.spawnDuplexStream(bin, args, {
        signal,
        env: {
          PATH: process.env.PATH,
          PGPASSWORD: databasePassword,
        },
      });

      gzip = this.processRepository.spawnDuplexStream('gzip', ['--rsyncable'], { signal });
      pgdump.on('data', (chunk: Buffer) => progress(chunk.length));
      const fileStream = this.storageRepository.createWriteStream(temporaryFilePath);

      await pipeline(pgdump, gzip, fileStream, { signal });
      if (verify) {
        await this.verifyDatabaseBackup(temporaryFilePath, { signal, progress });
      }
      signal?.throwIfAborted();
      await this.storageRepository.rename(temporaryFilePath, backupFilePath);
    } catch (error) {
      this.logger.error(`Database Backup Failure: ${error}`);
      pgdump?.destroy();
      gzip?.destroy();
      await Promise.all(
        [pgdump, gzip].filter((stream): stream is Duplex => !!stream).map((stream) => finished(stream).catch(() => {})),
      );
      await this.storageRepository
        .unlink(temporaryFilePath)

        .catch((error) => this.logger.error(`Failed to delete failed backup file: ${error}`));
      throw error;
    }

    this.logger.log(`Database Backup Success`);
    return backupFilePath;
  }

  /**
   * FL-295: whether a gzipped dump is complete: not empty, a valid gzip stream to its end, and SQL that
   * ends with the line `pg_dump` writes once it has finished. Throws
   * {@link DatabaseBackupVerificationError} saying what is wrong.
   */
  async verifyDatabaseBackup(
    filePath: string,
    {
      signal = executionSignal(),
      progress = advanceExecutionProgress,
    }: { signal?: AbortSignal; progress?: (bytes: number) => void } = {},
  ): Promise<void> {
    const { size } = await this.storageRepository.stat(filePath);
    if (!size) {
      throw new DatabaseBackupVerificationError(`${basename(filePath)} is empty`);
    }

    let bytes = 0;
    let tail = '';
    try {
      await pipeline(
        this.storageRepository.createPlainReadStream(filePath),
        this.storageRepository.createGunzip(),
        new Writable({
          write(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length;
            progress(chunk.length);
            tail = (tail + chunk.toString('latin1')).slice(-DUMP_TAIL_BYTES);
            callback();
          },
        }),
        { signal },
      );
    } catch (error) {
      throw new DatabaseBackupVerificationError(`${basename(filePath)} is not a complete gzip file (${error})`);
    }

    if (bytes === 0) {
      throw new DatabaseBackupVerificationError(`${basename(filePath)} is empty once uncompressed`);
    }

    if (!DUMP_COMPLETE.test(tail)) {
      throw new DatabaseBackupVerificationError(`${basename(filePath)} does not finish like a complete dump`);
    }
  }

  /** Validate before any restore DDL; an Immich dump is a source for import-immich only. */
  private async assertFrameleafBackup(filePath: string): Promise<void> {
    const stream = this.readDatabaseDump(filePath);
    const signal = jobSignal();
    const abort = () => {
      stream.destroy(signal?.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
    let tail = '';
    let ledger = false;
    let postgres19 = false;
    try {
      signal?.throwIfAborted();
      for await (const chunk of stream) {
        advanceJobProgress(chunk.byteLength);
        const text = tail + chunk.toString();
        ledger ||= /CREATE TABLE (?:public\.)?"?frameleaf_migrations"?\s*\(/.test(text);
        postgres19 ||= /-- Dumped from database version 19(?:[.\s]|beta|rc)/.test(text);
        if (/CREATE SCHEMA "?immich_fork"?|CREATE TABLE (?:public\.)?"?kysely_migrations"?\s*\(/.test(text)) {
          throw new Error(
            'This is not a canonical Frameleaf backup. Use import-immich for a supported Immich library.',
          );
        }
        tail = text.slice(-8192);
      }
      if (!ledger || !postgres19 || !DUMP_COMPLETE.test(tail))
        throw new Error('Restore requires a complete Frameleaf PostgreSQL 19 backup.');
    } finally {
      signal?.removeEventListener('abort', abort);
      stream.destroy();
    }
  }

  private readDatabaseDump(filePath: string): Readable {
    const storage = this.storageRepository;
    let file: Readable | undefined;
    let decoded: Readable | undefined;
    // Opening is deferred until iteration, after the restore fence has been checked.
    const output = Readable.from(
      (async function* () {
        const input = storage.createPlainReadStream(filePath);
        const decoder = filePath.endsWith('.gz') ? storage.createGunzip() : undefined;
        file = input;
        decoded = decoder ?? input;
        try {
          if (decoder) {
            // Pipe does not forward disk errors to the decoder's async iterator.
            input.on('error', (error) => decoder.destroy(error));
            input.pipe(decoder);
          }
          yield* decoder ?? input;
        } finally {
          input.destroy();
          decoder?.destroy();
        }
      })(),
    );
    const destroy = output._destroy.bind(output);
    output._destroy = (error, callback) => {
      // Readable.from waits for generator.return(). Break a pending inner read first so
      // cancellation never waits for a stalled disk stream to yield another chunk.
      file?.destroy(error ?? undefined);
      decoded?.destroy(error ?? undefined);
      destroy(error, callback);
    };
    return output;
  }

  async uploadBackup(file: Express.Multer.File): Promise<void> {
    const backupsFolder = StorageCore.getBaseFolder(StorageFolder.Backups);
    const fn = basename(file.originalname);
    if (!isValidDatabaseBackupName(fn)) {
      throw new BadRequestException('Invalid backup name!');
    }

    const filePath = path.join(backupsFolder, `uploaded-${fn}`);
    await this.storageRepository.createOrOverwriteFile(filePath, file.buffer);
  }

  downloadBackup(fileName: string): ImmichFileResponse {
    if (!isValidDatabaseBackupName(fileName)) {
      throw new BadRequestException('Invalid backup name!');
    }

    const filePath = path.join(StorageCore.getBaseFolder(StorageFolder.Backups), fileName);

    return {
      path: filePath,
      fileName,
      cacheControl: CacheControl.PrivateWithoutCache,
      contentType: fileName.endsWith('.gz') ? 'application/gzip' : 'application/sql',
    };
  }

  /** FL-71 (CC-9): the last recorded restore test and whether another is due. Administrators only. */
  async getRestoreVerification(): Promise<BackupRestoreVerificationResponseDto> {
    const record = (await this.systemMetadataRepository.get(SystemMetadataKey.BackupRestoreVerification)) ?? {};
    const verifier = record.verifiedBy ? await this.userRepository.get(record.verifiedBy, { withDeleted: true }) : null;
    return {
      metadataVerifiedAt: record.metadataVerifiedAt ?? null,
      originalsVerifiedAt: record.originalsVerifiedAt ?? null,
      verifiedBy: verifier ? { id: verifier.id, name: verifier.name } : null,
      ...restoreVerificationDue(record, new Date()),
      intervalDays: RESTORE_VERIFICATION_INTERVAL_DAYS,
    };
  }

  /**
   * FL-71 (CC-9): an administrator records that a restore test succeeded for the database, the
   * original files or both. A part not tested keeps its earlier record.
   */
  async recordRestoreVerification(
    auth: AuthDto,
    dto: BackupRestoreVerificationRecordDto,
  ): Promise<BackupRestoreVerificationResponseDto> {
    const record = (await this.systemMetadataRepository.get(SystemMetadataKey.BackupRestoreVerification)) ?? {};
    const now = new Date().toISOString();
    await this.systemMetadataRepository.set(SystemMetadataKey.BackupRestoreVerification, {
      metadataVerifiedAt: dto.metadata ? now : (record.metadataVerifiedAt ?? null),
      originalsVerifiedAt: dto.originals ? now : (record.originalsVerifiedAt ?? null),
      verifiedBy: auth.user.id,
    });
    await this.recordReview(auth, 'Recovery readiness', now);
    return this.getRestoreVerification();
  }

  /**
   * FL-71 (CC-10): a review lands in the settings change history as "Reviewed: {title}"
   * (`CommandCenter.jsx:2495`), with no values. Appended under the settings lock like a save; a
   * failure is logged and never undoes the review.
   */
  private async recordReview(auth: AuthDto, title: string, at: string) {
    try {
      await this.databaseRepository.withLock(DatabaseLock.SystemConfigUpdate, async () => {
        const history = readConfigHistory(
          await this.systemMetadataRepository.get(SystemMetadataKey.SystemConfigHistory),
        );
        await this.systemMetadataRepository.set(
          SystemMetadataKey.SystemConfigHistory,
          appendConfigHistory(
            history,
            {
              id: randomUUID(),
              createdAt: at,
              actorId: auth.user.id,
              actorName: auth.user.name,
              kind: 'review',
              title: reviewHistoryTitle(title),
            },
            [],
          ),
        );
      });
    } catch (error) {
      this.logger.error(`Unable to record the review in the change history: ${error}`);
    }
  }

  async listBackups(): Promise<DatabaseBackupListResponseDto> {
    const backupsFolder = StorageCore.getBaseFolder(StorageFolder.Backups);
    // FL-81: no backups folder yet (nothing was ever backed up) is no backups, not an error.
    const files = await this.storageRepository.readdir(backupsFolder).catch((error: NodeJS.ErrnoException) => {
      if (error?.code === 'ENOENT') {
        return [];
      }
      throw error;
    });
    const timezone = DateTime.local().zoneName;

    const validFiles = files
      // FL-160: a cloud backup run's own temporary dump is never offered for a restore
      .filter((fn) => isValidDatabaseBackupName(fn) && !isCloudBackupDumpName(fn))
      .toSorted((a, b) => (a.startsWith('uploaded-') === b.startsWith('uploaded-') ? a.localeCompare(b) : 1))
      .toReversed();

    const backups = await Promise.all(
      validFiles.map(async (filename) => {
        const stats = await this.storageRepository.stat(path.join(backupsFolder, filename));
        return { filename, filesize: stats.size, timezone };
      }),
    );

    return {
      backups,
    };
  }

  async deleteBackup(files: string[]): Promise<void> {
    const backupsFolder = StorageCore.getBaseFolder(StorageFolder.Backups);

    if (files.some((filename) => !isValidDatabaseBackupName(filename))) {
      throw new BadRequestException('Invalid backup name!');
    }

    await Promise.all(files.map((filename) => this.storageRepository.unlink(path.join(backupsFolder, filename))));
  }

  async cleanupDatabaseBackups() {
    this.logger.debug(`Database Backup Cleanup Started`);
    const {
      backup: { database: config },
    } = await getConfig(
      {
        configRepo: this.configRepository,
        metadataRepo: this.systemMetadataRepository,
        logger: this.logger,
      },
      {
        withCache: false,
      },
    );

    const backupsFolder = StorageCore.getBaseFolder(StorageFolder.Backups);
    const files = await this.storageRepository.readdir(backupsFolder);
    const backups = files
      .filter((filename) => isValidDatabaseRoutineBackupName(filename))
      .toSorted()
      .toReversed();
    const failedBackups = files.filter((filename) => isFailedDatabaseBackupName(filename));

    const toDelete = backups.slice(config.keepLastAmount);
    toDelete.push(...failedBackups);

    for (const file of toDelete) {
      await this.storageRepository.unlink(path.join(backupsFolder, file));
    }

    this.logger.debug(`Database Backup Cleanup Finished, deleted ${toDelete.length} backups`);
  }

  async restoreDatabaseBackup(
    filename: string,
    progressCb?: (action: 'backup' | 'restore' | 'migrations' | 'rollback', progress: number) => void,
    { keepSafetyBackup = true, fence }: { keepSafetyBackup?: boolean; fence?: DatabaseRestoreFence } = {},
  ): Promise<void> {
    this.logger.debug(`Database Restore Started`);

    let isComplete = false;
    try {
      await fence?.assert();
      if (fence && (!Number.isSafeInteger(fence.backendPid) || fence.backendPid <= 0))
        throw new Error('Invalid restore lock');
      if (!isValidDatabaseBackupName(filename)) {
        throw new Error('Invalid backup file format!');
      }

      const backupFilePath = path.join(StorageCore.getBaseFolder(StorageFolder.Backups), filename);
      await this.storageRepository.stat(backupFilePath);
      await this.assertFrameleafBackup(backupFilePath);

      const version = findDatabaseBackupVersion(filename);

      // FL-81: migrations only move a database forward, so a backup from a newer server cannot run on
      // this one. It is refused before the restore point is made or anything is changed.
      const backupVersion = version ? coerce(version) : null;
      const runningVersion = coerce(serverVersion.toString());
      if (backupVersion && runningVersion && gt(backupVersion, runningVersion)) {
        throw new Error(
          `This backup was made by a newer server (v${backupVersion.toString()}) than the one running (v${runningVersion.toString()}). Update the server first.`,
        );
      }
      const { bin, args, databaseUsername, databasePassword, databaseMajorVersion } =
        await this.buildPostgresLaunchArguments('psql', {
          singleTransaction: true,
        });

      progressCb?.('backup', 0.05);

      const restorePointFilePath = await this.createDatabaseBackup('restore-point-');

      this.logger.log(`Database Restore Starting. Database Version: ${databaseMajorVersion}`);

      const inputStream = this.readDatabaseDump(backupFilePath);

      const sqlStream = Readable.from(sql(inputStream, databaseUsername, fence));
      const psql = this.processRepository.spawnDuplexStream(bin, args, {
        env: {
          PATH: process.env.PATH,
          PGPASSWORD: databasePassword,
        },
      });

      const [progressSource, progressSink] = createSqlProgressStreams((progress) => {
        if (isComplete) {
          return;
        }

        this.logger.log(`Restore progress ~ ${(progress * 100).toFixed(2)}%`);
        progressCb?.('restore', progress);
      });

      await pipeline(sqlStream, createSqlOwnerTransformStream(databaseUsername), progressSource, psql, progressSink, {
        signal: jobSignal(),
      });

      try {
        await fence?.assert();
        progressCb?.('migrations', 0.9);

        await this.databaseRepository.runMigrations();
        await fence?.assert();
        await this.databaseRepository.resetTransientExecutionState();

        const hasAdmin = await this.userRepository.hasAdmin();
        if (!hasAdmin) {
          throw new Error('Server health check failed, no admin exists.');
        }

        await this.maintenanceHealthRepository.checkApiHealth();
        await fence?.assert();
      } catch (error) {
        // A lost fence belongs to another worker; even rollback must not mutate underneath it.
        await fence?.assert();
        progressCb?.('rollback', 0);

        const rollbackStream = this.readDatabaseDump(restorePointFilePath);
        const sqlStream = Readable.from(sqlRollback(rollbackStream, databaseUsername, fence));
        const psql = this.processRepository.spawnDuplexStream(bin, args, {
          env: {
            PATH: process.env.PATH,
            PGPASSWORD: databasePassword,
          },
        });

        const [progressSource, progressSink] = createSqlProgressStreams((progress) => {
          if (isComplete) {
            return;
          }

          this.logger.log(`Rollback progress ~ ${(progress * 100).toFixed(2)}%`);
          progressCb?.('rollback', progress);
        });

        await pipeline(sqlStream, progressSource, psql, progressSink);

        throw error;
      }

      // The restore point is always made, for the rollback above. After a successful restore it is
      // kept as the administrator's safety backup ("Create a safety backup of the current database
      // first", the template's RestoreDialog) unless they chose not to keep it.
      if (!keepSafetyBackup) {
        await this.storageRepository.unlink(restorePointFilePath).catch((error: unknown) => {
          this.logger.warn(`Could not remove the restore point ${restorePointFilePath}: ${error}`);
        });
      }
    } catch (error) {
      this.logger.error(`Database Restore Failure: ${error}`);
      throw error;
    } finally {
      isComplete = true;
    }

    this.logger.log(`Database Restore Success`);
  }
}

export type DatabaseRestoreFence = { backendPid: number; assert: () => Promise<void> };

const SQL_DROP_CONNECTIONS = (backendPid = 0) => `
  -- drop all other database connections
  SELECT pg_terminate_backend(pid)
  FROM pg_stat_activity
  WHERE datname = current_database()
    AND pid <> pg_backend_pid()${backendPid ? ` AND pid <> ${backendPid}` : ''};
`;

const SQL_RESET_SCHEMA = (username: string) => `
  -- re-create the default schema
  DROP SCHEMA public CASCADE;
  CREATE SCHEMA public;

  -- restore access to schema
  GRANT ALL ON SCHEMA public TO "${username}";
  GRANT ALL ON SCHEMA public TO public;
`;

async function* sql(inputStream: Readable, databaseUsername: string, fence?: DatabaseRestoreFence) {
  try {
    await fence?.assert();
    yield SQL_DROP_CONNECTIONS(fence?.backendPid);
    yield SQL_RESET_SCHEMA(databaseUsername);
    for await (const chunk of inputStream) {
      await fence?.assert();
      yield chunk;
    }
    await fence?.assert();
  } finally {
    inputStream.destroy();
  }
}

async function* sqlRollback(inputStream: Readable, databaseUsername: string, fence?: DatabaseRestoreFence) {
  try {
    await fence?.assert();
    yield SQL_DROP_CONNECTIONS(fence?.backendPid);
    yield SQL_RESET_SCHEMA(databaseUsername);
    for await (const chunk of inputStream) {
      await fence?.assert();
      yield chunk;
    }
    await fence?.assert();
  } finally {
    inputStream.destroy();
  }
}

function createSqlProgressStreams(cb: (progress: number) => void) {
  const STDIN_START_MARKER = new TextEncoder().encode('FROM stdin');
  const STDIN_END_MARKER = new TextEncoder().encode(String.raw`\.`);

  let isReadingStdin = false;
  let sequenceIdx = 0;

  let linesSent = 0;
  let linesProcessed = 0;

  const startedAt = +Date.now();
  const cbDebounced = debounce(
    () => {
      const progress = source.writableEnded
        ? Math.min(1, linesProcessed / linesSent)
        : // progress simulation while we're in an indeterminate state
          Math.min(0.3, 0.1 + (Date.now() - startedAt) / 1e4);
      cb(progress);
    },
    100,
    {
      maxWait: 100,
    },
  );

  let lastByte = -1;
  const source = new PassThrough({
    transform(chunk, _encoding, callback) {
      for (const byte of chunk) {
        if (!isReadingStdin && byte === 10 && lastByte !== 10) {
          linesSent += 1;
        }

        lastByte = byte;

        const sequence = isReadingStdin ? STDIN_END_MARKER : STDIN_START_MARKER;
        if (sequence[sequenceIdx] === byte) {
          sequenceIdx += 1;

          if (sequence.length === sequenceIdx) {
            sequenceIdx = 0;
            isReadingStdin = !isReadingStdin;
          }
        } else {
          sequenceIdx = 0;
        }
      }

      cbDebounced();
      // eslint-disable-next-line unicorn/no-this-outside-of-class
      this.push(chunk);
      callback();
    },
  });

  const sink = new Writable({
    write(chunk, _encoding, callback) {
      advanceJobProgress(chunk.byteLength);
      for (const byte of chunk) {
        if (byte === 10) {
          linesProcessed++;
        }
      }

      cbDebounced();
      callback();
    },
  });

  return [source, sink];
}

function createSqlOwnerTransformStream(databaseUsername: string) {
  const OWNER_MARKER_START = new TextEncoder().encode('OWNER TO ');
  const DATA_MARKER_START = new TextEncoder().encode('FROM stdin');
  const LINE_END = new TextEncoder().encode(';');

  const owner = new TextEncoder().encode(`"${databaseUsername}"`);

  let ownerSequenceIndex = 0;

  let replacingOwnerIndex = 0;
  let replacingOwner = false;

  let readingDataIndex = 0;

  let dataPart = false;

  return new PassThrough({
    transform(chunk, _encoding, callback) {
      let result = chunk;
      if (!dataPart) {
        for (let index = 0; index < result.length; index++) {
          if (replacingOwner) {
            if (result[index] === LINE_END[0]) {
              result = Buffer.concat([result.slice(0, index), owner.slice(replacingOwnerIndex), result.slice(index)]);
              replacingOwnerIndex = owner.length;
            } else {
              result[index] = owner[replacingOwnerIndex];
              replacingOwnerIndex++;
            }
          }

          if (replacingOwnerIndex === owner.length) {
            replacingOwner = false;
          }

          if (result[index] === OWNER_MARKER_START[ownerSequenceIndex]) {
            ownerSequenceIndex++;
          } else {
            ownerSequenceIndex = 0;
          }

          if (ownerSequenceIndex === OWNER_MARKER_START.length) {
            ownerSequenceIndex = 0;
            replacingOwner = true;
            replacingOwnerIndex = 0;
          }

          if (result[index] === DATA_MARKER_START[readingDataIndex]) {
            readingDataIndex++;
          } else {
            readingDataIndex = 0;
          }

          if (readingDataIndex === DATA_MARKER_START.length) {
            dataPart = true;
            break;
          }
        }
      }

      // eslint-disable-next-line unicorn/no-this-outside-of-class
      this.push(result);
      callback();
    },
  });
}
