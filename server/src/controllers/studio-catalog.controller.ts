import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { StudioMediaFactsDto, StudioResourceInventoryDto } from 'src/dtos/studio-inventory.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { StudioCatalogService } from 'src/services/studio-catalog.service.js';
import { UUIDParamDto } from 'src/validation.js';

/**
 * What a native Studio client reads before it edits (FL-348): the resources this deployment may use,
 * with their licences and capabilities, and the media facts behind a placed clip.
 */
@ApiTags(ApiTag.StudioProjects)
@Controller('studio')
export class StudioCatalogController {
  constructor(private service: StudioCatalogService) {}

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
