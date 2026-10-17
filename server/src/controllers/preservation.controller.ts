import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
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
  PreservationDecisionsUpdateDto,
  PreservationExportCreateDto,
  PreservationItemsQueryDto,
  PreservationItemsResponseDto,
  PreservationPackageDto,
  PreservationPreviewDto,
  PreservationPreviewResponseDto,
  PreservationRestoreCreateDto,
  PreservationRestoreDto,
  PreservationRestoreItemsQueryDto,
  PreservationRestoreItemsResponseDto,
  PreservationServerPackageCreateDto,
  PreservationUploadCreateDto,
} from 'src/dtos/preservation.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, AuthRequest, Authenticated, FileResponse, OriginalTransfer } from 'src/middleware/auth.guard.js';
import { preservationUploadFolder } from 'src/repositories/preservation-files.repository.js';
import { PreservationService } from 'src/services/preservation.service.js';
import { asStreamableFile } from 'src/utils/file.js';
import { PRESERVATION_UPLOAD_MAX_BYTES } from 'src/utils/preservation.js';
import { UUIDv7ParamDto } from 'src/validation.js';

/**
 * Where an uploaded package is written: the uploading account's own private exports folder, under
 * a random name. Never a path the client chose, never memory — a package can be tens of gigabytes.
 */
const packageUploadStorage = diskStorage({
  destination: (request, _file, callback) => {
    const ownerId = (request as unknown as AuthRequest).user?.user.id;
    if (!ownerId) {
      callback(new Error('Not authenticated'), '');
      return;
    }
    try {
      const folder = preservationUploadFolder(ownerId);
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      callback(null, folder);
    } catch (error) {
      callback(error as Error, '');
    }
  },
  filename: (_request, _file, callback) => callback(null, `${randomUUID()}.zip`),
});

const history = () => new HistoryBuilder().added('v3.0.0').alpha('v3.0.0');

/**
 * Preservation packages (FL-74, `IMP-006`).
 *
 * Every route is owner-scoped: a package, an item report or a restoration that is not yours
 * answers `404`, exactly like one that does not exist. Writing, verifying, reviewing and restoring
 * are durable media operations; their progress, pause, cancel and retry are the media operation
 * routes, and they appear in Activity.
 */
@ApiTags(ApiTag.Preservation)
@Controller('preservation')
export class PreservationController {
  constructor(private service: PreservationService) {}

  @Get('packages')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AssetDownload })
  @Endpoint({
    summary: 'List preservation packages',
    description: 'Your packages, newest first, with their counts, last verification and newest job.',
    history: history(),
  })
  getPreservationPackages(@Auth() auth: AuthDto): Promise<PreservationPackageDto[]> {
    return this.service.listPackages(auth);
  }

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AssetDownload })
  @Endpoint({
    summary: 'Preview a preservation export',
    description:
      'How many of your items a selection holds, how large they are, whether they fit in one package and what a restoration brings back. Writes nothing.',
    history: history(),
  })
  previewPreservationExport(
    @Auth() auth: AuthDto,
    @Body() dto: PreservationPreviewDto,
  ): Promise<PreservationPreviewResponseDto> {
    return this.service.preview(auth, dto);
  }

  @Post('packages')
  @HttpCode(HttpStatus.CREATED)
  @Authenticated({ permission: Permission.AssetDownload })
  @Endpoint({
    summary: 'Create a preservation package',
    description:
      'Freezes a selection of your own items and queues the job that copies their originals, with checksums, metadata sidecars, albums, people, tags and edit recipes. Locked items are included only from an unlocked session.',
    history: history(),
  })
  createPreservationPackage(
    @Auth() auth: AuthDto,
    @Body() dto: PreservationExportCreateDto,
  ): Promise<PreservationPackageDto> {
    return this.service.createExport(auth, dto);
  }

  @Get('packages/:id')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AssetDownload })
  @Endpoint({ summary: 'Get a preservation package', description: 'One of your packages.', history: history() })
  getPreservationPackage(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<PreservationPackageDto> {
    return this.service.getPackage(auth, id);
  }

  @Get('packages/:id/items')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AssetDownload })
  @Endpoint({
    summary: 'Get a preservation package item report',
    description:
      'Each item of the package with its state, last verification and checksum. Locked items are counted but not named until the session is unlocked.',
    history: history(),
  })
  getPreservationPackageItems(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
    @Query() dto: PreservationItemsQueryDto,
  ): Promise<PreservationItemsResponseDto> {
    return this.service.getPackageItems(auth, id, dto);
  }

  @Post('packages/:id/retry')
  @HttpCode(HttpStatus.CREATED)
  @Authenticated({ permission: Permission.AssetDownload })
  @Endpoint({
    summary: 'Retry a preservation export',
    description: 'Queues a job that copies the items the package could not; items already copied are kept.',
    history: history(),
  })
  retryPreservationPackage(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<MediaOperationDto> {
    return this.service.retryExport(auth, id);
  }

  @Post('packages/:id/verify')
  @HttpCode(HttpStatus.CREATED)
  @Authenticated({ permission: Permission.AssetDownload })
  @Endpoint({
    summary: 'Verify a preservation package',
    description:
      'Queues a check of every file of the package against its manifest; missing and changed files are reported.',
    history: history(),
  })
  verifyPreservationPackage(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<MediaOperationDto> {
    return this.service.verifyPackage(auth, id);
  }

  @Get('packages/:id/download')
  @FileResponse()
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AssetDownload })
  @OriginalTransfer()
  @Endpoint({
    summary: 'Download a preservation package',
    description:
      'The package this server wrote, as one ZIP. A package holding Locked items needs an unlocked session. Verify the downloaded copy before relying on it.',
    history: history(),
  })
  downloadPreservationPackage(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<StreamableFile> {
    return this.service.downloadPackage(auth, id).then(asStreamableFile);
  }

  @Get('packages/:id/manifest')
  @FileResponse()
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AssetDownload })
  @Endpoint({
    summary: 'Download a preservation manifest',
    description: 'The manifest of a package this server wrote.',
    history: history(),
  })
  downloadPreservationManifest(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<StreamableFile> {
    return this.service.downloadManifest(auth, id).then(asStreamableFile);
  }

  @Delete('packages/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ permission: Permission.AssetDownload })
  @Endpoint({
    summary: 'Remove a preservation package',
    description:
      'Deletes the package’s own copy on this server. Your library’s originals are never touched, and a package named on the server by an administrator is only forgotten.',
    history: history(),
  })
  removePreservationPackage(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<void> {
    return this.service.removePackage(auth, id);
  }

  @Post('uploads')
  @HttpCode(HttpStatus.CREATED)
  @Authenticated({ permission: Permission.AssetUpload })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ description: 'A preservation package to verify or restore', type: PreservationUploadCreateDto })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: packageUploadStorage,
      limits: { files: 1, fileSize: PRESERVATION_UPLOAD_MAX_BYTES },
    }),
  )
  @Endpoint({
    summary: 'Upload a preservation package',
    description:
      'Reads the package’s manifest before anything is kept. The upload is kept for three days for verification and restoration.',
    history: history(),
  })
  uploadPreservationPackage(
    @Auth() auth: AuthDto,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<PreservationPackageDto> {
    return this.service.registerUpload(auth, file);
  }

  @Post('server-packages')
  @HttpCode(HttpStatus.CREATED)
  @Authenticated({ permission: Permission.AssetUpload, admin: true })
  @Endpoint({
    summary: 'Register a preservation package on the server',
    description:
      'An administrator names a package directory or ZIP on this server, outside its media storage, to verify or restore into their own library. It is read in place and never modified.',
    history: history(),
  })
  registerPreservationServerPackage(
    @Auth() auth: AuthDto,
    @Body() dto: PreservationServerPackageCreateDto,
  ): Promise<PreservationPackageDto> {
    return this.service.registerServerPackage(auth, dto);
  }

  @Get('restores')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({ summary: 'List restorations', description: 'Your restorations, newest first.', history: history() })
  getPreservationRestores(@Auth() auth: AuthDto): Promise<PreservationRestoreDto[]> {
    return this.service.listRestores(auth);
  }

  @Post('restores')
  @HttpCode(HttpStatus.CREATED)
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Start a restoration',
    description:
      'Queues a review of the package: every file is verified and compared with your library. Nothing is written until you restore.',
    history: history(),
  })
  createPreservationRestore(
    @Auth() auth: AuthDto,
    @Body() dto: PreservationRestoreCreateDto,
  ): Promise<PreservationRestoreDto> {
    return this.service.createRestore(auth, dto);
  }

  @Get('restores/:id')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({ summary: 'Get a restoration', description: 'One of your restorations.', history: history() })
  getPreservationRestore(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<PreservationRestoreDto> {
    return this.service.getRestore(auth, id);
  }

  @Get('restores/:id/items')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Get restoration items',
    description:
      'What the review found for each item — new, already in your library, or in the trash — the fields that disagree, your choices and what the restore left for you to look at.',
    history: history(),
  })
  getPreservationRestoreItems(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
    @Query() dto: PreservationRestoreItemsQueryDto,
  ): Promise<PreservationRestoreItemsResponseDto> {
    return this.service.getRestoreItems(auth, id, dto);
  }

  @Put('restores/:id/decisions')
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Record restoration choices',
    description:
      'Your choices where the package and your library disagree. They apply to items not yet restored; a retry keeps them.',
    history: history(),
  })
  updatePreservationRestoreDecisions(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
    @Body() dto: PreservationDecisionsUpdateDto,
  ): Promise<PreservationRestoreDto> {
    return this.service.updateDecisions(auth, id, dto);
  }

  @Post('restores/:id/apply')
  @HttpCode(HttpStatus.CREATED)
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Restore a reviewed package',
    description:
      'Queues the restore: originals your library lacks are added, ones it has are matched and never replaced, and metadata is applied by your choices. Asking again carries on a restore that stopped.',
    history: history(),
  })
  applyPreservationRestore(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<MediaOperationDto> {
    return this.service.applyRestore(auth, id);
  }
}
