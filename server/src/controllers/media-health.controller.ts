import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  MediaHealthBulkActionDto,
  MediaHealthBulkResponseDto,
  MediaHealthChooseCandidatesDto,
  MediaHealthDeleteCorruptDto,
  MediaHealthListQueryDto,
  MediaHealthListResponseDto,
  MediaHealthLocateDto,
  MediaHealthRecoverDto,
  MediaHealthRootsResponseDto,
  MediaHealthScanResponseDto,
  MediaHealthSummaryQueryDto,
  MediaHealthSummaryResponseDto,
} from 'src/dtos/media-health.dto.js';
import { ApiTag } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { MediaHealthService } from 'src/services/media-health.service.js';

@ApiTags(ApiTag.MediaHealth)
@Controller('media-health')
export class MediaHealthController {
  constructor(private service: MediaHealthService) {}

  @Get()
  @Authenticated()
  @Endpoint({
    summary: 'List media health findings',
    description: 'List missing and corrupt media health findings in timeline buckets.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  list(@Auth() auth: AuthDto, @Query() dto: MediaHealthListQueryDto): Promise<MediaHealthListResponseDto> {
    return this.service.list(auth, dto);
  }

  @Get('summary')
  @Authenticated()
  @Endpoint({
    summary: 'Get Library Care summary',
    description:
      'Queue sizes for missing, damaged, duplicate, import and enrichment work, the latest scan or search, and recent Library Care jobs.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  getSummary(@Auth() auth: AuthDto, @Query() dto: MediaHealthSummaryQueryDto): Promise<MediaHealthSummaryResponseDto> {
    return this.service.summary(auth, dto);
  }

  @Get('roots')
  @Authenticated()
  @Endpoint({
    summary: 'List Library Care search locations',
    description: 'Locations the caller may search for exact copies of missing or damaged originals.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  getRoots(@Auth() auth: AuthDto): Promise<MediaHealthRootsResponseDto> {
    return this.service.getRoots(auth);
  }

  @Post('candidates/choose')
  @Authenticated()
  @Endpoint({
    summary: 'Choose media health candidates',
    description: 'Record which verified exact copy each missing original should be relinked to.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  chooseCandidates(
    @Auth() auth: AuthDto,
    @Body() dto: MediaHealthChooseCandidatesDto,
  ): Promise<MediaHealthBulkResponseDto> {
    return this.service.chooseCandidates(auth, dto);
  }

  @Post('missing/scan')
  @Authenticated()
  @Endpoint({
    summary: 'Start missing media scan',
    description: 'Queue an owner-scoped scan that identifies missing files and restores supported untracked media.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  startMissingScan(@Auth() auth: AuthDto): Promise<MediaHealthScanResponseDto> {
    return this.service.startMissingScan(auth);
  }

  @Post('missing/locate')
  @Authenticated()
  @Endpoint({
    summary: 'Locate missing media',
    description:
      'Queue a durable exact-checksum search of the chosen locations for missing originals or copies of confirmed damage.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  locateMissing(@Auth() auth: AuthDto, @Body() dto: MediaHealthLocateDto): Promise<MediaHealthScanResponseDto> {
    return this.service.locateMissing(auth, dto);
  }

  @Post('missing/relink')
  @Authenticated()
  @Endpoint({
    summary: 'Relink missing media',
    description: 'Queue a durable job relinking missing originals to their verified exact copies.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  relinkMissing(@Auth() auth: AuthDto, @Body() dto: MediaHealthBulkActionDto): Promise<MediaHealthBulkResponseDto> {
    return this.service.relinkMissing(auth, dto);
  }

  @Post('corrupt/scan')
  @Authenticated()
  @Endpoint({
    summary: 'Start corrupt media scan',
    description: 'Queue an explicit scan that validates source media integrity.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  startCorruptScan(@Auth() auth: AuthDto): Promise<MediaHealthScanResponseDto> {
    return this.service.startCorruptScan(auth);
  }

  @Post('corrupt/recover')
  @Authenticated()
  @Endpoint({
    summary: 'Recover damaged media from a verified copy',
    description:
      'Queue a durable job replacing confirmed damage with an exact, decoded copy while keeping the damaged file.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  recoverDamaged(@Auth() auth: AuthDto, @Body() dto: MediaHealthRecoverDto): Promise<MediaHealthBulkResponseDto> {
    return this.service.recoverDamaged(auth, dto);
  }

  @Post('dismiss')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated()
  @Endpoint({
    summary: 'Dismiss media health findings',
    description: 'Dismiss selected media health findings without modifying assets.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  dismiss(@Auth() auth: AuthDto, @Body() dto: MediaHealthBulkActionDto): Promise<void> {
    return this.service.dismiss(auth, dto);
  }

  @Post('reopen')
  @Authenticated()
  @Endpoint({
    summary: 'Reopen media health findings',
    description:
      'Undo a dismissal, or reopen confirmed damage whose item was restored from the trash, putting the findings back in review.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  reopen(@Auth() auth: AuthDto, @Body() dto: MediaHealthBulkActionDto): Promise<MediaHealthBulkResponseDto> {
    return this.service.reopen(auth, dto);
  }

  @Delete('corrupt')
  @Authenticated()
  @Endpoint({
    summary: 'Move confirmed corrupt media to trash',
    description: 'Move recently confirmed corrupt media findings to trash after revalidation.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  deleteCorrupt(@Auth() auth: AuthDto, @Body() dto: MediaHealthDeleteCorruptDto): Promise<MediaHealthBulkResponseDto> {
    return this.service.deleteCorrupt(auth, dto);
  }
}
