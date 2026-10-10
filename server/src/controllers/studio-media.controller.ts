import { Controller, Get, Next, Param, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { NextFunction, Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  AssetFilmstripOptionsDto,
  AssetFilmstripResponseDto,
  AssetFilmstripSpriteOptionsDto,
  AssetWaveformOptionsDto,
  AssetWaveformResponseDto,
} from 'src/dtos/studio-media.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated, FileResponse } from 'src/middleware/auth.guard.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StudioMediaService } from 'src/services/studio-media.service.js';
import { sendFile } from 'src/utils/file.js';
import { UUIDParamDto } from 'src/validation.js';

/**
 * Studio timeline media for the native iPad and Android Studio apps: filmstrip sprite sheets and
 * audio waveform peaks of a video, under the same access rules as its thumbnail.
 */
@ApiTags(ApiTag.Assets)
@Controller('assets')
export class StudioMediaController {
  constructor(
    private service: StudioMediaService,
    private logger: LoggingRepository,
  ) {}

  @Get(':id/filmstrip')
  @Authenticated({ permission: Permission.AssetView, sharedLink: true })
  @Endpoint({
    summary: 'Get video filmstrip',
    description:
      'The index of a filmstrip sprite sheet for a Studio timeline: `count` frames sampled at the centre of equal slices of the video, each `height` pixels high, laid out left to right and top to bottom. Returns each frame timestamp and its position in the sprite; fetch the image from `/assets/{id}/filmstrip/sprite` with the same parameters and `version`. Made on first request from the playback rendition, cached, and remade when the video changes. 404 for anything that is not a video.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  getAssetFilmstrip(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Query() dto: AssetFilmstripOptionsDto,
  ): Promise<AssetFilmstripResponseDto> {
    return this.service.getFilmstrip(auth, id, dto);
  }

  @Get(':id/filmstrip/sprite')
  @FileResponse()
  @Authenticated({ permission: Permission.AssetView, sharedLink: true })
  @Endpoint({
    summary: 'View video filmstrip sprite',
    description:
      'The filmstrip sprite sheet (JPEG or WebP) the filmstrip index describes, for the same `count`, `height` and `format`. With `version`, 404 when the video changed since that index was read.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  async viewAssetFilmstripSprite(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Query() dto: AssetFilmstripSpriteOptionsDto,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    await sendFile(res, next, () => this.service.viewFilmstripSprite(auth, id, dto), this.logger);
  }

  @Get(':id/waveform')
  @Authenticated({ permission: Permission.AssetView, sharedLink: true })
  @Endpoint({
    summary: 'Get video audio waveform',
    description:
      'Minimum and maximum sample per bucket of the video’s first audio track, normalized to -1..1, mono or per channel, for a Studio timeline. A video without audio returns `hasAudio: false` and no channels; anything that is not a video is 404. Made on first request from the playback rendition, cached, and remade when the video changes.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  getAssetWaveform(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Query() dto: AssetWaveformOptionsDto,
  ): Promise<AssetWaveformResponseDto> {
    return this.service.getWaveform(auth, id, dto);
  }
}
