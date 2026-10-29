import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Head,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { AssetUploadResource } from 'src/repositories/asset-upload-resource.repository.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { AlbumResponseDto } from 'src/dtos/album.dto.js';
import {
  CaptureAlbumCreateDto,
  CaptureCapabilitiesDto,
  CaptureCatalogDto,
  CaptureCommitDto,
  CaptureCancelResponseDto,
  CaptureResponseDto,
  CaptureUploadStateDto,
} from 'src/dtos/capture.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { AssetUploadResourceService } from 'src/services/asset-upload-resource.service.js';
import { CaptureService } from 'src/services/capture.service.js';
import { assetUploadRequestHeaders, writeAssetUploadHeaders } from 'src/utils/asset-upload-response.js';
import { asDateTimeString } from 'src/utils/date.js';
import { writeInformation } from 'src/utils/response.js';
import { UUIDParamDto } from 'src/validation.js';

@ApiTags(ApiTag.Capture)
@Controller('capture')
export class CaptureController {
  constructor(
    private service: CaptureService,
    private uploads: AssetUploadResourceService,
  ) {}

  @Get('capabilities')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.CaptureCatalogRead })
  @Endpoint({
    summary: 'Discover versioned design capture support and account binding',
    history: new HistoryBuilder().added('v3'),
  })
  getCaptureCapabilities(@Auth() auth: AuthDto): Promise<CaptureCapabilitiesDto> {
    return this.service.capabilities(auth);
  }

  @Get('catalog')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.CaptureCatalogRead })
  @Endpoint({
    summary: 'List writable designer album hierarchy and permitted existing tags',
    history: new HistoryBuilder().added('v3'),
  })
  getCaptureCatalog(@Auth() auth: AuthDto): Promise<CaptureCatalogDto> {
    return this.service.catalog(auth);
  }

  @Post('commit')
  @Header('Cache-Control', 'private, no-store')
  @HttpCode(200)
  @Authenticated({ permission: Permission.CaptureCreate })
  @Endpoint({
    summary: 'Commit a capture and its provenance, tags, album membership and receipt atomically',
    history: new HistoryBuilder().added('v3'),
  })
  commitCapture(@Auth() auth: AuthDto, @Body() dto: CaptureCommitDto): Promise<CaptureResponseDto> {
    return this.service.commit(auth, dto);
  }

  @Post('cancel')
  @Header('Cache-Control', 'private, no-store')
  @HttpCode(200)
  @Authenticated({ permission: Permission.CaptureCreate })
  @Endpoint({
    summary: 'Cancel an unpublished capture UUID or return its existing saved receipt',
    history: new HistoryBuilder().added('v3'),
  })
  cancelCapture(@Auth() auth: AuthDto, @Body() dto: CaptureCommitDto): Promise<CaptureCancelResponseDto> {
    return this.service.cancel(auth, dto);
  }

  @Post('albums')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.CaptureCreate })
  @Endpoint({ summary: 'Create an ordinary design album for capture', history: new HistoryBuilder().added('v3') })
  createCaptureAlbum(@Auth() auth: AuthDto, @Body() dto: CaptureAlbumCreateDto): Promise<AlbumResponseDto> {
    return this.service.createAlbum(auth, dto);
  }

  @Post('uploads')
  @Authenticated({ permission: Permission.CaptureCreate })
  @ApiConsumes('image/*', 'video/*', 'audio/*')
  @ApiBody({ schema: { type: 'string', format: 'binary' } })
  @ApiResponse({ status: 201, type: CaptureUploadStateDto })
  @Endpoint({
    summary: 'Stage a private resumable file using its persisted capture UUID',
    description:
      'Upload draft interop 9. Asset-Metadata must include publication: capture, captureId, libraryScope: design, filename and file timestamps. Verified bytes remain private until capture commit.',
    history: new HistoryBuilder().added('v3'),
  })
  async createCaptureUpload(@Auth() auth: AuthDto, @Req() req: Request, @Res() res: Response): Promise<void> {
    writeAssetUploadHeaders(res);
    const { resource } = await this.uploads.create(
      auth,
      assetUploadRequestHeaders(req),
      req,
      (row) => {
        writeAssetUploadHeaders(res, row);
        const location = `/api/capture/uploads/${row.id}`;
        res.setHeader('Location', location);
        writeInformation(res, 104, {
          Location: location,
          'Upload-Draft-Interop-Version': '9',
          'Upload-Complete': '?0',
          'Upload-Limit': String(res.getHeader('Upload-Limit')),
        });
      },
      'capture',
    );
    if (!res.destroyed) {
      writeAssetUploadHeaders(res, resource);
      res.status(201).json(this.state(resource));
    }
  }

  @Get('uploads/:id')
  @Authenticated({ permission: Permission.CaptureCreate })
  @Endpoint({
    summary: 'Recover capture byte verification state without returning media metadata',
    history: new HistoryBuilder().added('v3'),
  })
  async getCaptureUpload(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CaptureUploadStateDto> {
    await this.uploads.captureResource(auth, id);
    const { resource } = await this.uploads.result(auth, id);
    writeAssetUploadHeaders(res, resource);
    return this.state(resource);
  }

  @Head('uploads/:id')
  @Authenticated({ permission: Permission.CaptureCreate })
  @Endpoint({
    summary: 'Read the durable acknowledged capture upload offset',
    history: new HistoryBuilder().added('v3'),
  })
  async getCaptureUploadOffset(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Res() res: Response,
  ): Promise<void> {
    writeAssetUploadHeaders(res, await this.uploads.captureResource(auth, id));
    res.status(204).end();
  }

  @Patch('uploads/:id')
  @Authenticated({ permission: Permission.CaptureCreate })
  @ApiConsumes('application/partial-upload')
  @ApiBody({ schema: { type: 'string', format: 'binary' } })
  @ApiResponse({ status: 200, type: CaptureUploadStateDto })
  @Endpoint({
    summary: 'Append acknowledged capture bytes without publishing an asset',
    history: new HistoryBuilder().added('v3'),
  })
  async appendCaptureUpload(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.uploads.captureResource(auth, id);
    writeAssetUploadHeaders(res);
    try {
      const { resource } = await this.uploads.append(auth, id, assetUploadRequestHeaders(req), req);
      if (!res.destroyed) {
        writeAssetUploadHeaders(res, resource);
        res.status(200).json(this.state(resource));
      }
    } catch (error) {
      if (error instanceof ConflictException) {
        const detail = error.getResponse();
        if (typeof detail === 'object' && 'expectedOffset' in detail && typeof detail.expectedOffset === 'number') {
          res.setHeader('Upload-Offset', detail.expectedOffset);
          res.setHeader('Upload-Complete', '?0');
        }
      }
      throw error;
    }
  }

  @Delete('uploads/:id')
  @Authenticated({ permission: Permission.CaptureCreate })
  @Endpoint({ summary: 'Cancel an unpublished capture resource', history: new HistoryBuilder().added('v3') })
  async cancelCaptureUpload(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Res() res: Response): Promise<void> {
    await this.uploads.captureResource(auth, id);
    await this.uploads.cancel(auth, id);
    writeAssetUploadHeaders(res);
    res.status(204).end();
  }

  private state(row: AssetUploadResource): CaptureUploadStateDto {
    return {
      id: row.id,
      offset: row.offset,
      ready: row.state === 'verified' || row.state === 'published',
      expiresAt: asDateTimeString(row.expiresAt),
    };
  }
}
