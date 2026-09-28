import { BadRequestException, Injectable } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Partner } from 'src/database.js';
import { PartnerCreateDto, PartnerResponseDto, PartnerSearchDto, PartnerUpdateDto } from 'src/dtos/partner.dto.js';
import { mapUser } from 'src/dtos/user.dto.js';
import { Permission } from 'src/enum.js';
import { PartnerDirection, PartnerIds } from 'src/repositories/partner.repository.js';
import { BaseService } from 'src/services/base.service.js';

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
    return this.mapPartner(partner, PartnerDirection.SharedBy);
  }

  async remove(auth: AuthDto, sharedWithId: string): Promise<void> {
    const partnerId: PartnerIds = { sharedById: auth.user.id, sharedWithId };
    const partner = await this.partnerRepository.get(partnerId);
    if (!partner) {
      throw new BadRequestException('Partner not found');
    }

    await this.partnerRepository.remove(partnerId);

    // FL-54: revocation takes effect on open pages too. Access is always checked live on the server,
    // so this only tells the clients to drop what they already loaded (timeline months, the partner
    // page, an open viewer) instead of showing it until the next reload.
    for (const userId of [sharedWithId, auth.user.id]) {
      this.websocketRepository.clientSend('PartnerRevokeV1', userId, partnerId);
    }
  }

  async search(auth: AuthDto, { direction }: PartnerSearchDto): Promise<PartnerResponseDto[]> {
    const partners = await this.partnerRepository.getAll(auth.user.id);
    const key = direction === PartnerDirection.SharedBy ? 'sharedById' : 'sharedWithId';
    return partners
      .filter((partner): partner is Partner => !!(partner.sharedBy && partner.sharedWith)) // Filter out soft deleted users
      .filter((partner) => partner[key] === auth.user.id)
      .map((partner) => this.mapPartner(partner, direction));
  }

  async update(auth: AuthDto, partnerUserId: string, dto: PartnerUpdateDto): Promise<PartnerResponseDto> {
    const hasInTimeline = dto.inTimeline !== undefined;
    const hasShareLocation = dto.shareLocation !== undefined;
    if (hasInTimeline === hasShareLocation) {
      throw new BadRequestException('Specify exactly one of inTimeline or shareLocation');
    }

    if (hasInTimeline) {
      // recipient preference: the partner identified by `:id` shares with me
      await this.requireAccess({ auth, permission: Permission.PartnerUpdate, ids: [partnerUserId] });
      const partnerId: PartnerIds = { sharedById: partnerUserId, sharedWithId: auth.user.id };

      const entity = await this.partnerRepository.update(partnerId, { inTimeline: dto.inTimeline });
      return this.mapPartner(entity, PartnerDirection.SharedWith);
    }

    // sharer setting: I share with the partner identified by `:id`; only the row owned by the caller
    // as `sharedById` can be changed, so the recipient can never grant themselves location access
    const partnerId: PartnerIds = { sharedById: auth.user.id, sharedWithId: partnerUserId };
    const partner = await this.partnerRepository.get(partnerId);
    if (!partner) {
      throw new BadRequestException('Partner not found');
    }

    const entity = await this.partnerRepository.update(partnerId, { shareLocation: dto.shareLocation });
    return this.mapPartner(entity, PartnerDirection.SharedBy);
  }

  private mapPartner(partner: Partner, direction: PartnerDirection): PartnerResponseDto {
    // this is opposite to return the non-me user of the "partner"
    const sharedUser = direction === PartnerDirection.SharedBy ? partner.sharedWith : partner.sharedBy;
    const user = mapUser(sharedUser);

    return { ...user, inTimeline: partner.inTimeline, shareLocation: partner.shareLocation };
  }
}
