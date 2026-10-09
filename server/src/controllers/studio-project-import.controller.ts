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
import { StudioProjectInventoryDto } from 'src/dtos/studio-inventory.dto.js';
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
      'Keeps a recording, sound, image, short video, SVG or Lottie graphic, caption file (.srt or .vtt) or .cube LUT with the project rather than the library. The type is read from the bytes; an SVG with scripts is refused, external subresources of a graphic are counted, and a caption file or LUT must be well formed throughout. The same id and file again answers the stored import.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  importStudioProjectFile(
    @Auth() auth: AuthDto,
    // Checked by the service, not a pipe, for the same reason as the body below.
    @Param('id') id: string,
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

  @Get(':id/inventory')
  @Authenticated()
  @Endpoint({
    summary: 'List what a Studio project keeps and uses',
    description:
      'The files kept with one of your projects, and the fonts, bundled LUTs and models its current revision names, each with its licence and whether this server may run it (GET /studio/resources lists everything it may).',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getStudioProjectInventory(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
  ): Promise<StudioProjectInventoryDto> {
    return this.service.inventory(auth, id);
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
    // A kept file is a picture or a sound, never a document: opened on its own it runs nothing and
    // is never read as another type (an SVG is scanned, and this is the belt to that brace).
    res.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
    res.header('X-Content-Type-Options', 'nosniff');
    await sendFile(res, next, () => this.service.getFile(auth, id, importId), this.logger);
  }
}
