import { Injectable } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { UserMetadata, UserMetadataItem } from 'src/types.js';
import { PartnerLockedNoticeResponseDto } from 'src/dtos/partner-locked-notice.dto.js';
import { UserMetadataKey } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';

type NoticeRecord = UserMetadata[UserMetadataKey.PartnerLockedNotice];

/**
 * FL-326 (spec §4.9): Locked items a partner shares arrive as the recipient's own locked copies, which only
 * the recipient's PIN unlocks. An account without a PIN cannot open its Locked view, so those copies stay
 * hidden and the account gets a one-time notice offering to set one. The flag is a user metadata row: it
 * is written once, when the first locked copy reaches an account with no PIN, and dismissing it is final.
 */
@Injectable()
export class PartnerLockedNoticeService extends BaseService {
  async getNotice(auth: AuthDto): Promise<PartnerLockedNoticeResponseDto> {
    const record = await this.readRecord(auth.user.id);
    if (!record) {
      return { show: false, flaggedAt: null };
    }
    const hasPin = await this.userRepository.hasPinCode(auth.user.id);
    return { show: !record.dismissedAt && !hasPin, flaggedAt: record.flaggedAt };
  }

  async dismiss(auth: AuthDto): Promise<PartnerLockedNoticeResponseDto> {
    const record = await this.readRecord(auth.user.id);
    if (record && !record.dismissedAt) {
      await this.userRepository.upsertMetadata(auth.user.id, {
        key: UserMetadataKey.PartnerLockedNotice,
        value: { ...record, dismissedAt: new Date().toISOString() },
      });
    }
    return this.getNotice(auth);
  }

  /**
   * Called by the partner copy engine after it creates a locked copy for `ownerId`. Flags the notice the
   * first time only, and never for an account that has a PIN. Returns whether it flagged it now.
   */
  async noteLockedCopy(ownerId: string): Promise<boolean> {
    if (await this.readRecord(ownerId)) {
      return false;
    }
    if (await this.userRepository.hasPinCode(ownerId)) {
      return false;
    }
    await this.userRepository.upsertMetadata(ownerId, {
      key: UserMetadataKey.PartnerLockedNotice,
      value: { flaggedAt: new Date().toISOString(), dismissedAt: null },
    });
    return true;
  }

  private async readRecord(userId: string): Promise<NoticeRecord | null> {
    const metadata = await this.userRepository.getMetadata(userId);
    const item = metadata.find(
      (item): item is UserMetadataItem<UserMetadataKey.PartnerLockedNotice> =>
        item.key === UserMetadataKey.PartnerLockedNotice,
    );
    return item?.value ?? null;
  }
}
