import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { AdminConfigDto } from 'src/dtos/config.dto.js';
import { AdminConfigRevisionResponseDto, AdminConfigRevisionUpdateDto } from 'src/dtos/system-config.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Authenticated } from 'src/middleware/auth.guard.js';
import { SystemConfigService } from 'src/services/system-config.service.js';

@ApiTags(ApiTag.ConfigAdmin)
@Controller('admin/config')
export class ConfigAdminController {
  constructor(private service: SystemConfigService) {}

  @Get()
  @Authenticated({ permission: Permission.AdminConfigRead, admin: true })
  @Endpoint({
    summary: 'Get the admin configuration',
    description: 'Retrieve admin configuration.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getAdminConfig(): Promise<AdminConfigDto> {
    return this.service.getAdminConfig();
  }

  @Get('defaults')
  @Authenticated({ permission: Permission.AdminConfigRead, admin: true })
  @Endpoint({
    summary: 'Get the system configuration defaults',
    description: 'Retrieve the default value of every system configuration property.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getAdminConfigDefaults(): AdminConfigDto {
    return this.service.getAdminConfigDefaults();
  }

  @Put()
  @Authenticated({ permission: Permission.AdminConfigUpdate, admin: true })
  @Endpoint({
    summary: 'Update the system configuration',
    description: 'Update the system configuration with a new system configuration.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  updateAdminConfig(@Body() dto: AdminConfigDto): Promise<AdminConfigDto> {
    return this.service.updateAdminConfig(dto);
  }

  @Get('revision')
  @Authenticated({ permission: Permission.AdminConfigRead, admin: true })
  @Endpoint({
    summary: 'Get the admin configuration with its revision',
    description:
      'Retrieve the admin configuration together with a revision that changes whenever a saved setting changes. Send the revision back when saving so a save made against older settings is refused.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getAdminConfigWithRevision(): Promise<AdminConfigRevisionResponseDto> {
    return this.service.getAdminConfigWithRevision();
  }

  @Put('revision')
  @Authenticated({ permission: Permission.AdminConfigUpdate, admin: true })
  @Endpoint({
    summary: 'Update the system configuration if it is unchanged',
    description:
      'Save a complete system configuration only when the saved settings still match the revision it was made against. Returns the saved configuration and its new revision.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  @ApiResponse({ status: 409, description: 'The saved settings changed since the given revision; nothing was saved.' })
  updateAdminConfigWithRevision(@Body() dto: AdminConfigRevisionUpdateDto): Promise<AdminConfigRevisionResponseDto> {
    return this.service.updateAdminConfigWithRevision(dto);
  }
}
