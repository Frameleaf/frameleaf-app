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
  LocationHistoryChunkQueryDto,
  LocationHistorySourceCreateDto,
  LocationHistorySourceResponseDto,
  LocationHistoryUploadCreateDto,
  LocationHistoryUploadParamsDto,
  LocationHistoryUploadResponseDto,
} from 'src/dtos/location-history.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { LOCATION_HISTORY_CHUNK_BYTES } from 'src/repositories/location-history.repository.js';
import { LocationHistoryService } from 'src/services/location-history.service.js';
import { UUIDv7ParamDto } from 'src/validation.js';

const history = () => new HistoryBuilder().added('v3.4.0').alpha('v3.4.0');

/**
 * FL-925: your own location history files (Google Timeline, GPX, OwnTracks, Dawarich). Every route is the signed-in
 * person's own: there is no route for another account, an administrator or a shared link.
 */
@ApiTags(ApiTag.Users)
@Controller('users/me/location-history')
export class LocationHistoryController {
  constructor(private service: LocationHistoryService) {}

  @Post('uploads')
  @HttpCode(HttpStatus.CREATED)
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'Start uploading a location history file',
    description:
      'Send the file in parts next, then add it with its upload ID. An upload left unfinished is cleared after a day.',
    history: history(),
  })
  createLocationHistoryUpload(
    @Auth() auth: AuthDto,
    @Body() dto: LocationHistoryUploadCreateDto,
  ): Promise<LocationHistoryUploadResponseDto> {
    return this.service.createUpload(auth, dto);
  }

  @Put('uploads/:id')
  @Authenticated({ permission: Permission.AssetUpdate })
  @ApiConsumes('application/octet-stream')
  @ApiBody({ schema: { type: 'string', format: 'binary' } })
  @Endpoint({
    summary: 'Upload part of a location history file',
    description:
      'Appends up to 8 MiB at the given byte offset. Repeating a part already stored is harmless; a part at the wrong offset is refused with where to resume.',
    history: history(),
  })
  async uploadLocationHistoryPart(
    @Auth() auth: AuthDto,
    @Param() { id }: LocationHistoryUploadParamsDto,
    @Query() { offset }: LocationHistoryChunkQueryDto,
    @Req() request: Request,
  ): Promise<LocationHistoryUploadResponseDto> {
    if (request.headers['content-type']?.split(';', 1)[0] !== 'application/octet-stream') {
      throw new BadRequestException('Upload the file bytes as application/octet-stream');
    }
    if (Number(request.headers['content-length']) > LOCATION_HISTORY_CHUNK_BYTES) {
      throw new BadRequestException('An upload part cannot exceed 8 MiB');
    }
    const parts: Buffer[] = [];
    let length = 0;
    for await (const part of request) {
      const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part as Uint8Array);
      length += bytes.length;
      if (length > LOCATION_HISTORY_CHUNK_BYTES) {
        throw new BadRequestException('An upload part cannot exceed 8 MiB');
      }
      parts.push(bytes);
    }
    return this.service.uploadChunk(auth, id, offset, Buffer.concat(parts, length));
  }

  @Post('sources')
  @HttpCode(HttpStatus.CREATED)
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'Add an uploaded location history file',
    description:
      'Reads the finished upload in the background, which continues after the browser closes. The format is told from the file itself. Photos are not changed.',
    history: history(),
  })
  createLocationHistorySource(
    @Auth() auth: AuthDto,
    @Body() dto: LocationHistorySourceCreateDto,
  ): Promise<LocationHistorySourceResponseDto> {
    return this.service.createSource(auth, dto);
  }

  @Get('sources')
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'List your location history files',
    description: 'Each file with the dates it covers. A file still being read has no import date yet.',
    history: history(),
  })
  getLocationHistorySources(@Auth() auth: AuthDto): Promise<LocationHistorySourceResponseDto[]> {
    return this.service.getSources(auth);
  }

  @Delete('sources/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'Remove a location history file',
    description: 'Removes the history that came from this file. Photos keep any location they were given from it.',
    history: history(),
  })
  deleteLocationHistorySource(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<void> {
    return this.service.deleteSource(auth, id);
  }
}
