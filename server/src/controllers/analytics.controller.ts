import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { AnalyticsQueryDto, AnalyticsReportResponseDto, AnalyticsScopesResponseDto } from 'src/dtos/analytics.dto.js';
import { ApiTag } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { AnalyticsService } from 'src/services/analytics.service.js';

/**
 * Scoped library analytics (FL-79). Reads only; everything is computed from this server's own
 * database and library volume, and nothing is sent anywhere.
 *
 * The whole server (`all`) is for administrators. An account can read its own account and its own
 * external libraries; administrators can read any.
 */
@ApiTags(ApiTag.Analytics)
@Controller('analytics')
export class AnalyticsController {
  constructor(private service: AnalyticsService) {}

  @Get('scopes')
  @Authenticated()
  @Endpoint({
    summary: 'List analytics scopes',
    description:
      'The selections the signed-in account may read analytics for: the whole server for administrators, then accounts and external libraries.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  getAnalyticsScopes(@Auth() auth: AuthDto): Promise<AnalyticsScopesResponseDto> {
    return this.service.getScopes(auth);
  }

  @Get()
  @Authenticated()
  @Endpoint({
    summary: 'Retrieve library analytics',
    description:
      'Counts, sizes, dated history and processing outcomes for one selection and date range. Series that are not recorded for the selection are omitted or null, never filled in; estimated processing cost is an estimate, not a charge.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  getAnalyticsReport(@Auth() auth: AuthDto, @Query() dto: AnalyticsQueryDto): Promise<AnalyticsReportResponseDto> {
    return this.service.getReport(auth, dto);
  }
}
