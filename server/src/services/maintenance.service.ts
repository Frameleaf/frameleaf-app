import { Injectable } from '@nestjs/common';
import type { FrameleafSetupCodeDto } from 'src/dtos/frameleaf-server-setup.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { MaintenanceModeState } from 'src/types.js';
import { OnEvent } from 'src/decorators.js';
import {
  MaintenanceAuthDto,
  MaintenanceDetectInstallResponseDto,
  MaintenanceStatusResponseDto,
  SetMaintenanceModeDto,
} from 'src/dtos/maintenance.dto.js';
import { MaintenanceAction, SystemMetadataKey } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { buddyMaintenancePath } from 'src/utils/buddy-backup-maintenance.js';
import { writeBuddyFile } from 'src/utils/buddy-backup-vault.js';
import { type SetupClient, withSetupProof } from 'src/utils/frameleaf-setup-gate.js';
import {
  createMaintenanceLoginUrl,
  detectPriorInstall,
  generateMaintenanceSecret,
  signMaintenanceJwt,
} from 'src/utils/maintenance.js';

/**
 * This service is available outside of maintenance mode to manage maintenance mode
 */
@Injectable()
export class MaintenanceService extends BaseService {
  getMaintenanceMode(): Promise<MaintenanceModeState> {
    return this.systemMetadataRepository
      .get(SystemMetadataKey.MaintenanceMode)

      .then((state) => state ?? { isMaintenanceMode: false });
  }

  getMaintenanceStatus(): MaintenanceStatusResponseDto {
    return {
      active: false,
      action: MaintenanceAction.End,
    };
  }

  detectPriorInstall(): Promise<MaintenanceDetectInstallResponseDto> {
    return detectPriorInstall(this.storageRepository);
  }

  async startMaintenance(action: SetMaintenanceModeDto, username: string): Promise<{ jwt: string }> {
    const secret = generateMaintenanceSecret();
    if (action.buddyRecoveryId) {
      await writeBuddyFile(
        buddyMaintenancePath(this.configRepository),
        JSON.stringify({ isMaintenanceMode: true, secret, action }),
      );
    }
    await this.systemMetadataRepository.set(SystemMetadataKey.MaintenanceMode, {
      isMaintenanceMode: true,
      secret,
      action,
    });

    await this.eventRepository.emit('AppRestart', { isMaintenanceMode: true });

    return {
      jwt: await signMaintenanceJwt(secret, {
        username,
      }),
    };
  }

  async startRestoreFlow(dto: FrameleafSetupCodeDto, client: SetupClient): Promise<{ jwt: string }> {
    return withSetupProof(this.setupGate, { code: dto.code }, client, () =>
      this.startMaintenance(
        {
          action: MaintenanceAction.SelectDatabaseRestore,
        },
        'admin',
      ),
    );
  }

  @OnEvent({ name: 'AppRestart', server: true, priority: 100 })
  async onRestart(event: ArgOf<'AppRestart'>, ack?: (ok: 'ok') => void): Promise<void> {
    this.logger.log(`Restarting due to event... ${JSON.stringify(event)}`);

    await this.websocketRepository.acknowledgeRestart(ack);
    this.appRepository.exitApp();
  }

  async createLoginUrl(auth: MaintenanceAuthDto, secret?: string): Promise<string> {
    const { server } = await this.getConfig({ withCache: true });
    const baseUrl = await this.getPublicUrl(server);

    if (!secret) {
      const state = await this.getMaintenanceMode();
      if (!state.isMaintenanceMode) {
        throw new Error('Not in maintenance mode');
      }

      secret = state.secret;
    }

    return await createMaintenanceLoginUrl(baseUrl, auth, secret);
  }
}
