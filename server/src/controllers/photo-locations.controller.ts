import { Body, Controller, Delete, Get, Header, HttpCode, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { LocationScanStatusResponseDto, StartLocationScanDto } from 'src/dtos/photo-locations.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { PhotoLocationsService } from 'src/services/photo-locations.service.js';
import { UUIDParamDto } from 'src/validation.js';

@ApiTags(ApiTag.FrameleafCloudJobs)
@Controller('users/me/location-scans')
export class PhotoLocationsController {
  constructor(private service: PhotoLocationsService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AssetRead, refreshElevation: false })
  @Endpoint({
    summary: 'Read own photo location scan and Cloud availability',
    history: new HistoryBuilder().added('v3'),
  })
  getLocationScanStatus(@Auth() auth: AuthDto): Promise<LocationScanStatusResponseDto> {
    return this.service.status(auth);
  }

  @Post()
  @Authenticated({ permission: Permission.AssetUpdate, refreshElevation: false })
  @Endpoint({
    summary: 'Explicitly identify own photo locations using Frameleaf Cloud',
    history: new HistoryBuilder().added('v3'),
  })
  startLocationScan(@Auth() auth: AuthDto, @Body() body: StartLocationScanDto): Promise<LocationScanStatusResponseDto> {
    return this.service.start(auth, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @Authenticated({ permission: Permission.AssetUpdate, refreshElevation: false })
  @Endpoint({
    summary: 'Cancel own photo location scan and purge its Cloud input',
    history: new HistoryBuilder().added('v3'),
  })
  cancelLocationScan(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.cancel(auth, id);
  }
}

@ApiTags(ApiTag.Assets)
@Controller('assets')
export class AssetLocationInsightController {
  constructor(private service: PhotoLocationsService) {}

  @Delete(':id/location-insight')
  @HttpCode(204)
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'Dismiss own inferred venue without changing GPS or EXIF',
    history: new HistoryBuilder().added('v3'),
  })
  dismissAssetLocationInsight(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.dismiss(auth, id);
  }
}
