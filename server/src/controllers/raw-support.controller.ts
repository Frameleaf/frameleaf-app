import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { RawSupportQueryDto, RawSupportResponseDto } from 'src/dtos/raw-support.dto.js';
import { ApiTag } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { RawSupportService } from 'src/services/raw-support.service.js';

/** FL-420: the Universal RAW page under Library Care. */
@ApiTags(ApiTag.MediaHealth)
@Controller('media-health')
export class RawSupportController {
  constructor(private service: RawSupportService) {}

  @Get('raw')
  @Authenticated()
  @Endpoint({
    summary: 'Get RAW support status',
    description:
      "How the caller's RAW originals are doing: whether the server can decode and develop RAW files, how many files are in each state, one row per RAW extension, and the files needing attention first. Read-only; repair uses the regenerate-thumbnail asset job.",
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getRawSupport(@Auth() auth: AuthDto, @Query() dto: RawSupportQueryDto): Promise<RawSupportResponseDto> {
    return this.service.getSummary(auth, dto);
  }
}
