import { Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  FileTrashListQueryDto,
  FileTrashResponseDto,
  FileTrashRestoreResponseDto,
} from 'src/dtos/physical-file-trash.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Authenticated } from 'src/middleware/auth.guard.js';
import { PhysicalFileTrashService } from 'src/services/physical-file-trash.service.js';
import { UUIDParamDto } from 'src/validation.js';

@ApiTags(ApiTag.FileTrash)
@Controller('admin/file-trash')
export class PhysicalFileTrashController {
  constructor(private service: PhysicalFileTrashService) {}

  @Get()
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  @Endpoint({
    summary: 'List the file trash',
    description:
      'Originals no library references any more, newest first, with the total disk space the file trash holds. Nothing here is deleted automatically.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  getFileTrash(@Query() dto: FileTrashListQueryDto): Promise<FileTrashResponseDto> {
    return this.service.list(dto);
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  @Endpoint({
    summary: 'Restore a file from the file trash',
    description:
      'Re-import the file as a new asset in the library it was last in, reading its metadata again. Answers 400 when that account is unknown or gone and 409 when its library already holds the file.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  restoreFileTrashItem(@Param() { id }: UUIDParamDto): Promise<FileTrashRestoreResponseDto> {
    return this.service.restore(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  @Endpoint({
    summary: 'Delete a file permanently',
    description: 'Delete the file from disk for good. This cannot be undone.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  deleteFileTrashItem(@Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.purge(id);
  }
}
