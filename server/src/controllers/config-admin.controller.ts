import { Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  ConfigCredentialParamDto,
  ConfigCredentialResponseDto,
  ConfigCredentialUpdateDto,
} from 'src/dtos/config-credential.dto.js';
import { AdminConfigDto } from 'src/dtos/config.dto.js';
import {
  AdminConfigRevisionResponseDto,
  AdminConfigRevisionUpdateDto,
  SystemConfigHistoryResponseDto,
} from 'src/dtos/system-config.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
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
  updateAdminConfig(@Auth() auth: AuthDto, @Body() dto: AdminConfigDto): Promise<AdminConfigDto> {
    return this.service.updateAdminConfig(dto, auth);
  }

  @Get('credentials')
  @Authenticated({ permission: Permission.AdminConfigRead, admin: true })
  @Endpoint({
    summary: 'List the server credentials',
    description: 'Whether each write-only server credential is stored. Credential values are never returned.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  getConfigCredentials(): Promise<ConfigCredentialResponseDto[]> {
    return this.service.getCredentials();
  }

  @Put('credentials/:name')
  @Authenticated({ permission: Permission.AdminConfigUpdate, admin: true })
  @Endpoint({
    summary: 'Replace a server credential',
    description:
      'Store a new value for one write-only server credential. The value is validated like a configuration save and is never returned.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  updateConfigCredential(
    @Auth() auth: AuthDto,
    @Param() { name }: ConfigCredentialParamDto,
    @Body() dto: ConfigCredentialUpdateDto,
  ): Promise<ConfigCredentialResponseDto> {
    return this.service.setCredential(auth, name, dto);
  }

  @Delete('credentials/:name')
  @Authenticated({ permission: Permission.AdminConfigUpdate, admin: true })
  @Endpoint({
    summary: 'Clear a server credential',
    description: 'Remove the stored value of one write-only server credential.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  deleteConfigCredential(
    @Auth() auth: AuthDto,
    @Param() { name }: ConfigCredentialParamDto,
  ): Promise<ConfigCredentialResponseDto> {
    return this.service.clearCredential(auth, name);
  }

  @Get('history')
  @Authenticated({ permission: Permission.AdminConfigRead, admin: true })
  @Endpoint({
    summary: 'Get the settings change history',
    description:
      'The newest saved settings changes, each with its time, the administrator who saved it and the changed settings before and after. Credentials are listed only as replaced or cleared.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getAdminConfigHistory(): Promise<SystemConfigHistoryResponseDto> {
    return this.service.getConfigHistory();
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
  updateAdminConfigWithRevision(
    @Auth() auth: AuthDto,
    @Body() dto: AdminConfigRevisionUpdateDto,
  ): Promise<AdminConfigRevisionResponseDto> {
    return this.service.updateAdminConfigWithRevision(dto, auth);
  }
}
