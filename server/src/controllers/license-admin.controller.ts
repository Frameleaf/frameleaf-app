import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  LicenseActivateDto,
  LicenseCertificateDto,
  LicenseProductsResponseDto,
  LicenseStatusResponseDto,
} from 'src/dtos/frameleaf-license.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { RATE_LIMITS, RateLimited } from 'src/middleware/rate-limit.guard.js';
import { FrameleafLicenseService } from 'src/services/frameleaf-license.service.js';

/**
 * Frameleaf licence certificates on this server (FL-156): the supporter key and the Frameleaf Cloud
 * plan, activated by key, installed from a file, refreshed daily and removable one at a time.
 */
@ApiTags(ApiTag.FrameleafLicense)
@Controller('admin/license')
export class LicenseAdminController {
  constructor(private service: FrameleafLicenseService) {}

  @Get()
  @Authenticated({ permission: Permission.ServerLicenseRead, admin: true })
  @Endpoint({
    operationId: 'getLicenseStatus',
    summary: 'Get the licence status',
    description:
      'Whether this server holds a supporter key and a Frameleaf Cloud plan, their state (none, active, grace, expired, invalid), the entitlements cloud features read, and the refresh schedule.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getStatus(): Promise<LicenseStatusResponseDto> {
    return this.service.getStatus();
  }

  @Put('activate')
  @Authenticated({ permission: Permission.ServerLicenseUpdate, admin: true })
  @RateLimited(RATE_LIMITS.licenseActivation)
  @Endpoint({
    operationId: 'activateLicense',
    summary: 'Activate a server licence key',
    description:
      'Checks the key format (FL-SXXX-XXXX-XXXX with its check symbol) and activates it with Frameleaf Cloud for this server. The key travels only in this request body and is never stored.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  activate(@Auth() auth: AuthDto, @Body() dto: LicenseActivateDto): Promise<LicenseStatusResponseDto> {
    return this.service.activate(auth, dto);
  }

  @Put('certificate')
  @Authenticated({ permission: Permission.ServerLicenseUpdate, admin: true })
  @RateLimited(RATE_LIMITS.licenseActivation)
  @Endpoint({
    operationId: 'installLicenseCertificate',
    summary: 'Install a licence file',
    description:
      'Installs a licence file downloaded for this server’s instance ID, for servers without internet access. It is verified with the pinned Frameleaf keys before it is kept.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  installCertificate(@Auth() auth: AuthDto, @Body() dto: LicenseCertificateDto): Promise<LicenseStatusResponseDto> {
    return this.service.installCertificate(auth, dto);
  }

  @Delete()
  @Authenticated({ permission: Permission.ServerLicenseDelete, admin: true })
  @Endpoint({
    operationId: 'removeLicenseKey',
    summary: 'Remove the licence key',
    description:
      'Removes the supporter key from this server, deactivating it with Frameleaf Cloud when reachable. A Frameleaf Cloud plan is not affected.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  removeKey(@Auth() auth: AuthDto): Promise<LicenseStatusResponseDto> {
    return this.service.removeKey(auth);
  }

  @Delete('plan')
  @Authenticated({ permission: Permission.ServerLicenseDelete, admin: true })
  @Endpoint({
    operationId: 'removeLicensePlan',
    summary: 'Remove the plan from this server',
    description:
      'Removes the Frameleaf Cloud plan certificate from this server. The subscription itself is managed in the Frameleaf account and is not cancelled; the licence key is not affected.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  removePlan(@Auth() auth: AuthDto): Promise<LicenseStatusResponseDto> {
    return this.service.removePlan(auth);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.ServerLicenseUpdate, admin: true })
  @Endpoint({
    operationId: 'refreshLicense',
    summary: 'Refresh the licence now',
    description: 'Asks Frameleaf Cloud for current certificates now instead of waiting for the daily refresh.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  refresh(): Promise<LicenseStatusResponseDto> {
    return this.service.refreshNow();
  }
}

/** The Support Frameleaf prices and store (FL-157), readable by every signed-in account. */
@ApiTags(ApiTag.FrameleafLicense)
@Controller('license')
export class LicenseController {
  constructor(private service: FrameleafLicenseService) {}

  @Get('products')
  @Authenticated()
  @Endpoint({
    operationId: 'getLicenseProducts',
    summary: 'Get Support Frameleaf prices',
    description:
      'Bundled plan and supporter prices in US dollars, the licensed-server discount, cloud backup pricing and the store this server was deployed with. Makes no outbound call.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getProducts(): Promise<LicenseProductsResponseDto> {
    return this.service.getProducts();
  }
}
