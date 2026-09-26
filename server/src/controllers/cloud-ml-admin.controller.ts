import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  CloudMlCatalogResponseDto,
  CloudMlConsentHistoryResponseDto,
  CloudMlDescriptionBatchCreateDto,
  CloudMlDescriptionBatchesResponseDto,
  CloudMlDescriptionEstimateResponseDto,
  CloudMlDestinationCreateDto,
  CloudMlModelChoiceUpdateDto,
  CloudMlModelChoicesResponseDto,
  CloudMlModelGroupParamDto,
  CloudMlSettlementsResponseDto,
  CloudMlStatusResponseDto,
  CloudMlWalletDto,
  CloudMlWalletUpdateDto,
} from 'src/dtos/cloud-ml.dto.js';
import { MlDestinationResponseDto } from 'src/dtos/ml-destination.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { CloudMlBatchService } from 'src/services/cloud-ml-batch.service.js';
import { CloudMlService } from 'src/services/cloud-ml.service.js';

/**
 * Frameleaf Cloud processing administration (FL-159). Consent for the destination is recorded with
 * the existing `PUT /ml-destinations/:id/consent`; routes use `PUT /ml-destinations/routes/:workload`.
 * The Frameleaf Cloud model per model group (FL-186) is chosen here, apart from the routes, and a
 * description backfill (FL-163) is estimated and queued here.
 */
@ApiTags(ApiTag.FrameleafCloudMl)
@Controller('admin/cloud/ml')
export class CloudMlAdminController {
  constructor(
    private service: CloudMlService,
    private batchService: CloudMlBatchService,
  ) {}

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

  @Post('descriptions/batches')
  @Authenticated({ permission: Permission.AdminCloudMlUpdate, admin: true })
  @Endpoint({
    operationId: 'startCloudMlDescriptionBackfill',
    summary: 'Describe photos with Frameleaf Cloud',
    description:
      'Queues the estimated backfill as batches, one owner per batch and one cloud job per batch. Refused when the model changed, more photos need a description than were estimated, or the AI Wallet or a budget cannot cover it; nothing is sent to another destination.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  startDescriptionBackfill(
    @Body() dto: CloudMlDescriptionBatchCreateDto,
  ): Promise<CloudMlDescriptionBatchesResponseDto> {
    return this.batchService.startBackfill(dto);
  }

  @Post('descriptions/estimate')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AdminCloudMlUpdate, admin: true })
  @Endpoint({
    operationId: 'estimateCloudMlDescriptionBackfill',
    summary: 'Estimate describing photos with Frameleaf Cloud',
    description:
      'What describing every photo still without a description would cost, from the metered GPU time of the chosen model: a p50–p90 range, a per-photo figure, the start fee per batch and the AI Wallet balance. Nothing is queued.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  estimateDescriptionBackfill(@Auth() auth: AuthDto): Promise<CloudMlDescriptionEstimateResponseDto> {
    return this.batchService.estimateBackfill(auth);
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

  @Get('models')
  @Authenticated({ permission: Permission.AdminCloudMlRead, admin: true })
  @Endpoint({
    operationId: 'getCloudMlModelChoices',
    summary: 'List the chosen Frameleaf Cloud models',
    description:
      'The Frameleaf Cloud model chosen for each model group, or null where the group uses the model the catalogue recommends. A cloud job reads its group whatever its workload is routed to.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getModelChoices(): Promise<CloudMlModelChoicesResponseDto> {
    return this.service.getModelChoices();
  }

  @Put('models/:group')
  @Authenticated({ permission: Permission.AdminCloudMlUpdate, admin: true })
  @Endpoint({
    operationId: 'setCloudMlModelChoice',
    summary: 'Choose the Frameleaf Cloud model of a model group',
    description:
      'Choose a catalogue model for one model group, checked against the catalogue for exactly that group, or null to use the model the catalogue recommends.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  setModelChoice(
    @Param() { group }: CloudMlModelGroupParamDto,
    @Body() dto: CloudMlModelChoiceUpdateDto,
  ): Promise<CloudMlModelChoicesResponseDto> {
    return this.service.setModelChoice(group, dto);
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
