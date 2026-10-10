import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import type { LoginDetails } from 'src/services/auth.service.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  FrameleafSetupAdminDto,
  FrameleafSetupCodeDto,
  FrameleafSetupErrorDto,
  FrameleafSetupLinkDto,
  FrameleafSetupLinkResponseDto,
  FrameleafSetupTicketResponseDto,
} from 'src/dtos/frameleaf-server-setup.dto.js';
import { UserAdminResponseDto } from 'src/dtos/user.dto.js';
import { ApiTag } from 'src/enum.js';
import { Authenticated, GetLoginDetails } from 'src/middleware/auth.guard.js';
import { RATE_LIMITS, RateLimited } from 'src/middleware/rate-limit.guard.js';
import { FrameleafCloudService } from 'src/services/frameleaf-cloud.service.js';
import { FrameleafServerSetupService } from 'src/services/frameleaf-server-setup.service.js';

const history = () => new HistoryBuilder().added('v3.2.0').alpha('v3.2.0');
const client = (details: LoginDetails) => ({ ip: details.clientIp, via: details.via ?? null });

const REFUSALS =
  'Every refusal carries a FrameleafSetupErrorCode in `code`: setup_lan_only (only from the home network, never over remote access), setup_complete (the server already has an administrator), setup_code_required, setup_code_invalid (with `attemptsLeft`), setup_code_replaced (too many wrong tries: a new code is on the console), setup_code_locked (a code pinned with FRAMELEAF_SETUP_CODE after too many wrong tries: restart the server), setup_ticket_invalid, setup_cloud_unavailable, setup_already_linked, setup_link_token_invalid, setup_link_token_used, setup_link_failed. Too many requests from one address answer 429 rate_limited.';

/**
 * FL-292 (NAPI-012): setting up a new server from the Frameleaf app. Public routes, accepted only
 * from the home network and only while the server has no administrator; each needs the setup code
 * the server shows on its console and in its log (never in any response), or the ticket it buys.
 */
@ApiTags(ApiTag.Server)
@Controller('server/setup')
export class FrameleafServerSetupController {
  constructor(
    private service: FrameleafServerSetupService,
    private cloud: FrameleafCloudService,
  ) {}

  @Post('code')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ public: true })
  @RateLimited(RATE_LIMITS.frameleafSetup)
  @Endpoint({
    operationId: 'verifyServerSetupCode',
    summary: 'Check a new server’s setup code',
    description: `For the Frameleaf apps, from the home network, while the server has no administrator: checks the setup code shown on the server's console and in its log (or its QR code), and returns a setup ticket, usable once from this device for ten minutes, to link the server or create its administrator. Five wrong codes replace the code. The code is never in any response. ${REFUSALS}`,
    history: history(),
  })
  @ApiResponse({ status: 401, type: FrameleafSetupErrorDto, description: 'A wrong, replaced or locked setup code' })
  verifyServerSetupCode(
    @Body() dto: FrameleafSetupCodeDto,
    @GetLoginDetails() details: LoginDetails,
  ): Promise<FrameleafSetupTicketResponseDto> {
    return this.service.issueTicket(dto, client(details));
  }

  @Post('link')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ public: true })
  @RateLimited(RATE_LIMITS.frameleafSetup)
  @Endpoint({
    operationId: 'linkNewServer',
    summary: 'Set up a new server with a Frameleaf account',
    description: `For the Frameleaf apps, from the home network, with a setup ticket: links this new server with a single-use Frameleaf link token (fll_…, the same kind FRAMELEAF_LINK_TOKEN takes) under the name the person chose. The Frameleaf account that minted the token owns the server, and its first Sign in with Frameleaf (in a browser or by token exchange) creates the administrator, without a server password. ${REFUSALS}`,
    history: history(),
  })
  @ApiResponse({ status: 400, type: FrameleafSetupErrorDto, description: 'A refused setup or link' })
  linkNewServer(
    @Body() dto: FrameleafSetupLinkDto,
    @GetLoginDetails() details: LoginDetails,
  ): Promise<FrameleafSetupLinkResponseDto> {
    return this.cloud.claimNewServer(dto, client(details));
  }

  @Post('admin')
  @Authenticated({ public: true })
  @RateLimited(RATE_LIMITS.frameleafSetup)
  @Endpoint({
    operationId: 'createNewServerAdmin',
    summary: 'Set up a new server with a password administrator',
    description: `For the Frameleaf apps, from the home network, with a setup ticket: creates the server's first administrator with an email and password (the same account as the web first-run sign-up), for sign-in without Frameleaf Cloud. ${REFUSALS}`,
    history: history(),
  })
  @ApiResponse({ status: 400, type: FrameleafSetupErrorDto, description: 'A refused setup' })
  createNewServerAdmin(
    @Body() dto: FrameleafSetupAdminDto,
    @GetLoginDetails() details: LoginDetails,
  ): Promise<UserAdminResponseDto> {
    return this.service.claimWithPassword(dto, client(details));
  }
}
