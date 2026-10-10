import { Injectable } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { UserMetadata, UserMetadataItem } from 'src/types.js';
import { CloudTourResponseDto, CloudTourSeenDto } from 'src/dtos/frameleaf-cloud.dto.js';
import { SystemMetadataKey, UserMetadataKey } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { readCloudLink } from 'src/utils/frameleaf-cloud-gateway.js';

type TourRecord = UserMetadata[UserMetadataKey.FrameleafCloudTour];

/**
 * FL-196: the linked-server tour an administrator sees once after this server is linked to a
 * Frameleaf account outside first-run setup (design/frameleaf/template/src/cloud-tour.mjs, c4a009f8b5).
 * "Seen" belongs to the account, not the browser: it is a user metadata row, and the first ending is
 * kept. The tour's status chips read what this server already holds (settings, the last AI Wallet read,
 * the cloud backup record); nothing here contacts Frameleaf Cloud.
 */
@Injectable()
export class FrameleafCloudTourService extends BaseService {
  async getTour(auth: AuthDto): Promise<CloudTourResponseDto> {
    const [record, link, config, wallet, backup] = await Promise.all([
      this.readRecord(auth.user.id),
      readCloudLink({
        configRepository: this.configRepository,
        systemMetadataRepository: this.systemMetadataRepository,
      }),
      this.getConfig({ withCache: false }),
      this.systemMetadataRepository.get(SystemMetadataKey.FrameleafMlWallet),
      this.systemMetadataRepository.get(SystemMetadataKey.FrameleafCloudBackup),
    ]);
    const { remoteAccess, cloudMl, cloudBackup } = config.frameleafCloud;
    return {
      seen: !!record,
      seenAt: record?.seenAt ?? null,
      ending: record?.ending ?? null,
      offer: link.linked && !record,
      customHostnameVerified: !!remoteAccess.customHostname.host && remoteAccess.customHostname.status === 'verified',
      processingEnabled: cloudMl.enabled,
      walletAvailableUsd: wallet ? Math.max(0, wallet.balanceUsd - wallet.heldUsd) : null,
      // as the cloud backup section counts it, without refreshing managed usage from the cloud
      backupConfigured: !!backup && cloudBackup.enabled && cloudBackup.target !== 'off',
    };
  }

  /** Records the first way this administrator ended the tour; a later ending (a reopened tour) keeps it. */
  async markSeen(auth: AuthDto, dto: CloudTourSeenDto): Promise<CloudTourResponseDto> {
    if (!(await this.readRecord(auth.user.id))) {
      await this.userRepository.upsertMetadata(auth.user.id, {
        key: UserMetadataKey.FrameleafCloudTour,
        value: { seenAt: new Date().toISOString(), ending: dto.ending },
      });
    }
    return this.getTour(auth);
  }

  private async readRecord(userId: string): Promise<TourRecord | null> {
    const metadata = await this.userRepository.getMetadata(userId);
    const item = metadata.find(
      (item): item is UserMetadataItem<UserMetadataKey.FrameleafCloudTour> =>
        item.key === UserMetadataKey.FrameleafCloudTour,
    );
    return item?.value ?? null;
  }
}
