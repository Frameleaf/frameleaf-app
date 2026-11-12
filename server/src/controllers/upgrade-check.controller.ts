import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { UpgradeCheckResponseDto } from 'src/dtos/upgrade-check.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Authenticated } from 'src/middleware/auth.guard.js';
import { UpgradeCheckService } from 'src/services/upgrade-check.service.js';

@ApiTags(ApiTag.Attention)
@Controller('admin/upgrade-check')
export class UpgradeCheckController {
  constructor(private service: UpgradeCheckService) {}

  // FL-954: read by the Overview and by Frameleaf Manager after an update.
  @Get()
  @Authenticated({ permission: Permission.ServerStatistics, admin: true })
  @Endpoint({
    summary: 'Get the library check after the last upgrade',
    description:
      'After each upgrade the server compares the library with how it was just before: how many photos and videos there are, when the newest was added, the folders they are in and whether each drive is mounted. This returns the latest comparison: everything where it was, or each difference found.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  getUpgradeCheck(): Promise<UpgradeCheckResponseDto> {
    return this.service.getUpgradeCheck();
  }
}
