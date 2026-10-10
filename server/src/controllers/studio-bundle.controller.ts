import {
  Body,
  type CallHandler,
  Controller,
  Delete,
  type ExecutionContext,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Injectable,
  type NestInterceptor,
  Param,
  PayloadTooLargeException,
  Post,
  Req,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { diskStorage } from 'multer';
import { mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { type Observable, catchError, from, mergeMap, throwError } from 'rxjs';
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
import { StudioBundleService } from 'src/services/studio-bundle.service.js';
import { asStreamableFile } from 'src/utils/file.js';
import { STUDIO_BUNDLE_MAX_BYTES } from 'src/utils/studio-bundle.js';
import { UUIDv7ParamDto } from 'src/validation.js';

type BundleUploadRequest = AuthRequest & { studioBundleUploadId?: string };

/** Admission precedes Multer, so concurrent request bodies consume a reserved owner budget. */
@Injectable()
export class StudioBundleUploadInterceptor implements NestInterceptor {
  constructor(private service: StudioBundleService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<BundleUploadRequest>();
    const auth = request.user;
    if (!auth) throw new ForbiddenException();
    const length = Number(request.headers['content-length'] ?? STUDIO_BUNDLE_MAX_BYTES);
    if (!Number.isSafeInteger(length) || length < 1 || length > STUDIO_BUNDLE_MAX_BYTES + 1024 ** 2)
      throw new PayloadTooLargeException('Studio bundle is too large');
    const reserved = Math.min(length, STUDIO_BUNDLE_MAX_BYTES);
    const upload = await this.service.reserveUpload(auth, reserved);
    request.studioBundleUploadId = upload.id;
    const storage = diskStorage({
      destination: (_request, _file, callback) => {
        try {
          mkdirSync(dirname(upload.path), { recursive: true });
          callback(null, dirname(upload.path));
        } catch (error) {
          callback(error as Error, '');
        }
      },
      filename: (_request, _file, callback) => callback(null, basename(upload.path)),
    });
    // A live body cannot outlast its reservation's 24-hour retention.
    const timer = setTimeout(() => request.destroy(new Error('Studio bundle upload timed out')), 30 * 60_000);
    timer.unref();
    try {
      const interceptor = new (FileInterceptor('file', { storage, limits: { files: 1, fileSize: reserved } }))();
      const response = await interceptor.intercept(context, next);
      return response.pipe(
        catchError((error: unknown) =>
          from(this.service.abortUpload(auth, upload.id)).pipe(mergeMap(() => throwError(() => error))),
        ),
      );
    } catch (error) {
      await this.service.abortUpload(auth, upload.id);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

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
  @UseInterceptors(StudioBundleUploadInterceptor)
  @Endpoint({
    summary: 'Upload a Studio bundle',
    description:
      'Checks the archive against every bundle limit and verifies its manifest and project document before anything is kept. Returns what the import will relink, keep and report missing.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  uploadStudioBundle(
    @Auth() auth: AuthDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() request: BundleUploadRequest,
  ): Promise<StudioBundleUploadDto> {
    return this.service.registerUpload(auth, file, request.studioBundleUploadId);
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
