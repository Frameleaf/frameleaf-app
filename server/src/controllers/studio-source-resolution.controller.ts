import { Body, Controller, Header, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { StudioSourceResolutionDto, StudioSourceResolutionRequestDto } from 'src/dtos/studio-source-resolution.dto.js';
import { ApiTag } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { StudioSourceResolutionService } from 'src/services/studio-source-resolution.service.js';
import { UUIDv7ParamDto } from 'src/validation.js';

@ApiTags(ApiTag.StudioProjects)
@Controller('studio/projects')
export class StudioSourceResolutionController {
  constructor(private service: StudioSourceResolutionService) {}

  @Post(':id/source-resolutions')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Authenticated()
  @Endpoint({
    summary: 'Resolve an exact saved Studio source',
    description:
      'Closed immutable Lottie bytes bound to the acknowledged saved revision, current session, source admission and original-download permission. Expires within five seconds.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  resolveStudioProjectSource(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
    @Body() dto: StudioSourceResolutionRequestDto,
  ): Promise<StudioSourceResolutionDto> {
    return this.service.resolve(auth, id, dto);
  }
}
