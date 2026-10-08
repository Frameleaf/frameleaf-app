import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Next,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { NextFunction, Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  AssetDevelopArtifactResponseDto,
  AssetDevelopFileQueryDto,
  AssetDevelopFillGenerateDto,
  AssetDevelopPreviewDto,
  AssetDevelopResponseDto,
  AssetDevelopRevertDto,
  AssetDevelopRevisionParamDto,
  AssetDevelopRevisionResponseDto,
  AssetDevelopSaveDto,
  AssetDevelopSemanticMaskDto,
} from 'src/dtos/asset-develop.dto.js';
import { ApiTag, Permission, RouteKey } from 'src/enum.js';
import { Auth, Authenticated, FileResponse, OriginalTransfer } from 'src/middleware/auth.guard.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { AssetDevelopService } from 'src/services/asset-develop.service.js';
import { sendFile } from 'src/utils/file.js';
import { UUIDParamDto } from 'src/validation.js';

const history = () => new HistoryBuilder().added('v3.2.0').alpha('v3.2.0');

/**
 * Still-image develop recipes (FL-113). Every route re-checks asset access through the existing
 * edit permissions; the original file is never modified by any of them.
 */
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
export class AssetDevelopController {
  constructor(
    private service: AssetDevelopService,
    private logger: LoggingRepository,
  ) {}

  @Get(':id/develop')
  @Authenticated({ permission: Permission.AssetEditGet })
  @Endpoint({
    summary: 'List develop versions of an asset',
    description:
      'Every saved still-image edit recipe for the asset, newest first, with its render state and which one is current.',
    history: history(),
  })
  getAssetDevelop(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<AssetDevelopResponseDto> {
    return this.service.get(auth, id);
  }

  @Put(':id/develop')
  @Authenticated({ permission: Permission.AssetEditCreate })
  @Endpoint({
    summary: 'Save a develop recipe as a new version',
    description:
      'Stores the recipe as the next revision of the asset and, by default, queues the edited master render. The original file is never changed.',
    history: history(),
  })
  saveAssetDevelop(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: AssetDevelopSaveDto,
  ): Promise<AssetDevelopRevisionResponseDto> {
    return this.service.save(auth, id, dto);
  }

  @Post(':id/develop/preview')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({
    content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
    headers: {
      'X-Frameleaf-HDR-Histogram': {
        description:
          'Optional version 1 JSON histogram from linear HDR preview pixels, in stops relative to 203-nit reference white; see native API contract.',
        schema: { type: 'string' },
      },
    },
  })
  @Authenticated({ permission: Permission.AssetEditGet })
  @Endpoint({
    summary: 'Render a develop preview',
    description: 'Renders the recipe from the original at preview size and returns the image; nothing is stored.',
    history: history(),
  })
  async previewAssetDevelop(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: AssetDevelopPreviewDto,
    @Res() res: Response,
  ) {
    const controller = new AbortController();
    const abandon = () => controller.abort();
    res.once('close', abandon);
    if (res.destroyed) abandon();
    try {
      const { buffer, contentType, histogram } = await this.service.preview(auth, id, dto, controller.signal);
      if (!res.destroyed) {
        res.set({
          'Content-Type': contentType,
          'Cache-Control': 'private, no-store',
          'Content-Length': String(buffer.length),
          ...(histogram && {
            'X-Frameleaf-HDR-Histogram': JSON.stringify(histogram),
            'Access-Control-Expose-Headers': 'X-Frameleaf-HDR-Histogram',
          }),
        });
        res.end(buffer);
      }
    } finally {
      res.removeListener('close', abandon);
    }
  }

  @Post(':id/develop/masks/propose')
  @Authenticated({ permission: Permission.AssetEditCreate })
  @Endpoint({
    summary: 'Suggest a subject or sky mask locally',
    description:
      'Runs on the instance-local ML worker and stores the proposal as a mask artifact of this photo. Without `coordinates` (or with `sensor-active`) the original must be a RAW and the mask covers its unrotated sensor canvas, for version 2 recipes. With `coordinates: "original"` any still works and the mask covers the whole original (EXIF orientation applied); reference it as the `artifact` of a version 1 `subject`, `sky` or `background` mask.',
    history: history(),
  })
  async proposeAssetDevelopMask(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: AssetDevelopSemanticMaskDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AssetDevelopArtifactResponseDto> {
    const controller = new AbortController();
    const abandon = () => controller.abort();
    res.once('close', abandon);
    if (res.destroyed) abandon();
    try {
      return await this.service.proposeSemanticMask(auth, id, dto, controller.signal);
    } finally {
      res.removeListener('close', abandon);
    }
  }

  @Post(':id/develop/fills/generate')
  @Authenticated({ permission: Permission.AssetEditCreate })
  @Endpoint({
    summary: 'Generate a Clean Up Remove fill',
    description:
      "Fills the area (`region` or `strokes`, in original-image fractions, as the Remove operation will carry it) on the instance-local ML worker and stores the result as a fill artifact covering the area's bounding box. Reference its `id` as the Remove operation's `fill`. Answers 503 with code `develop_inpaint_unavailable` while the worker has no inpainting model.",
    history: history(),
  })
  async generateAssetDevelopFill(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: AssetDevelopFillGenerateDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AssetDevelopArtifactResponseDto> {
    const controller = new AbortController();
    const abandon = () => controller.abort();
    res.once('close', abandon);
    if (res.destroyed) abandon();
    try {
      return await this.service.generateFill(auth, id, dto, controller.signal);
    } finally {
      res.removeListener('close', abandon);
    }
  }

  @Post(':id/develop/revert')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AssetEditCreate })
  @Endpoint({
    summary: 'Revert to the original or an earlier develop version',
    description:
      'Makes the named rendered version current, or the original when no version is named. History and files are kept.',
    history: history(),
  })
  revertAssetDevelop(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: AssetDevelopRevertDto,
  ): Promise<AssetDevelopResponseDto> {
    return this.service.revert(auth, id, dto);
  }

  @Post(':id/develop/revisions/:revisionId/render')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AssetEditCreate })
  @Endpoint({
    summary: 'Render a develop version',
    description: 'Queues (or re-queues after a failure or cancellation) the edited master render of a saved version.',
    history: history(),
  })
  renderAssetDevelopRevision(
    @Auth() auth: AuthDto,
    @Param() { id, revisionId }: AssetDevelopRevisionParamDto,
  ): Promise<AssetDevelopRevisionResponseDto> {
    return this.service.render(auth, id, revisionId);
  }

  @Delete(':id/develop/revisions/:revisionId/render')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AssetEditCreate })
  @Endpoint({
    summary: 'Cancel a develop render',
    description:
      'Stops a queued or running render of the version. Files already rendered for other versions are untouched.',
    history: history(),
  })
  cancelAssetDevelopRender(
    @Auth() auth: AuthDto,
    @Param() { id, revisionId }: AssetDevelopRevisionParamDto,
  ): Promise<AssetDevelopRevisionResponseDto> {
    return this.service.cancel(auth, id, revisionId);
  }

  @Get(':id/develop/revisions/:revisionId/file')
  @FileResponse()
  @Authenticated({ permission: Permission.AssetEditGet })
  // FL-161: can stream the edited full-resolution master
  @OriginalTransfer()
  @Endpoint({
    summary: 'View a rendered develop file',
    description: 'Streams the edited master or the preview rendered for the version.',
    history: history(),
  })
  async viewAssetDevelopFile(
    @Auth() auth: AuthDto,
    @Param() { id, revisionId }: AssetDevelopRevisionParamDto,
    @Query() { kind, dynamicRange, format }: AssetDevelopFileQueryDto,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    const controller = new AbortController();
    const abandon = () => controller.abort();
    res.once('close', abandon);
    if (res.destroyed) abandon();
    try {
      // Resolve admission/format errors before sendFile's filesystem-only 404 handling.
      const file = await this.service.getFile(auth, id, revisionId, kind, dynamicRange, format, controller.signal);
      await sendFile(res, next, () => file, this.logger);
    } finally {
      res.removeListener('close', abandon);
    }
  }
}
