import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  MediaOperationBulkCreateDto,
  MediaOperationDetailDto,
  MediaOperationDto,
  MediaOperationListResponseDto,
  MediaOperationSearchDto,
  MediaOperationStatisticsDto,
} from 'src/dtos/media-operation.dto.js';
import { ApiTag } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { MediaOperationService } from 'src/services/media-operation.service.js';
import { UUIDv7ParamDto } from 'src/validation.js';

/**
 * The durable job feed behind Activity (FL-43, FL-104).
 *
 * Everything here is owner-scoped. The one administrator route returns aggregate counts and
 * nothing else; there is no route that shows an administrator another account's jobs.
 *
 * Route order matters: `statistics` and `bulk` are declared before `:id` so neither is matched as an id.
 */
@ApiTags(ApiTag.MediaOperations)
@Controller('media-operations')
export class MediaOperationController {
  constructor(private service: MediaOperationService) {}

  @Get()
  @Authenticated()
  @Endpoint({
    summary: 'List your media operations',
    description:
      'Durable renders, restorations and edits belonging to the signed-in account, newest first. These survive closing the browser and restarting the server.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  searchMediaOperations(
    @Auth() auth: AuthDto,
    @Query() dto: MediaOperationSearchDto,
  ): Promise<MediaOperationListResponseDto> {
    return this.service.search(auth, dto);
  }

  @Get('statistics')
  @Authenticated({ admin: true })
  @Endpoint({
    summary: 'Get media operation statistics',
    description:
      'Operational counts by kind, status and destination. Aggregates only: no owner, label or media is included.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  getMediaOperationStatistics(): Promise<MediaOperationStatisticsDto> {
    return this.service.getStatistics();
  }

  @Post('bulk')
  @HttpCode(HttpStatus.CREATED)
  @Authenticated()
  @Endpoint({
    summary: 'Queue a bulk operation',
    description:
      'Applies one action to a frozen list of assets in the background. The list is never re-resolved; access is checked for every item as it is changed, and items the account cannot change are reported as skipped. Submitting the same requestId again returns the existing operation.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  createBulkMediaOperation(
    @Auth() auth: AuthDto,
    @Body() dto: MediaOperationBulkCreateDto,
  ): Promise<MediaOperationDto> {
    return this.service.createBulk(auth, dto);
  }

  @Get(':id')
  @Authenticated()
  @Endpoint({
    summary: 'Get a media operation',
    description: 'The job with its render checkpoints and the immutable snapshot it was bound to.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  getMediaOperation(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<MediaOperationDetailDto> {
    return this.service.get(auth, id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @Authenticated()
  @Endpoint({
    summary: 'Cancel a media operation',
    description:
      'Records the cancellation durably. A queued job stops at once; a claimed job reports `cancelling` until the worker acknowledges it.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  cancelMediaOperation(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<MediaOperationDto> {
    return this.service.cancel(auth, id);
  }

  @Post(':id/pause')
  @HttpCode(HttpStatus.OK)
  @Authenticated()
  @Endpoint({
    summary: 'Pause a media operation',
    description:
      'Holds a bulk operation, Studio export or restoration. A queued job is paused at once; a running job stops at its next checkpoint and reports `pauseRequestedAt` until then. Other kinds cannot be paused.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  pauseMediaOperation(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<MediaOperationDto> {
    return this.service.pause(auth, id);
  }

  @Post(':id/resume')
  @HttpCode(HttpStatus.OK)
  @Authenticated()
  @Endpoint({
    summary: 'Resume a media operation',
    description:
      'Returns a paused job to the queue, where it carries on from what it recorded, or withdraws a pause its worker has not reached yet.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  resumeMediaOperation(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<MediaOperationDto> {
    return this.service.resume(auth, id);
  }

  @Post(':id/retry')
  @HttpCode(HttpStatus.CREATED)
  @Authenticated()
  @Endpoint({
    summary: 'Retry a media operation',
    description:
      'Queues a new job from the failed or cancelled one, reusing its immutable snapshot and destination and recording the lineage.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  retryMediaOperation(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<MediaOperationDto> {
    return this.service.retry(auth, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated()
  @Endpoint({
    summary: 'Clear a finished media operation',
    description: 'Removes a finished job from your Activity list. The record is kept for lineage and remote cleanup.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  dismissMediaOperation(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<void> {
    return this.service.dismiss(auth, id);
  }
}
