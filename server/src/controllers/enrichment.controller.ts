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
  EnrichmentOptionsResponseDto,
  EnrichmentPlanCreateDto,
  EnrichmentPlanResponseDto,
  EnrichmentPreviewRequestDto,
  EnrichmentPreviewResponseDto,
  VideoMomentCoverDto,
  VideoMomentCreateDto,
  VideoMomentDto,
  VideoMomentParamDto,
  VideoMomentSearchDto,
  VideoMomentSearchResponseDto,
  VideoMomentSimilarDto,
  VideoMomentUpdateDto,
  VideoMomentsResponseDto,
} from 'src/dtos/enrichment.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated, FileResponse } from 'src/middleware/auth.guard.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { EnrichmentPlanService } from 'src/services/enrichment-plan.service.js';
import { VideoMomentIndexService } from 'src/services/video-moment-index.service.js';
import { sendFile } from 'src/utils/file.js';
import { UUIDParamDto, UUIDv7ParamDto } from 'src/validation.js';

/**
 * Sample-first enrichment and the timestamped moment workbench (FL-59, `REC-101`).
 *
 * The options and preview routes are an administrator's: they name processing destinations and
 * draft models. Plans, moments and moment search are the signed-in account's own, over media it may
 * read or change; a Locked video answers only to its owner's unlocked session.
 */
@ApiTags(ApiTag.Enrichment)
@Controller('enrichment')
export class EnrichmentController {
  constructor(
    private logger: LoggingRepository,
    private plans: EnrichmentPlanService,
    private moments: VideoMomentIndexService,
  ) {
    this.logger.setContext(EnrichmentController.name);
  }

  @Get('options')
  @Authenticated({ admin: true })
  @Endpoint({
    summary: 'Get enrichment options',
    description:
      'The processing destinations an enrichment preview or plan may use, with whether each would take the work now, the routed destinations and the saved models.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  getEnrichmentOptions(): Promise<EnrichmentOptionsResponseDto> {
    return this.plans.getOptions();
  }

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ admin: true })
  @Endpoint({
    summary: 'Preview an enrichment change',
    description:
      'Describes a few samples with a draft model or prompt, one at a time, on a named destination. Nothing is written: stored descriptions, tags, Locked state, embeddings and frames are unchanged.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  previewEnrichment(
    @Auth() auth: AuthDto,
    @Body() dto: EnrichmentPreviewRequestDto,
  ): Promise<EnrichmentPreviewResponseDto> {
    return this.plans.preview(auth, dto);
  }

  @Post('plans')
  @HttpCode(HttpStatus.CREATED)
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'Queue an enrichment plan',
    description:
      'Runs the chosen stages, and the ones they need, on a frozen list of assets in the background, pinned to the destinations and configuration admitted now. Moment captions are never added unless chosen. Submitting the same requestKey again returns the existing plan.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  createEnrichmentPlan(
    @Auth() auth: AuthDto,
    @Body() dto: EnrichmentPlanCreateDto,
  ): Promise<EnrichmentPlanResponseDto> {
    return this.plans.createPlan(auth, dto);
  }

  @Get('plans/:id')
  @Authenticated()
  @Endpoint({
    summary: 'Get an enrichment plan',
    description:
      'The plan with every asset and stage: queued, running, skipped, failed, completed or cancelled. Read from the durable record, so it is the same after a reload. Cancel, pause, resume and retry are the media operation routes.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  getEnrichmentPlan(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<EnrichmentPlanResponseDto> {
    return this.plans.getPlan(auth, id);
  }

  @Post('moments/search')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Search video moments',
    description:
      'Finds timestamped moments inside your videos by meaning, against the frame index, and by words in captions and typed transcripts.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  searchVideoMoments(@Auth() auth: AuthDto, @Body() dto: VideoMomentSearchDto): Promise<VideoMomentSearchResponseDto> {
    return this.moments.search(auth, dto);
  }

  @Get('frames/:id')
  @FileResponse()
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Get a video moment frame',
    description: 'The image of one reusable video frame, under the same access as its video.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  async getVideoMomentFrame(
    @Res() res: Response,
    @Next() next: NextFunction,
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
  ) {
    await sendFile(res, next, () => this.moments.getFrameFile(auth, id), this.logger);
  }

  @Get('frames/:id/similar')
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Find moments like a video frame',
    description:
      "Finds the moments nearest one frame's stored search embedding across your videos, including other times in the same video, never the frame itself. Nothing is sent to a model and nothing is written.",
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  searchSimilarVideoMoments(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
    @Query() dto: VideoMomentSimilarDto,
  ): Promise<VideoMomentSearchResponseDto> {
    return this.moments.searchSimilar(auth, id, dto);
  }

  @Get('videos/:id/moments')
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Get video moments',
    description:
      'The reusable frames of a video ranked best first, its cover, its generated and manual moments, and what they were made from, with any that are out of date marked.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  getVideoMoments(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<VideoMomentsResponseDto> {
    return this.moments.getMoments(auth, id);
  }

  @Put('videos/:id/cover')
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'Choose a video cover frame',
    description:
      'Keeps the chosen frame as a time in the video, so it survives the frames being cut again. Null returns to the best-ranked frame.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  setVideoMomentCover(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: VideoMomentCoverDto,
  ): Promise<VideoMomentsResponseDto> {
    return this.moments.setCover(auth, id, dto);
  }

  @Post('videos/:id/moments')
  @HttpCode(HttpStatus.CREATED)
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'Add a video moment',
    description: 'Adds your own moment, with an optional title and typed transcript. Refreshing never removes it.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  createVideoMoment(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: VideoMomentCreateDto,
  ): Promise<VideoMomentDto> {
    return this.moments.createMoment(auth, id, dto);
  }

  @Put('videos/:id/moments/:momentId')
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'Update a video moment',
    description: 'Edits one of your own moments. Generated moments are refreshed, not edited.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  updateVideoMoment(
    @Auth() auth: AuthDto,
    @Param() { id, momentId }: VideoMomentParamDto,
    @Body() dto: VideoMomentUpdateDto,
  ): Promise<VideoMomentDto> {
    return this.moments.updateMoment(auth, id, momentId, dto);
  }

  @Delete('videos/:id/moments/:momentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'Delete a video moment',
    description: 'Removes one of your own moments. Generated moments are refreshed, not deleted.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  deleteVideoMoment(@Auth() auth: AuthDto, @Param() { id, momentId }: VideoMomentParamDto): Promise<void> {
    return this.moments.deleteMoment(auth, id, momentId);
  }
}
