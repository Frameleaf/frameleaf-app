import { Controller, Delete, Get, HttpCode, HttpStatus, Next, Param, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { pipeline } from 'node:stream/promises';
import type { NextFunction, Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  IntegrityCheckRunsResponseDto,
  IntegrityGetReportDto,
  IntegrityReportClearResponseDto,
  IntegrityReportResponseDto,
  IntegrityReportSummaryResponseDto,
  IntegrityReportTypeParamDto,
} from 'src/dtos/integrity.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated, FileResponse, OriginalTransfer } from 'src/middleware/auth.guard.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { IntegrityService } from 'src/services/integrity.service.js';
import { sendFile } from 'src/utils/file.js';
import { UUIDv7ParamDto } from 'src/validation.js';

@ApiTags(ApiTag.Maintenance)
@Controller('admin/integrity')
export class IntegrityAdminController {
  constructor(
    private logger: LoggingRepository,
    private service: IntegrityService,
  ) {}

  @Get('summary')
  @Endpoint({
    summary: 'Get integrity report summary',
    description: 'Get a count of the items flagged in each integrity report',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  getIntegrityReportSummary(): Promise<IntegrityReportSummaryResponseDto> {
    return this.service.getIntegrityReportSummary();
  }

  @Get('runs')
  @Endpoint({
    summary: 'Get integrity check runs',
    description: 'Get when each integrity check last completed a full run',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  getIntegrityCheckRuns(): Promise<IntegrityCheckRunsResponseDto> {
    return this.service.getIntegrityCheckRuns();
  }

  @Get('report')
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Get integrity report by type',
    description: 'Get all flagged items by integrity report type',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  getIntegrityReport(@Query() dto: IntegrityGetReportDto): Promise<IntegrityReportResponseDto> {
    return this.service.getIntegrityReport(dto);
  }

  @Get('report/:id/file')
  @Endpoint({
    summary: 'Download flagged file',
    description: 'Download the untracked/broken file if one exists',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  @FileResponse()
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  // FL-161: the flagged file itself, usually an original
  @OriginalTransfer()
  async getIntegrityReportFile(
    @Param() { id }: UUIDv7ParamDto,
    @Res() res: Response,
    @Next() next: NextFunction,
  ): Promise<void> {
    await sendFile(res, next, () => this.service.getIntegrityReportFile(id), this.logger);
  }

  @Delete('report/:id')
  @Endpoint({
    summary: 'Delete integrity report item',
    description: 'Delete a given report item and perform corresponding deletion (e.g. trash asset, delete file)',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  async deleteIntegrityReport(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<void> {
    await this.service.deleteIntegrityReport(auth.user.id, id);
  }

  @Post('report/:id/dismiss')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Remove one finding from its list',
    description:
      'Forget one integrity finding without acting on it: no file is deleted and no photo is moved to the trash. The next check reports it again if the problem remains.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  async dismissIntegrityReport(@Param() { id }: UUIDv7ParamDto): Promise<void> {
    await this.service.dismissIntegrityReport(id);
  }

  @Post('report/:type/clear')
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Clear the list of one integrity check',
    description:
      'Empty the findings of one integrity check without acting on them: no file is deleted and no photo is moved to the trash. The next check reports what is still wrong.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  clearIntegrityReports(@Param() { type }: IntegrityReportTypeParamDto): Promise<IntegrityReportClearResponseDto> {
    return this.service.clearIntegrityReports(type);
  }

  @Get('report/:type/csv')
  @Endpoint({
    summary: 'Export integrity report by type as CSV',
    description: 'Get all integrity report entries for a given type as a CSV',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  @FileResponse()
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  async getIntegrityReportCsv(@Param() { type }: IntegrityReportTypeParamDto, @Res() res: Response): Promise<void> {
    res.header({
      'Content-Type': 'text/csv',
      'Cache-Control': 'private, no-cache, no-transform',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(`${Date.now()}-${type}.csv`)}"`,
    });

    await pipeline(this.service.getIntegrityReportCsv(type), res);
  }
}
