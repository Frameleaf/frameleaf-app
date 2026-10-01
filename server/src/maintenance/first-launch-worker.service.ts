import { Injectable } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { readFileSync } from 'node:fs';
import { DatabaseLock, ExitCode } from 'src/enum.js';
import {
  FirstLaunchBackup,
  FirstLaunchBackupError,
  FirstLaunchBackupInfo,
  FirstLaunchFailureReason,
} from 'src/maintenance/first-launch-backup.js';
import { type MaintenanceWorkerService as _MaintenanceWorkerService } from 'src/maintenance/maintenance-worker.service.js';
import { AppRepository } from 'src/repositories/app.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { DatabaseBackupService } from 'src/services/database-backup.service.js';
import {
  FIRST_LAUNCH_PAGE,
  FIRST_LAUNCH_RETRY_AFTER_SECONDS,
  FIRST_LAUNCH_STATUS_PATH,
} from 'src/utils/first-launch.js';
import { RESTART_BUDGET } from 'src/utils/shutdown.js';

/** How long the screen shows which recent backup made the copy unnecessary. */
const SKIPPED_NOTICE_MS = 5000;
/** How long the screen shows that the copy is saved before startup carries on. */
const DONE_NOTICE_MS = 2000;

/**
 * What the "Getting Ready…" screen shows. Public: anyone who opens the server sees it, so a failure
 * carries only its kind (and the space figures), never the error text; the details are in the log.
 */
export type FirstLaunchStatus = {
  state: 'checking' | 'backing-up' | 'skipped' | 'done' | 'ready' | 'failed';
  /** Whether a copy was taken or a recent backup made it unnecessary; kept once known. */
  copy?: 'taken' | 'skipped';
  /** The backup that made the copy unnecessary (`skipped`) or the copy just taken (`done`). */
  backup?: FirstLaunchBackupInfo;
  error?: { reason: FirstLaunchFailureReason; requiredBytes?: number; availableBytes?: number };
};

/**
 * FL-295: the "Getting Ready…" worker, the same pattern as the maintenance worker. The supervisor starts
 * it alone on the first start on a library the official server created. It serves the web UI, with
 * every page sent to the "Getting Ready…" screen and every API route refused with 503 and Retry-After,
 * while it takes the safety copy of the database under the boot migration lock. It then exits with
 * {@link ExitCode.FirstLaunchReady} and the supervisor starts the configured workers, whose boot migrates.
 * When the copy fails it stays on the error screen and the database is left exactly as it was.
 */
@Injectable()
export class FirstLaunchWorkerService {
  #status: FirstLaunchStatus = { state: 'checking' };

  constructor(
    private logger: LoggingRepository,
    private appRepository: AppRepository,
    private configRepository: ConfigRepository,
    private databaseRepository: DatabaseRepository,
    private storageRepository: StorageRepository,
    private databaseBackupService: DatabaseBackupService,
  ) {
    this.logger.setContext(this.constructor.name);
  }

  getStatus(): FirstLaunchStatus {
    return this.#status;
  }

  protected firstLaunchBackup(): Pick<FirstLaunchBackup, 'run'> {
    return new FirstLaunchBackup(
      {
        logger: this.logger,
        database: this.databaseRepository,
        storage: this.storageRepository,
        config: this.configRepository,
      },
      this.databaseBackupService,
    );
  }

  async prepare(): Promise<void> {
    this.logger.log('Frameleaf is getting ready: checking whether this library needs a safety copy before upgrading');
    try {
      // Another server (or another container) taking the copy holds this lock; this one waits, then
      // finds that fresh copy and skips.
      const outcome = await this.databaseRepository.withLock(DatabaseLock.Migrations, () =>
        this.firstLaunchBackup().run({ onProgress: (state) => (this.#status = { state }) }),
      );
      switch (outcome.kind) {
        case 'not-needed': {
          this.handOver();
          break;
        }
        case 'skipped': {
          this.#status = { state: 'skipped', copy: 'skipped', backup: outcome.backup };
          setTimeout(() => this.handOver(), SKIPPED_NOTICE_MS);
          break;
        }
        case 'created': {
          this.#status = { state: 'done', copy: 'taken', backup: outcome.backup };
          setTimeout(() => this.handOver(), DONE_NOTICE_MS);
          break;
        }
      }
    } catch (error) {
      const reason: FirstLaunchFailureReason = error instanceof FirstLaunchBackupError ? error.reason : 'backup-failed';
      const space =
        error instanceof FirstLaunchBackupError && error.requiredBytes !== undefined
          ? { requiredBytes: error.requiredBytes, availableBytes: error.availableBytes }
          : {};
      this.#status = { state: 'failed', error: { reason, ...space } };
      this.logger.error(
        `Frameleaf could not make the safety copy, so nothing was upgraded and the official server can still use this library: ${error instanceof Error ? error.message : error}. ` +
          (reason === 'disk-space'
            ? 'Free up space where the library is stored (or move the backups folder to a larger disk), then restart Frameleaf.'
            : 'Check the messages above, then restart Frameleaf.') +
          ' It tries again at every start.',
      );
    }
  }

  private handOver() {
    this.#status = { ...this.#status, state: 'ready' };
    this.logger.log('Frameleaf is ready to upgrade the library; starting normally');
    this.appRepository.stop(ExitCode.FirstLaunchReady, RESTART_BUDGET);
  }

  /**
   * {@link _MaintenanceWorkerService.ssr}: the "Getting Ready…" screen for every page, its status for the
   * screen, and 503 with Retry-After for everything else. Static web files are served before this.
   */
  ssr(excludePaths: string[]) {
    const { resourcePaths } = this.configRepository.getEnv();

    let index = '';
    try {
      index = readFileSync(resourcePaths.web.indexHtml).toString();
    } catch {
      this.logger.warn(`Unable to open ${resourcePaths.web.indexHtml}, skipping SSR.`);
    }

    return (request: Request, res: Response, next: NextFunction) => {
      const method = request.method.toUpperCase();
      const isRead = method === 'GET' || method === 'HEAD';

      if (isRead && request.path === FIRST_LAUNCH_STATUS_PATH) {
        res.status(200).header('Cache-Control', 'no-store').json(this.getStatus());
        return;
      }

      if (isRead && request.path === '/favicon.ico') {
        return next();
      }

      if (
        !isRead ||
        request.path === '/api' ||
        request.path.startsWith('/api/') ||
        excludePaths.some((item) => request.path.startsWith(item))
      ) {
        res
          .status(503)
          .header('Retry-After', String(FIRST_LAUNCH_RETRY_AFTER_SECONDS))
          .header('Cache-Control', 'no-store')
          .json({ message: 'Frameleaf is getting ready. Try again shortly.', statusCode: 503 });
        return;
      }

      if (request.path === FIRST_LAUNCH_PAGE || request.path.startsWith(`${FIRST_LAUNCH_PAGE}/`)) {
        res.status(200).type('text/html').header('Cache-Control', 'no-store').send(index);
        return;
      }

      // An auth page keeps only its path, so a callback's one-time `code`/`state` is not copied.
      const params = new URLSearchParams({
        continue: request.path.startsWith('/auth/') ? request.path : request.originalUrl,
      });
      res.redirect(`${FIRST_LAUNCH_PAGE}?${params}`);
    };
  }
}
