import { Body, Controller, Get, Header, Param, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { BulkIdResponseDto } from 'src/dtos/asset-ids.response.dto.js';
import {
  ConnectAddAssetsDto,
  ConnectAddTagsDto,
  ConnectAlbumsDto,
  ConnectAssetDto,
  ConnectAssetsDto,
  ConnectCapabilitiesDto,
  ConnectSearchDto,
  ConnectTagResultDto,
} from 'src/dtos/connect.dto.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { requestVia } from 'src/middleware/frameleaf-via.middleware.js';
import { ConnectMediaService } from 'src/services/connect-media.service.js';
import { ConnectService } from 'src/services/connect.service.js';
import { UUIDParamDto } from 'src/validation.js';

@ApiTags('Connect')
@Controller('connect')
export class ConnectController {
  constructor(
    private service: ConnectService,
    private media: ConnectMediaService,
  ) {}

  @Get('capabilities')
  @Header('Cache-Control', 'no-store')
  @Authenticated({ connect: true, permission: false })
  @Endpoint({
    history: new HistoryBuilder().added('v1.2.21'),
    operationId: 'getConnectCapabilities',
    summary: 'Get Connect capabilities',
  })
  async capabilities(@Auth() auth: AuthDto, @Req() request: Request): Promise<ConnectCapabilitiesDto> {
    const [base, media] = await Promise.all([
      this.service.capabilities(auth),
      this.media.capabilities(auth, requestVia(request)),
    ]);
    const { acceptedUploadTypes, ...limits } = media;
    return {
      ...base,
      limits: { ...base.limits, ...limits },
      supportedTypes: { ...base.supportedTypes, upload: acceptedUploadTypes },
    };
  }

  @Get('albums')
  @Header('Cache-Control', 'no-store')
  @Authenticated({ connect: true, permission: false })
  @Endpoint({
    history: new HistoryBuilder().added('v1.2.21'),
    operationId: 'getConnectAlbums',
    summary: 'List authorized Connect albums',
  })
  albums(@Auth() auth: AuthDto): Promise<ConnectAlbumsDto> {
    return this.service.albums(auth);
  }

  @Get('assets')
  @Header('Cache-Control', 'no-store')
  @Authenticated({ connect: true, permission: false })
  @Endpoint({
    history: new HistoryBuilder().added('v1.2.21'),
    operationId: 'searchConnectAssets',
    summary: 'Search authorized Connect assets',
  })
  search(@Auth() auth: AuthDto, @Query() dto: ConnectSearchDto): Promise<ConnectAssetsDto> {
    return this.service.search(auth, dto);
  }

  @Get('assets/:id')
  @Header('Cache-Control', 'no-store')
  @Authenticated({ connect: true, permission: false })
  @Endpoint({
    history: new HistoryBuilder().added('v1.2.21'),
    operationId: 'getConnectAsset',
    summary: 'Get authorized Connect asset metadata',
  })
  asset(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<ConnectAssetDto> {
    return this.service.asset(auth, id);
  }

  @Post('albums/:id/assets')
  @Header('Cache-Control', 'no-store')
  @Authenticated({ connect: true, permission: false })
  @Endpoint({
    history: new HistoryBuilder().added('v1.2.21'),
    operationId: 'addConnectAlbumAssets',
    summary: 'Add readable assets to a writable album',
  })
  addAssets(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: ConnectAddAssetsDto,
  ): Promise<BulkIdResponseDto[]> {
    return this.service.addAssets(auth, id, dto);
  }

  @Post('assets/:id/tags')
  @Header('Cache-Control', 'no-store')
  @Authenticated({ connect: true, permission: false })
  @Endpoint({
    history: new HistoryBuilder().added('v1.2.21'),
    operationId: 'addConnectAssetTags',
    summary: 'Add tags to a writable readable asset',
  })
  addTags(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: ConnectAddTagsDto,
  ): Promise<ConnectTagResultDto> {
    return this.service.addTags(auth, id, dto);
  }
}
