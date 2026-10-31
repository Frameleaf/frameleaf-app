import { Body, Controller, Delete, Get, Header, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  ApplePhotosSourceCreateDto,
  ApplePhotosSourceResponseDto,
  PhotoSourceCreateDto,
  PhotoSourceCursorDto,
  PhotoSourceItemDto,
  PhotoSourceItemParamsDto,
  PhotoSourceItemResponseDto,
  PhotoSourceReceiptDto,
  PhotoSourceResponseDto,
  PhotoSourceRunDto,
  PhotoSourceRunParamsDto,
  PhotoSourceRunResponseDto,
  PhotoSourceRunStateDto,
  PhotoSourceSnapshotDto,
  PhotoSourceVerifyDto,
} from 'src/dtos/photo-source.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { PhotoSourceService } from 'src/services/photo-source.service.js';
import { UUIDParamDto } from 'src/validation.js';

const history = () => new HistoryBuilder().added('v3.2.0').alpha('v3.2.0');
@ApiTags(ApiTag.Libraries)
@Controller('photo-sources')
export class PhotoSourceController {
  constructor(private service: PhotoSourceService) {}
  @Post()
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AssetUpload })
  @ApiResponse({ status: 201, type: PhotoSourceResponseDto })
  @Endpoint({ summary: 'Approve an owner-scoped desktop folder-copy source', history: history() })
  async createPhotoSource(@Auth() auth: AuthDto, @Body() dto: PhotoSourceCreateDto): Promise<PhotoSourceResponseDto> {
    return PhotoSourceResponseDto.schema.parse(await this.service.create(auth, dto));
  }
  @Post('apple-photos')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AssetUpload })
  @ApiResponse({ status: 201, type: ApplePhotosSourceResponseDto })
  @Endpoint({ summary: 'Approve an owner-scoped Apple Photos copy source', history: history() })
  async createApplePhotosSource(
    @Auth() auth: AuthDto,
    @Body() dto: ApplePhotosSourceCreateDto,
  ): Promise<ApplePhotosSourceResponseDto> {
    return ApplePhotosSourceResponseDto.schema.parse(await this.service.create(auth, dto));
  }
  @Delete(':id')
  @HttpCode(204)
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Revoke a photo source while retaining its managed copies and associations',
    history: history(),
  })
  revokePhotoSource(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.revoke(auth, id);
  }
  @Post(':id/runs')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AssetUpload })
  @ApiResponse({ status: 201, type: PhotoSourceRunResponseDto })
  @Endpoint({ summary: 'Start or recover a bounded photo-copy run', history: history() })
  createPhotoSourceRun(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: PhotoSourceRunDto,
  ): Promise<PhotoSourceRunResponseDto> {
    return this.service.run(auth, id, dto);
  }
  @Get(':id/runs/:runId')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AssetUpload })
  @ApiResponse({ status: 200, type: PhotoSourceSnapshotDto })
  @Endpoint({ summary: 'Read paginated copy-run dispositions without source paths or asset IDs', history: history() })
  getPhotoSourceRun(
    @Auth() auth: AuthDto,
    @Param() { id, runId }: PhotoSourceRunParamsDto,
    @Query() { after }: PhotoSourceCursorDto,
  ): Promise<PhotoSourceSnapshotDto> {
    return this.service.snapshot(auth, id, runId, after);
  }
  @Patch(':id/runs/:runId')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AssetUpload })
  @ApiResponse({ status: 200, type: PhotoSourceRunResponseDto })
  @Endpoint({
    summary: 'Pause, resume, cancel or finish a copy run; incomplete inventory never removes originals',
    history: history(),
  })
  setPhotoSourceRunState(
    @Auth() auth: AuthDto,
    @Param() { id, runId }: PhotoSourceRunParamsDto,
    @Body() dto: PhotoSourceRunStateDto,
  ): Promise<PhotoSourceRunResponseDto> {
    return this.service.setState(auth, id, runId, dto);
  }
  @Post(':id/runs/:runId/items')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AssetUpload })
  @ApiResponse({ status: 201, type: PhotoSourceItemResponseDto })
  @Endpoint({ summary: 'Reserve an immutable source resource and its whole-run byte/item budget', history: history() })
  planPhotoSourceCopy(
    @Auth() auth: AuthDto,
    @Param() { id, runId }: PhotoSourceRunParamsDto,
    @Body() dto: PhotoSourceItemDto,
  ): Promise<PhotoSourceItemResponseDto> {
    return this.service.plan(auth, id, runId, dto);
  }
  @Post(':id/runs/:runId/items/:itemId/verify')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AssetUpload })
  @ApiResponse({ status: 200, type: PhotoSourceReceiptDto })
  @Endpoint({ summary: 'Verify healthy owned original bytes and record the source association', history: history() })
  async verifyPhotoSourceCopy(
    @Auth() auth: AuthDto,
    @Param() { id, runId, itemId }: PhotoSourceItemParamsDto,
    @Body() dto: PhotoSourceVerifyDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PhotoSourceReceiptDto | void> {
    const cancel = new AbortController();
    const close = () => cancel.abort();
    response.once('close', close);
    try {
      return await this.service.verify(auth, id, runId, itemId, dto, cancel.signal);
    } catch (error) {
      if (response.destroyed && cancel.signal.aborted && error === cancel.signal.reason) return;
      throw error;
    } finally {
      response.off('close', close);
    }
  }
}
