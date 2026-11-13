import { Body, Controller, Get, HttpCode, HttpStatus, Next, Param, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { NextFunction, Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  FoundFileDetailResponseDto,
  FoundFileListDto,
  FoundFileListResponseDto,
  FoundFilesDeleteSpareDto,
  FoundFilesDeleteSpareResponseDto,
  FoundFilesResolveDto,
  FoundFilesResolveResponseDto,
  FoundFilesSummaryResponseDto,
} from 'src/dtos/found-file.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated, FileResponse, OriginalTransfer } from 'src/middleware/auth.guard.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { FoundFilesService } from 'src/services/found-files.service.js';
import { sendFile } from 'src/utils/file.js';
import { UUIDv7ParamDto } from 'src/validation.js';

/** FL-1537: the review of the photos found on the drive that no library listed. */
@ApiTags(ApiTag.Maintenance)
@Controller('admin/found-files')
export class FoundFileAdminController {
  constructor(
    private logger: LoggingRepository,
    private service: FoundFilesService,
  ) {}

  @Get()
  @Endpoint({
    summary: 'Get the found files summary',
    description:
      'How many files found on the drive were put back, added, left as spare copies or wait for a person, what was tidied without asking, and the groups that wait for one decision each.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  getFoundFilesSummary(): Promise<FoundFilesSummaryResponseDto> {
    return this.service.getSummary();
  }

  @Get('files')
  @Endpoint({
    summary: 'List found files',
    description:
      'A page of the found files with one outcome, oldest first. Each says whether the person asking may see its picture: another account’s is never shown.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  getFoundFiles(@Auth() auth: AuthDto, @Query() dto: FoundFileListDto): Promise<FoundFileListResponseDto> {
    return this.service.list(auth, dto);
  }

  @Get('files/:id')
  @Endpoint({
    summary: 'Get one found file',
    description: 'One found file with everything that was done with it, oldest first.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  getFoundFile(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<FoundFileDetailResponseDto> {
    return this.service.get(auth, id);
  }

  @Get('files/:id/file')
  @Endpoint({
    summary: 'Download a found file',
    description:
      'The file itself, to show its picture. Refused for a file that belongs to another account than the person asking.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  @FileResponse()
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  @OriginalTransfer()
  async downloadFoundFile(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
    @Res() res: Response,
    @Next() next: NextFunction,
  ): Promise<void> {
    await sendFile(res, next, () => this.service.getFile(auth, id), this.logger);
  }

  @Post('files/:id/undo')
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Undo what was done with a found file',
    description:
      'A file that was put back under a missing photo: the photo points where it did before. A file that was added: the photo leaves the library. The file stays on the drive and is not sorted again.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  undoFoundFile(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<FoundFileDetailResponseDto> {
    return this.service.undo(auth, id);
  }

  @Post('resolve')
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Decide about a group of found files',
    description:
      'Choose the account the files of a folder no account uses go to, add an account’s files over its storage limit this once, or sort the files held back while putting back was switched off. Works through a batch; call again with `nextCursor` until it is null.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  resolveFoundFiles(@Body() dto: FoundFilesResolveDto): Promise<FoundFilesResolveResponseDto> {
    return this.service.resolve(dto);
  }

  @Post('spare/delete')
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Delete spare copies',
    description:
      'Delete second copies of photos that are in a library. Each is deleted only after the photo it copies is read again and opens; a copy that cannot be shown to be spare is kept. Works through a batch; call again with `nextCursor` until it is null.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  deleteSpareFoundFiles(@Body() dto: FoundFilesDeleteSpareDto): Promise<FoundFilesDeleteSpareResponseDto> {
    return this.service.deleteSpares(dto);
  }
}
