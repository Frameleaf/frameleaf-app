import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Next,
  Param,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { diskStorage } from 'multer';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import type { NextFunction, Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  StudioProjectImportCreateDto,
  StudioProjectImportDto,
  StudioProjectImportParamDto,
} from 'src/dtos/studio-project-import.dto.js';
import { ApiTag } from 'src/enum.js';
import { Auth, AuthRequest, Authenticated, FileResponse } from 'src/middleware/auth.guard.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StudioProjectImportService, studioImportIncomingFolder } from 'src/services/studio-project-import.service.js';
import { sendFile } from 'src/utils/file.js';
import { STUDIO_IMPORT_MAX_BYTES } from 'src/utils/studio-imports.js';
import { UUIDv7ParamDto } from 'src/validation.js';

/**
 * Where an upload is written before it is checked: the uploader's own private folder, under a
 * random name. Never a path the client chose, never memory.
 */
const importUploadStorage = diskStorage({
  destination: (request, _file, callback) => {
    const ownerId = (request as unknown as AuthRequest).user?.user.id;
    if (!ownerId) {
      callback(new Error('Not authenticated'), '');
      return;
    }
    try {
      const folder = studioImportIncomingFolder(ownerId);
      mkdirSync(folder, { recursive: true });
      callback(null, folder);
    } catch (error) {
      callback(error as Error, '');
    }
  },
  filename: (_request, _file, callback) => callback(null, `${randomUUID()}.upload`),
});

/**
 * Files uploaded into a Studio project (FL-103 recordings, FL-105 media import). Owner-only: a
 * project that is not yours answers `404`, exactly like one that does not exist.
 */
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/projects')
export class StudioProjectImportController {
  constructor(
    private service: StudioProjectImportService,
    private logger: LoggingRepository,
  ) {}

  @Post(':id/imports')
  @HttpCode(HttpStatus.CREATED)
  @Authenticated()
  @ApiConsumes('multipart/form-data')
  @ApiBody({ description: 'A file to import into the project', type: StudioProjectImportCreateDto })
  @UseInterceptors(
    FileInterceptor('file', { storage: importUploadStorage, limits: { files: 1, fileSize: STUDIO_IMPORT_MAX_BYTES } }),
  )
  @Endpoint({
    summary: 'Import a file into a Studio project',
    description:
      'Keeps a recording, sound, image, short video, SVG or Lottie file with the project rather than the library. The type is read from the bytes; an SVG with scripts is refused and external subresources of a graphic are counted. The same id and file again answers the stored import.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  importStudioProjectFile(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
    // Checked by the service, not a pipe: a refused request must still remove the file multer wrote.
    @Body() body: { id?: unknown },
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<StudioProjectImportDto> {
    return this.service.upload(auth, id, typeof body?.id === 'string' ? body.id : undefined, file);
  }

  @Get(':id/imports')
  @Authenticated()
  @Endpoint({
    summary: 'List the files imported into a Studio project',
    description: 'Every file kept with one of your projects, with its type, size and checksum.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getStudioProjectImports(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<StudioProjectImportDto[]> {
    return this.service.list(auth, id);
  }

  @Get(':id/imports/:importId/file')
  @FileResponse()
  @Authenticated()
  @Endpoint({
    summary: 'Read a file imported into a Studio project',
    description: 'The bytes of a file kept with one of your projects, for the editor to play or show.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  async getStudioProjectImportFile(
    @Auth() auth: AuthDto,
    @Param() { id, importId }: StudioProjectImportParamDto,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    await sendFile(res, next, () => this.service.getFile(auth, id, importId), this.logger);
  }
}
