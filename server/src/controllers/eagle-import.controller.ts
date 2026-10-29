import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  EagleImportCreateDto,
  EagleImportListResponseDto,
  EagleImportQueryDto,
  EagleImportResponseDto,
  EagleLibrariesResponseDto,
  EagleLibraryCheckDto,
  EagleLibraryResponseDto,
} from 'src/dtos/eagle-import.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { EagleImportService } from 'src/services/eagle-import.service.js';
import { UUIDParamDto } from 'src/validation.js';

const history = () => new HistoryBuilder().added('v3');

/**
 * FL-653: import an Eagle library from a folder the server can open, so it keeps going with the
 * tab closed. Choosing a folder on the server is an administrator's choice, as for Google Photos
 * imports; the import itself belongs to the account that started it.
 */
@ApiTags(ApiTag.Assets)
@Controller('eagle-imports')
export class EagleImportController {
  constructor(private service: EagleImportService) {}

  @Get('libraries')
  @Authenticated({ admin: true })
  @Endpoint({
    summary: 'List the Eagle libraries in the permitted import locations',
    history: history(),
  })
  getEagleLibraries(@Auth() auth: AuthDto): Promise<EagleLibrariesResponseDto> {
    return this.service.listLibraries(auth);
  }

  @Post('check')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ admin: true })
  @Endpoint({
    summary: 'Read an Eagle library on the server for the check before importing',
    description: 'Reads the library’s lists only. Nothing is imported and the library is never changed.',
    history: history(),
  })
  checkEagleLibrary(@Auth() auth: AuthDto, @Body() dto: EagleLibraryCheckDto): Promise<EagleLibraryResponseDto> {
    return this.service.check(auth, dto);
  }

  @Post()
  @Authenticated({ admin: true })
  @Endpoint({
    summary: 'Import an Eagle library from a folder on the server',
    description:
      'Starts the import on the server, or carries on an earlier import of the same library from where it got to.',
    history: history(),
  })
  createEagleImport(@Auth() auth: AuthDto, @Body() dto: EagleImportCreateDto): Promise<EagleImportResponseDto> {
    return this.service.create(auth, dto);
  }

  @Get()
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({ summary: 'List your Eagle imports from the server that have not finished', history: history() })
  getEagleImports(@Auth() auth: AuthDto): Promise<EagleImportListResponseDto> {
    return this.service.listUnfinished(auth);
  }

  @Get(':id')
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({ summary: 'Get an Eagle import from the server', history: history() })
  getEagleImport(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Query() query: EagleImportQueryDto,
  ): Promise<EagleImportResponseDto> {
    return this.service.get(auth, id, query);
  }

  @Post(':id/stop')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Stop an Eagle import from the server',
    description: 'Stops after the item being brought over now. Everything already brought over stays.',
    history: history(),
  })
  stopEagleImport(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<EagleImportResponseDto> {
    return this.service.stop(auth, id);
  }
}
