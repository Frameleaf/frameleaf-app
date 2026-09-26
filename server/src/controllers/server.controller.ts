import { Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiNotFoundResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  ReleaseEventV1,
  ServerAboutResponseDto,
  ServerApkLinksDto,
  ServerAppReleasesResponseDto,
  ServerConfigDto,
  ServerFeaturesDto,
  ServerMediaTypesResponseDto,
  ServerPingResponse,
  ServerStatsResponseDto,
  ServerStorageResponseDto,
  ServerVersionHistoryResponseDto,
  ServerVersionResponseDto,
} from 'src/dtos/server.dto.js';
import { VersionCheckStateResponseDto } from 'src/dtos/system-metadata.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Authenticated } from 'src/middleware/auth.guard.js';
import { requestVia } from 'src/middleware/frameleaf-via.middleware.js';
import { ServerService } from 'src/services/server.service.js';
import { SystemMetadataService } from 'src/services/system-metadata.service.js';
import { VersionService } from 'src/services/version.service.js';

@ApiTags(ApiTag.Server)
@Controller('server')
export class ServerController {
  constructor(
    private service: ServerService,
    private systemMetadataService: SystemMetadataService,
    private versionService: VersionService,
  ) {}

  @Get('about')
  @Authenticated({ permission: Permission.ServerAbout })
  @Endpoint({
    summary: 'Get server information',
    description: 'Retrieve a list of information about the server.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getAboutInfo(): Promise<ServerAboutResponseDto> {
    return this.service.getAboutInfo();
  }

  @Get('apk-links')
  @Authenticated({ permission: Permission.ServerApkLinks })
  @ApiNotFoundResponse({ description: 'No signed Android release is configured for this server' })
  @Endpoint({
    summary: 'Get APK links',
    description:
      'Retrieve links to the signed APKs for the current server version, from the release destination configured for this server.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getApkLinks(): ServerApkLinksDto {
    return this.service.getApkLinks();
  }

  @Get('app-releases')
  @Authenticated({ permission: Permission.ServerAbout })
  @Endpoint({
    summary: 'Get app releases',
    description:
      'Retrieve the signed release destinations of the mobile apps for this server, or that none is configured.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getAppReleases(): ServerAppReleasesResponseDto {
    return this.service.getAppReleases();
  }

  @Get('storage')
  @Authenticated({ permission: Permission.ServerStorage })
  @Endpoint({
    summary: 'Get storage',
    description: 'Retrieve the current storage utilization information of the server.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getStorage(): Promise<ServerStorageResponseDto> {
    return this.service.getStorage();
  }

  @Get('ping')
  @Authenticated({ public: true })
  @Endpoint({
    summary: 'Ping',
    description: 'Pong',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  pingServer(): ServerPingResponse {
    return this.service.ping();
  }

  @Get('version')
  @Authenticated({ public: true })
  @Endpoint({
    summary: 'Get server version',
    description: 'Retrieve the current server version in semantic versioning (semver) format.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getServerVersion(): ServerVersionResponseDto {
    return this.versionService.getVersion();
  }

  @Get('version-history')
  @Authenticated({ public: true })
  @Endpoint({
    summary: 'Get version history',
    description: 'Retrieve a list of past versions the server has been on.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getVersionHistory(): Promise<ServerVersionHistoryResponseDto[]> {
    return this.versionService.getVersionHistory();
  }

  @Get('features')
  @Authenticated({ public: true })
  @Endpoint({
    summary: 'Get features',
    description: 'Retrieve available features supported by this server.',
    history: new HistoryBuilder()
      .added('v1')
      .beta('v1')
      .stable('v2')
      .deprecated('v3.2.0', { replacementId: 'getPublicConfig' }),
  })
  getServerFeatures(): Promise<ServerFeaturesDto> {
    return this.service.getFeatures();
  }

  @Get('config')
  @Authenticated({ public: true })
  @Endpoint({
    summary: 'Get config',
    description: 'Retrieve the current server configuration.',
    history: new HistoryBuilder()
      .added('v1')
      .beta('v1')
      .stable('v2')
      .deprecated('v3.2.0', { replacementId: 'getPublicConfig' }),
  })
  getServerConfig(@Req() request: Request): Promise<ServerConfigDto> {
    return this.service.getSystemConfig(requestVia(request));
  }

  @Get('statistics')
  @Authenticated({ permission: Permission.ServerStatistics, admin: true })
  @Endpoint({
    summary: 'Get statistics',
    description: 'Retrieve statistics about the entire Immich instance such as asset counts.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getServerStatistics(): Promise<ServerStatsResponseDto> {
    return this.service.getStatistics();
  }

  @Get('media-types')
  @Authenticated({ public: true })
  @Endpoint({
    summary: 'Get supported media types',
    description: 'Retrieve all media types supported by the server.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getSupportedMediaTypes(): ServerMediaTypesResponseDto {
    return this.service.getSupportedMediaTypes();
  }

  @Get('version-check')
  @Authenticated({ permission: Permission.ServerVersionCheck })
  @Endpoint({
    summary: 'Get version check status',
    description: 'Retrieve information about the last time the version check ran.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getVersionCheck(): Promise<VersionCheckStateResponseDto> {
    return this.systemMetadataService.getVersionCheckState();
  }

  @Post('version-check')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.ServerVersionCheck, admin: true })
  @Endpoint({
    summary: 'Check for updates now',
    description:
      "Ask Frameleaf's release feed for the newest version now, whether or not automatic checks are on (About → Check for updates). No other service is contacted.",
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  checkVersionNow(): Promise<ReleaseEventV1> {
    return this.versionService.checkNow();
  }
}
