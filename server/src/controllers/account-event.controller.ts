import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  AccountActivityAdminSearchDto,
  AccountActivityResponseDto,
  AccountActivitySearchDto,
} from 'src/dtos/account-event.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { AccountEventService } from 'src/services/account-event.service.js';

// FL-808 (E16-02): the account activity log. Shared-link visitors are refused (no `sharedLink` route).
@ApiTags(ApiTag.Users)
@Controller('users/me/activity')
export class AccountEventController {
  constructor(private service: AccountEventService) {}

  @Get()
  @Authenticated({ permission: Permission.UserRead })
  @Endpoint({
    summary: 'Retrieve my account activity',
    description:
      'What happened to your account, newest first: sign-ins (and failed ones), sign-outs, signed-out devices, password, PIN and two-step sign-in changes, API keys, shared links, partners and shared items. Kept 400 days. Page with `before` and `take`.',
    history: new HistoryBuilder().added('v3.4.0').beta('v3.4.0'),
  })
  getMyActivity(@Auth() auth: AuthDto, @Query() dto: AccountActivitySearchDto): Promise<AccountActivityResponseDto> {
    return this.service.getMine(auth, dto);
  }
}

@ApiTags(ApiTag.UsersAdmin)
@Controller('admin/activity')
export class AccountEventAdminController {
  constructor(private service: AccountEventService) {}

  @Get()
  @Authenticated({ permission: Permission.AdminUserRead, admin: true })
  @Endpoint({
    summary: 'Retrieve account activity',
    description:
      'Every account’s activity log merged with what administrators did (`source: admin`), newest first. Filter by `userId`, `action`, `from` and `to`; page with `before` and `take`.',
    history: new HistoryBuilder().added('v3.4.0').beta('v3.4.0'),
  })
  getAccountActivityAdmin(
    @Auth() auth: AuthDto,
    @Query() dto: AccountActivityAdminSearchDto,
  ): Promise<AccountActivityResponseDto> {
    return this.service.getAll(auth, dto);
  }
}
