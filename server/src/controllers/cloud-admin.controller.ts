import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  CloudPermissionsUpdateDto,
  CloudRemoteAccessUpdateDto,
  CloudSignInUpdateDto,
  CloudStatusResponseDto,
  CloudTourResponseDto,
  CloudTourSeenDto,
} from 'src/dtos/frameleaf-cloud.dto.js';
import {
  RemoteAccessStatusResponseDto,
  RemoteAccessUpdateDto,
  RemoteAccessUsageResponseDto,
  RemoteHostnameUpdateDto,
} from 'src/dtos/frameleaf-remote-access.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { RATE_LIMITS, RateLimited } from 'src/middleware/rate-limit.guard.js';
import { FrameleafCloudTourService } from 'src/services/frameleaf-cloud-tour.service.js';
import { FrameleafCloudService } from 'src/services/frameleaf-cloud.service.js';
import { FrameleafRemoteAccessService } from 'src/services/frameleaf-remote-access.service.js';

/**
 * Linking this server to a Frameleaf account (FL-154 status, FL-155 link lifecycle). Nothing is
 * contacted until an administrator starts linking; an unset `FRAMELEAF_CLOUD_URL` is reported as
 * not configured and never replaced by a default host.
 */
@ApiTags(ApiTag.FrameleafCloud)
@Controller('admin/cloud')
export class CloudAdminController {
  constructor(
    private service: FrameleafCloudService,
    private remoteAccessService: FrameleafRemoteAccessService,
    private tourService: FrameleafCloudTourService,
  ) {}

  @Get('tour')
  @Authenticated({ permission: Permission.AdminCloudRead, admin: true })
  @Endpoint({
    operationId: 'getCloudTour',
    summary: 'Get your linked-server tour',
    description:
      'Whether you have seen the tour of what linking to Frameleaf Cloud unlocks, whether to open it now, and the status it shows for this server. Reads local state only; nothing is contacted.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getTour(@Auth() auth: AuthDto): Promise<CloudTourResponseDto> {
    return this.tourService.getTour(auth);
  }

  @Put('tour')
  @Authenticated({ permission: Permission.AdminCloudRead, admin: true })
  @Endpoint({
    operationId: 'markCloudTourSeen',
    summary: 'Mark your linked-server tour as seen',
    description:
      'Records how you ended the tour (finished, skipped, opened a settings page, or linked during first-run setup), so it is not offered to you again. The first ending is kept. Changes no settings and contacts nothing.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  markTourSeen(@Auth() auth: AuthDto, @Body() dto: CloudTourSeenDto): Promise<CloudTourResponseDto> {
    return this.tourService.markSeen(auth, dto);
  }

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

  @Post('link/continue')
  @Authenticated({ permission: Permission.AdminCloudLink, admin: true })
  @Endpoint({
    operationId: 'continueCloudLink',
    summary: 'Link in the Frameleaf account’s data region',
    description:
      'After Frameleaf Cloud refused an approved link because the account keeps its data in another region (409 region-mismatch), links again with the same, unspent approval in the account’s region. No new code is needed.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  continueLink(@Auth() auth: AuthDto): Promise<CloudStatusResponseDto> {
    return this.service.continueLink(auth);
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

  @Get('remote')
  @Authenticated({ permission: Permission.AdminCloudRead, admin: true })
  @Endpoint({
    operationId: 'getRemoteAccess',
    summary: 'Get remote access',
    description:
      'Whether remote access is on, how it connects, the address it publishes, its certificate, the custom hostname and the connection candidates. Reads local state only; nothing is contacted.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getRemoteAccess(): Promise<RemoteAccessStatusResponseDto> {
    return this.remoteAccessService.getStatus();
  }

  @Get('remote/usage')
  @Authenticated({ permission: Permission.AdminCloudRead, admin: true })
  @Endpoint({
    operationId: 'getRemoteAccessUsage',
    summary: 'Get relay use this month',
    description:
      'How much has gone through the Frameleaf relay this month and the allowance the plan includes, as Frameleaf Cloud meters them. Only on a linked server with remote access in its plan.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getRemoteAccessUsage(@Auth() auth: AuthDto): Promise<RemoteAccessUsageResponseDto> {
    return this.remoteAccessService.getUsage(auth);
  }

  @Put('remote')
  @Authenticated({ permission: Permission.AdminRemoteAccessUpdate, admin: true })
  @Endpoint({
    operationId: 'updateRemoteAccess',
    summary: 'Change remote access',
    description:
      'Turns remote access on or off and chooses its connection, direct port and published address. Turning it on needs a linked server with a remote access plan; publishing your own domain needs a verified custom hostname.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  updateRemoteAccessSettings(
    @Auth() auth: AuthDto,
    @Body() dto: RemoteAccessUpdateDto,
  ): Promise<RemoteAccessStatusResponseDto> {
    return this.remoteAccessService.update(auth, dto);
  }

  @Post('remote/test')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AdminRemoteAccessUpdate, admin: true })
  @Endpoint({
    operationId: 'testRemoteAccess',
    summary: 'Test remote access',
    description:
      'Checks the certificate, the HTTPS listener and a request through it to this server, and reports the relay and the router as last seen. The result is kept with the remote access status.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  testRemoteAccess(@Auth() auth: AuthDto): Promise<RemoteAccessStatusResponseDto> {
    return this.remoteAccessService.test(auth);
  }

  @Put('remote/hostname')
  @Authenticated({ permission: Permission.AdminRemoteAccessUpdate, admin: true })
  @Endpoint({
    operationId: 'setRemoteHostname',
    summary: 'Use your own domain for remote access',
    description:
      'Adds a hostname on a domain you own, such as photos.example.com, and returns the two DNS records to add at your DNS provider. It waits for them until they are checked.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  setRemoteHostname(
    @Auth() auth: AuthDto,
    @Body() dto: RemoteHostnameUpdateDto,
  ): Promise<RemoteAccessStatusResponseDto> {
    return this.remoteAccessService.setCustomHostname(auth, dto);
  }

  @Post('remote/hostname/check')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AdminRemoteAccessUpdate, admin: true })
  @Endpoint({
    operationId: 'checkRemoteHostname',
    summary: 'Check the custom hostname’s DNS records',
    description:
      'Asks Frameleaf Cloud whether both DNS records point to this server. Once they do, the hostname is verified and this server obtains its certificate.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  checkRemoteHostname(@Auth() auth: AuthDto): Promise<RemoteAccessStatusResponseDto> {
    return this.remoteAccessService.checkCustomHostname(auth);
  }

  @Delete('remote/hostname')
  @Authenticated({ permission: Permission.AdminRemoteAccessUpdate, admin: true })
  @Endpoint({
    operationId: 'removeRemoteHostname',
    summary: 'Stop using the custom hostname',
    description:
      'Removes the custom hostname and publishes the Frameleaf address again. Its DNS records can then be deleted.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  removeRemoteHostname(@Auth() auth: AuthDto): Promise<RemoteAccessStatusResponseDto> {
    return this.remoteAccessService.removeCustomHostname(auth);
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
