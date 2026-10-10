import { Injectable } from '@nestjs/common';
import type { ArgOf } from 'src/repositories/event.repository.js';
import { OnEvent } from 'src/decorators.js';
import {
  FrameleafSetupAdminDto,
  FrameleafSetupCodeDto,
  FrameleafSetupTicketResponseDto,
} from 'src/dtos/frameleaf-server-setup.dto.js';
import { UserAdminResponseDto, mapUserAdmin } from 'src/dtos/user.dto.js';
import { AdminAuditAction, ImmichWorker } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { readCloudLink } from 'src/utils/frameleaf-cloud-gateway.js';
import {
  type SetupClient,
  endSetup,
  issueSetupTicket,
  prepareSetup,
  withSetupProof,
} from 'src/utils/frameleaf-setup-gate.js';

/** FL-292: what an app on the network may know about a server's setup before it is signed in. */
export type ServerSetupState = {
  /** `needed` while the server has no administrator. */
  setup: 'needed' | 'complete';
  /** Whether the server can link to Frameleaf Cloud (`FRAMELEAF_CLOUD_URL` is set). */
  cloud: 'available' | 'unavailable';
  linked: boolean;
};

/**
 * Setting up a new server from the Frameleaf app (FL-292, NAPI-012). While the server has no
 * administrator it shows a setup code on its console and in its log (`frameleaf-setup-gate.ts`):
 *
 * - `POST server/setup/code`: the app sends the code from the home network and gets a short-lived,
 *   single-use setup ticket bound to its address;
 * - `POST server/setup/link` (FrameleafCloudService): with the ticket, a Frameleaf link token links
 *   the server, and the account that minted it becomes the owner; its first Sign in with Frameleaf
 *   creates the administrator;
 * - `POST server/setup/admin`: with the ticket, an administrator with email and password instead;
 * - the web first-run sign-up (`POST auth/admin-sign-up`) asks for the code itself.
 */
@Injectable()
export class FrameleafServerSetupService extends BaseService {
  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Api] })
  async onBootstrap() {
    await prepareSetup(this.setupGate);
  }

  /** The first administrator ends setup: the code stops working and is forgotten. */
  @OnEvent({ name: 'UserCreate' })
  async onUserCreate(user: ArgOf<'UserCreate'>) {
    if (user.isAdmin) {
      await endSetup(this.setupGate);
    }
  }

  async getState(): Promise<ServerSetupState> {
    const admin = await this.userRepository.getAdmin();
    const { cloudUrl, linked } = await readCloudLink({
      configRepository: this.configRepository,
      systemMetadataRepository: this.systemMetadataRepository,
    });
    return {
      setup: admin || !this.configRepository.getEnv().setup.allow ? 'complete' : 'needed',
      cloud: cloudUrl ? 'available' : 'unavailable',
      linked,
    };
  }

  /** `POST server/setup/code`. */
  issueTicket(dto: FrameleafSetupCodeDto, client: SetupClient): Promise<FrameleafSetupTicketResponseDto> {
    return issueSetupTicket(this.setupGate, dto.code, client);
  }

  /** `POST server/setup/admin`: the app's optional password administrator, with a setup ticket. */
  claimWithPassword(dto: FrameleafSetupAdminDto, client: SetupClient): Promise<UserAdminResponseDto> {
    return withSetupProof(this.setupGate, { ticket: dto.ticket, ticketOnly: true }, client, async () => {
      const admin = await this.createUser({
        isAdmin: true,
        email: dto.email,
        name: dto.name,
        password: dto.password,
        storageLabel: 'admin',
      });
      await this.recordAdminEvents([
        {
          userId: admin.id,
          actorId: admin.id,
          action: AdminAuditAction.AccountCreated,
          subject: admin.name,
          detail: 'server-claimed:app-password',
        },
      ]);
      this.logger.log(`This server was set up from the Frameleaf app (${client.ip}): ${admin.email} administers it`);
      return mapUserAdmin(admin);
    });
  }
}
