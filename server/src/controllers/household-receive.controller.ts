import { Controller, Get, Header, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { HouseholdInboundShareDto } from 'src/dtos/household-receive.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { HouseholdReceiveService } from 'src/services/household-receive.service.js';
import { UUIDParamDto } from 'src/validation.js';

const history = new HistoryBuilder().added('v3.2.0').alpha('v3.2.0');

/** Linked Households (FL-994): spaces other households offered the signed-in account. */
@ApiTags(ApiTag.SharedSpaces)
@Controller('household-shares')
export class HouseholdReceiveController {
  constructor(private service: HouseholdReceiveService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AlbumRead })
  @Endpoint({
    operationId: 'getHouseholdShares',
    summary: 'List spaces offered by linked households, with their state',
    history,
  })
  list(@Auth() auth: AuthDto): Promise<HouseholdInboundShareDto[]> {
    return this.service.list(auth);
  }

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AlbumCreate })
  @Endpoint({ operationId: 'acceptHouseholdShare', summary: 'Accept a space from a linked household', history })
  accept(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<HouseholdInboundShareDto> {
    return this.service.accept(auth, id);
  }

  @Post(':id/decline')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ permission: Permission.AlbumUserDelete })
  @Endpoint({
    operationId: 'declineHouseholdShare',
    summary: 'Decline or leave a space from a linked household; what was received stays',
    history,
  })
  decline(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.decline(auth, id);
  }
}
