import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { StudioReframeResponseDto } from 'src/dtos/studio-reframe.dto.js';
import { ApiTag } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { StudioReframeService } from 'src/services/studio-reframe.service.js';
import { UUIDv7ParamDto } from 'src/validation.js';

/** FL-563: the automatic framing a vertical or square export starts from. */
@ApiTags(ApiTag.StudioProjects)
@Controller('studio')
export class StudioReframeController {
  constructor(private service: StudioReframeService) {}

  @Get('projects/:id/framing')
  @Authenticated()
  @Endpoint({
    summary: 'Get the automatic framing of a Studio project’s shots',
    description:
      'Owner only. For a vertical (9:16) or square (1:1) export of the head revision: where the subject is through each video and still on the main timeline, from the faces found in the source and in a few frames sampled through each video clip on this server or a computer on your home network. Shots without a face are centred. Nothing is stored and the project is not changed; send the framing back with `POST /studio/projects/{id}/exports`.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getStudioFraming(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<StudioReframeResponseDto> {
    return this.service.framing(auth, id);
  }
}
