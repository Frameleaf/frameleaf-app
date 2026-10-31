import { Injectable } from '@nestjs/common';
import { FrameleafSetupAdminDto } from 'src/dtos/frameleaf-server-setup.dto.js';
import { UserAdminResponseDto, mapUserAdmin } from 'src/dtos/user.dto.js';
import { AdminAuditAction } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { readCloudLink } from 'src/utils/frameleaf-cloud-gateway.js';
import { type SetupClient, whileClaimable } from 'src/utils/frameleaf-setup-gate.js';

/** FL-292: what an app on the network may know about a server's setup before it is signed in. */
export type ServerSetupState = {
  /** `needed` while the server has no administrator. */
  setup: 'needed' | 'complete';
  /** Whether the server can link to Frameleaf Cloud (`FRAMELEAF_CLOUD_URL` is set). */
  cloud: 'available' | 'unavailable';
  linked: boolean;
};

/**
 * Setting up a new server from the Frameleaf app (FL-292, NAPI-012), from the home network while it
 * has no administrator (`frameleaf-setup-gate.ts`):
 *
 * - `POST server/setup/link` (FrameleafCloudService): a Frameleaf link token links the server, and
 *   the account that minted it becomes the owner; its first Sign in with Frameleaf creates the
 *   administrator;
 * - `POST server/setup/admin`: an administrator with email and password instead;
 * - the web first-run sign-up (`POST auth/admin-sign-up`) does the same as the password route.
 */
@Injectable()
export class FrameleafServerSetupService extends BaseService {
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

  /** `POST server/setup/admin`: the app's optional password administrator. */
  claimWithPassword(dto: FrameleafSetupAdminDto, client: SetupClient): Promise<UserAdminResponseDto> {
    return whileClaimable(this.setupGate, client, async () => {
      const admin = await this.createUser({
        isAdmin: true,
        email: dto.email,
        name: dto.name,
        password: dto.password,
        // The administrator chose this password themselves: there is nothing to change at first sign-in.
        shouldChangePassword: false,
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
