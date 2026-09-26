import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  CloudPermissionsUpdateDto,
  CloudRemoteAccessUpdateDto,
  CloudSignInUpdateDto,
  CloudStatusResponseDto,
} from 'src/dtos/frameleaf-cloud.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { RATE_LIMITS, RateLimited } from 'src/middleware/rate-limit.guard.js';
import { FrameleafCloudService } from 'src/services/frameleaf-cloud.service.js';

/**
 * Linking this server to a Frameleaf account (FL-154 status, FL-155 link lifecycle). Nothing is
 * contacted until an administrator starts linking; an unset `FRAMELEAF_CLOUD_URL` is reported as
 * not configured and never replaced by a default host.
 */
@ApiTags(ApiTag.FrameleafCloud)
@Controller('admin/cloud')
export class CloudAdminController {
  constructor(private service: FrameleafCloudService) {}

  @Get('status')
  @Authenticated({ permission: Permission.AdminCloudRead, admin: true })
  @Endpoint({
    operationId: 'getCloudStatus',
    summary: 'Get the Frameleaf Cloud link status',
    description:
      'Whether Frameleaf Cloud is configured, and whether this server is unlinked, waiting for approval, linked or revoked. Reads local state only; nothing is contacted.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getStatus(): Promise<CloudStatusResponseDto> {
    return this.service.getStatus();
  }

  @Post('link')
  @Authenticated({ permission: Permission.AdminCloudLink, admin: true })
  @RateLimited(RATE_LIMITS.linkStart)
  @Endpoint({
    operationId: 'startCloudLink',
    summary: 'Start linking this server to a Frameleaf account',
    description:
      'Starts an RFC 8628 device authorization and returns the code to approve on the Frameleaf Cloud approval page, with a QR payload and its expiry.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  startLink(@Auth() auth: AuthDto): Promise<CloudStatusResponseDto> {
    return this.service.startLink(auth);
  }

  @Get('link')
  @Authenticated({ permission: Permission.AdminCloudRead, admin: true })
  @Endpoint({
    operationId: 'getCloudLink',
    summary: 'Check the Frameleaf Cloud link',
    description:
      'The link state. While a code waits for approval, this server asks Frameleaf Cloud whether it was approved, denied or expired, no more often than the interval the cloud set.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getLink(): Promise<CloudStatusResponseDto> {
    return this.service.getLink();
  }

  @Delete('link/pending')
  @Authenticated({ permission: Permission.AdminCloudLink, admin: true })
  @Endpoint({
    operationId: 'cancelCloudLink',
    summary: 'Cancel a pending link',
    description: 'Stops waiting for the current code. Nothing changes on this server.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  cancelLink(): Promise<CloudStatusResponseDto> {
    return this.service.cancelLink();
  }

  @Delete('link')
  @Authenticated({ permission: Permission.AdminCloudLink, admin: true })
  @Endpoint({
    operationId: 'unlinkCloud',
    summary: 'Unlink this server from Frameleaf Cloud',
    description:
      'Clears the link and switches remote access, cloud processing and cloud backup off. Sign in with Frameleaf sessions end; local photos, accounts and password sign-in are unchanged.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  unlink(@Auth() auth: AuthDto): Promise<CloudStatusResponseDto> {
    return this.service.unlink(auth);
  }

  @Put('permissions')
  @Authenticated({ permission: Permission.AdminCloudUpdate, admin: true })
  @Endpoint({
    operationId: 'updateCloudPermissions',
    summary: 'Choose what Frameleaf Cloud may ask this server to do',
    description:
      'The instance-side toggles every cloud command is checked against. This server always decides and records each request.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  updatePermissions(@Auth() auth: AuthDto, @Body() dto: CloudPermissionsUpdateDto): Promise<CloudStatusResponseDto> {
    return this.service.updatePermissions(auth, dto);
  }

  @Put('sign-in')
  @Authenticated({ permission: Permission.AdminCloudUpdate, admin: true })
  @Endpoint({
    operationId: 'updateCloudSignIn',
    summary: 'Choose where Sign in with Frameleaf is offered',
    description:
      'Remote access always requires Sign in with Frameleaf. This also offers it on the login page at home, once the server is linked, and sets its button text.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  updateSignIn(@Auth() auth: AuthDto, @Body() dto: CloudSignInUpdateDto): Promise<CloudStatusResponseDto> {
    return this.service.updateSignIn(auth, dto);
  }

  @Put('remote-access')
  @Authenticated({ permission: Permission.AdminCloudUpdate, admin: true })
  @Endpoint({
    operationId: 'updateCloudRemoteAccess',
    summary: 'Choose what remote access may carry',
    description:
      'Remote visitors always sign in with Frameleaf. This allows original downloads, archives and database backups through the relay, and password sign-in away from home. Turning either on needs a linked server.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  updateRemoteAccess(@Auth() auth: AuthDto, @Body() dto: CloudRemoteAccessUpdateDto): Promise<CloudStatusResponseDto> {
    return this.service.updateRemoteAccess(auth, dto);
  }

  @Post('heartbeat')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AdminCloudUpdate, admin: true })
  @Endpoint({
    operationId: 'checkInCloud',
    summary: 'Check in with Frameleaf Cloud now',
    description: 'Sends one check-in with exactly the fields the "What this server sends" panel lists.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  checkIn(): Promise<CloudStatusResponseDto> {
    return this.service.checkInNow();
  }
}
