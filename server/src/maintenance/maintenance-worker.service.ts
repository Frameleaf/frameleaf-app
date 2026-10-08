import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { parse } from 'cookie';
import { NextFunction, Request, Response } from 'express';
import { jwtVerify } from 'jose';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { IncomingHttpHeaders } from 'node:http';
import { dirname } from 'node:path';
import type { MaintenanceModeState } from 'src/types.js';
import { serverVersion } from 'src/constants.js';
import { StorageCore } from 'src/cores/storage.core.js';
import {
  MaintenanceAuthDto,
  MaintenanceDetectInstallResponseDto,
  MaintenanceStatusResponseDto,
  SetMaintenanceModeDto,
} from 'src/dtos/maintenance.dto.js';
import { ServerConfigDto, ServerPingResponse, ServerVersionResponseDto } from 'src/dtos/server.dto.js';
import { DatabaseLock, ImmichCookie, MaintenanceAction, SystemMetadataKey } from 'src/enum.js';
import { MaintenanceHealthRepository } from 'src/maintenance/maintenance-health.repository.js';
import { MaintenanceWebsocketRepository } from 'src/maintenance/maintenance-websocket.repository.js';
import { AppRepository } from 'src/repositories/app.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository, type HeldLock } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { ProcessRepository } from 'src/repositories/process.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { type ApiService as _ApiService } from 'src/services/api.service.js';
import { type BaseService as _BaseService } from 'src/services/base.service.js';
import { BuddyBackupRecoveryService } from 'src/services/buddy-backup-recovery.service.js';
import { DatabaseBackupService, type DatabaseRestoreFence } from 'src/services/database-backup.service.js';
import { type ServerService as _ServerService } from 'src/services/server.service.js';
import { type VersionService as _VersionService } from 'src/services/version.service.js';
import { buddyMaintenancePath, buddyMaintenanceState } from 'src/utils/buddy-backup-maintenance.js';
import { flushBuddyDirectory } from 'src/utils/buddy-backup-vault.js';
import { getConfig } from 'src/utils/config.js';
import { createMaintenanceLoginUrl, detectPriorInstall, maintenanceLoginHint } from 'src/utils/maintenance.js';
import { discoverMediaLocation } from 'src/utils/media-location.js';
import { resolvePublicUrl } from 'src/utils/public-url.js';

/**
 * This service is available inside of maintenance mode to manage maintenance mode
 */
@Injectable()
export class MaintenanceWorkerService {
  #secret: string | null = null;
  /** FL-81: the administrator's public reason, carried on every status this worker reports */
  #reason: string | undefined;
  /**
   * FL-81: set when a restore is accepted or resumed on start, and cleared when it fails (a successful
   * restore ends maintenance, which restarts the worker), so no other action can start meanwhile.
   */
  #restoring = false;
  #status: MaintenanceStatusResponseDto = {
    active: true,
    action: MaintenanceAction.Start,
  };

  constructor(
    protected logger: LoggingRepository,
    private appRepository: AppRepository,
    private configRepository: ConfigRepository,
    private systemMetadataRepository: SystemMetadataRepository,
    private maintenanceWebsocketRepository: MaintenanceWebsocketRepository,
    private maintenanceHealthRepository: MaintenanceHealthRepository,
    private storageRepository: StorageRepository,
    private processRepository: ProcessRepository,
    private databaseRepository: DatabaseRepository,
    private databaseBackupService: DatabaseBackupService,
    private buddyRecovery: BuddyBackupRecoveryService,
  ) {
    this.logger.setContext(this.constructor.name);
  }

  mock(status: MaintenanceStatusResponseDto) {
    this.#secret = 'secret';
    this.#status = status;
  }

  async init() {
    const state = ((await buddyMaintenanceState(this.configRepository)) ??
      (await this.systemMetadataRepository.get(SystemMetadataKey.MaintenanceMode))) as MaintenanceModeState & {
      isMaintenanceMode: true;
    };

    this.#secret = state.secret;
    this.#reason = state.action?.reason ?? undefined;
    this.#status = {
      active: true,
      action: state.action?.action ?? MaintenanceAction.Start,
    };

    StorageCore.setMediaLocation(this.detectMediaLocation());

    this.maintenanceWebsocketRepository.setAuthFn(async (client) => this.authenticate(client.request.headers));
    this.maintenanceWebsocketRepository.setStatusUpdateFn((status) => {
      this.#status = status;
      // another server's status always carries its reason, so a missing one was cleared there
      this.#reason = status.reason;
    });

    await this.logSecret();

    if (state.action) {
      void this.runAction(state.action);
    }
  }

  /**
   * {@link _BaseService.configRepos}
   */
  private get configRepos() {
    return {
      configRepo: this.configRepository,
      metadataRepo: this.systemMetadataRepository,
      logger: this.logger,
    };
  }

  /**
   * {@link _BaseService.prototype.getConfig}
   */
  private getConfig(options: { withCache: boolean }) {
    return getConfig(this.configRepos, options);
  }

  /**
   * {@link _ServerService.getSystemConfig}
   */
  getSystemConfig() {
    return {
      maintenanceMode: true,
    } as ServerConfigDto;
  }

  /**
   * {@link _VersionService.getVersion}
   */
  getVersion() {
    return ServerVersionResponseDto.fromSemVer(serverVersion);
  }

  ping(): ServerPingResponse {
    // FL-229: identity during maintenance mode is intentionally static, not a real cloud/local id -
    // the database this worker's normal identity would come from may itself be mid-restore, so
    // nothing here claims a persisted identity it cannot safely read.
    // FL-292: a server in maintenance cannot be set up or linked from the app
    return {
      res: 'pong',
      id: 'maintenance',
      linked: false,
      name: 'Frameleaf server (maintenance mode)',
      setup: 'complete',
      cloud: 'unavailable',
    };
  }

  /**
   * {@link _ApiService.ssr}
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
      if (
        request.url.startsWith('/api') ||
        request.method.toLowerCase() !== 'get' ||
        excludePaths.some((item) => request.url.startsWith(item))
      ) {
        return next();
      }

      const maintenancePath = '/maintenance';
      if (!request.url.startsWith(maintenancePath)) {
        const params = new URLSearchParams();
        // The whole address, query included: Command Center sections live in the query
        // (`/user-settings?area=maintenance&section=backups`); the web page checks it is same-origin.
        // An auth page keeps only its path, so a callback's one-time `code`/`state` is not copied.
        params.set('continue', request.path.startsWith('/auth/') ? request.path : request.originalUrl);
        return res.redirect(`${maintenancePath}?${params}`);
      }

      res.status(200).type('text/html').header('Cache-Control', 'no-store').send(index);
    };
  }

  /**
   * {@link _StorageService.detectMediaLocation}
   */
  detectMediaLocation(): string {
    return discoverMediaLocation(this.configRepository.getEnv().storage.mediaLocation, (path) =>
      this.storageRepository.existsSync(path),
    );
  }

  private get secret() {
    if (!this.#secret) {
      throw new Error('Secret is not initialised yet.');
    }

    return this.#secret;
  }

  private get backupRepos() {
    return {
      logger: this.logger,
      storage: this.storageRepository,
      config: this.configRepository,
      process: this.processRepository,
      database: this.databaseRepository,
      health: this.maintenanceHealthRepository,
    };
  }

  private getStatus(): MaintenanceStatusResponseDto {
    return this.withReason(this.#status);
  }

  private getPublicStatus(): MaintenanceStatusResponseDto {
    const state = structuredClone(this.withReason(this.#status));

    if (state.error) {
      state.error = 'Something went wrong, see logs!';
    }

    return state;
  }

  private withReason(status: MaintenanceStatusResponseDto): MaintenanceStatusResponseDto {
    return this.#reason === undefined ? status : { ...status, reason: this.#reason };
  }

  setStatus(status: MaintenanceStatusResponseDto): void {
    this.#status = status;
    this.maintenanceWebsocketRepository.serverSend('MaintenanceStatus', this.getStatus());
    this.maintenanceWebsocketRepository.clientSend('MaintenanceStatusV1', 'private', this.getStatus());
    this.maintenanceWebsocketRepository.clientSend('MaintenanceStatusV1', 'public', this.getPublicStatus());
  }

  async logSecret(): Promise<void> {
    const { server } = await this.getConfig({ withCache: true });

    const baseUrl = await resolvePublicUrl(server, {
      configRepository: this.configRepository,
      systemMetadataRepository: this.systemMetadataRepository,
    });
    const url = await createMaintenanceLoginUrl(
      baseUrl,
      {
        username: 'frameleaf-admin',
      },
      this.secret,
    );

    this.logger.log(`\n\n🚧 Frameleaf is in maintenance mode. ${maintenanceLoginHint(url)}:\n${url}\n`);
  }

  async authenticate(headers: IncomingHttpHeaders): Promise<MaintenanceAuthDto> {
    const jwtToken = parse(headers.cookie || '')[ImmichCookie.MaintenanceToken];
    return this.login(jwtToken);
  }

  async status(potentiallyJwt?: string): Promise<MaintenanceStatusResponseDto> {
    try {
      await this.login(potentiallyJwt);
      return this.getStatus();
    } catch {
      return this.getPublicStatus();
    }
  }

  detectPriorInstall(): Promise<MaintenanceDetectInstallResponseDto> {
    return detectPriorInstall(this.storageRepository);
  }

  async login(jwt?: string): Promise<MaintenanceAuthDto> {
    if (!jwt) {
      throw new UnauthorizedException('Missing JWT Token');
    }

    try {
      const result = await jwtVerify<MaintenanceAuthDto>(jwt, new TextEncoder().encode(this.secret));
      return result.payload;
    } catch {
      throw new UnauthorizedException('Invalid JWT Token');
    }
  }

  /**
   * FL-81: refuses, before anything changes, an action that would conflict with a running restore:
   * a second restore, a new Start or restore selection, or End (which would restart the worker in
   * the middle of the restore). A restore that failed has cleared the flag, so End and another restore
   * stay available as the safe exit. Called synchronously by the controller, which then runs the action
   * without waiting for it.
   */
  claimAction(action: SetMaintenanceModeDto): void {
    // this worker's own restore, or one another server reports running (its status has no error yet)
    const reportedRestore = this.#status.action === MaintenanceAction.RestoreDatabase && this.#status.task !== 'error';
    if (this.#restoring || reportedRestore) {
      throw new ConflictException('A database restore is running. Wait until it finishes or fails.');
    }
    if (action.action === MaintenanceAction.RestoreDatabase) {
      this.#restoring = true;
    }
  }

  async setAction(action: SetMaintenanceModeDto) {
    // a new reason replaces the old one, null (or a blank one) clears it, and an action without one keeps it
    if (action.reason !== undefined) {
      this.#reason = action.reason ?? undefined;
      // kept with the maintenance state so a restart shows the same reason (a restore rewrites it itself)
      if (action.action === MaintenanceAction.Start || action.action === MaintenanceAction.SelectDatabaseRestore) {
        await this.systemMetadataRepository.set(SystemMetadataKey.MaintenanceMode, {
          isMaintenanceMode: true,
          secret: this.secret,
          action: { action: action.action, reason: this.#reason },
        });
      }
    }
    this.setStatus({
      active: true,
      action: action.action,
    });

    await this.runAction(action);
  }

  async runAction(action: SetMaintenanceModeDto) {
    switch (action.action) {
      case MaintenanceAction.Start:
      case MaintenanceAction.SelectDatabaseRestore: {
        return;
      }
      case MaintenanceAction.End: {
        return this.endMaintenance();
      }
      case MaintenanceAction.RestoreDatabase: {
        return this.runRestoreDatabase(action);
      }
    }
  }

  async runRestoreDatabase(action: SetMaintenanceModeDto) {
    // also set here, before the first await, for a restore resumed from the stored state on start
    this.#restoring = true;
    let held: HeldLock | null = null;
    let failure: string | undefined;
    const assert = async () => {
      if (!held || !(await held.verify()))
        throw new Error('Recovery lost its maintenance lock; retry in maintenance mode');
    };
    try {
      held = await this.databaseRepository.holdLock(DatabaseLock.MaintenanceOperation);
      if (!held) {
        return;
      }
      this.logger.log(`Running maintenance action ${action.action}`);
      await assert();
      await this.systemMetadataRepository.set(SystemMetadataKey.MaintenanceMode, {
        isMaintenanceMode: true,
        secret: this.secret,
        action: {
          action: MaintenanceAction.Start,
          reason: this.#reason,
        },
      });

      if (action.buddyRecoveryId) {
        const maintenance = { isMaintenanceMode: true as const, secret: this.secret, action };
        if (action.restoreBackupFilename) {
          await this.buddyRecovery.restore(
            action.buddyRecoveryId,
            () =>
              this.databaseBackupService.restoreDatabaseBackup(
                action.restoreBackupFilename!,
                (task, progress) => this.setStatus({ active: true, action: action.action, task, progress }),
                { keepSafetyBackup: true, fence: { backendPid: held!.backendPid, assert } },
              ),
            maintenance,
            assert,
          );
        } else {
          await this.buddyRecovery.settings(action.buddyRecoveryId, assert);
        }
        await assert();
        await this.systemMetadataRepository.set(SystemMetadataKey.MaintenanceMode, {
          isMaintenanceMode: true,
          secret: this.secret,
          action: { action: MaintenanceAction.Start },
        });
        await assert();
        await rm(buddyMaintenancePath(this.configRepository));
        await flushBuddyDirectory(dirname(buddyMaintenancePath(this.configRepository)));
        await this.setAction({ action: MaintenanceAction.End });
        return;
      }
      if (!action.restoreBackupFilename) {
        throw new Error("Expected restoreBackupFilename but it's missing!");
      }

      await this.restoreBackup(action.restoreBackupFilename, action.keepSafetyBackup !== false, {
        backendPid: held.backendPid,
        assert,
      });
    } catch (error) {
      this.logger.error(`Encountered error running action: ${error}`);
      failure = '' + error;
    } finally {
      try {
        await held?.release();
      } finally {
        this.#restoring = false;
        // A terminal error permits End; publish it only after the restore reservation has settled.
        if (failure !== undefined) {
          this.setStatus({ active: true, action: action.action, task: 'error', error: failure });
        }
      }
    }
  }

  private async restoreBackup(filename: string, keepSafetyBackup: boolean, fence: DatabaseRestoreFence): Promise<void> {
    this.setStatus({
      active: true,
      action: MaintenanceAction.RestoreDatabase,
      task: 'ready',
      progress: 0,
    });

    await this.databaseBackupService.restoreDatabaseBackup(
      filename,
      (task, progress) =>
        this.setStatus({
          active: true,
          action: MaintenanceAction.RestoreDatabase,
          progress,
          task,
        }),
      { keepSafetyBackup, fence },
    );

    await fence.assert();
    await this.setAction({
      action: MaintenanceAction.End,
    });
  }

  private async endMaintenance(): Promise<void> {
    if (await buddyMaintenanceState(this.configRepository))
      throw new ConflictException('Finish the staged Buddy recovery before reopening this server.');
    const state: MaintenanceModeState = { isMaintenanceMode: false as const };
    await this.systemMetadataRepository.set(SystemMetadataKey.MaintenanceMode, state);

    // => corresponds to notification.service.ts#onAppRestart
    this.maintenanceWebsocketRepository.clientBroadcast('AppRestartV1', state);
    this.maintenanceWebsocketRepository.serverSend('AppRestart', state);
    this.appRepository.exitApp();
  }
}
