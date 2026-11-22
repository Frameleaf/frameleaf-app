import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  ImportConnectionCreateDto,
  ImportConnectionFolderQueryDto,
  ImportConnectionFoldersResponseDto,
  ImportConnectionParamsDto,
  ImportConnectionProvidersResponseDto,
  ImportConnectionResponseDto,
  ImportConnectionRootsDto,
  ImportConnectionRunParamsDto,
  ImportConnectionStatisticsResponseDto,
  ImportConnectionUpdateDto,
} from 'src/dtos/import-connector.dto.js';
import {
  TakeoutControlDto,
  TakeoutItemQueryDto,
  TakeoutItemsResponseDto,
  TakeoutOptionsDto,
  TakeoutResponseDto,
} from 'src/dtos/takeout.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { ImportConnectorService } from 'src/services/import-connector.service.js';

const history = () => new HistoryBuilder().added('v3.0.0').alpha('v3.0.0');

/**
 * Import connections (FL-920): connect a remote place, choose folders, scan, review, import, and
 * check daily for what is new.
 *
 * Owner-scoped throughout; `statistics` is the one administrator route and gives counts only. A run
 * answers in the Google Photos import's shapes. `providers` and `statistics` are declared before
 * `:id` so they are never read as an id.
 */
@ApiTags(ApiTag.Assets)
@Controller('import-connections')
export class ImportConnectorController {
  constructor(private service: ImportConnectorService) {}

  @Get()
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({ summary: 'List import connections', history: history() })
  getImportConnections(@Auth() auth: AuthDto): Promise<ImportConnectionResponseDto[]> {
    return this.service.list(auth);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Connect a remote source',
    description:
      'The source is asked for its folders once, so a wrong sign-in is refused. The sign-in details are sealed on the server and are never returned.',
    history: history(),
  })
  createImportConnection(
    @Auth() auth: AuthDto,
    @Body() dto: ImportConnectionCreateDto,
  ): Promise<ImportConnectionResponseDto> {
    return this.service.create(auth, dto);
  }

  @Get('providers')
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({ summary: 'List the kinds of source this server can connect to', history: history() })
  getImportConnectionProviders(): ImportConnectionProvidersResponseDto {
    return this.service.providers();
  }

  @Get('statistics')
  @Authenticated({ admin: true })
  @Endpoint({
    summary: 'Count import connections',
    description: 'For administrators: how many connections exist, by kind. Nothing about whose they are.',
    history: history(),
  })
  getImportConnectionStatistics(): Promise<ImportConnectionStatisticsResponseDto> {
    return this.service.statistics();
  }

  @Get(':id')
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({ summary: 'Get an import connection', history: history() })
  getImportConnection(
    @Auth() auth: AuthDto,
    @Param() { id }: ImportConnectionParamsDto,
  ): Promise<ImportConnectionResponseDto> {
    return this.service.get(auth, id);
  }

  @Patch(':id')
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Rename an import connection, change its daily check, or sign in again',
    history: history(),
  })
  updateImportConnection(
    @Auth() auth: AuthDto,
    @Param() { id }: ImportConnectionParamsDto,
    @Body() dto: ImportConnectionUpdateDto,
  ): Promise<ImportConnectionResponseDto> {
    return this.service.update(auth, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Remove an import connection',
    description:
      'Removes the connection and its runs. Everything it brought into the library stays there, and nothing changes at the source.',
    history: history(),
  })
  deleteImportConnection(@Auth() auth: AuthDto, @Param() { id }: ImportConnectionParamsDto): Promise<void> {
    return this.service.remove(auth, id);
  }

  @Get(':id/folders')
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({ summary: 'List the folders inside a folder at the source', history: history() })
  getImportConnectionFolders(
    @Auth() auth: AuthDto,
    @Param() { id }: ImportConnectionParamsDto,
    @Query() { path }: ImportConnectionFolderQueryDto,
  ): Promise<ImportConnectionFoldersResponseDto> {
    return this.service.folders(auth, id, path);
  }

  @Put(':id/roots')
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({ summary: 'Choose the folders an import connection reads', history: history() })
  setImportConnectionRoots(
    @Auth() auth: AuthDto,
    @Param() { id }: ImportConnectionParamsDto,
    @Body() dto: ImportConnectionRootsDto,
  ): Promise<ImportConnectionResponseDto> {
    return this.service.setRoots(auth, id, dto);
  }

  @Post(':id/scan')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Scan the source for what is new',
    description:
      'Starts a run that lists the chosen folders and offers every file the connection has not seen, or that changed. Nothing is downloaded until the run is imported.',
    history: history(),
  })
  scanImportConnection(@Auth() auth: AuthDto, @Param() { id }: ImportConnectionParamsDto): Promise<TakeoutResponseDto> {
    return this.service.scan(auth, id);
  }

  @Get(':id/runs')
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({ summary: 'List the runs of an import connection', history: history() })
  getImportConnectionRuns(
    @Auth() auth: AuthDto,
    @Param() { id }: ImportConnectionParamsDto,
  ): Promise<TakeoutResponseDto[]> {
    return this.service.runs(auth, id);
  }

  @Get(':id/runs/:runId')
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({ summary: 'Get a run of an import connection', history: history() })
  getImportConnectionRun(
    @Auth() auth: AuthDto,
    @Param() { id, runId }: ImportConnectionRunParamsDto,
  ): Promise<TakeoutResponseDto> {
    return this.service.run(auth, id, runId);
  }

  @Get(':id/runs/:runId/items')
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({ summary: 'List what a run found', history: history() })
  getImportConnectionRunItems(
    @Auth() auth: AuthDto,
    @Param() { id, runId }: ImportConnectionRunParamsDto,
    @Query() query: TakeoutItemQueryDto,
  ): Promise<TakeoutItemsResponseDto> {
    return this.service.items(auth, id, runId, query);
  }

  @Post(':id/runs/:runId/import')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Import what a run found',
    description:
      'Downloads and imports the run’s files with the given choices. Files already in the library are matched, not added again.',
    history: history(),
  })
  startImportConnectionRun(
    @Auth() auth: AuthDto,
    @Param() { id, runId }: ImportConnectionRunParamsDto,
    @Body() dto: TakeoutOptionsDto,
  ): Promise<TakeoutResponseDto> {
    return this.service.startImport(auth, id, runId, dto);
  }

  @Post(':id/runs/:runId/control')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({ summary: 'Pause, resume or cancel the job working on a run', history: history() })
  controlImportConnectionRun(
    @Auth() auth: AuthDto,
    @Param() { id, runId }: ImportConnectionRunParamsDto,
    @Body() dto: TakeoutControlDto,
  ): Promise<TakeoutResponseDto> {
    return this.service.control(auth, id, runId, dto);
  }
}
