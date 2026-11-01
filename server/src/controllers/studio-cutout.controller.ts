import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  StudioCutoutCreateDto,
  StudioCutoutDto,
  StudioCutoutParamDto,
  StudioCutoutSubjectsDto,
  StudioCutoutSubjectsQueryDto,
} from 'src/dtos/studio-cutout.dto.js';
import { ApiTag } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { StudioCutoutService } from 'src/services/studio-cutout.service.js';
import { UUIDv7ParamDto } from 'src/validation.js';

/** FL-639: Cut out the subject in a video clip. */
@ApiTags(ApiTag.StudioProjects)
@Controller('studio')
export class StudioCutoutController {
  constructor(private service: StudioCutoutService) {}

  @Get('projects/:id/cutouts/subjects')
  @Authenticated()
  @Endpoint({
    summary: 'List who a Studio cut-out can follow in a clip',
    description:
      'Owner only. The named people face recognition found in the video of one clip on the main timeline of the head revision, largest first, or just the main subject when there is no one.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getStudioCutoutSubjects(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
    @Query() { clipId }: StudioCutoutSubjectsQueryDto,
  ): Promise<StudioCutoutSubjectsDto> {
    return this.service.subjects(auth, id, clipId);
  }

  @Post('projects/:id/cutouts')
  @HttpCode(HttpStatus.ACCEPTED)
  @Authenticated()
  @Endpoint({
    summary: 'Cut out the subject in a Studio clip',
    description:
      'Owner only. Follows one person (from their face) or the main subject through one video clip of the head revision on this server or a computer on your home network, never Frameleaf Cloud. When it completes, the matte is kept with the project as a file; name it on the clip. The original video never changes. Follow the job with `GET /studio/projects/{id}/cutouts/{cutoutId}`.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  createStudioCutout(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
    @Body() dto: StudioCutoutCreateDto,
  ): Promise<StudioCutoutDto> {
    return this.service.create(auth, id, dto);
  }

  @Get('projects/:id/cutouts/:cutoutId')
  @Authenticated()
  @Endpoint({
    summary: 'Get a Studio cut-out',
    description: 'Owner only. Where the cut-out is and, once it completed, the matte to name on the clip.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getStudioCutout(@Auth() auth: AuthDto, @Param() { id, cutoutId }: StudioCutoutParamDto): StudioCutoutDto {
    return this.service.get(auth, id, cutoutId);
  }
}
