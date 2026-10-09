import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { StorageMigrationStatusResponseDto } from 'src/dtos/queue.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Authenticated } from 'src/middleware/auth.guard.js';
import { StorageTemplateService } from 'src/services/storage-template.service.js';

/**
 * FL-349: the storage template migration as two calls for the native apps' Migration page. The
 * migration itself is the `storageTemplateMigration` queue; these read it and start it.
 */
@ApiTags(ApiTag.Queues)
@Controller('admin/storage-migration')
export class StorageMigrationAdminController {
  constructor(private service: StorageTemplateService) {}

  @Get()
  @Authenticated({ permission: Permission.QueueRead, admin: true })
  @Endpoint({
    summary: 'Get storage migration status',
    description:
      'Whether the storage template is on, which template originals are moved to, and where the storage template migration queue stands: running, paused, unfinished work and job counts.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  getStorageMigrationStatus(): Promise<StorageMigrationStatusResponseDto> {
    return this.service.getMigrationStatus();
  }

  @Post()
  @Authenticated({ permission: Permission.QueueUpdate, admin: true })
  @HttpCode(HttpStatus.ACCEPTED)
  @Endpoint({
    summary: 'Run storage migration in the background',
    description:
      'Start moving originals to the paths the storage template names, in the background, and return the status. Refused with 400 while the storage template is off and with 409 while a migration is already running.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  runStorageMigrationInBackground(): Promise<StorageMigrationStatusResponseDto> {
    return this.service.runMigration();
  }
}
