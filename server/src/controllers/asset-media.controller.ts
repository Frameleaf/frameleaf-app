import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Next,
  Param,
  ParseFilePipe,
  Post,
  Query,
  Req,
  Res,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiHeader, ApiResponse, ApiTags } from '@nestjs/swagger';
import { type NextFunction, type Request, type Response } from 'express';
import type { UploadFiles } from 'src/types.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  AssetBulkUploadCheckResponseDto,
  AssetMediaResponseDto,
  AssetMediaStatus,
} from 'src/dtos/asset-media-response.dto.js';
import {
  AssetBulkUploadCheckDto,
  AssetMediaCreateDto,
  AssetMediaOptionsDto,
  AssetMediaSize,
  AssetPlaybackOptionsDto,
} from 'src/dtos/asset-media.dto.js';
import { AssetDownloadOriginalDto } from 'src/dtos/asset.dto.js';
import { type AuthDto } from 'src/dtos/auth.dto.js';
import { VideoEditVersionParamsDto } from 'src/dtos/editing.dto.js';
import { ApiTag, CacheControl, ImmichHeader, Permission, RouteKey } from 'src/enum.js';
import { AssetUploadInterceptor } from 'src/middleware/asset-upload.interceptor.js';
import { Auth, Authenticated, FileResponse, OriginalTransfer } from 'src/middleware/auth.guard.js';
import { FileUploadInterceptor, getFiles } from 'src/middleware/file-upload.interceptor.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { type AssetMediaRedirectResponse, AssetMediaService } from 'src/services/asset-media.service.js';
import { AssetRestorationService } from 'src/services/asset-restoration.service.js';
import { ImmichFileResponse, sendFile } from 'src/utils/file.js';
import { FileNotEmptyValidator, UUIDParamDto } from 'src/validation.js';

@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
export class AssetMediaController {
  constructor(
    private logger: LoggingRepository,
    private service: AssetMediaService,
    private restorationService: AssetRestorationService,
  ) {}

  /**
   * FL-115: the owner's chosen restored version replaces what their own sessions play or view;
   * otherwise the ordinary file, revalidated while a switch is possible.
   */
  private async withPlaybackChoice(
    auth: AuthDto,
    id: string,
    view: 'video' | 'preview' | 'fullsize',
    ordinary: () => Promise<ImmichFileResponse | AssetMediaRedirectResponse>,
  ): Promise<ImmichFileResponse | AssetMediaRedirectResponse> {
    const choice = await this.restorationService.getPlaybackChoice(auth, id, view);
    if (choice.file) {
      return choice.file;
    }
    const response = await ordinary();
    return choice.revalidate && response instanceof ImmichFileResponse
      ? new ImmichFileResponse({ ...response, cacheControl: CacheControl.PrivateWithoutCache })
      : response;
  }

  @Post()
  @Authenticated({ permission: Permission.AssetUpload, sharedLink: true })
  @UseInterceptors(AssetUploadInterceptor, FileUploadInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiHeader({
    name: ImmichHeader.Checksum,
    description:
      'SHA-256 checksum (preferred) or SHA-1 checksum (legacy) for duplicate detection before upload; hex or base64-encoded',
    required: false,
  })
  @ApiBody({ description: 'Asset Upload Information', type: AssetMediaCreateDto })
  @ApiResponse({
    status: 200,
    description: 'Asset is a duplicate',
    type: AssetMediaResponseDto,
  })
  @ApiResponse({
    status: 201,
    description: 'Asset uploaded successfully',
    type: AssetMediaResponseDto,
  })
  @Endpoint({
    summary: 'Upload asset',
    description: 'Uploads a new asset to the server.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  async uploadAsset(
    @Auth() auth: AuthDto,
    @UploadedFiles(new ParseFilePipe({ validators: [new FileNotEmptyValidator(['assetData'])] })) files: UploadFiles,
    @Body() dto: AssetMediaCreateDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AssetMediaResponseDto> {
    const { file, sidecarFile } = getFiles(files);
    const responseDto = await this.service.uploadAsset(auth, dto, file, sidecarFile);

    if (responseDto.status === AssetMediaStatus.DUPLICATE) {
      res.status(HttpStatus.OK);
    }

    return responseDto;
  }

  @Get(':id/edit-versions/:versionId/download')
  @FileResponse()
  @Authenticated({ permission: Permission.AssetDownload })
  @Endpoint({
    summary: 'Download a video version master',
    history: new HistoryBuilder().added('v3.2.0').beta('v3.2.0'),
  })
  async downloadVideoEditVersion(
    @Auth() auth: AuthDto,
    @Param() { id, versionId }: VideoEditVersionParamsDto,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    await sendFile(res, next, () => this.service.downloadVideoEditVersion(auth, id, versionId), this.logger);
  }

  @Get(':id/original')
  @FileResponse()
  @Authenticated({ permission: Permission.AssetDownload, sharedLink: true })
  @OriginalTransfer()
  @Endpoint({
    summary: 'Download original asset',
    description: 'Downloads the original file of the specified asset.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  async downloadAsset(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Query() dto: AssetDownloadOriginalDto,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    await sendFile(res, next, () => this.service.downloadOriginal(auth, id, dto), this.logger);
  }

  @Get(':id/thumbnail')
  @FileResponse()
  @Authenticated({ permission: Permission.AssetView, sharedLink: true })
  @Endpoint({
    summary: 'View asset thumbnail',
    description:
      'Retrieve the thumbnail image for the specified asset. Viewing the fullsize thumbnail might redirect to downloadAsset, which requires a different permission.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  async viewAsset(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Query() dto: AssetMediaOptionsDto,
    @Req() req: Request,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    if (dto.size === AssetMediaSize.Original) {
      this.logger.deprecate(
        'Calling the thumbnail endpoint with size=original is deprecated. Use the :id/original endpoint instead',
      );
      const [_, reqSearch] = req.url.split('?', 2);
      const redirSearchParams = new URLSearchParams(reqSearch);
      redirSearchParams.delete('size');
      return res.redirect('original?' + redirSearchParams.toString());
    }

    const view =
      dto.size === AssetMediaSize.FULLSIZE ? 'fullsize' : dto.size === AssetMediaSize.PREVIEW ? 'preview' : null;
    const viewThumbnailRes = view
      ? await this.withPlaybackChoice(auth, id, view, () => this.service.viewThumbnail(auth, id, dto))
      : await this.service.viewThumbnail(auth, id, dto);

    if (viewThumbnailRes instanceof ImmichFileResponse) {
      await sendFile(res, next, () => Promise.resolve(viewThumbnailRes), this.logger);
    } else {
      // viewThumbnailRes is a AssetMediaRedirectResponse
      // which redirects to the original asset or a specific size to make better use of caching
      const { targetSize } = viewThumbnailRes;
      const [reqPath, reqSearch] = req.url.split('?', 2);
      let redirPath: string;
      const redirSearchParams = new URLSearchParams(reqSearch);
      if (targetSize === 'original') {
        // relative path to this.downloadAsset
        redirPath = 'original';
        redirSearchParams.delete('size');
      } else if (Object.values(AssetMediaSize).includes(targetSize)) {
        redirPath = reqPath;
        redirSearchParams.set('size', targetSize);
      } else {
        throw new Error('Invalid targetSize: ' + targetSize);
      }
      const finalRedirPath = redirPath + '?' + redirSearchParams.toString();
      return res.redirect(finalRedirPath);
    }
  }

  @Get(':id/video/playback')
  @FileResponse()
  @Authenticated({ permission: Permission.AssetView, sharedLink: true })
  @Endpoint({
    summary: 'Play asset video',
    description: 'Streams the video file for the specified asset. This endpoint also supports byte range requests.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  async playAssetVideo(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Query() { edited }: AssetPlaybackOptionsDto,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    // `edited=false` is the quick editor's unedited source for the owner (FL-113), so a chosen
    // restoration does not stand in for it; every other request honours the playback choice.
    await sendFile(
      res,
      next,
      async () =>
        edited === false
          ? this.service.playbackVideo(auth, id, false)
          : ((await this.withPlaybackChoice(auth, id, 'video', () =>
              this.service.playbackVideo(auth, id, edited ?? true),
            )) as ImmichFileResponse),
      this.logger,
    );
  }

  @Post('bulk-upload-check')
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Check bulk upload',
    description: 'Determine which assets have already been uploaded to the server based on their SHA1 checksums.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  @HttpCode(HttpStatus.OK)
  checkBulkUpload(
    @Auth() auth: AuthDto,
    @Body() dto: AssetBulkUploadCheckDto,
  ): Promise<AssetBulkUploadCheckResponseDto> {
    return this.service.bulkUploadCheck(auth, dto);
  }
}
