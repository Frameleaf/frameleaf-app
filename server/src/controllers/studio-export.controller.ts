import { Body, Controller, Get, HttpCode, HttpStatus, Next, Param, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { NextFunction, Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  StudioExportCreateDto,
  StudioExportCreateResponseDto,
  StudioExportListResponseDto,
  StudioExportSearchDto,
  StudioExportVersionDto,
} from 'src/dtos/studio-export.dto.js';
import { ApiTag } from 'src/enum.js';
import { Auth, Authenticated, FileResponse, OriginalTransfer } from 'src/middleware/auth.guard.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StudioExportService } from 'src/services/studio-export.service.js';
import { sendFile } from 'src/utils/file.js';
import { UUIDv7ParamDto } from 'src/validation.js';

const history = () => new HistoryBuilder().added('v3.0.0').alpha('v3.0.0');

/**
 * Studio project exports and their versions (FL-106, `STU-404`).
 *
 * Owner-scoped throughout: somebody else's export, and a Locked export outside an unlocked session,
 * answer `404` like one that does not exist.
 */
@ApiTags(ApiTag.StudioProjects)
@Controller('studio')
export class StudioExportController {
  constructor(
    private service: StudioExportService,
    private logger: LoggingRepository,
  ) {}

  @Post('projects/:id/exports')
  @HttpCode(HttpStatus.CREATED)
  @Authenticated()
  @Endpoint({
    summary: 'Export a Studio project',
    description:
      'Queues a render of the current version to a finished file. Every source is checked for you now, again when the render starts and again before the result is published; the result inherits every source’s Locked and sensitive status. A result that uses media shared with you stays with the project. Follow it in Activity. Owner only.',
    history: history(),
  })
  createStudioExport(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
    @Body() dto: StudioExportCreateDto,
  ): Promise<StudioExportCreateResponseDto> {
    return this.service.create(auth, id, dto);
  }

  @Get('projects/:id/exports')
  @Authenticated()
  @Endpoint({
    summary: 'List a Studio project’s exports',
    description: 'Every export of the project, newest first: published versions and exports still on their way.',
    history: history(),
  })
  getStudioExports(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
    @Query() dto: StudioExportSearchDto,
  ): Promise<StudioExportListResponseDto> {
    return this.service.list(auth, id, dto);
  }

  @Get('exports/:id')
  @Authenticated()
  @Endpoint({
    summary: 'Get a Studio export',
    description: 'One export version, with where its result lives and what it inherited.',
    history: history(),
  })
  getStudioExport(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<StudioExportVersionDto> {
    return this.service.get(auth, id);
  }

  @Get('exports/:id/download')
  @FileResponse()
  @Authenticated()
  // FL-161: a finished full-resolution render
  @OriginalTransfer()
  @Endpoint({
    summary: 'Download a Studio export kept with its project',
    description:
      'The file of a published export that uses media shared with you. Available only while every source is still available to you; a result in your library is downloaded like any other photo or video.',
    history: history(),
  })
  async downloadStudioExport(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    await sendFile(res, next, () => this.service.download(auth, id), this.logger);
  }
}
