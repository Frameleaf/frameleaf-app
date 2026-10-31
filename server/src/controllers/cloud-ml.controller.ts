import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  CloudMlJobActivityDto,
  CloudMlJobCreateDto,
  CloudMlJobEstimateRequestDto,
  CloudMlJobEstimateResponseDto,
  CloudMlJobResponseDto,
} from 'src/dtos/cloud-ml-job.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { CloudMlJobService } from 'src/services/cloud-ml-job.service.js';
import { UUIDv7ParamDto } from 'src/validation.js';

/**
 * Frameleaf Cloud restoration and Smooth motion jobs for their owner (FL-162, `CLD-202`). A job is
 * estimated, then confirmed with its consent; from then on it is a durable job in Activity, cancelled
 * and followed through the media operations API (`/media-operations`). Access to the asset is
 * checked through the same edit permissions as a restoration on this server.
 */
@ApiTags(ApiTag.FrameleafCloudJobs)
@Controller('cloud/ml/jobs')
export class CloudMlController {
  constructor(private service: CloudMlJobService) {}

  @Post('estimate')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.CloudMlJobCreate })
  @Endpoint({
    operationId: 'estimateCloudMlJob',
    summary: 'Estimate a Frameleaf Cloud job',
    description:
      'Prepares the preview or the whole file without metadata and asks Frameleaf Cloud for a sealed estimate: metered GPU time × rate + a start fee per worker, as a p50–p90 range with a per-photo or per-minute figure, the AI Wallet and the consent version. Nothing is sent to be processed. 409 model-mismatch sends the person back to the model slider.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  estimateCloudMlJob(
    @Auth() auth: AuthDto,
    @Body() dto: CloudMlJobEstimateRequestDto,
  ): Promise<CloudMlJobEstimateResponseDto> {
    return this.service.estimate(auth, dto);
  }

  @Post()
  @Authenticated({ permission: Permission.CloudMlJobCreate })
  @Endpoint({
    operationId: 'createCloudMlJob',
    summary: 'Confirm a Frameleaf Cloud job',
    description:
      'Confirms a kept estimate with the consent version it was shown with and the acknowledgement that the file leaves this server. The job then runs in Activity. A repeated confirmation answers with the same job; an expired estimate is refused with 409 estimate-expired and is never reused.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  createCloudMlJob(@Auth() auth: AuthDto, @Body() dto: CloudMlJobCreateDto): Promise<CloudMlJobResponseDto> {
    return this.service.create(auth, dto);
  }

  @Get(':id')
  @Authenticated({ permission: Permission.CloudMlJobRead })
  @Endpoint({
    operationId: 'getCloudMlJob',
    summary: 'Get a Frameleaf Cloud job',
    description:
      'Where one of your Frameleaf Cloud jobs is: its stage (queued, starting, running, paused, done, failed or cancelled), the model, and the estimated, metered and settled cost.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getCloudMlJob(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<CloudMlJobActivityDto> {
    return this.service.get(auth, id);
  }
}
