import { Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { IdenticalFilesChangeDto, IdenticalFilesStatusDto } from 'src/dtos/identical-files.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { IdenticalFilesService } from 'src/services/identical-files.service.js';
import { UUIDParamDto } from 'src/validation.js';

/**
 * FL-413: identical files are stored once, for the whole server, with no account to choose. Admins read
 * where the latest run stands, ask for "Check again", and undo one photo's link ("Restore own file").
 */
@ApiTags(ApiTag.Maintenance)
@Controller('admin/identical-files')
export class IdenticalFilesController {
  constructor(private service: IdenticalFilesService) {}

  @Get()
  @Authenticated({ permission: Permission.JobRead, admin: true })
  @Endpoint({
    summary: 'Get the identical files status',
    description:
      'Where the latest identical-files run stands: its stage, what started it, the counts (files read, files stored once, photos merged, orphans recovered per owner, space moved to Unused files) and the first problems found.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  getIdenticalFilesStatus(): Promise<IdenticalFilesStatusDto> {
    return this.service.getStatus();
  }

  @Post('check')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.JobCreate, admin: true })
  @Endpoint({
    summary: 'Check identical files again',
    description:
      'Queue a full identical-files run: every managed original is read again, identical files across people share the oldest, identical photos in one library are merged into the oldest, and orphaned files are recovered into each owner’s Recovered Media album. A run already in progress carries on instead of starting again.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  checkIdenticalFiles(@Auth() auth: AuthDto): Promise<IdenticalFilesStatusDto> {
    return this.service.check(auth);
  }

  @Get('assets/:id/changes')
  @Authenticated({ permission: Permission.JobRead, admin: true })
  @Endpoint({
    summary: 'List a photo’s identical-file changes',
    description: 'The links the identical-files run made for one photo, newest first, and whether each can be undone.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  getIdenticalFileChanges(@Param() { id }: UUIDParamDto): Promise<IdenticalFilesChangeDto[]> {
    return this.service.getChanges(id);
  }

  @Post('changes/:id/undo')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.JobCreate, admin: true })
  @Endpoint({
    summary: 'Restore a photo’s own file',
    description:
      'Undo one link: the photo’s own file comes back out of Unused files to where it was, is checked to hold the same bytes, and the photo uses it again. The photo is never linked again automatically. Answers 409 when the file is no longer in Unused files or another file now sits at its place.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  undoIdenticalFileChange(@Param() { id }: UUIDParamDto): Promise<IdenticalFilesChangeDto> {
    return this.service.undoChange(id);
  }
}
