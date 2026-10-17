import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  BackupDeviceDto,
  BackupDeviceListDto,
  BackupDevicePageDto,
  BackupDeviceWriteDto,
  ReconciliationBucketDto,
  ReconciliationHistoryDto,
  ReconciliationResultDto,
  ReconciliationStartDto,
} from 'src/dtos/backup-device.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { BackupDeviceService } from 'src/services/backup-device.service.js';
import { UUIDParamDto } from 'src/validation.js';

class ReconciliationParams extends createZodDto(z.object({ id: z.uuid(), runId: z.uuid() })) {}

@ApiTags(ApiTag.Users)
@Controller('users/me/backup-devices')
export class BackupDeviceController {
  constructor(private service: BackupDeviceService) {}
  @Post()
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.UserUpdate })
  @Endpoint({
    summary: 'Register or report an own backup device',
    description:
      'Stable deviceKey scoped to the owner. Success time and pending count are device-reported, never checksum verification. Removing a device preserves assets and reconciliation history.',
    history: new HistoryBuilder().added('v3'),
  })
  registerBackupDevice(@Auth() auth: AuthDto, @Body() dto: BackupDeviceWriteDto): Promise<BackupDeviceDto> {
    return this.service.register(auth, dto);
  }

  @Get()
  @Authenticated({ permission: Permission.UserRead })
  @Endpoint({ summary: 'List own backup devices', history: new HistoryBuilder().added('v3') })
  listBackupDevices(@Auth() auth: AuthDto, @Query() page: BackupDevicePageDto): Promise<BackupDeviceListDto> {
    return this.service.list(auth, page);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ permission: Permission.UserUpdate })
  @Endpoint({
    summary: 'Remove an own backup device without deleting assets',
    history: new HistoryBuilder().added('v3'),
  })
  removeBackupDevice(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.remove(auth, id);
  }

  @Post(':id/reconciliations')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Start own device inventory reconciliation',
    description:
      'Requires a current elevated session and no active hidden-content filter.256 indexed bucket digests of sorted unique raw SHA256 bytes, maximum2000 hashes per bucket. Differing buckets require complete hash lists. Snapshot database inventory excludes offline/last-checked-missing originals; not a fresh filesystem check.',
    history: new HistoryBuilder().added('v3'),
  })
  startBackupReconciliation(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: ReconciliationStartDto,
  ): Promise<ReconciliationResultDto> {
    return this.service.start(auth, id, dto);
  }

  @Post(':id/reconciliations/:runId/buckets')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Reconcile one complete differing bucket',
    description:
      'Up to2000 distinct SHA256 hashes matching original count/digest and first-byte bucket. Server extras never count as device missing. Changed server inventory refuses continuation; start a new run. Repeated validated bucket requests do not double-count; a concurrent snapshot conflict returns409 and may be retried. No completed audit until every differing bucket is validated.',
    history: new HistoryBuilder().added('v3'),
  })
  reconcileBackupBucket(
    @Auth() auth: AuthDto,
    @Param() { id, runId }: ReconciliationParams,
    @Body() dto: ReconciliationBucketDto,
  ): Promise<ReconciliationResultDto> {
    return this.service.submit(auth, id, runId, dto);
  }

  @Get(':id/reconciliations')
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'List own device reconciliation history',
    description:
      'Requires elevated unfiltered session; checkedAt identifies actual inventory snapshot. Includes incomplete runs explicitly; admin metadata access never grants foreign hash access.',
    history: new HistoryBuilder().added('v3'),
  })
  listBackupReconciliations(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Query() page: BackupDevicePageDto,
  ): Promise<ReconciliationHistoryDto> {
    return this.service.history(auth, id, page);
  }
}

@ApiTags(ApiTag.UsersAdmin)
@Controller('admin/backup-devices')
export class BackupDeviceAdminController {
  constructor(private service: BackupDeviceService) {}
  @Get()
  @Authenticated({ permission: Permission.AdminUserRead, admin: true })
  @Endpoint({
    summary: 'List backup device metadata across users',
    description:
      'Administrative metadata only. No reconciliation digests or foreign asset access. quietForDays is elapsed whole days since reported successful backup, null when never reported.',
    history: new HistoryBuilder().added('v3'),
  })
  listAllBackupDevices(@Auth() auth: AuthDto, @Query() page: BackupDevicePageDto): Promise<BackupDeviceListDto> {
    return this.service.list(auth, page, true);
  }
}
