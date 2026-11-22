import { Body, Controller, Delete, Get, Header, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  HouseholdInvitationAcceptDto,
  HouseholdInvitationCodeParamDto,
  HouseholdInvitationDto,
  HouseholdInvitationPreviewDto,
  HouseholdLinkDto,
  HouseholdLinkUpdateDto,
} from 'src/dtos/household-link.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Authenticated } from 'src/middleware/auth.guard.js';
import { HouseholdLinkService } from 'src/services/household-link.service.js';
import { UUIDv7ParamDto } from 'src/validation.js';

const history = new HistoryBuilder().added('v3.2.0').alpha('v3.2.0');

/** Linked Households (FL-952): an administrator links this server with another household's server. */
@ApiTags(ApiTag.FrameleafCloud)
@Controller('admin/household-links')
export class HouseholdLinkController {
  constructor(private service: HouseholdLinkService) {}

  @Post('invitations')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AdminCloudUpdate, admin: true })
  @Endpoint({
    operationId: 'createHouseholdInvitation',
    summary: 'Create an invitation for another household to link its server',
    history,
  })
  invite(): Promise<HouseholdInvitationDto> {
    return this.service.invite();
  }

  @Get('invitations/:code')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AdminCloudRead, admin: true })
  @Endpoint({
    operationId: 'previewHouseholdInvitation',
    summary: 'Show which server sent a household invitation',
    history,
  })
  preview(@Param() { code }: HouseholdInvitationCodeParamDto): Promise<HouseholdInvitationPreviewDto> {
    return this.service.preview(code);
  }

  @Post('invitations/accept')
  @Authenticated({ permission: Permission.AdminCloudUpdate, admin: true })
  @Endpoint({
    operationId: 'acceptHouseholdInvitation',
    summary: 'Accept a household invitation and link the two servers',
    history,
  })
  accept(@Body() dto: HouseholdInvitationAcceptDto): Promise<HouseholdLinkDto> {
    return this.service.accept(dto.code, dto.householdName);
  }

  @Get()
  @Authenticated({ permission: Permission.AdminCloudRead, admin: true })
  @Endpoint({ operationId: 'getHouseholdLinks', summary: 'List the households this server is linked with', history })
  list(): Promise<HouseholdLinkDto[]> {
    return this.service.list();
  }

  @Patch(':id')
  @Authenticated({ permission: Permission.AdminCloudUpdate, admin: true })
  @Endpoint({
    operationId: 'updateHouseholdLink',
    summary: 'Rename the other household. The name stays on this server',
    history,
  })
  update(@Param() { id }: UUIDv7ParamDto, @Body() dto: HouseholdLinkUpdateDto): Promise<HouseholdLinkDto> {
    return this.service.rename(id, dto.householdName);
  }

  @Post(':id/refresh')
  @Authenticated({ permission: Permission.AdminCloudUpdate, admin: true })
  @Endpoint({
    operationId: 'refreshHouseholdLink',
    summary: 'Check a household link with Frameleaf Cloud and the other server now',
    history,
  })
  refresh(@Param() { id }: UUIDv7ParamDto): Promise<HouseholdLinkDto> {
    return this.service.refresh(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ permission: Permission.AdminCloudUpdate, admin: true })
  @Endpoint({
    operationId: 'endHouseholdLink',
    summary: 'End a household link. Nothing already received is deleted',
    history,
  })
  end(@Param() { id }: UUIDv7ParamDto): Promise<void> {
    return this.service.end(id);
  }
}
