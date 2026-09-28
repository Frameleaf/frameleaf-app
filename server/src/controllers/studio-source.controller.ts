import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { StudioRestoredVersionDto } from 'src/dtos/studio-source.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { StudioResourceService } from 'src/services/studio-resource.service.js';
import { UUIDParamDto } from 'src/validation.js';

/**
 * Studio sources beyond the library original (FL-115): an accepted AI restoration the person chose
 * with Use in Studio. The same rules decide it here and when a project that places it is resolved.
 */
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/restored-versions')
export class StudioSourceController {
  constructor(private service: StudioResourceService) {}

  @Get(':id')
  @Authenticated({ permission: Permission.AssetEditGet })
  @Endpoint({
    summary: 'Get a restored version for Studio',
    description:
      'An accepted restoration of one of your photos or videos as a Studio media bin entry: the media id a clip of it carries, its size and length, and whether it can be placed now. A discarded, expired or Locked one says so; someone else’s is not found.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getStudioRestoredVersion(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<StudioRestoredVersionDto> {
    return this.service.getRestoredVersion(auth, id);
  }
}
