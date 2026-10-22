import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { type AuthDto, OAuthCheckDto, OAuthCheckResponseDto } from 'src/dtos/auth.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { AuthAdminService } from 'src/services/auth-admin.service.js';

@ApiTags(ApiTag.AuthenticationAdmin)
@Controller('admin/auth')
export class AuthAdminController {
  constructor(private service: AuthAdminService) {}
  @Post('unlink-all')
  @Authenticated({ permission: Permission.AdminAuthUnlinkAll, admin: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Unlink all OAuth accounts',
    description: 'Unlinks all OAuth accounts associated with user accounts in the system.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  unlinkAllOAuthAccountsAdmin(@Auth() auth: AuthDto): Promise<void> {
    return this.service.unlinkAll(auth);
  }

  // FL-367: Sign-in methods' "Check" button. Reads the provider; saves nothing.
  @Post('oauth-check')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.SystemConfigUpdate, admin: true })
  @Endpoint({
    summary: 'Check a sign-in provider',
    description:
      'Asks the provider at the issuer URL for its sign-in details and says whether it answered. Nothing is saved.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  checkOAuthProvider(@Body() dto: OAuthCheckDto): Promise<OAuthCheckResponseDto> {
    return this.service.checkOAuthProvider(dto);
  }
}
