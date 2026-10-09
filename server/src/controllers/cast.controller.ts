import { Body, Controller, Get, HttpCode, HttpStatus, Next, NotFoundException, Param, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type NextFunction, type Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { AssetMediaSize } from 'src/dtos/asset-media.dto.js';
import { CastMediaTokenParamDto, CastMediaUrlCreateDto, CastMediaUrlResponseDto } from 'src/dtos/cast.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated, FileResponse } from 'src/middleware/auth.guard.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { CastService } from 'src/services/cast.service.js';
import { CastMediaKind } from 'src/utils/cast-media.js';
import { ImmichFileResponse, sendFile } from 'src/utils/file.js';
import { UUIDParamDto } from 'src/validation.js';

const history = () => new HistoryBuilder().added('v3');

/**
 * Cast receivers: item-scoped, short-lived signed media URLs that work without the app's session
 * token or cookies (native Frameleaf apps, Google Cast).
 */
@ApiTags(ApiTag.Assets)
@Controller()
export class CastController {
  constructor(
    private service: CastService,
    private media: AssetMediaService,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(CastController.name);
  }

  @Post('assets/:id/cast')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AssetView })
  @Endpoint({
    summary: 'Create a Cast media URL',
    description:
      'Returns a signed URL path for one rendition (original, preview or video) of one item, for a Cast receiver that cannot send the session token or cookies. It expires after 15 minutes, serves only this item, and stops working when the session or API key is revoked, access is lost, the item becomes Locked or hidden for the account, or an administrator turns casting off for the account (refused with 403 here in those cases). Shared links cannot cast. The original needs download permission.',
    history: history(),
  })
  createCastMediaUrl(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: CastMediaUrlCreateDto,
  ): Promise<CastMediaUrlResponseDto> {
    return this.service.createMediaUrl(auth, id, dto);
  }

  @Get('cast/:token')
  @FileResponse()
  @Authenticated({ public: true })
  @Endpoint({
    summary: 'Read Cast media',
    description:
      'Streams the rendition a signed Cast URL names, without a session token or cookies (byte ranges supported for video). Answers 401 for an invalid, tampered or expired URL and 403 when casting is no longer allowed.',
    history: history(),
  })
  async readCastMedia(@Param() { token }: CastMediaTokenParamDto, @Res() res: Response, @Next() next: NextFunction) {
    await sendFile(
      res,
      next,
      async () => {
        const { auth, assetId, kind } = await this.service.resolveMediaUrl(token);
        switch (kind) {
          case CastMediaKind.Original: {
            return this.media.downloadOriginal(auth, assetId, { edited: true });
          }
          case CastMediaKind.Video: {
            return this.media.playbackVideo(auth, assetId, true);
          }
          default: {
            const preview = await this.media.viewThumbnail(auth, assetId, {
              size: AssetMediaSize.PREVIEW,
              edited: true,
            });
            if (!(preview instanceof ImmichFileResponse)) {
              // the preview is not generated yet; the original is a separate, explicitly issued URL
              throw new NotFoundException('This item has no preview yet');
            }
            return preview;
          }
        }
      },
      this.logger,
    );
  }
}
