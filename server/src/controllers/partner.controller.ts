import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { PartnerLockedNoticeResponseDto } from 'src/dtos/partner-locked-notice.dto.js';
import { PartnerCreateDto, PartnerResponseDto, PartnerSearchDto, PartnerUpdateDto } from 'src/dtos/partner.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { PartnerLockedNoticeService } from 'src/services/partner-locked-notice.service.js';
import { PartnerService } from 'src/services/partner.service.js';
import { UUIDParamDto } from 'src/validation.js';

@ApiTags(ApiTag.Partners)
@Controller('partners')
export class PartnerController {
  constructor(
    private service: PartnerService,
    private lockedNoticeService: PartnerLockedNoticeService,
  ) {}

  // Declared before the `:id` routes so `locked-notice` is never read as a partner id.
  @Get('locked-notice')
  @Authenticated({ permission: Permission.PartnerRead })
  @Endpoint({
    summary: 'Get the Locked partner items notice',
    description:
      'Whether to show the one-time notice that Locked items arrived from a partner and stay hidden until you set a PIN.',
    history: new HistoryBuilder().added('v2'),
  })
  getPartnerLockedNotice(@Auth() auth: AuthDto): Promise<PartnerLockedNoticeResponseDto> {
    return this.lockedNoticeService.getNotice(auth);
  }

  @Put('locked-notice')
  @Authenticated({ permission: Permission.PartnerUpdate })
  @Endpoint({
    summary: 'Dismiss the Locked partner items notice',
    description: 'Dismisses the one-time notice about Locked partner items for good. The items stay locked.',
    history: new HistoryBuilder().added('v2'),
  })
  dismissPartnerLockedNotice(@Auth() auth: AuthDto): Promise<PartnerLockedNoticeResponseDto> {
    return this.lockedNoticeService.dismiss(auth);
  }

  @Get()
  @Authenticated({ permission: Permission.PartnerRead })
  @Endpoint({
    summary: 'Retrieve partners',
    description: 'Retrieve a list of partners with whom assets are shared.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getPartners(@Auth() auth: AuthDto, @Query() dto: PartnerSearchDto): Promise<PartnerResponseDto[]> {
    return this.service.search(auth, dto);
  }

  @Post()
  @Authenticated({ permission: Permission.PartnerCreate })
  @Endpoint({
    summary: 'Create a partner',
    description: 'Create a new partner to share assets with.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  createPartner(@Auth() auth: AuthDto, @Body() dto: PartnerCreateDto): Promise<PartnerResponseDto> {
    return this.service.create(auth, dto);
  }

  @Post(':id')
  @Endpoint({
    summary: 'Create a partner',
    description: 'Create a new partner to share assets with.',
    history: new HistoryBuilder().added('v1').deprecated('v1', { replacementId: 'createPartner' }),
  })
  @Authenticated({ permission: Permission.PartnerCreate })
  createPartnerDeprecated(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<PartnerResponseDto> {
    return this.service.create(auth, { sharedWithId: id });
  }

  @Put(':id')
  @Authenticated({ permission: Permission.PartnerUpdate })
  @Endpoint({
    summary: 'Update a partner',
    description:
      'A partnership has no settings left (FL-326): partners receive their own copies and locations are always shared. Kept for older clients; returns the partner who shares with the user.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  updatePartner(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: PartnerUpdateDto,
  ): Promise<PartnerResponseDto> {
    return this.service.update(auth, id, dto);
  }

  @Delete(':id')
  @Authenticated({ permission: Permission.PartnerDelete })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Remove a partner',
    description: 'Stop sharing assets with a partner.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  removePartner(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.remove(auth, id);
  }
}
