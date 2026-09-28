import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
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
