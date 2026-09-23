import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  PhysicalDeduplicationPreviewRequestDto,
  PhysicalDeduplicationPreviewResponseDto,
} from 'src/dtos/physical-deduplication.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { PhysicalDeduplicationService } from 'src/services/physical-deduplication.service.js';

@ApiTags(ApiTag.Maintenance)
@Controller('admin/physical-deduplication')
export class PhysicalDeduplicationController {
  constructor(private service: PhysicalDeduplicationService) {}

  @Get('preview')
  @Authenticated({ permission: Permission.JobRead, admin: true })
  @Endpoint({
    summary: 'Get physical deduplication preview',
    description:
      'Return the latest physical deduplication plan with per-copy evidence. Thumbnail visibility is the asset access of the requesting administrator, evaluated on every read.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  getPhysicalDeduplicationPreview(@Auth() auth: AuthDto): Promise<PhysicalDeduplicationPreviewResponseDto> {
    return this.service.getPreview(auth);
  }

  @Post('preview')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ permission: Permission.JobCreate, admin: true })
  @Endpoint({
    summary: 'Request physical deduplication preview',
    description:
      'Queue a dry run that may retain originals in an account chosen for the preview and may review the copies of one account. Applying a plan still requires the saved master account and is queued through the jobs endpoint.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  requestPhysicalDeduplicationPreview(@Body() dto: PhysicalDeduplicationPreviewRequestDto): Promise<void> {
    return this.service.requestPreview(dto);
  }
}
