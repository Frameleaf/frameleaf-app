import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  TakeoutArchiveCreateDto,
  TakeoutArchiveParamsDto,
  TakeoutChunkQueryDto,
  TakeoutControlDto,
  TakeoutCreateDto,
  TakeoutItemParamsDto,
  TakeoutItemQueryDto,
  TakeoutItemsResponseDto,
  TakeoutOptionsDto,
  TakeoutPairDecisionDto,
  TakeoutPairQueryDto,
  TakeoutPairsResponseDto,
  TakeoutParamsDto,
  TakeoutResolveDto,
  TakeoutResponseDto,
  TakeoutRootsResponseDto,
  TakeoutSourceResponseDto,
  TakeoutVerifyChunkDto,
} from 'src/dtos/takeout.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { TAKEOUT_CHUNK_BYTES } from 'src/repositories/takeout-staging.repository.js';
import { TakeoutService } from 'src/services/takeout.service.js';

const history = () => new HistoryBuilder().added('v3.0.0').alpha('v3.0.0');

/**
 * Google Photos imports (FL-65, `IMP-001`): source → stage → scan → review → import → reconcile.
 *
 * Owner-scoped throughout. Scanning and importing run as durable media operations, so they also
 * appear, and can be paused, cancelled and retried, in Activity. `roots` is declared before `:id` so
 * it is never read as an id.
 */
@ApiTags(ApiTag.Assets)
@Controller('takeout')
export class TakeoutController {
  constructor(private service: TakeoutService) {}

  @Get()
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({ summary: 'List Google Photos imports', history: history() })
  listTakeoutImports(@Auth() auth: AuthDto): Promise<TakeoutResponseDto[]> {
    return this.service.list(auth);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Start a Google Photos import',
    description:
      'Creates an import to stage Takeout archives into. Administrators may instead name a folder inside one of the permitted import locations.',
    history: history(),
  })
  createTakeoutImport(@Auth() auth: AuthDto, @Body() dto: TakeoutCreateDto): Promise<TakeoutResponseDto> {
    return this.service.create(auth, dto);
  }

  @Get('roots')
  @Authenticated({ admin: true })
  @Endpoint({ summary: 'List the permitted import locations', history: history() })
  getTakeoutRoots(): TakeoutRootsResponseDto {
    return this.service.roots();
  }

  @Get(':id')
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({ summary: 'Get a Google Photos import', history: history() })
  getTakeoutImport(@Auth() auth: AuthDto, @Param() { id }: TakeoutParamsDto): Promise<TakeoutResponseDto> {
    return this.service.get(auth, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Delete a Google Photos import',
    description: 'Removes the import and its staged copies. Everything it brought into the library stays there.',
    history: history(),
  })
  deleteTakeoutImport(@Auth() auth: AuthDto, @Param() { id }: TakeoutParamsDto): Promise<void> {
    return this.service.remove(auth, id);
  }

  @Post(':id/archives')
  @HttpCode(HttpStatus.CREATED)
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({ summary: 'Stage a Takeout archive', history: history() })
  createTakeoutArchive(
    @Auth() auth: AuthDto,
    @Param() { id }: TakeoutParamsDto,
    @Body() dto: TakeoutArchiveCreateDto,
  ): Promise<TakeoutSourceResponseDto> {
    return this.service.addArchive(auth, id, dto);
  }

  @Delete(':id/archives/:archiveId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({ summary: 'Remove a staged Takeout archive', history: history() })
  deleteTakeoutArchive(@Auth() auth: AuthDto, @Param() { id, archiveId }: TakeoutArchiveParamsDto): Promise<void> {
    return this.service.removeArchive(auth, id, archiveId);
  }

  @Put(':id/archives/:archiveId/chunks')
  @Authenticated({ permission: Permission.AssetUpload })
  @ApiConsumes('application/octet-stream')
  @ApiBody({ schema: { type: 'string', format: 'binary' } })
  @Endpoint({
    summary: 'Upload part of a Takeout archive',
    description: 'Appends up to 8 MiB at the given byte offset. Repeating a part already staged is harmless.',
    history: history(),
  })
  async uploadTakeoutArchiveChunk(
    @Auth() auth: AuthDto,
    @Param() { id, archiveId }: TakeoutArchiveParamsDto,
    @Query() { offset }: TakeoutChunkQueryDto,
    @Req() request: Request,
  ): Promise<TakeoutSourceResponseDto> {
    if (request.headers['content-type']?.split(';', 1)[0] !== 'application/octet-stream') {
      throw new BadRequestException('Upload the archive bytes as application/octet-stream');
    }
    if (Number(request.headers['content-length']) > TAKEOUT_CHUNK_BYTES) {
      throw new BadRequestException('An upload part cannot exceed 8 MiB');
    }
    const parts: Buffer[] = [];
    let length = 0;
    for await (const part of request) {
      const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part as Uint8Array);
      length += bytes.length;
      if (length > TAKEOUT_CHUNK_BYTES) {
        throw new BadRequestException('An upload part cannot exceed 8 MiB');
      }
      parts.push(bytes);
    }
    return this.service.uploadChunk(auth, id, archiveId, offset, Buffer.concat(parts, length));
  }

  @Post(':id/archives/:archiveId/verify')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Check a staged part of a Takeout archive',
    description: 'Compares a range already uploaded with the file the browser is about to resume from.',
    history: history(),
  })
  verifyTakeoutArchiveChunk(
    @Auth() auth: AuthDto,
    @Param() { id, archiveId }: TakeoutArchiveParamsDto,
    @Body() dto: TakeoutVerifyChunkDto,
  ): Promise<void> {
    return this.service.verifyChunk(auth, id, archiveId, dto);
  }

  @Post(':id/scan')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Scan a Google Photos import',
    description: 'Queues the scan of the staged sources as a background job that continues after the browser closes.',
    history: history(),
  })
  scanTakeoutImport(@Auth() auth: AuthDto, @Param() { id }: TakeoutParamsDto): Promise<TakeoutResponseDto> {
    return this.service.scan(auth, id);
  }

  @Post(':id/import')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Import the reviewed items',
    description:
      'Queues the import as a background job with these choices. Items already in the library are matched, not copied again, and keep their album memberships.',
    history: history(),
  })
  startTakeoutImport(
    @Auth() auth: AuthDto,
    @Param() { id }: TakeoutParamsDto,
    @Body() dto: TakeoutOptionsDto,
  ): Promise<TakeoutResponseDto> {
    return this.service.startImport(auth, id, dto);
  }

  @Post(':id/control')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({ summary: 'Pause, resume or cancel a Google Photos import', history: history() })
  controlTakeoutImport(
    @Auth() auth: AuthDto,
    @Param() { id }: TakeoutParamsDto,
    @Body() dto: TakeoutControlDto,
  ): Promise<TakeoutResponseDto> {
    return this.service.control(auth, id, dto);
  }

  @Get(':id/items')
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({ summary: 'List the items of a Google Photos import', history: history() })
  getTakeoutItems(
    @Auth() auth: AuthDto,
    @Param() { id }: TakeoutParamsDto,
    @Query() query: TakeoutItemQueryDto,
  ): Promise<TakeoutItemsResponseDto> {
    return this.service.items(auth, id, query);
  }

  @Put(':id/items/:itemId')
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({ summary: 'Choose metadata for an item, or leave it out', history: history() })
  resolveTakeoutItem(
    @Auth() auth: AuthDto,
    @Param() { id, itemId }: TakeoutItemParamsDto,
    @Body() dto: TakeoutResolveDto,
  ): Promise<TakeoutResponseDto> {
    return this.service.resolve(auth, id, itemId, dto);
  }

  @Get(':id/live-photos')
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({ summary: 'List possible Live Photos in a Google Photos import', history: history() })
  getTakeoutPairs(
    @Auth() auth: AuthDto,
    @Param() { id }: TakeoutParamsDto,
    @Query() query: TakeoutPairQueryDto,
  ): Promise<TakeoutPairsResponseDto> {
    return this.service.pairs(auth, id, query);
  }

  @Put(':id/live-photos')
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({ summary: 'Link or separate a possible Live Photo', history: history() })
  decideTakeoutPair(
    @Auth() auth: AuthDto,
    @Param() { id }: TakeoutParamsDto,
    @Body() dto: TakeoutPairDecisionDto,
  ): Promise<TakeoutPairsResponseDto> {
    return this.service.decidePair(auth, id, dto);
  }
}
