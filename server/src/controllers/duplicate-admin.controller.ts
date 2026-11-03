import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  DuplicateEstimateQueryDto,
  DuplicateEstimateResponseDto,
  DuplicateRecompareDto,
} from 'src/dtos/duplicate.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Authenticated } from 'src/middleware/auth.guard.js';
import { DuplicateService } from 'src/services/duplicate.service.js';

/**
 * FL-520: Library care › Duplicates. How many look-alike groups each "How alike" choice would make, how
 * long comparing again takes, and starting that comparison now or in the next overnight run.
 */
@ApiTags(ApiTag.Duplicates)
@Controller('admin/duplicates')
export class DuplicateAdminController {
  constructor(private service: DuplicateService) {}

  @Get('estimate')
  @Authenticated({ permission: Permission.JobRead, admin: true })
  @Endpoint({
    summary: 'Estimate look-alike groups',
    description:
      'About how many look-alike groups each distance would make in this library, and how long comparing every photo again takes, from a sample of photos. Nothing is changed.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  getDuplicateEstimate(@Query() dto: DuplicateEstimateQueryDto): Promise<DuplicateEstimateResponseDto> {
    return this.service.estimateLookAlikes(dto);
  }

  @Post('recompare')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ permission: Permission.JobCreate, admin: true })
  @Endpoint({
    summary: 'Compare look-alike photos again',
    description:
      'Compare every photo again with the saved "How alike" setting: now, or in the next overnight run. Groups already dealt with stay dealt with.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  recompareDuplicates(@Body() dto: DuplicateRecompareDto): Promise<void> {
    return this.service.recompare(dto);
  }
}
