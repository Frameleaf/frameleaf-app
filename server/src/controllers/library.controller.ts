import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  CreateLibraryDto,
  LibraryRemovalDto,
  LibraryRemovalReviewDto,
  LibraryResponseDto,
  LibrarySearchDto,
  LibraryStatsResponseDto,
  ManagedUploadsStatsResponseDto,
  UpdateLibraryDto,
  ValidateLibraryDto,
  ValidateLibraryResponseDto,
} from 'src/dtos/library.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { LibraryScanService } from 'src/services/library-scan.service.js';
import { LibraryService } from 'src/services/library.service.js';
import { UUIDParamDto } from 'src/validation.js';

@ApiTags(ApiTag.Libraries)
@Controller('libraries')
export class LibraryController {
  constructor(
    private service: LibraryService,
    private scans: LibraryScanService,
  ) {}

  @Get()
  @Authenticated({ permission: Permission.LibraryRead, admin: true })
  @Endpoint({
    summary: 'Retrieve libraries',
    description: 'Retrieve a list of external libraries, each with its latest scan.',
    history: new HistoryBuilder()
      .added('v1')
      .beta('v1')
      .stable('v2')
      .updated('v3', 'Each library carries its latest scan and removal state'),
  })
  async getAllLibraries(@Query() dto: LibrarySearchDto): Promise<LibraryResponseDto[]> {
    return this.scans.withScans(await this.service.getAll(dto));
  }

  @Get('managed-uploads')
  @Authenticated({ permission: Permission.LibraryStatistics, admin: true })
  @Endpoint({
    summary: 'Retrieve managed upload statistics',
    description:
      'Retrieve, for every active account, the photos, videos and original sizes it keeps in managed upload storage rather than in external libraries.',
    history: new HistoryBuilder().added('v3'),
  })
  getManagedUploadStatistics(): Promise<ManagedUploadsStatsResponseDto[]> {
    return this.service.getManagedUploads();
  }

  @Post()
  @Authenticated({ permission: Permission.LibraryCreate, admin: true })
  @Endpoint({
    summary: 'Create a library',
    description: 'Create a new external library.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  createLibrary(@Auth() auth: AuthDto, @Body() dto: CreateLibraryDto): Promise<LibraryResponseDto> {
    return this.service.create(dto, auth);
  }

  @Get(':id')
  @Authenticated({ permission: Permission.LibraryRead, admin: true })
  @Endpoint({
    summary: 'Retrieve a library',
    description: 'Retrieve an external library by its ID.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  async getLibrary(@Param() { id }: UUIDParamDto): Promise<LibraryResponseDto> {
    const [library] = await this.scans.withScans([await this.service.get(id)]);
    return library;
  }

  @Put(':id')
  @Authenticated({ permission: Permission.LibraryUpdate, admin: true })
  @Endpoint({
    summary: 'Update a library',
    description: 'Update an existing external library.',
    history: new HistoryBuilder()
      .added('v1')
      .beta('v1')
      .stable('v2')
      .deprecated('v3', { replacementId: 'updateLibrary' }),
  })
  updateLibrary(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: UpdateLibraryDto,
  ): Promise<LibraryResponseDto> {
    return this.service.update(id, dto, auth);
  }

  @Patch(':id')
  @ApiExcludeEndpoint()
  @Authenticated({ permission: Permission.LibraryUpdate, admin: true })
  updateLibraryV3(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: UpdateLibraryDto,
  ): Promise<LibraryResponseDto> {
    return this.service.update(id, dto, auth);
  }

  @Delete(':id')
  @Authenticated({ permission: Permission.LibraryDelete, admin: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Delete a library',
    description: 'Delete an external library by its ID.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  deleteLibrary(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.delete(id, auth);
  }

  @Post(':id/validate')
  @Authenticated({ admin: true })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Validate library settings',
    description: 'Validate the settings of an external library.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  // TODO: change endpoint to validate current settings instead
  validate(@Param() { id }: UUIDParamDto, @Body() dto: ValidateLibraryDto): Promise<ValidateLibraryResponseDto> {
    return this.service.validate(id, dto);
  }

  @Get(':id/statistics')
  @Authenticated({ permission: Permission.LibraryStatistics, admin: true })
  @Endpoint({
    summary: 'Retrieve library statistics',
    description:
      'Retrieve statistics for a specific external library, including number of videos, images, and storage usage.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getLibraryStatistics(@Param() { id }: UUIDParamDto): Promise<LibraryStatsResponseDto> {
    return this.service.getStatistics(id);
  }

  @Post(':id/scan')
  @Authenticated({ permission: Permission.LibraryUpdate, admin: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Scan a library',
    description: 'Queue a scan for the external library to find and import new assets.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  scanLibrary(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.scans.queueManual(auth, id);
  }

  @Delete(':id/scan')
  @Authenticated({ permission: Permission.LibraryUpdate, admin: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Cancel a library scan',
    description:
      "Stop the external library's waiting, running or paused scan. Items it already handled stay as they are.",
    history: new HistoryBuilder().added('v3'),
  })
  cancelLibraryScan(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.scans.cancel(auth, id);
  }

  @Get(':id/removal')
  @Authenticated({ permission: Permission.LibraryDelete, admin: true })
  @Endpoint({
    summary: 'Review a library removal',
    description:
      'The first stage of removing an external library: the indexed items, albums, shared links and faces the removal takes with it, and a token to confirm it with. Source files are never deleted.',
    history: new HistoryBuilder().added('v3'),
  })
  async getLibraryRemovalReview(@Param() { id }: UUIDParamDto): Promise<LibraryRemovalReviewDto> {
    const review = await this.service.getRemovalReview(id);
    return { ...review, scanActive: await this.scans.isActive(id) };
  }

  @Post(':id/removal')
  @Authenticated({ permission: Permission.LibraryDelete, admin: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Remove a library',
    description:
      'The second stage of removing an external library: confirm with the typed name and the review token. Refused when the library changed after the review.',
    history: new HistoryBuilder().added('v3'),
  })
  removeLibrary(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Body() dto: LibraryRemovalDto): Promise<void> {
    return this.service.remove(auth, id, dto);
  }
}
