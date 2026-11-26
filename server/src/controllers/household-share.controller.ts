import { Body, Controller, Delete, Get, Header, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  HouseholdShareInviteDto,
  HouseholdShareLinkDto,
  HouseholdShareMemberDto,
  HouseholdShareMemberParamDto,
  HouseholdShareRoleDto,
} from 'src/dtos/household-share.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { HouseholdShareService } from 'src/services/household-share.service.js';
import { UUIDParamDto } from 'src/validation.js';

const history = new HistoryBuilder().added('v3.2.0').alpha('v3.2.0');

/** Linked Households (FL-979): a space owner offers the space to accounts of a linked household. */
@ApiTags(ApiTag.SharedSpaces)
@Controller('shared-spaces/:id/households')
export class HouseholdShareController {
  constructor(private service: HouseholdShareService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AlbumRead })
  @Endpoint({
    operationId: 'getSharedSpaceHouseholds',
    summary: 'List linked households and who can be invited from each',
    history,
  })
  list(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<HouseholdShareLinkDto[]> {
    return this.service.listLinks(auth, id);
  }

  @Post('members')
  @Authenticated({ permission: Permission.AlbumUserCreate })
  @Endpoint({
    operationId: 'inviteSharedSpaceHouseholdMember',
    summary: 'Invite an account of a linked household',
    history,
  })
  invite(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: HouseholdShareInviteDto,
  ): Promise<HouseholdShareMemberDto> {
    return this.service.invite(auth, id, dto);
  }

  @Put(':shareId/members/:remoteUserId')
  @Authenticated({ permission: Permission.AlbumUserUpdate })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({ operationId: 'updateSharedSpaceHouseholdMember', summary: 'Change a household member’s role', history })
  setRole(
    @Auth() auth: AuthDto,
    @Param() { id, shareId, remoteUserId }: HouseholdShareMemberParamDto,
    @Body() { role }: HouseholdShareRoleDto,
  ): Promise<void> {
    return this.service.setRole(auth, id, shareId, remoteUserId, role);
  }

  @Delete(':shareId/members/:remoteUserId')
  @Authenticated({ permission: Permission.AlbumUserDelete })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    operationId: 'removeSharedSpaceHouseholdMember',
    summary: 'Remove a household member; removing the last one ends the share',
    history,
  })
  remove(@Auth() auth: AuthDto, @Param() { id, shareId, remoteUserId }: HouseholdShareMemberParamDto): Promise<void> {
    return this.service.removeMember(auth, id, shareId, remoteUserId);
  }
}
