import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { HardwareCheckResponseDto } from 'src/dtos/hardware-check.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Authenticated } from 'src/middleware/auth.guard.js';
import { HardwareCheckService } from 'src/services/hardware-check.service.js';

/** Settings → Compute & jobs → Hardware & GPU (FL-159, CLD-201). */
@ApiTags(ApiTag.FrameleafCloudMl)
@Controller('admin/hardware')
export class HardwareCheckController {
  constructor(private service: HardwareCheckService) {}

  @Get()
  @Authenticated({ permission: Permission.SystemConfigRead, admin: true })
  @Endpoint({
    operationId: 'getHardwareCheck',
    summary: 'Get the Hardware & GPU check',
    description:
      'The last check of the GPU the server container and the ML container can each use, with any set-up problems found and the last benchmark. Runs a first check when there is none.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getCheck(): Promise<HardwareCheckResponseDto> {
    return this.service.getCheck();
  }

  @Post('check')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.SystemConfigUpdate, admin: true })
  @Endpoint({
    operationId: 'runHardwareCheck',
    summary: 'Check the GPU again',
    description: 'Checks both containers again: devices, driver, backend and a short test job in each.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  runCheck(): Promise<HardwareCheckResponseDto> {
    return this.service.runCheck();
  }

  @Post('benchmark')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.SystemConfigUpdate, admin: true })
  @Endpoint({
    operationId: 'runHardwareBenchmark',
    summary: 'Run a short benchmark',
    description:
      'Times a few search embeddings and a test transcode, and keeps how this hardware compares with the estimates so the model sliders show measured times.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  runBenchmark(): Promise<HardwareCheckResponseDto> {
    return this.service.runBenchmark();
  }
}
