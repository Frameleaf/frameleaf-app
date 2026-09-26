import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { diskStorage } from 'multer';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { MediaOperationDto } from 'src/dtos/media-operation.dto.js';
import {
  StudioBundleImportCreateDto,
  StudioBundleOperationDto,
  StudioBundleUploadCreateDto,
  StudioBundleUploadDto,
} from 'src/dtos/studio-bundle.dto.js';
import { ApiTag } from 'src/enum.js';
import { Auth, AuthRequest, Authenticated, FileResponse, OriginalTransfer } from 'src/middleware/auth.guard.js';
import { StudioBundleService, studioBundleUploadFolder } from 'src/services/studio-bundle.service.js';
import { asStreamableFile } from 'src/utils/file.js';
import { STUDIO_BUNDLE_MAX_BYTES } from 'src/utils/studio-bundle.js';
import { UUIDv7ParamDto } from 'src/validation.js';

/**
 * Where an uploaded bundle is written: the uploading account's own private exports folder, under a
 * random name. Never a path the client chose, never memory — a bundle can be gigabytes.
 */
const bundleUploadStorage = diskStorage({
  destination: (request, _file, callback) => {
    const ownerId = (request as unknown as AuthRequest).user?.user.id;
    if (!ownerId) {
      callback(new Error('Not authenticated'), '');
      return;
    }
    try {
      const folder = studioBundleUploadFolder(ownerId);
      mkdirSync(folder, { recursive: true });
      callback(null, folder);
    } catch (error) {
      callback(error as Error, '');
    }
  },
  filename: (_request, _file, callback) => callback(null, `${randomUUID()}.zip`),
});

/**
 * Portable Studio project bundles (FL-91, `STU-204`).
 *
 * Export is started from the project (`POST /studio/projects/:id/bundle`); everything after that
 * lives here. Every route is owner-scoped: an upload, a job or a file that is not yours answers
 * `404`, exactly like one that does not exist.
 */
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/bundles')
export class StudioBundleController {
  constructor(private service: StudioBundleService) {}

  @Post('uploads')
  @HttpCode(HttpStatus.CREATED)
  @Authenticated()
  @ApiConsumes('multipart/form-data')
  @ApiBody({ description: 'A Studio bundle to import', type: StudioBundleUploadCreateDto })
  @UseInterceptors(
    FileInterceptor('file', { storage: bundleUploadStorage, limits: { files: 1, fileSize: STUDIO_BUNDLE_MAX_BYTES } }),
  )
  @Endpoint({
    summary: 'Upload a Studio bundle',
    description:
      'Checks the archive against every bundle limit and verifies its manifest and project document before anything is kept. Returns what the import will relink, keep and report missing.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  uploadStudioBundle(
    @Auth() auth: AuthDto,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<StudioBundleUploadDto> {
    return this.service.registerUpload(auth, file);
  }

  @Get('uploads/:id')
  @Authenticated()
  @Endpoint({
    summary: 'Get an uploaded Studio bundle',
    description: 'The review of an uploaded bundle, recomputed for your library as it is now.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  getStudioBundleUpload(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<StudioBundleUploadDto> {
    return this.service.getUpload(auth, id);
  }

  @Delete('uploads/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated()
  @Endpoint({
    summary: 'Discard an uploaded Studio bundle',
    description: 'Deletes the uploaded file now rather than when it expires.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  deleteStudioBundleUpload(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<void> {
    return this.service.deleteUpload(auth, id);
  }

  @Post('imports')
  @HttpCode(HttpStatus.CREATED)
  @Authenticated()
  @Endpoint({
    summary: 'Import a Studio bundle',
    description:
      'Queues an import of an uploaded bundle into a new project of yours. Every item you chose in place of a missing source is checked for access now and again when the import runs. Nothing in your library is changed.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  importStudioBundle(@Auth() auth: AuthDto, @Body() dto: StudioBundleImportCreateDto): Promise<MediaOperationDto> {
    return this.service.createImport(auth, dto);
  }

  @Get('operations/:id')
  @Authenticated()
  @Endpoint({
    summary: 'Get a Studio bundle job',
    description: 'The state of an export or import job, with the file or project it produced.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  getStudioBundleOperation(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<StudioBundleOperationDto> {
    return this.service.getOperation(auth, id);
  }

  @Get('exports/:id/download')
  @Authenticated()
  // FL-161: a bundle carries the project's source media
  @OriginalTransfer()
  @FileResponse()
  @Endpoint({
    summary: 'Download a Studio bundle',
    description:
      'The finished file of one of your own exports. It is reachable by no other route and is deleted when it expires.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  downloadStudioBundle(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<StreamableFile> {
    return this.service.downloadExport(auth, id).then(asStreamableFile);
  }
}
