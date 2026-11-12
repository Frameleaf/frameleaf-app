import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  QueueDeleteDto,
  QueueJobParamDto,
  QueueJobResponseDto,
  QueueJobSearchDto,
  QueueNameParamDto,
  QueueOverviewResponseDto,
  QueueOwnerStatisticsResponseDto,
  QueueOwnerStatisticsSearchDto,
  QueueProblemActionDto,
  QueueProblemActionResponseDto,
  QueueResponseDto,
  QueueRetryFailedResponseDto,
  QueueRunOneDto,
  QueueUpdateDto,
} from 'src/dtos/queue.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { QueueService } from 'src/services/queue.service.js';

@ApiTags(ApiTag.Queues)
@Controller('queues')
export class QueueController {
  constructor(private service: QueueService) {}

  @Get()
  @Authenticated({ permission: Permission.QueueRead, admin: true })
  @Endpoint({
    summary: 'List all queues',
    description: 'Retrieves a list of queues.',
    history: new HistoryBuilder().added('v2.4.0').alpha('v2.4.0'),
  })
  getQueues(@Auth() auth: AuthDto): Promise<QueueResponseDto[]> {
    return this.service.getAll(auth);
  }

  // FL-1486: declared before `:name`, which would otherwise take these paths.
  @Get('overview')
  @Authenticated({ permission: Permission.QueueRead, admin: true })
  @Endpoint({
    summary: 'What went wrong and why queues are not running',
    description:
      "Failed jobs of every queue grouped by what went wrong, most first, with one of the server's messages each, and for each queue why it is not running: paused, closed by quiet hours, waiting for another queue, or its feature is off.",
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  getQueueOverview(@Auth() auth: AuthDto): Promise<QueueOverviewResponseDto> {
    return this.service.getOverview(auth);
  }

  @Post('problems')
  @Authenticated({ permission: Permission.QueueJobCreate, admin: true })
  @HttpCode(HttpStatus.OK)
  @ApiResponse({ status: 400, description: "This action doesn't apply to this problem" })
  @Endpoint({
    summary: 'Act on failed jobs with one problem',
    description:
      'Try again (retry) every failed job with one problem, or stop trying (stop) the files of a format that cannot be read. Missing and damaged files are handled in Library care.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  actOnQueueProblem(@Auth() auth: AuthDto, @Body() dto: QueueProblemActionDto): Promise<QueueProblemActionResponseDto> {
    return this.service.actOnProblem(auth, dto);
  }

  @Get(':name')
  @Authenticated({ permission: Permission.QueueRead, admin: true })
  @Endpoint({
    summary: 'Retrieve a queue',
    description: 'Retrieves a specific queue by its name.',
    history: new HistoryBuilder().added('v2.4.0').alpha('v2.4.0'),
  })
  getQueue(@Auth() auth: AuthDto, @Param() { name }: QueueNameParamDto): Promise<QueueResponseDto> {
    return this.service.get(auth, name);
  }

  @Put(':name')
  @Authenticated({ permission: Permission.QueueUpdate, admin: true })
  @Endpoint({
    summary: 'Update a queue',
    description: 'Change the paused status of a specific queue.',
    history: new HistoryBuilder().added('v2.4.0').alpha('v2.4.0'),
  })
  updateQueue(
    @Auth() auth: AuthDto,
    @Param() { name }: QueueNameParamDto,
    @Body() dto: QueueUpdateDto,
  ): Promise<QueueResponseDto> {
    return this.service.update(auth, name, dto);
  }

  @Get(':name/jobs')
  @Authenticated({ permission: Permission.QueueJobRead, admin: true })
  @Endpoint({
    summary: 'Retrieve queue jobs',
    description: 'Retrieves a list of queue jobs from the specified queue.',
    history: new HistoryBuilder().added('v2.4.0').alpha('v2.4.0'),
  })
  getQueueJobs(
    @Auth() auth: AuthDto,
    @Param() { name }: QueueNameParamDto,
    @Query() dto: QueueJobSearchDto,
  ): Promise<QueueJobResponseDto[]> {
    return this.service.searchJobs(auth, name, dto);
  }

  // FL-71 (J-1): the Job manager's account filter (`JobsManager.jsx` 341-355).
  @Get(':name/statistics')
  @Authenticated({ permission: Permission.QueueJobRead, admin: true })
  @Endpoint({
    summary: 'Retrieve queue statistics for an account',
    description:
      "Counts, per state, the jobs of the specified queue that work on one account's items. At most 1,000 jobs of each state are read; `truncated` marks lower bounds.",
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  getQueueOwnerStatistics(
    @Auth() auth: AuthDto,
    @Param() { name }: QueueNameParamDto,
    @Query() { ownerId }: QueueOwnerStatisticsSearchDto,
  ): Promise<QueueOwnerStatisticsResponseDto> {
    return this.service.getOwnerStatistics(auth, name, ownerId);
  }

  // FL-71: the Job manager's "Retry failed" (`JobsManager.jsx` 715-727).
  @Post(':name/jobs/retry-failed')
  @Authenticated({ permission: Permission.QueueJobCreate, admin: true })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Retry failed queue jobs',
    description: 'Puts every failed job of the specified queue back in the queue with its saved data.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  retryFailedQueueJobs(
    @Auth() auth: AuthDto,
    @Param() { name }: QueueNameParamDto,
  ): Promise<QueueRetryFailedResponseDto> {
    return this.service.retryFailedJobs(auth, name);
  }

  // Approved design (2026-11-04): one job at a time, from the jobs manager's rows and details.
  @Post(':name/jobs/run-one')
  @Authenticated({ permission: Permission.QueueJobCreate, admin: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Run a task on one item',
    description:
      "Queues the task's job for one photo or video and starts it at once, even while the task is paused or busy. Only thumbnails, metadata, faces, text recognition and playback videos.",
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  runQueueOnOne(
    @Auth() auth: AuthDto,
    @Param() { name }: QueueNameParamDto,
    @Body() dto: QueueRunOneDto,
  ): Promise<void> {
    return this.service.runOne(auth, name, dto);
  }

  @Post(':name/jobs/:id/start')
  @Authenticated({ permission: Permission.QueueJobCreate, admin: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Start a waiting job now',
    description: 'Starts one waiting job at the next pass, even while its queue is paused or busy.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  startQueueJob(@Auth() auth: AuthDto, @Param() { name, id }: QueueJobParamDto): Promise<void> {
    return this.service.startJob(auth, name, id);
  }

  @Post(':name/jobs/:id/retry')
  @Authenticated({ permission: Permission.QueueJobCreate, admin: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Retry a failed job',
    description: 'Puts one failed job back in its queue with its saved data.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  retryQueueJob(@Auth() auth: AuthDto, @Param() { name, id }: QueueJobParamDto): Promise<void> {
    return this.service.retryJob(auth, name, id);
  }

  @Delete(':name/jobs')
  @Authenticated({ permission: Permission.QueueJobDelete, admin: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Empty a queue',
    description: 'Removes all jobs from the specified queue.',
    history: new HistoryBuilder().added('v2.4.0').alpha('v2.4.0'),
  })
  emptyQueue(@Auth() auth: AuthDto, @Param() { name }: QueueNameParamDto, @Body() dto: QueueDeleteDto): Promise<void> {
    return this.service.emptyQueue(auth, name, dto);
  }
}
