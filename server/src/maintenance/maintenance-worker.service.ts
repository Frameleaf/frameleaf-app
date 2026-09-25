import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { parse } from 'cookie';
import { NextFunction, Request, Response } from 'express';
import { jwtVerify } from 'jose';
import { readFileSync } from 'node:fs';
import { IncomingHttpHeaders } from 'node:http';
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
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { ProcessRepository } from 'src/repositories/process.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { type ApiService as _ApiService } from 'src/services/api.service.js';
import { type BaseService as _BaseService } from 'src/services/base.service.js';
import { DatabaseBackupService } from 'src/services/database-backup.service.js';
import { type ServerService as _ServerService } from 'src/services/server.service.js';
import { type VersionService as _VersionService } from 'src/services/version.service.js';
import { getConfig } from 'src/utils/config.js';
import { createMaintenanceLoginUrl, detectPriorInstall } from 'src/utils/maintenance.js';
import { getExternalDomain } from 'src/utils/misc.js';

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
  ) {
    this.logger.setContext(this.constructor.name);
  }

  mock(status: MaintenanceStatusResponseDto) {
    this.#secret = 'secret';
    this.#status = status;
  }

  async init() {
    const state = (await this.systemMetadataRepository.get(
      SystemMetadataKey.MaintenanceMode,
    )) as MaintenanceModeState & { isMaintenanceMode: true };

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
    return { res: 'pong' };
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
    const envData = this.configRepository.getEnv();
    if (envData.storage.mediaLocation) {
      return envData.storage.mediaLocation;
    }

    const targets: string[] = [];
    const candidates = ['/data', '/usr/src/app/upload'];

    for (const candidate of candidates) {
      const isExists = this.storageRepository.existsSync(candidate);
      if (isExists) {
        targets.push(candidate);
      }
    }

    if (targets.length === 1) {
      return targets[0];
    }

    return '/usr/src/app/upload';
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

    const baseUrl = getExternalDomain(server);
    const url = await createMaintenanceLoginUrl(
      baseUrl,
      {
        username: 'immich-admin',
      },
      this.secret,
    );

    this.logger.log(`\n\n🚧 Immich is in maintenance mode, you can log in using the following URL:\n${url}\n`);
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
    const isLock = await this.databaseRepository.tryLock(DatabaseLock.MaintenanceOperation);
    if (!isLock) {
      // another process holds the maintenance lock; the claim is released so this worker is not stuck
      this.#restoring = false;
      return;
    }

    this.logger.log(`Running maintenance action ${action.action}`);

    await this.systemMetadataRepository.set(SystemMetadataKey.MaintenanceMode, {
      isMaintenanceMode: true,
      secret: this.secret,
      action: {
        action: MaintenanceAction.Start,
        reason: this.#reason,
      },
    });

    try {
      if (!action.restoreBackupFilename) {
        throw new Error("Expected restoreBackupFilename but it's missing!");
      }

      await this.restoreBackup(action.restoreBackupFilename, action.keepSafetyBackup !== false);
    } catch (error) {
      this.logger.error(`Encountered error running action: ${error}`);
      this.setStatus({
        active: true,
        action: action.action,
        task: 'error',
        error: '' + error,
      });
    } finally {
      this.#restoring = false;
    }
  }

  private async restoreBackup(filename: string, keepSafetyBackup: boolean): Promise<void> {
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
      { keepSafetyBackup },
    );

    await this.setAction({
      action: MaintenanceAction.End,
    });
  }

  private async endMaintenance(): Promise<void> {
    const state: MaintenanceModeState = { isMaintenanceMode: false as const };
    await this.systemMetadataRepository.set(SystemMetadataKey.MaintenanceMode, state);

    // => corresponds to notification.service.ts#onAppRestart
    this.maintenanceWebsocketRepository.clientBroadcast('AppRestartV1', state);
    this.maintenanceWebsocketRepository.serverSend('AppRestart', state);
    this.appRepository.exitApp();
  }
}
