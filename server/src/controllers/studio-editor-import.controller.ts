import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Injectable,
  Param,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { BundleUploadRequest } from 'src/controllers/studio-bundle.controller.js';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { StudioBundleUploadInterceptor } from 'src/controllers/studio-bundle.controller.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { StudioBundleUploadCreateDto } from 'src/dtos/studio-bundle.dto.js';
import {
  StudioEditorImportCreateDto,
  StudioEditorImportDto,
  StudioEditorImportProjectNotesDto,
  StudioEditorImportQueuedDto,
  StudioEditorImportStartDto,
  StudioEditorImportStartedDto,
  StudioEditorImportUploadDto,
} from 'src/dtos/studio-editor-import.dto.js';
import { ApiTag } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { StudioBundleService } from 'src/services/studio-bundle.service.js';
import { StudioEditorImportService } from 'src/services/studio-editor-import.service.js';
import { UUIDv7ParamDto } from 'src/validation.js';

/** Project files share the bundle uploads' owner reservation, size limit and 24-hour retention. */
@Injectable()
export class StudioEditorImportUploadInterceptor extends StudioBundleUploadInterceptor {
  constructor(service: StudioBundleService) {
    super(service);
  }
}

/**
 * Import a project from another video editor into Studio (FL-1542, Beta). Owner-only: an upload or
 * a job that is not yours answers `404`, exactly like one that does not exist.
 */
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/editor-imports')
export class StudioEditorImportController {
  constructor(private service: StudioEditorImportService) {}

  @Post('uploads')
  @HttpCode(HttpStatus.CREATED)
  @Authenticated()
  @ApiConsumes('multipart/form-data')
  @ApiBody({ description: 'A project file, or a CDL or LUT file to go with it', type: StudioBundleUploadCreateDto })
  @UseInterceptors(StudioEditorImportUploadInterceptor)
  @Endpoint({
    summary: 'Upload a project file from another editor',
    description:
      'Keeps a Final Cut Pro XML (.fcpxml, or a .fcpxmld bundle as a ZIP archive), Final Cut Pro 7 XML (.xml, which Premiere Pro and DaVinci Resolve also export), OpenTimelineIO (.otio, .otioz, or .otiod as a ZIP archive) or EDL (.edl) file for an import, or a CDL (.cdl, .cc, .ccc) or LUT (.cube) file to apply to the clips it names. Uploads are kept for 24 hours.',
    history: new HistoryBuilder().added('v3.5.0').beta('v3.5.0'),
  })
  uploadStudioEditorImportFile(
    @Auth() auth: AuthDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() request: BundleUploadRequest,
  ): Promise<StudioEditorImportUploadDto> {
    return this.service.registerUpload(auth, file, request.studioBundleUploadId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Authenticated()
  @Endpoint({
    summary: 'Check a project from another editor',
    description:
      'Queues a job that reads the uploaded project and finds each file it uses in your library: exact bytes for media carried in the archive, then the file name with its length and picture size. The result lists the timelines, what will come over differently, and each file as found, a likely match to confirm, or not in your library.',
    history: new HistoryBuilder().added('v3.5.0').beta('v3.5.0'),
  })
  createStudioEditorImport(
    @Auth() auth: AuthDto,
    @Body() dto: StudioEditorImportCreateDto,
  ): Promise<StudioEditorImportQueuedDto> {
    return this.service.create(auth, dto);
  }

  @Get('projects/:id')
  @Authenticated()
  @Endpoint({
    summary: 'Get the import notes of a project',
    description:
      'Owner only. For a project imported from another editor: the editor, the file, and each note about what came over differently, with where on the timeline. A project that was not imported answers `404`.',
    history: new HistoryBuilder().added('v3.5.0').beta('v3.5.0'),
  })
  getStudioEditorImportNotes(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
  ): Promise<StudioEditorImportProjectNotesDto> {
    return this.service.getProjectNotes(auth, id);
  }

  @Get(':id')
  @Authenticated()
  @Endpoint({
    summary: 'Get an import from another editor',
    description:
      'Owner only. The job status, step and progress, and once it has completed the check or the project it built.',
    history: new HistoryBuilder().added('v3.5.0').beta('v3.5.0'),
  })
  getStudioEditorImport(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<StudioEditorImportDto> {
    return this.service.get(auth, id);
  }

  @Post(':id/import')
  @HttpCode(HttpStatus.CREATED)
  @Authenticated()
  @Endpoint({
    summary: 'Import the checked project',
    description:
      'From a completed check: queues one job per timeline picked, each saving a new Studio project. Each file uses the library item chosen for it, or what the check found; a file with none keeps its clips as placeholders to relink. Files sent from your folder and media carried in the archive land in an album named after the project.',
    history: new HistoryBuilder().added('v3.5.0').beta('v3.5.0'),
  })
  startStudioEditorImport(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
    @Body() dto: StudioEditorImportStartDto,
  ): Promise<StudioEditorImportStartedDto> {
    return this.service.start(auth, id, dto);
  }
}
