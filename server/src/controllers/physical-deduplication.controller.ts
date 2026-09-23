import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { MediaOperationDto } from 'src/dtos/media-operation.dto.js';
import {
  PhysicalDeduplicationApplyRequestDto,
  PhysicalDeduplicationPreviewRequestDto,
  PhysicalDeduplicationPreviewResponseDto,
  PhysicalDeduplicationReviewRequestDto,
  PhysicalDeduplicationReviewResponseDto,
} from 'src/dtos/physical-deduplication.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { PhysicalDeduplicationPlanService } from 'src/services/physical-deduplication-plan.service.js';
import { PhysicalDeduplicationService } from 'src/services/physical-deduplication.service.js';

@ApiTags(ApiTag.Maintenance)
@Controller('admin/physical-deduplication')
export class PhysicalDeduplicationController {
  constructor(
    private service: PhysicalDeduplicationService,
    private plans: PhysicalDeduplicationPlanService,
  ) {}

  @Get('preview')
  @Authenticated({ permission: Permission.JobRead, admin: true })
  @Endpoint({
    summary: 'Get physical deduplication preview',
    description:
      'Return the latest physical deduplication plan with per-copy evidence, and the plans being applied or applied recently. Thumbnail visibility is the asset access of the requesting administrator, evaluated on every read.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  getPhysicalDeduplicationPreview(@Auth() auth: AuthDto): Promise<PhysicalDeduplicationPreviewResponseDto> {
    return this.plans.getPreview(auth);
  }

  @Post('preview')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ permission: Permission.JobCreate, admin: true })
  @Endpoint({
    summary: 'Request physical deduplication preview',
    description:
      'Queue a dry run that may retain originals in an account chosen for the preview and may review the copies of one account. Applying needs a reviewed plan and the saved master account.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  requestPhysicalDeduplicationPreview(@Body() dto: PhysicalDeduplicationPreviewRequestDto): Promise<void> {
    return this.service.requestPreview(dto);
  }

  @Post('plan/review')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.JobCreate, admin: true })
  @Endpoint({
    summary: 'Review a physical deduplication plan',
    description:
      'Check the plan on screen against the library again and bind the per-group decisions to it. Answers 409 when a newer preview replaced the plan, it was applied, or any checksum, ownership, path or reference evidence changed. Nothing is written.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  reviewPhysicalDeduplicationPlan(
    @Auth() auth: AuthDto,
    @Body() dto: PhysicalDeduplicationReviewRequestDto,
  ): Promise<PhysicalDeduplicationReviewResponseDto> {
    return this.plans.review(auth, dto);
  }

  @Post('plan/apply')
  @HttpCode(HttpStatus.CREATED)
  @Authenticated({ permission: Permission.JobCreate, admin: true })
  @Endpoint({
    summary: 'Apply a reviewed physical deduplication plan',
    description:
      'Queue exactly the reviewed copies as a durable, pausable job. Requires the review token and the typed confirmation. Answers 409 when another plan is being applied or anything changed since the review.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  applyPhysicalDeduplicationPlan(
    @Auth() auth: AuthDto,
    @Body() dto: PhysicalDeduplicationApplyRequestDto,
  ): Promise<MediaOperationDto> {
    return this.plans.apply(auth, dto);
  }
}
