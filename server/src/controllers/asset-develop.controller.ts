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
import { ApiTags } from '@nestjs/swagger';
import type { NextFunction, Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  AssetDevelopFileQueryDto,
  AssetDevelopPreviewDto,
  AssetDevelopResponseDto,
  AssetDevelopRevertDto,
  AssetDevelopRevisionParamDto,
  AssetDevelopRevisionResponseDto,
  AssetDevelopSaveDto,
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
  @FileResponse()
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
    const { buffer, contentType } = await this.service.preview(auth, id, dto);
    res.set({
      'Content-Type': contentType,
      'Cache-Control': 'private, no-store',
      'Content-Length': String(buffer.length),
    });
    res.end(buffer);
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
    @Query() { kind }: AssetDevelopFileQueryDto,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    await sendFile(res, next, () => this.service.getFile(auth, id, revisionId, kind), this.logger);
  }
}
