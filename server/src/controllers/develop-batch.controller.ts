import {
  BadRequestException,
  Body,
  CallHandler,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  Param,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { diskStorage } from 'multer';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { lastValueFrom, of } from 'rxjs';
import type { Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  DevelopBatchCapabilitiesDto,
  DevelopBatchConfirmDto,
  DevelopBatchCreateDto,
  DevelopBatchImportDto,
  DevelopBatchItemParamDto,
  DevelopBatchItemResponseDto,
  DevelopBatchManifestDto,
  DevelopBatchMatchDto,
  DevelopBatchMatchResponseDto,
  DevelopBatchResponseDto,
} from 'src/dtos/develop-batch.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, AuthRequest, Authenticated, OriginalTransfer } from 'src/middleware/auth.guard.js';
import { DEVELOP_IMPORT_MAX_BYTES } from 'src/services/asset-develop.service.js';
import { DevelopBatchService, batchStagingFolder } from 'src/services/develop-batch.service.js';
import { UUIDParamDto } from 'src/validation.js';

const history = () => new HistoryBuilder().added('v3.2.0').alpha('v3.2.0');
const storage = diskStorage({
  destination: (request, _file, callback) => {
    const user = (request as unknown as AuthRequest).user;
    const id = request.params.id;
    if (!user || typeof id !== 'string' || !DevelopBatchItemParamDto.schema.safeParse(request.params).success) {
      callback(new BadRequestException('Invalid editing batch item'), '');
      return;
    }
    try {
      const folder = batchStagingFolder(user.user.id, id);
      mkdirSync(folder, { recursive: true });
      callback(null, folder);
    } catch (error) {
      callback(error as Error, '');
    }
  },
  filename: (request, file, callback) => {
    const ownerId = (request as unknown as AuthRequest).user!.user.id;
    const filename = `${randomUUID()}.partial`,
      target = path.join(batchStagingFolder(ownerId, String(request.params.id)), filename);
    const cleanup = () => {
      void rm(target, { force: true }).catch(() => {});
    };
    request.once('aborted', cleanup);
    request.once('error', cleanup);
    file.stream.once('close', () => {
      if (request.aborted) cleanup();
    });
    callback(null, filename);
  },
});
/** Runs before body pipes too: invalid DTOs and exceptions must release multer's staged upload. */
@Injectable()
class DevelopBatchUploadInterceptor extends FileInterceptor('file', {
  storage,
  limits: { files: 1, fileSize: DEVELOP_IMPORT_MAX_BYTES },
}) {
  async intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<AuthRequest & { file?: Express.Multer.File }>();
    try {
      return of(await lastValueFrom(await super.intercept(context, next)));
    } finally {
      if (request.file?.path) await rm(request.file.path, { force: true });
    }
  }
}
@ApiTags(ApiTag.Assets)
@Controller('develop-batches')
export class DevelopBatchController {
  constructor(private service: DevelopBatchService) {}
  @Get('capabilities')
  @Authenticated()
  @Endpoint({ summary: 'Get batch external editor capabilities', history: history() })
  getDevelopBatchCapabilities(): DevelopBatchCapabilitiesDto {
    return { version: 1 };
  }
  @Get()
  @Authenticated({ permission: Permission.AssetEditGet })
  @Endpoint({ summary: 'List your external editor batches', history: history() })
  getDevelopBatches(@Auth() auth: AuthDto): Promise<DevelopBatchResponseDto[]> {
    return this.service.list(auth);
  }
  @Post()
  @Authenticated({ permission: Permission.AssetEditCreate })
  @Endpoint({ summary: 'Create an external editor batch', history: history() })
  createDevelopBatch(@Auth() auth: AuthDto, @Body() dto: DevelopBatchCreateDto): Promise<DevelopBatchResponseDto> {
    return this.service.create(auth, dto);
  }
  @Get(':id')
  @Authenticated({ permission: Permission.AssetEditGet })
  @Endpoint({ summary: 'Get resumable external editor batch status', history: history() })
  getDevelopBatch(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<DevelopBatchResponseDto> {
    return this.service.get(auth, id);
  }
  @Get(':id/manifest')
  @Authenticated({ permission: Permission.AssetEditGet })
  @Endpoint({ summary: 'Get the versioned external editor manifest', history: history() })
  getDevelopBatchManifest(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<DevelopBatchManifestDto> {
    return this.service.manifest(auth, id);
  }
  @Get(':id/download')
  @Authenticated({ permission: Permission.AssetDownload })
  @OriginalTransfer()
  @ApiOkResponse({ content: { 'application/zip': { schema: { type: 'string', format: 'binary' } } } })
  @Endpoint({ summary: 'Stream a ZIP of batch originals and associated sidecars', history: history() })
  async downloadDevelopBatch(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Res() response: Response,
  ): Promise<void> {
    const stream = await this.service.download(auth, id);
    response.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="frameleaf-edit-${id}.zip"`,
      'Cache-Control': 'private, no-store',
    });
    await pipeline(stream, response);
  }
  @Post(':id/items/:itemId/prepare')
  @Authenticated({ permission: Permission.AssetEditCreate })
  @Endpoint({ summary: 'Prepare or resume one original for a durable editing batch', history: history() })
  prepareDevelopBatchItem(
    @Auth() auth: AuthDto,
    @Param() { id, itemId }: DevelopBatchItemParamDto,
  ): Promise<DevelopBatchItemResponseDto> {
    return this.service.prepare(auth, id, itemId);
  }
  @Post(':id/match')
  @Authenticated({ permission: Permission.AssetEditCreate })
  @Endpoint({ summary: 'Review returned file matches without importing', history: history() })
  matchDevelopBatchReturns(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: DevelopBatchMatchDto,
  ): Promise<DevelopBatchMatchResponseDto[]> {
    return this.service.match(auth, id, dto);
  }
  @Post(':id/confirm')
  @Authenticated({ permission: Permission.AssetEditCreate })
  @Endpoint({ summary: 'Confirm mappings and capture working versions for safe activation', history: history() })
  confirmDevelopBatchReturns(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: DevelopBatchConfirmDto,
  ): Promise<DevelopBatchResponseDto> {
    return this.service.confirm(auth, id, dto);
  }
  @Post(':id/items/:itemId/import')
  @Authenticated({ permission: Permission.AssetEditCreate })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: DevelopBatchImportDto })
  @UseInterceptors(DevelopBatchUploadInterceptor)
  @Endpoint({ summary: 'Import or resume one confirmed returned file idempotently', history: history() })
  importDevelopBatchReturn(
    @Auth() auth: AuthDto,
    @Param() { id, itemId }: DevelopBatchItemParamDto,
    @Body() dto: DevelopBatchImportDto,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<DevelopBatchItemResponseDto> {
    return this.service.import(auth, id, itemId, dto, file);
  }
  @Post(':id/cancel')
  @Authenticated({ permission: Permission.AssetEditCreate })
  @Endpoint({ summary: 'Cancel unfinished batch work and retain completed versions', history: history() })
  cancelDevelopBatch(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<DevelopBatchResponseDto> {
    return this.service.cancel(auth, id);
  }
}
