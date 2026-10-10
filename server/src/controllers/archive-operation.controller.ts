import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  ArchiveOperationConfirmDto,
  ArchiveOperationCreateDto,
  ArchiveOperationPrepareDto,
  ArchiveOperationResponseDto,
  ArchiveOperationUndoDto,
} from 'src/dtos/archive-operation.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { ArchiveOperationService } from 'src/services/archive-operation.service.js';
import { UUIDParamDto } from 'src/validation.js';

const history = () => new HistoryBuilder().added('v3.2.0').alpha('v3.2.0');

/**
 * Transactional archive (FL-32). Route order matters: `prepare` is declared before `:id`.
 */
@ApiTags(ApiTag.Assets)
@Controller('archive-operations')
export class ArchiveOperationController {
  constructor(private service: ArchiveOperationService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'Archive a selection in the background',
    description:
      'Freezes the selection and hands it to a durable bulk job. Undo later restores only items nothing has changed since.',
    history: history(),
  })
  createArchiveOperation(
    @Auth() auth: AuthDto,
    @Body() dto: ArchiveOperationCreateDto,
  ): Promise<ArchiveOperationResponseDto> {
    return this.service.create(auth, dto);
  }

  @Post('prepare')
  @HttpCode(HttpStatus.CREATED)
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'Count and freeze every matching Timeline asset',
    description:
      'Counts and freezes, in one transaction, every asset of your own normal Timeline this session can see. Nothing changes until the count is confirmed.',
    history: history(),
  })
  prepareArchiveOperation(
    @Auth() auth: AuthDto,
    @Body() dto: ArchiveOperationPrepareDto,
  ): Promise<ArchiveOperationResponseDto> {
    return this.service.prepare(auth, dto);
  }

  @Get()
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({ summary: 'List recent archive operations', history: history() })
  getArchiveOperations(@Auth() auth: AuthDto): Promise<ArchiveOperationResponseDto[]> {
    return this.service.list(auth);
  }

  @Get(':id')
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({ summary: 'Retrieve an archive operation', history: history() })
  getArchiveOperation(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<ArchiveOperationResponseDto> {
    return this.service.get(auth, id);
  }

  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({ summary: 'Confirm a prepared archive selection', history: history() })
  confirmArchiveOperation(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: ArchiveOperationConfirmDto,
  ): Promise<ArchiveOperationResponseDto> {
    return this.service.confirm(auth, id, dto.requestKey);
  }

  @Post(':id/undo')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'Undo an archive operation',
    description:
      'Restores, in the background, every item the archive changed that nothing has changed since. A running archive is stopped first.',
    history: history(),
  })
  undoArchiveOperation(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: ArchiveOperationUndoDto,
  ): Promise<ArchiveOperationResponseDto> {
    return this.service.undo(auth, id, dto.requestKey);
  }
}
