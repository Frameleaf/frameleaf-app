import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  StreamableFile,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { BulkIdResponseDto, BulkIdsDto } from 'src/dtos/asset-ids.response.dto.js';
import {
  MemoryCreateDto,
  MemoryExportCreateDto,
  MemoryExportResponseDto,
  MemoryExportSearchDto,
  MemoryResponseDto,
  MemorySearchDto,
  MemoryShowLessDto,
  MemoryShowLessResponseDto,
  MemoryStatisticsResponseDto,
  MemoryUpdateDto,
} from 'src/dtos/memory.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated, FileResponse } from 'src/middleware/auth.guard.js';
import { MemoryService } from 'src/services/memory.service.js';
import { asStreamableFile } from 'src/utils/file.js';
import { UUIDParamDto } from 'src/validation.js';

@ApiTags(ApiTag.Memories)
@Controller('memories')
export class MemoryController {
  constructor(private service: MemoryService) {}

  @Get()
  @Authenticated({ permission: Permission.MemoryRead })
  @Endpoint({
    summary: 'Retrieve memories',
    description:
      'Retrieve a list of memories. Memories are sorted descending by creation date by default, although they can also be sorted in ascending order, or randomly.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  searchMemories(@Auth() auth: AuthDto, @Query() dto: MemorySearchDto): Promise<MemoryResponseDto[]> {
    return this.service.search(auth, dto);
  }

  @Post()
  @Authenticated({ permission: Permission.MemoryCreate })
  @Endpoint({
    summary: 'Create a memory',
    description:
      'Create a new memory by providing a name, description, and a list of asset IDs to include in the memory.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  createMemory(@Auth() auth: AuthDto, @Body() dto: MemoryCreateDto): Promise<MemoryResponseDto> {
    return this.service.create(auth, dto);
  }

  @Get('statistics')
  @Authenticated({ permission: Permission.MemoryStatistics })
  @Endpoint({
    summary: 'Retrieve memories statistics',
    description: 'Retrieve statistics about memories, such as total count and other relevant metrics.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  memoriesStatistics(@Auth() auth: AuthDto, @Query() dto: MemorySearchDto): Promise<MemoryStatisticsResponseDto> {
    return this.service.statistics(auth, dto);
  }

  // "Show less" on memories (FL-62), declared before `:id` like the exports below.

  @Get('show-less')
  @Authenticated({ permission: Permission.MemoryRead })
  @Endpoint({
    summary: 'Retrieve memories show-less rules',
    description:
      "Retrieve the caller's own rules: people, pets, dates and kinds of memory they asked to see less of. Memories of them are neither generated nor shown.",
    history: new HistoryBuilder().added('v3'),
  })
  getMemoryShowLess(@Auth() auth: AuthDto): Promise<MemoryShowLessResponseDto[]> {
    return this.service.getShowLess(auth);
  }

  @Post('show-less')
  @Authenticated({ permission: Permission.MemoryUpdate })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Show less of a person, pet, date or kind of memory',
    description:
      "Add a show-less rule for one of the caller's own people or pets, a date written as 'MM-dd', or a memory type, and return every rule.",
    history: new HistoryBuilder().added('v3'),
  })
  addMemoryShowLess(@Auth() auth: AuthDto, @Body() dto: MemoryShowLessDto): Promise<MemoryShowLessResponseDto[]> {
    return this.service.addShowLess(auth, dto);
  }

  @Delete('show-less')
  @Authenticated({ permission: Permission.MemoryUpdate })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Remove a memories show-less rule',
    description:
      "Remove one of the caller's show-less rules, so its memories are generated and shown again, and return every rule.",
    history: new HistoryBuilder().added('v3'),
  })
  removeMemoryShowLess(@Auth() auth: AuthDto, @Body() dto: MemoryShowLessDto): Promise<MemoryShowLessResponseDto[]> {
    return this.service.removeShowLess(auth, dto);
  }

  // Private highlight exports (FL-62).
  //
  // These are declared before `:id` so `/memories/exports` is never swallowed by the
  // memory-by-id route. Every one of them is owner-scoped inside the service: an export is
  // only ever readable, cancellable, deletable and downloadable by the user who asked for
  // it, and there is no admin or shared-link path to somebody else's archive.

  @Get('exports')
  @Authenticated({ permission: Permission.MemoryRead })
  @Endpoint({
    summary: 'Retrieve memory exports',
    description:
      "Retrieve the caller's own private highlight exports, newest first, optionally limited to a single memory. This is the durable job state the Activity page reads.",
    history: new HistoryBuilder().added('v3'),
  })
  getMemoryExports(@Auth() auth: AuthDto, @Query() dto: MemoryExportSearchDto): Promise<MemoryExportResponseDto[]> {
    return this.service.getExports(auth, dto.memoryId);
  }

  @Get('exports/:id')
  @Authenticated({ permission: Permission.MemoryRead })
  @Endpoint({
    summary: 'Retrieve a memory export',
    description: "Retrieve the current state of one of the caller's own private highlight exports.",
    history: new HistoryBuilder().added('v3'),
  })
  getMemoryExport(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<MemoryExportResponseDto> {
    return this.service.getExport(auth, id);
  }

  @Post('exports/:id/cancel')
  @Authenticated({ permission: Permission.MemoryUpdate })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Cancel a memory export',
    description:
      'Ask for a running export to stop. A queued export is cancelled immediately; a running one stops at its next asset. Cancelling a finished export returns its final state unchanged.',
    history: new HistoryBuilder().added('v3'),
  })
  cancelMemoryExport(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<MemoryExportResponseDto> {
    return this.service.cancelExport(auth, id);
  }

  @Delete('exports/:id')
  @Authenticated({ permission: Permission.MemoryDelete })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Delete a memory export',
    description: 'Cancel the export if it is still running, then delete the run and its archive.',
    history: new HistoryBuilder().added('v3'),
  })
  deleteMemoryExport(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.deleteExport(auth, id);
  }

  @Get('exports/:id/download')
  @Authenticated({ permission: Permission.MemoryRead })
  @FileResponse()
  @Endpoint({
    summary: 'Download a memory export',
    description:
      "Download the finished archive for one of the caller's own exports. The archive is not reachable by any other route and is deleted when it expires.",
    history: new HistoryBuilder().added('v3'),
  })
  downloadMemoryExport(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<StreamableFile> {
    return this.service.downloadExport(auth, id).then(asStreamableFile);
  }

  // `MemoryUpdate`, not `MemoryRead`: starting an export queues work and writes a file, so
  // a read-only API key must not be able to do it. The service still checks `MemoryRead`
  // on the memory itself and `AssetDownload` on its assets.
  @Post(':id/exports')
  @Authenticated({ permission: Permission.MemoryUpdate })
  @HttpCode(HttpStatus.CREATED)
  @Endpoint({
    summary: 'Export a memory',
    description:
      "Start a private highlight export of a memory's assets as a durable, cancellable background job. The asset list is snapshotted when the export starts, and a second request while one is already running returns the export in flight.",
    history: new HistoryBuilder().added('v3'),
  })
  createMemoryExport(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: MemoryExportCreateDto,
  ): Promise<MemoryExportResponseDto> {
    return this.service.createExport(auth, id, dto);
  }

  @Get(':id')
  @Authenticated({ permission: Permission.MemoryRead })
  @Endpoint({
    summary: 'Retrieve a memory',
    description: 'Retrieve a specific memory by its ID.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getMemory(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<MemoryResponseDto> {
    return this.service.get(auth, id);
  }

  @Put(':id')
  @Authenticated({ permission: Permission.MemoryUpdate })
  @Endpoint({
    summary: 'Update a memory',
    description: 'Update an existing memory by its ID.',
    history: new HistoryBuilder()
      .added('v1')
      .beta('v1')
      .stable('v2')
      .deprecated('v3', { replacementId: 'updateMemory' }),
  })
  updateMemory(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: MemoryUpdateDto,
  ): Promise<MemoryResponseDto> {
    return this.service.update(auth, id, dto);
  }

  @Patch(':id')
  @ApiExcludeEndpoint()
  @Authenticated({ permission: Permission.MemoryUpdate })
  updateMemoryV3(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: MemoryUpdateDto,
  ): Promise<MemoryResponseDto> {
    return this.service.update(auth, id, dto);
  }

  @Delete(':id')
  @Authenticated({ permission: Permission.MemoryDelete })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Delete a memory',
    description: 'Delete a specific memory by its ID.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  deleteMemory(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.remove(auth, id);
  }

  @Put(':id/assets')
  @Authenticated({ permission: Permission.MemoryAssetCreate })
  @Endpoint({
    summary: 'Add assets to a memory',
    description: 'Add a list of asset IDs to a specific memory.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  addMemoryAssets(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: BulkIdsDto,
  ): Promise<BulkIdResponseDto[]> {
    return this.service.addAssets(auth, id, dto);
  }

  @Delete(':id/assets')
  @Authenticated({ permission: Permission.MemoryAssetDelete })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Remove assets from a memory',
    description: 'Remove a list of asset IDs from a specific memory.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  removeMemoryAssets(
    @Auth() auth: AuthDto,
    @Body() dto: BulkIdsDto,
    @Param() { id }: UUIDParamDto,
  ): Promise<BulkIdResponseDto[]> {
    return this.service.removeAssets(auth, id, dto);
  }
}
