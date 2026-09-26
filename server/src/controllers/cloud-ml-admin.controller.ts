import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  CloudMlCatalogResponseDto,
  CloudMlConsentHistoryResponseDto,
  CloudMlDestinationCreateDto,
  CloudMlSettlementsResponseDto,
  CloudMlStatusResponseDto,
  CloudMlWalletDto,
  CloudMlWalletUpdateDto,
} from 'src/dtos/cloud-ml.dto.js';
import { MlDestinationResponseDto } from 'src/dtos/ml-destination.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Authenticated } from 'src/middleware/auth.guard.js';
import { CloudMlService } from 'src/services/cloud-ml.service.js';

/**
 * Frameleaf Cloud processing administration (FL-159). Consent for the destination is recorded with
 * the existing `PUT /ml-destinations/:id/consent`; routes use `PUT /ml-destinations/routes/:workload`.
 */
@ApiTags(ApiTag.FrameleafCloudMl)
@Controller('admin/cloud/ml')
export class CloudMlAdminController {
  constructor(private service: CloudMlService) {}

  @Get()
  @Authenticated({ permission: Permission.AdminCloudMlRead, admin: true })
  @Endpoint({
    operationId: 'getCloudMlStatus',
    summary: 'Get Frameleaf Cloud processing status',
    description:
      'Whether Frameleaf Cloud is configured and linked, the destination once added, the consent version it requires and the AI Wallet. Nothing is contacted unless the server is linked.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getStatus(): Promise<CloudMlStatusResponseDto> {
    return this.service.getStatus();
  }

  @Post('destination')
  @Authenticated({ permission: Permission.AdminCloudMlUpdate, admin: true })
  @Endpoint({
    operationId: 'createCloudMlDestination',
    summary: 'Add Frameleaf Cloud as a processing destination',
    description:
      'The only way the Frameleaf Cloud destination is created. It has no URL or token, is not routed automatically, and refuses all work until consent is recorded.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  createDestination(@Body() dto: CloudMlDestinationCreateDto): Promise<MlDestinationResponseDto> {
    return this.service.createDestination(dto);
  }

  @Get('wallet')
  @Authenticated({ permission: Permission.AdminCloudMlRead, admin: true })
  @Endpoint({
    operationId: 'getCloudMlWallet',
    summary: 'Get the AI Wallet',
    description: 'The AI Wallet balance and holds, read now from Frameleaf Cloud (USD).',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getWallet(): Promise<CloudMlWalletDto> {
    return this.service.getWallet();
  }

  @Put('wallet')
  @Authenticated({ permission: Permission.AdminCloudMlUpdate, admin: true })
  @Endpoint({
    operationId: 'updateCloudMlWallet',
    summary: 'Change the AI Wallet daily cap or automatic top-up',
    description:
      'Lowers the daily spending cap or turns automatic top-up off on the linked Frameleaf account. Raising the cap or turning automatic top-up on is done by the account owner in the Frameleaf account; Frameleaf Cloud refuses it here with 403. Payment details stay on frameleaf.cloud.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  updateWallet(@Body() dto: CloudMlWalletUpdateDto): Promise<CloudMlWalletDto> {
    return this.service.updateWallet(dto);
  }

  @Get('catalog')
  @Authenticated({ permission: Permission.AdminCloudMlRead, admin: true })
  @Endpoint({
    operationId: 'getCloudMlCatalog',
    summary: 'List Frameleaf Cloud models',
    description: 'The models Frameleaf Cloud offers now, with their prices, for choosing a model per workload.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getCatalog(): Promise<CloudMlCatalogResponseDto> {
    return this.service.getCatalog();
  }

  @Get('consent')
  @Authenticated({ permission: Permission.AdminCloudMlRead, admin: true })
  @Endpoint({
    operationId: 'getCloudMlConsentHistory',
    summary: 'List Frameleaf Cloud consent records',
    description: 'Every consent recorded for the Frameleaf Cloud destination, newest first.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getConsentHistory(): Promise<CloudMlConsentHistoryResponseDto> {
    return this.service.getConsentHistory();
  }

  @Get('settlements')
  @Authenticated({ permission: Permission.AdminCloudMlRead, admin: true })
  @Endpoint({
    operationId: 'getCloudMlSettlements',
    summary: 'List settled Frameleaf Cloud charges',
    description:
      'The charges Frameleaf Cloud settled for this server, newest first, as recorded against the jobs that incurred them.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getSettlements(): Promise<CloudMlSettlementsResponseDto> {
    return this.service.getSettlements();
  }

  @Post('usage')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ permission: Permission.AdminCloudMlUpdate, admin: true })
  @Endpoint({
    operationId: 'reconcileCloudMlUsage',
    summary: 'Apply Frameleaf Cloud settlements',
    description: 'Reads settled charges from Frameleaf Cloud and records them against the jobs that incurred them.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  async reconcileUsage(): Promise<void> {
    await this.service.reconcileUsage();
  }
}
