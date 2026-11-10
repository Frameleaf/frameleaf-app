import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  JobRunFailureActionDto,
  JobRunFailureActionResponseDto,
  JobRunFailuresDto,
  JobRunIdParamDto,
  JobRunItemPageDto,
  JobRunItemSearchDto,
  JobRunPageDto,
  JobRunSearchDto,
} from 'src/dtos/job-run.dto.js';
import { JobCreateDto } from 'src/dtos/job.dto.js';
import { QueueResponseLegacyDto, QueuesResponseLegacyDto } from 'src/dtos/queue-legacy.dto.js';
import { QueueCommandDto, QueueNameParamDto } from 'src/dtos/queue.dto.js';
import { RunningJobsResponseDto } from 'src/dtos/running-job.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { JobService } from 'src/services/job.service.js';
import { QueueService } from 'src/services/queue.service.js';
import { RunningJobService } from 'src/services/running-job.service.js';

@ApiTags(ApiTag.Jobs)
@Controller('jobs')
export class JobController {
  constructor(
    private service: JobService,
    private queueService: QueueService,
    private runningJobService: RunningJobService,
  ) {}

  @Get('runs')
  @Authenticated({ permission: Permission.JobRead, admin: true })
  @Endpoint({ summary: 'List durable job runs', history: new HistoryBuilder().added('v3').alpha('v3') })
  getJobRuns(@Query() dto: JobRunSearchDto): Promise<JobRunPageDto> {
    return this.service.getRuns(dto);
  }

  @Get('runs/:id/items')
  @Authenticated({ permission: Permission.JobRead, admin: true })
  @Endpoint({ summary: 'Inspect selected job run items', history: new HistoryBuilder().added('v3').alpha('v3') })
  getJobRunItems(@Param() { id }: JobRunIdParamDto, @Query() dto: JobRunItemSearchDto): Promise<JobRunItemPageDto> {
    return this.service.getRunItems(id, dto);
  }

  @Get('runs/:id/failures')
  @Authenticated({ permission: Permission.JobRead, admin: true })
  @ApiResponse({ status: 404, description: 'Job run not found' })
  @Endpoint({
    summary: "Review a job run's left-over photos",
    description:
      "The photos a run left over (failed or needing attention), grouped by plain cause, each with up to six photos the caller may see and one raw message. The counts cover every account's photos; another account's Locked or hidden photos never appear among the samples.",
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  getJobRunFailures(@Auth() auth: AuthDto, @Param() { id }: JobRunIdParamDto): Promise<JobRunFailuresDto> {
    return this.service.getRunFailures(auth, id);
  }

  @Post('runs/:id/failures')
  @Authenticated({ permission: Permission.JobCreate, admin: true })
  @HttpCode(HttpStatus.OK)
  @ApiResponse({ status: 400, description: "This action doesn't apply to photos left over for this reason" })
  @ApiResponse({ status: 404, description: 'Job run not found' })
  @Endpoint({
    summary: "Act on a job run's left-over photos",
    description:
      "Try again now (retry) the photos left over because a drive can't be reached or for other reasons, or stop trying (stop) the ones whose format can't be read. Stopping keeps their history; nightly processing no longer picks them.",
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  actOnJobRunFailures(
    @Param() { id }: JobRunIdParamDto,
    @Body() dto: JobRunFailureActionDto,
  ): Promise<JobRunFailureActionResponseDto> {
    return this.service.actOnRunFailures(id, dto);
  }

  @Post('runs/:id/release')
  @Authenticated({ permission: Permission.JobCreate, admin: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiResponse({ status: 400, description: "The run's import is not activated yet" })
  @ApiResponse({ status: 404, description: 'Job run not found' })
  @Endpoint({
    summary: 'Release held job run work',
    description:
      'Start the work a run holds back: the first setup of an import, or a paused setup. An import can be released once it is activated. Releasing a run with nothing held does nothing.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  releaseJobRun(@Param() { id }: JobRunIdParamDto): Promise<void> {
    return this.service.releaseRun(id);
  }

  @Get()
  @Authenticated({ permission: Permission.JobRead, admin: true })
  @Endpoint({
    summary: 'Retrieve queue counts and status',
    description: 'Retrieve the counts of the current queue, as well as the current status.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2').deprecated('v2.4.0'),
  })
  getQueuesLegacy(@Auth() auth: AuthDto): Promise<QueuesResponseLegacyDto> {
    return this.queueService.getAllLegacy(auth);
  }

  // FL-104 / FL-72: the one summary the notifications panel polls. Owner-scoped for everybody;
  // the queue counts in it are for administrators only, decided by the service.
  @Get('running')
  @Authenticated()
  @Endpoint({
    summary: 'Get running jobs',
    description:
      'Everything running in the background that the signed-in account may see, in one answer: its own unfinished media operations (paused ones included) and highlight exports, and for administrators every server job queue that has work, with the progress of its current run. Non-administrators always receive an empty queue list.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  getRunningJobs(@Auth() auth: AuthDto): Promise<RunningJobsResponseDto> {
    return this.runningJobService.getRunning(auth);
  }

  @Post()
  @Authenticated({ permission: Permission.JobCreate, admin: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Create a manual job',
    description:
      'Run a specific job. Most jobs are queued automatically, but this endpoint allows for manual creation of a handful of jobs, including various cleanup tasks, as well as creating a new database backup.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  createJob(@Body() dto: JobCreateDto): Promise<void> {
    return this.service.create(dto);
  }

  @Put(':name')
  @Authenticated({ permission: Permission.JobCreate, admin: true })
  @Endpoint({
    summary: 'Run jobs',
    description:
      'Queue all assets for a specific job type. Defaults to only queueing assets that have not yet been processed, but the force command can be used to re-process all assets.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2').deprecated('v2.4.0'),
  })
  runQueueCommandLegacy(
    @Param() { name }: QueueNameParamDto,
    @Body() dto: QueueCommandDto,
  ): Promise<QueueResponseLegacyDto> {
    return this.queueService.runCommandLegacy(name, dto);
  }
}
