import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  ArchiveOperationCommandDto,
  ArchiveOperationConfirmDto,
  ArchiveOperationCreateDto,
  ArchiveOperationPrepareDto,
  ArchiveOperationResponseDto,
} from 'src/dtos/archive-operation.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { ArchiveOperationService } from 'src/services/archive-operation.service.js';
import { UUIDParamDto } from 'src/validation.js';

@ApiTags(ApiTag.Assets)
@Controller('archive-operations')
export class ArchiveOperationController {
  constructor(private service: ArchiveOperationService) {}

  @Post()
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({ summary: 'Archive a frozen selection', history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0') })
  createArchiveOperation(
    @Auth() auth: AuthDto,
    @Body() dto: ArchiveOperationCreateDto,
  ): Promise<ArchiveOperationResponseDto> {
    return this.service.create(auth, dto);
  }

  @Post('prepare')
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'Prepare all matching owned Timeline assets',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  prepareArchiveOperation(
    @Auth() auth: AuthDto,
    @Body() dto: ArchiveOperationPrepareDto,
  ): Promise<ArchiveOperationResponseDto> {
    return this.service.prepare(auth, dto);
  }

  @Post(':id/confirm')
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'Confirm an exact prepared archive selection',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  confirmArchiveOperation(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: ArchiveOperationConfirmDto,
  ): Promise<ArchiveOperationResponseDto> {
    return this.service.confirm(auth, id, dto.requestKey);
  }

  @Get()
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'List recent archive operations',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getArchiveOperations(@Auth() auth: AuthDto): Promise<ArchiveOperationResponseDto[]> {
    return this.service.list(auth);
  }

  @Get(':id')
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({ summary: 'Read an archive operation', history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0') })
  getArchiveOperation(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<ArchiveOperationResponseDto> {
    return this.service.get(auth, id);
  }

  @Post(':id')
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'Cancel, retry or undo an archive operation',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  commandArchiveOperation(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: ArchiveOperationCommandDto,
  ): Promise<ArchiveOperationResponseDto> {
    return this.service.command(auth, id, dto.command);
  }
}
