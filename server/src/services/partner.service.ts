import { BadRequestException, Injectable } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Partner } from 'src/database.js';
import { PartnerCreateDto, PartnerResponseDto, PartnerSearchDto, PartnerUpdateDto } from 'src/dtos/partner.dto.js';
import { mapUser } from 'src/dtos/user.dto.js';
import { Permission, PushEventType } from 'src/enum.js';
import { PartnerDirection, PartnerIds } from 'src/repositories/partner.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { startPartnerBackfill, stopPartnerSharing } from 'src/services/partner-copy.service.js';

@Injectable()
export class PartnerService extends BaseService {
  async create(auth: AuthDto, { sharedWithId }: PartnerCreateDto): Promise<PartnerResponseDto> {
    const partnerId: PartnerIds = { sharedById: auth.user.id, sharedWithId };
    const exists = await this.partnerRepository.get(partnerId);
    if (exists) {
      throw new BadRequestException(`Partner already exists`);
    }

    const user = await this.userRepository.get(sharedWithId, {});
    if (!user) {
      this.logger.debug('Partner creation failed: user not found');
      throw new BadRequestException('Invalid user');
    }

    const partner = await this.partnerRepository.create(partnerId);
    // FL-326: the partner receives their own copies of this library
    await startPartnerBackfill(
      { partnerOrigin: this.partnerOriginRepository, job: this.jobRepository },
      auth.user.id,
      sharedWithId,
    );
    // FL-228: the new partner gained access to this library
    await this.eventRepository.emit('PushNotify', {
      type: PushEventType.AccessChanged,
      userIds: [sharedWithId],
      title: 'Access changed',
      body: `${auth.user.name} shared their library with you`,
      systemTemplate: { version: 1, key: 'partner-added', args: { senderName: auth.user.name } },
      data: { partnerId: auth.user.id, change: 'partner-added' },
    });
    return this.mapPartner(partner, PartnerDirection.SharedBy);
  }

  async remove(auth: AuthDto, sharedWithId: string): Promise<void> {
    const partnerId: PartnerIds = { sharedById: auth.user.id, sharedWithId };
    const partner = await this.partnerRepository.get(partnerId);
    if (!partner) {
      throw new BadRequestException('Partner not found');
    }

    await this.partnerRepository.remove(partnerId);
    // FL-326: the former partner keeps every copy received; following and new copies stop
    await stopPartnerSharing({ partnerOrigin: this.partnerOriginRepository }, auth.user.id, sharedWithId);

    // FL-54: revocation takes effect on open pages too. Access is always checked live on the server,
    // so this only tells the clients to drop what they already loaded (timeline months, the partner
    // page, an open viewer) instead of showing it until the next reload.
    for (const userId of [sharedWithId, auth.user.id]) {
      this.websocketRepository.clientSend('PartnerRevokeV1', userId, partnerId);
    }
    // FL-228: the former partner's access ended
    await this.eventRepository.emit('PushNotify', {
      type: PushEventType.AccessChanged,
      userIds: [sharedWithId],
      title: 'Access changed',
      body: `${auth.user.name} stopped sharing their library with you`,
      systemTemplate: { version: 1, key: 'partner-removed', args: { senderName: auth.user.name } },
      data: { partnerId: auth.user.id, change: 'partner-removed' },
    });
  }

  async search(auth: AuthDto, { direction }: PartnerSearchDto): Promise<PartnerResponseDto[]> {
    const partners = await this.partnerRepository.getAll(auth.user.id);
    const key = direction === PartnerDirection.SharedBy ? 'sharedById' : 'sharedWithId';
    const mine = partners
      .filter((partner): partner is Partner => !!(partner.sharedBy && partner.sharedWith)) // Filter out soft deleted users
      .filter((partner) => partner[key] === auth.user.id);
    // FL-326: how far the first copy of the library shared this way has come (the partner card)
    return Promise.all(
      mine.map(async (partner) => {
        const backfill = await this.partnerOriginRepository.getBackfill(partner.sharedById, partner.sharedWithId);
        return {
          ...this.mapPartner(partner, direction),
          backfill: backfill ? { state: backfill.state, total: backfill.total, done: backfill.done } : null,
        };
      }),
    );
  }

  /** FL-326: a partnership has no settings left; this answers the partner who shares with the caller. */
  async update(auth: AuthDto, partnerUserId: string, _dto: PartnerUpdateDto): Promise<PartnerResponseDto> {
    await this.requireAccess({ auth, permission: Permission.PartnerUpdate, ids: [partnerUserId] });
    const partner = await this.partnerRepository.get({ sharedById: partnerUserId, sharedWithId: auth.user.id });
    if (!partner?.sharedBy || !partner.sharedWith) {
      throw new BadRequestException('Partner not found');
    }
    return this.mapPartner(partner as Partner, PartnerDirection.SharedWith);
  }

  private mapPartner(partner: Partner, direction: PartnerDirection): PartnerResponseDto {
    // this is opposite to return the non-me user of the "partner"
    const sharedUser = direction === PartnerDirection.SharedBy ? partner.sharedWith : partner.sharedBy;
    return mapUser(sharedUser);
  }
}
