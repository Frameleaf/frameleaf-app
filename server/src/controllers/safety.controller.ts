import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { SafetyLookupDto, SafetyLookupResponseDto, SafetySummaryDto } from 'src/dtos/safety.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated, ViewerAllowed } from 'src/middleware/auth.guard.js';
import { SafetyService } from 'src/services/safety.service.js';

@ApiTags(ApiTag.Assets)
@Controller('assets/safety')
export class SafetyController {
  constructor(private service: SafetyService) {}

  @Post('lookup')
  @HttpCode(HttpStatus.OK)
  @ViewerAllowed()
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Look up own asset safety by SHA-256',
    description:
      'Up to 2000 hashes. Current own accessible assets only, including for admins; shared and partner assets omitted. Completed membership and GET + SHA-256 verification are separate facts. No bucket credentials/settings.',
    history: new HistoryBuilder().added('v3'),
  })
  getAssetSafety(@Auth() auth: AuthDto, @Body() dto: SafetyLookupDto): Promise<SafetyLookupResponseDto> {
    return this.service.lookup(auth, dto);
  }

  @Get('summary')
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Summarize own library safety',
    description:
      'Same current owner/access scope as lookup. Percentages use only this accessible server library, not unknown device-only items. Backup counts are null when unavailable; HEAD size is not SHA-256 verification.',
    history: new HistoryBuilder().added('v3'),
  })
  getSafetySummary(@Auth() auth: AuthDto): Promise<SafetySummaryDto> {
    return this.service.summary(auth);
  }
}
