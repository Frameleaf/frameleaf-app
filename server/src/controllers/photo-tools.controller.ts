import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { diskStorage } from 'multer';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { AssetDevelopRevisionResponseDto } from 'src/dtos/asset-develop.dto.js';
import {
  AssetDevelopImportDto,
  DevelopExportResponseDto,
  DevelopPresetCreateDto,
  DevelopPresetResponseDto,
  DevelopPresetUpdateDto,
} from 'src/dtos/photo-tools.dto.js';
import { ApiTag, Permission, RouteKey } from 'src/enum.js';
import { Auth, AuthRequest, Authenticated } from 'src/middleware/auth.guard.js';
import {
  AssetDevelopService,
  DEVELOP_IMPORT_MAX_BYTES,
  developImportStagingFolder,
} from 'src/services/asset-develop.service.js';
import { PhotoToolsService } from 'src/services/photo-tools.service.js';
import { UUIDParamDto } from 'src/validation.js';

const history = () => new HistoryBuilder().added('v3.2.0').alpha('v3.2.0');

/**
 * Where a developed file waits while it is checked: the uploading account's private exports
 * folder under a random name. Never a path the client chose, never memory, never a folder a
 * library scan reads; the service moves it into place or deletes it.
 */
const importStorage = diskStorage({
  destination: (request, _file, callback) => {
    const ownerId = (request as unknown as AuthRequest).user?.user.id;
    if (!ownerId) {
      callback(new Error('Not authenticated'), '');
      return;
    }
    try {
      const folder = developImportStagingFolder(ownerId);
      mkdirSync(folder, { recursive: true });
      callback(null, folder);
    } catch (error) {
      callback(error as Error, '');
    }
  },
  filename: (_request, _file, callback) => callback(null, `${randomUUID()}.partial`),
});

/**
 * Selective photo tools (FL-64): reusable develop presets, and the round trip of an original
 * through another application. Presets belong to the signed-in account. The round-trip routes
 * use the asset edit permissions, so a Locked photo is reachable only from its owner's unlocked
 * session, and never through a shared link, an album or a partner.
 */
@ApiTags(ApiTag.Assets)
@Controller()
export class PhotoToolsController {
  constructor(
    private service: PhotoToolsService,
    private developService: AssetDevelopService,
  ) {}

  @Get('develop-presets')
  @Authenticated()
  @Endpoint({
    summary: 'List develop presets',
    description: 'Your saved develop presets, by name.',
    history: history(),
  })
  getDevelopPresets(@Auth() auth: AuthDto): Promise<DevelopPresetResponseDto[]> {
    return this.service.listPresets(auth);
  }

  @Post('develop-presets')
  @Authenticated()
  @Endpoint({
    summary: 'Save a develop preset',
    description: 'Saves develop settings (sliders, look, strength and masks, never geometry) under a new name.',
    history: history(),
  })
  createDevelopPreset(@Auth() auth: AuthDto, @Body() dto: DevelopPresetCreateDto): Promise<DevelopPresetResponseDto> {
    return this.service.createPreset(auth, dto);
  }

  @Put('develop-presets/:id')
  @Authenticated()
  @Endpoint({
    summary: 'Update a develop preset',
    description: 'Renames a preset, replaces its settings, or both.',
    history: history(),
  })
  updateDevelopPreset(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: DevelopPresetUpdateDto,
  ): Promise<DevelopPresetResponseDto> {
    return this.service.updatePreset(auth, id, dto);
  }

  @Delete('develop-presets/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated()
  @Endpoint({
    summary: 'Delete a develop preset',
    description: 'Deletes the preset. Versions already saved with its settings are unchanged.',
    history: history(),
  })
  deleteDevelopPreset(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.deletePreset(auth, id);
  }

  @Get(`${RouteKey.Asset}/:id/develop/exports`)
  @Authenticated({ permission: Permission.AssetEditGet })
  @Endpoint({
    summary: 'List exports of an original for editing elsewhere',
    description: 'Every recorded export of the original, newest first, and whether the original still matches it.',
    history: history(),
  })
  getAssetDevelopExports(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<DevelopExportResponseDto[]> {
    return this.developService.listExports(auth, id);
  }

  @Post(`${RouteKey.Asset}/:id/develop/exports`)
  @Authenticated({ permission: Permission.AssetEditCreate })
  @Endpoint({
    summary: 'Export an original for editing elsewhere',
    description:
      'Records the SHA-256 of the original now, so a file developed from it in another application can be brought back and checked. Download the original through the ordinary download route.',
    history: history(),
  })
  createAssetDevelopExport(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<DevelopExportResponseDto> {
    return this.developService.createExport(auth, id);
  }

  @Post(`${RouteKey.Asset}/:id/develop/imports`)
  @Authenticated({ permission: Permission.AssetEditCreate })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ description: 'The developed file and the original it was made from', type: AssetDevelopImportDto })
  @UseInterceptors(
    FileInterceptor('file', { storage: importStorage, limits: { files: 1, fileSize: DEVELOP_IMPORT_MAX_BYTES } }),
  )
  @Endpoint({
    summary: 'Bring back a file developed elsewhere',
    description:
      'Checks that the file arrived intact and was developed from the original the photo has now, then keeps it as a new version and renders its preview. Nothing is kept when a check fails; the original is never changed.',
    history: history(),
  })
  importAssetDevelopRendition(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: AssetDevelopImportDto,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<AssetDevelopRevisionResponseDto> {
    return this.developService.importRendition(auth, id, dto, file);
  }
}
