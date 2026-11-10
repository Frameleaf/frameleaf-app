import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  FileProblemDto,
  FileProblemFolderDto,
  FileProblemListQueryDto,
  FileProblemLookInDto,
  FileProblemPageDto,
} from 'src/dtos/file-problem.dto.js';
import {
  MediaHealthBulkActionDto,
  MediaHealthBulkResponseDto,
  MediaHealthChooseCandidatesDto,
  MediaHealthDeleteCorruptDto,
  MediaHealthListQueryDto,
  MediaHealthListResponseDto,
  MediaHealthLocateDto,
  MediaHealthRecoverDto,
  MediaHealthRepairDto,
  MediaHealthRepairPreviewDto,
  MediaHealthRepairPreviewResponseDto,
  MediaHealthRepairResponseDto,
  MediaHealthRootsResponseDto,
  MediaHealthScanDto,
  MediaHealthScanResponseDto,
  MediaHealthSummaryQueryDto,
  MediaHealthSummaryResponseDto,
} from 'src/dtos/media-health.dto.js';
import { ApiTag } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { MediaHealthService } from 'src/services/media-health.service.js';
import { UUIDParamDto } from 'src/validation.js';

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

  @Get('files')
  @Authenticated()
  @Endpoint({
    summary: 'List damaged and missing files',
    description:
      'One page of a tab of damaged and missing files: what needs the caller, what Frameleaf fixed in the last 30 days, or what was left as it is. Members see their own; administrators see every account, without another account’s pictures.',
    history: new HistoryBuilder().added('v3.4.0').alpha('v3.4.0'),
  })
  getFileProblems(@Auth() auth: AuthDto, @Query() dto: FileProblemListQueryDto): Promise<FileProblemPageDto> {
    return this.service.listFileProblems(auth, dto);
  }

  @Get('files/folders')
  @Authenticated()
  @Endpoint({
    summary: 'List the folders to look in for a file',
    description:
      'The folders the caller may search for an exact copy of a missing or changed file: library storage and their own external libraries, and for administrators also recovery folders and drives added in Frameleaf Manager.',
    history: new HistoryBuilder().added('v3.4.0').alpha('v3.4.0'),
  })
  getFileProblemFolders(@Auth() auth: AuthDto): Promise<FileProblemFolderDto[]> {
    return this.service.getFileProblemFolders(auth);
  }

  @Get('files/:id')
  @Authenticated()
  @Endpoint({
    summary: 'Get a damaged or missing file',
    description: 'One damaged or missing file and what happened to it, oldest first, open or closed.',
    history: new HistoryBuilder().added('v3.4.0').alpha('v3.4.0'),
  })
  getFileProblem(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<FileProblemDto> {
    return this.service.getFileProblem(auth, id);
  }

  @Post('files/:id/undo')
  @Authenticated()
  @Endpoint({
    summary: 'Undo what Frameleaf fixed',
    description:
      'Put back the file the photo used before Frameleaf repaired, relinked or restored it, keeping every file. Only the owner can undo, not once the photo changed since the fix, and not while it is Locked.',
    history: new HistoryBuilder().added('v3.4.0').alpha('v3.4.0'),
  })
  undoFileProblemFix(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<FileProblemDto> {
    return this.service.undoFileProblemFix(auth, id);
  }

  @Post('files/:id/keep')
  @Authenticated()
  @Endpoint({
    summary: 'Keep a damaged or missing file as it is',
    description: 'Move a file that needs the owner to the files left as they are. Only the owner can keep it.',
    history: new HistoryBuilder().added('v3.4.0').alpha('v3.4.0'),
  })
  keepFileProblem(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<FileProblemDto> {
    return this.service.keepFileProblem(auth, id);
  }

  @Post('files/:id/try-again')
  @Authenticated()
  @Endpoint({
    summary: 'Try to fix a damaged or missing file again',
    description:
      'Check the file again and fix what can be fixed, from the start. A repair someone undid is not redone by itself.',
    history: new HistoryBuilder().added('v3.4.0').alpha('v3.4.0'),
  })
  tryFileProblemAgain(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<FileProblemDto> {
    return this.service.tryFileProblemAgain(auth, id);
  }

  @Post('files/:id/look-in')
  @Authenticated()
  @Endpoint({
    summary: 'Look in a folder for a missing or changed file',
    description:
      'Search one folder the owner may search for an exact copy, and put it back when there is exactly one. Answers at once; what was found is added to the history when the search is done.',
    history: new HistoryBuilder().added('v3.4.0').alpha('v3.4.0'),
  })
  lookInFolderForFileProblem(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: FileProblemLookInDto,
  ): Promise<FileProblemDto> {
    return this.service.lookInFolderForFileProblem(auth, id, dto);
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

  @Post('missing/scan/assets')
  @Authenticated()
  @Endpoint({
    summary: 'Scan chosen photos for missing media',
    description: 'Queue a scan of chosen photos only, which brings back no untracked media.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  startMissingAssetScan(@Auth() auth: AuthDto, @Body() dto: MediaHealthScanDto): Promise<MediaHealthScanResponseDto> {
    return this.service.startMissingScan(auth, dto);
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

  @Post('corrupt/scan/assets')
  @Authenticated()
  @Endpoint({
    summary: 'Scan chosen photos for damaged media',
    description: 'Queue a scan validating the source media of chosen photos only.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  startCorruptAssetScan(@Auth() auth: AuthDto, @Body() dto: MediaHealthScanDto): Promise<MediaHealthScanResponseDto> {
    return this.service.startCorruptScan(auth, dto);
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

  @Post('corrupt/repair/preview')
  @Authenticated()
  @Endpoint({
    summary: 'Preview a repair of a damaged JPEG',
    description:
      'Repair a damaged JPEG without changing anything, and return the result to review before it replaces the original.',
    history: new HistoryBuilder().added('v3.4.0').alpha('v3.4.0'),
  })
  previewRepair(
    @Auth() auth: AuthDto,
    @Body() dto: MediaHealthRepairPreviewDto,
  ): Promise<MediaHealthRepairPreviewResponseDto> {
    return this.service.previewRepair(auth, dto);
  }

  @Post('corrupt/repair')
  @Authenticated()
  @Endpoint({
    summary: 'Replace a damaged JPEG with its reviewed repair',
    description:
      'Repair the damaged JPEG again and, when the result is exactly the one reviewed, make it the original while keeping the damaged file.',
    history: new HistoryBuilder().added('v3.4.0').alpha('v3.4.0'),
  })
  repair(@Auth() auth: AuthDto, @Body() dto: MediaHealthRepairDto): Promise<MediaHealthRepairResponseDto> {
    return this.service.repair(auth, dto);
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
