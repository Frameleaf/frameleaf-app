import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { ModelDownloadKeyResponseDto, ModelDownloadKeyUpdateDto } from 'src/dtos/model-download-key.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Authenticated } from 'src/middleware/auth.guard.js';
import { ModelDownloadKeyService } from 'src/services/model-download-key.service.js';

/** Settings → Computers → Advanced → Connections → Faster model downloads (FL-1825). */
@ApiTags(ApiTag.FrameleafCloudMl)
@Controller('admin/model-download-key')
export class ModelDownloadKeyController {
  constructor(private service: ModelDownloadKeyService) {}

  @Get()
  @Authenticated({ permission: Permission.SystemConfigRead, admin: true })
  @Endpoint({
    operationId: 'getModelDownloadKey',
    summary: 'Get the model download key status',
    description:
      'Whether a Hugging Face key for faster model downloads is saved and still accepted. The key itself is never returned. A key last checked an hour or more ago is checked with Hugging Face again.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getStatus(): Promise<ModelDownloadKeyResponseDto> {
    return this.service.getStatus();
  }

  @Put()
  @Authenticated({ permission: Permission.SystemConfigUpdate, admin: true })
  @Endpoint({
    operationId: 'setModelDownloadKey',
    summary: 'Save a model download key',
    description:
      'Checks the Hugging Face key with Hugging Face, then keeps it sealed on this server and gives it to this server’s own ML service for model downloads. A key Hugging Face refuses is not saved.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  save(@Body() dto: ModelDownloadKeyUpdateDto): Promise<ModelDownloadKeyResponseDto> {
    return this.service.save(dto);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ permission: Permission.SystemConfigUpdate, admin: true })
  @Endpoint({
    operationId: 'removeModelDownloadKey',
    summary: 'Remove the model download key',
    description: 'Forgets the Hugging Face key. Models keep downloading without one.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  remove(): Promise<void> {
    return this.service.remove();
  }
}
