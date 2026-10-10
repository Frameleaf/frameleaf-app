import { Controller, Get, Next, Param, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { NextFunction, Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  StudioFontCatalogDto,
  StudioFontParamDto,
  StudioMediaFactsDto,
  StudioResourceInventoryDto,
} from 'src/dtos/studio-inventory.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated, FileResponse } from 'src/middleware/auth.guard.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StudioCatalogService } from 'src/services/studio-catalog.service.js';
import { sendFile } from 'src/utils/file.js';
import { UUIDParamDto } from 'src/validation.js';

/**
 * What a native Studio client reads before it edits (FL-348): the resources this deployment may use,
 * with their licences and capabilities, and the media facts behind a placed clip.
 */
@ApiTags(ApiTag.StudioProjects)
@Controller('studio')
export class StudioCatalogController {
  constructor(
    private service: StudioCatalogService,
    private logger: LoggingRepository,
  ) {}

  @Get('resources')
  @Authenticated()
  @Endpoint({
    summary: 'List the Studio resources this server may use',
    description:
      'Every font, LUT, audio track, model, voice and tool the Studio engine can reach that has a reviewed rights decision: its licence, whether it may be redistributed, run on this server or run on Frameleaf Cloud, why a use was withheld, and the worker capability that runs it. A resource not listed is refused.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getStudioResources(): StudioResourceInventoryDto {
    return this.service.getResourceInventory();
  }

  @Get('fonts')
  @Authenticated()
  @Endpoint({
    summary: 'List the title fonts bundled with this server',
    description:
      'The title font families a native Studio client draws (graph protocol 14.3.5): each family as a graph names it, its package, version, licence and copyright line, and every bundled file with its weight, style, Unicode subset, format, size and SHA-256. Each font is listed twice: as WOFF2, and decoded to TTF for a client that cannot load WOFF2. The files are served by GET /studio/fonts/{sha256}.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getStudioFonts(): StudioFontCatalogDto {
    return this.service.getFontCatalog();
  }

  @Get('fonts/:sha256')
  @FileResponse()
  @Authenticated()
  @Endpoint({
    summary: 'Download a bundled title font file',
    description:
      'The bytes of one file of GET /studio/fonts, named by its SHA-256. Only a hash the catalogue lists is served; the answer for a hash never changes and may be cached for good. Check the hash after download.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  async getStudioFontFile(@Res() res: Response, @Next() next: NextFunction, @Param() { sha256 }: StudioFontParamDto) {
    await sendFile(res, next, () => this.service.getFontFile(sha256), this.logger);
  }

  @Get('assets/:id/media-facts')
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Get the Studio media facts of an asset',
    description:
      'What placing this photo or video in Studio needs (graph protocol 3.5), read from the original: its exact frame rate as a reduced fraction, whether it has an audio track and its codec, its display size and length. When the original cannot be read, the stored metadata is answered and `source` says so.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getStudioMediaFacts(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<StudioMediaFactsDto> {
    return this.service.getMediaFacts(auth, id);
  }
}
