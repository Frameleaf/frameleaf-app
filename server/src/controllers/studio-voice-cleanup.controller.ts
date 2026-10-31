import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  StudioVoiceAnalysisCreateDto,
  StudioVoiceAnalysisDto,
  StudioVoiceCleanupCreateDto,
  StudioVoiceCleanupDto,
  StudioVoiceCleanupParamDto,
  StudioVoiceCleanupQueuedDto,
} from 'src/dtos/studio-voice-cleanup.dto.js';
import { ApiTag } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { StudioVoiceCleanupService } from 'src/services/studio-voice-cleanup.service.js';
import { UUIDv7ParamDto } from 'src/validation.js';

/** Studio "Clean up voice" (FL-637): one audio clip at a time, on the person's own hardware. */
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/projects')
export class StudioVoiceCleanupController {
  constructor(private service: StudioVoiceCleanupService) {}

  @Post(':id/voice-analysis')
  @HttpCode(HttpStatus.OK)
  @Authenticated()
  @Endpoint({
    summary: 'Find the noise in a Studio clip',
    description:
      'Owner only. A quick look at up to the first minute of one audio clip on the main timeline of the head revision: wind, hum and buzz (with its mains frequency), background noise and room echo. It runs on this server or a computer at home, never on Frameleaf Cloud. Nothing is kept.',
    history: new HistoryBuilder().added('v3.4.0').alpha('v3.4.0'),
  })
  analyzeStudioVoice(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
    @Body() dto: StudioVoiceAnalysisCreateDto,
  ): Promise<StudioVoiceAnalysisDto> {
    return this.service.analyze(auth, id, dto.clipId);
  }

  @Post(':id/voice-cleanups')
  @HttpCode(HttpStatus.CREATED)
  @Authenticated()
  @Endpoint({
    summary: 'Clean up the voice in a Studio clip',
    description:
      'Owner only. Queues a clean-up of one audio clip on the main timeline of the head revision: the chosen noises are removed at the chosen strength, on this server or a computer at home (never Frameleaf Cloud). A clip cleaned before is cleaned again from its original. The cleaned sound is kept with the project as an audio import; the original is never changed and the graph is not edited. Follow the job in Activity (`/media-operations/{id}`, cancel with `/media-operations/{id}/cancel`).',
    history: new HistoryBuilder().added('v3.4.0').alpha('v3.4.0'),
  })
  createStudioVoiceCleanup(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
    @Body() dto: StudioVoiceCleanupCreateDto,
  ): Promise<StudioVoiceCleanupQueuedDto> {
    return this.service.create(auth, id, dto);
  }

  @Get(':id/voice-cleanups/:voiceCleanupId')
  @Authenticated()
  @Endpoint({
    summary: 'Get a Studio voice clean-up',
    description:
      'Owner only. The job status and progress, and once it has completed the cleaned sound’s project import and where the clip’s window starts in it.',
    history: new HistoryBuilder().added('v3.4.0').alpha('v3.4.0'),
  })
  getStudioVoiceCleanup(
    @Auth() auth: AuthDto,
    @Param() { id, voiceCleanupId }: StudioVoiceCleanupParamDto,
  ): Promise<StudioVoiceCleanupDto> {
    return this.service.get(auth, id, voiceCleanupId);
  }
}
