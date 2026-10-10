import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  FrameleafSetupLibraryResponseDto,
  FrameleafSetupResponseDto,
  FrameleafSetupStorageResponseDto,
  FrameleafSetupUpdateDto,
} from 'src/dtos/frameleaf-setup.dto.js';
import {
  AdminOnboardingUpdateDto,
  ReverseGeocodingStateResponseDto,
  VersionCheckStateResponseDto,
} from 'src/dtos/system-metadata.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Authenticated } from 'src/middleware/auth.guard.js';
import { SystemMetadataService } from 'src/services/system-metadata.service.js';

@ApiTags(ApiTag.SystemMetadata)
@Controller('system-metadata')
export class SystemMetadataController {
  constructor(private service: SystemMetadataService) {}

  @Get('admin-onboarding')
  @Authenticated({ permission: Permission.SystemMetadataRead, admin: true })
  @Endpoint({
    summary: 'Retrieve admin onboarding',
    description: 'Retrieve the current admin onboarding status.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getAdminOnboarding(): Promise<AdminOnboardingUpdateDto> {
    return this.service.getAdminOnboarding();
  }

  @Post('admin-onboarding')
  @Authenticated({ permission: Permission.SystemMetadataUpdate, admin: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Update admin onboarding',
    description: 'Update the admin onboarding status.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  updateAdminOnboarding(@Body() dto: AdminOnboardingUpdateDto): Promise<void> {
    return this.service.updateAdminOnboarding(dto);
  }

  @Get('frameleaf-setup')
  @Authenticated({ permission: Permission.SystemMetadataRead, admin: true })
  @Endpoint({
    summary: 'Retrieve Frameleaf setup',
    description: 'Retrieve whether Frameleaf first-run setup is complete, its flow and the saved progress.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  getFrameleafSetup(): Promise<FrameleafSetupResponseDto> {
    return this.service.getFrameleafSetup();
  }

  @Put('frameleaf-setup')
  @Authenticated({ permission: Permission.SystemMetadataUpdate, admin: true })
  @Endpoint({
    summary: 'Save Frameleaf setup progress',
    description: 'Save the per-step first-run setup progress. Passwords are never accepted.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  updateFrameleafSetup(@Body() dto: FrameleafSetupUpdateDto): Promise<FrameleafSetupResponseDto> {
    return this.service.updateFrameleafSetup(dto);
  }

  @Post('frameleaf-setup/finish')
  @Authenticated({ permission: Permission.SystemMetadataUpdate, admin: true })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Finish Frameleaf setup',
    description: 'Finish first-run setup after checking that an admin exists and the library location is writable.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  finishFrameleafSetup(): Promise<FrameleafSetupResponseDto> {
    return this.service.finishFrameleafSetup();
  }

  @Get('frameleaf-setup/library')
  @Authenticated({ permission: Permission.SystemMetadataRead, admin: true })
  @Endpoint({
    summary: 'Retrieve library totals for setup',
    description: 'Retrieve the items, people, albums and size of the library for first-run setup.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  getFrameleafSetupLibrary(): Promise<FrameleafSetupLibraryResponseDto> {
    return this.service.getFrameleafSetupLibrary();
  }

  @Get('frameleaf-setup/storage')
  @Authenticated({ permission: Permission.SystemMetadataRead, admin: true })
  @Endpoint({
    summary: 'Check library storage for setup',
    description: 'Check that the library location is writable and report its free space.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  getFrameleafSetupStorage(): Promise<FrameleafSetupStorageResponseDto> {
    return this.service.getFrameleafSetupStorage();
  }

  @Get('reverse-geocoding-state')
  @Authenticated({ permission: Permission.SystemMetadataRead, admin: true })
  @Endpoint({
    summary: 'Retrieve reverse geocoding state',
    description: 'Retrieve the current state of the reverse geocoding import.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getReverseGeocodingState(): Promise<ReverseGeocodingStateResponseDto> {
    return this.service.getReverseGeocodingState();
  }

  @Get('version-check-state')
  @Authenticated({ permission: Permission.SystemMetadataRead, admin: true })
  @Endpoint({
    summary: 'Retrieve version check state',
    description: 'Retrieve the current state of the version check process.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getVersionCheckState(): Promise<VersionCheckStateResponseDto> {
    return this.service.getVersionCheckState();
  }
}
