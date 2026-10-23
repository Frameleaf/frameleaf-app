import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { UtilitiesSummaryResponseDto } from 'src/dtos/utilities.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { UtilitiesService } from 'src/services/utilities.service.js';

@ApiTags(ApiTag.MediaHealth)
@Controller('utilities')
export class UtilitiesController {
  constructor(private service: UtilitiesService) {}

  @Get('summary')
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Get what each utility has waiting',
    description:
      'Counts for the Utilities directory: look-alike groups and photos with no place for your library, and for an administrator the missing, damaged and unused files across the server.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  getUtilitiesSummary(@Auth() auth: AuthDto): Promise<UtilitiesSummaryResponseDto> {
    return this.service.getSummary(auth);
  }
}
