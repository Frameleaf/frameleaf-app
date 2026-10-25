import {
  Body,
  Controller,
  Header,
  Headers,
  HttpCode,
  Post,
  Put,
  Req,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiHeader, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  SourceReadDeliveryResultDto,
  SourceReadHeartbeatDto,
  SourceReadPollDto,
  SourceResourcePayloadDto,
} from 'src/dtos/source-resource-read.dto.js';
import { SourceGrantDto, SourceGrantRequestDto } from 'src/dtos/source-resource.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { SourceResourceAuthService } from 'src/services/source-resource-auth.service.js';
import { SourceResourceDeliveryService } from 'src/services/source-resource-delivery.service.js';
import { SourceResourceReadService } from 'src/services/source-resource-read.service.js';

@ApiTags(ApiTag.Libraries)
@Controller('source-resources')
export class SourceResourceController {
  constructor(
    private auth: SourceResourceAuthService,
    private reads: SourceResourceReadService,
    private delivery: SourceResourceDeliveryService,
  ) {}

  @Post('grants')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AssetUpload })
  @ApiResponse({ status: 201, type: SourceGrantDto })
  @Endpoint({
    summary: 'Issue a source-only credential for an approved desktop reference source',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  createSourceResourceGrant(@Auth() auth: AuthDto, @Body() dto: SourceGrantRequestDto): Promise<SourceGrantDto> {
    return this.auth.issue(auth, dto);
  }

  @Post('poll')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ public: true })
  @ApiBearerAuth()
  @ApiHeader({
    name: 'x-frameleaf-source-proof',
    required: true,
    description: 'Canonical base64 installation-signed source request proof.',
  })
  @ApiResponse({ status: 200, type: SourceReadPollDto })
  @Endpoint({
    summary: 'Claim one bounded original request for a signed source companion',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  pollSourceResource(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-frameleaf-source-proof') proof: string | undefined,
    @Body() dto: SourceResourcePayloadDto,
  ): Promise<SourceReadPollDto> {
    return this.reads.poll(authorization, proof, dto.payload);
  }

  @Post('heartbeat')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ public: true })
  @ApiBearerAuth()
  @ApiHeader({
    name: 'x-frameleaf-source-proof',
    required: true,
    description: 'Canonical base64 installation-signed source request proof.',
  })
  @ApiResponse({ status: 200, type: SourceReadHeartbeatDto })
  @Endpoint({
    summary: 'Renew the exact current original request claim for a signed source companion',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  heartbeatSourceResource(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-frameleaf-source-proof') proof: string | undefined,
    @Body() dto: SourceResourcePayloadDto,
  ): Promise<SourceReadHeartbeatDto> {
    return this.reads.heartbeat(authorization, proof, dto.payload);
  }

  @Put('deliver')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ public: true })
  @ApiBearerAuth()
  @ApiHeader({
    name: 'x-frameleaf-source-proof',
    required: true,
    description: 'Canonical base64 installation-signed source request proof.',
  })
  @ApiHeader({
    name: 'x-frameleaf-source-payload',
    required: true,
    description:
      'Canonical base64 UTF-8 JSON binding requestId, claimFence, claimToken, resourceKey, version, sha256 and bytes. At most 4096 base64 characters.',
  })
  @ApiConsumes('application/octet-stream')
  @ApiBody({ schema: { type: 'string', format: 'binary' } })
  @ApiResponse({ status: 200, type: SourceReadDeliveryResultDto })
  @Endpoint({
    summary: 'Deliver the exact verified original under a signed source claim',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  deliverSourceResource(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-frameleaf-source-proof') proof: string | undefined,
    @Headers('x-frameleaf-source-payload') payload: string | undefined,
    @Headers('content-type') contentType: string | undefined,
    @Req() request: Request,
  ): Promise<SourceReadDeliveryResultDto> {
    if (contentType?.split(';', 1)[0].trim().toLowerCase() !== 'application/octet-stream')
      throw new UnsupportedMediaTypeException('source_original_binary_required');
    return this.delivery.deliver(authorization, proof, payload, request);
  }
}
