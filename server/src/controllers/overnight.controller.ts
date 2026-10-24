import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { OvernightResponseDto } from 'src/dtos/overnight.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Authenticated } from 'src/middleware/auth.guard.js';
import { OvernightService } from 'src/services/overnight.service.js';

/** FL-363: the overnight schedule: its next start, the run in progress, recent nights, Run now and Stop. */
@ApiTags(ApiTag.Jobs)
@Controller('admin/overnight')
export class OvernightController {
  constructor(private service: OvernightService) {}

  @Get()
  @Authenticated({ permission: Permission.JobRead, admin: true })
  @Endpoint({
    summary: 'Get the overnight schedule',
    description:
      'When the night’s work starts next, which steps are on, the run in progress and what the last few nights did',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  getOvernight(): Promise<OvernightResponseDto> {
    return this.service.getStatus();
  }

  @Post('run')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.JobCreate, admin: true })
  @Endpoint({
    summary: 'Run the overnight work now',
    description: 'Starts every step that is on, one after another, including steps that run only when started',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  runOvernight(): Promise<OvernightResponseDto> {
    return this.service.runNow();
  }

  @Post('stop')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.JobCreate, admin: true })
  @Endpoint({
    summary: 'Stop the overnight work',
    description: 'Ends the run in progress; the steps it did not reach run on the next night',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  stopOvernight(): Promise<OvernightResponseDto> {
    return this.service.stop();
  }
}
