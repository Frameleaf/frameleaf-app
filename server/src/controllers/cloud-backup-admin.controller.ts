import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  CloudBackupCheckDto,
  CloudBackupCheckResponseDto,
  CloudBackupEscrowDto,
  CloudBackupGeneratedKeyDto,
  CloudBackupManifestAlbumsDto,
  CloudBackupManifestAlbumsResponseDto,
  CloudBackupManifestItemsDto,
  CloudBackupManifestItemsResponseDto,
  CloudBackupManifestsResponseDto,
  CloudBackupPruneDto,
  CloudBackupRestoreDto,
  CloudBackupSetupDto,
  CloudBackupStatusResponseDto,
  CloudBackupUnlockDto,
  CloudBackupVerifyDto,
} from 'src/dtos/cloud-backup.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { CloudBackupService } from 'src/services/cloud-backup.service.js';
import { UUIDv7ParamDto } from 'src/validation.js';

/**
 * Cloud backup administration (FL-160): the bucket claim, the bucket key and the runs. The bucket key is
 * returned once, by `POST key`, for the recovery kit; never after that. FL-164: verification, clean-up,
 * the kept backups and restore from them, and key escrow with Frameleaf Cloud.
 */
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/cloud/backup')
export class CloudBackupAdminController {
  constructor(private service: CloudBackupService) {}

  @Get()
  @Authenticated({ permission: Permission.AdminCloudBackupRead, admin: true })
  @Endpoint({
    operationId: 'getCloudBackupStatus',
    summary: 'Get the cloud backup status',
    description:
      'The claimed bucket, the key mode and fingerprint (never the key), whether the key is loaded, the last run, the last success, usage and the run in progress.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getStatus(): Promise<CloudBackupStatusResponseDto> {
    return this.service.getStatus();
  }

  @Post('check')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true })
  @Endpoint({
    operationId: 'checkCloudBackupBucket',
    summary: 'Check a bucket for cloud backup',
    description:
      'Lists the bucket and writes, reads back and deletes a test file encrypted with a throwaway customer key (SSE-C). Nothing is claimed or saved.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  check(@Body() dto: CloudBackupCheckDto): Promise<CloudBackupCheckResponseDto> {
    return this.service.check(dto);
  }

  @Post('key')
  @Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true })
  @Endpoint({
    operationId: 'generateCloudBackupKey',
    summary: 'Generate a bucket key',
    description:
      'A new 256-bit key made by this server for "Generate a key for me", returned this once for the recovery kit. Nothing is stored until setup claims a bucket with it.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  generateKey(): CloudBackupGeneratedKeyDto {
    return this.service.generateKey();
  }

  @Post('setup')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true })
  @Endpoint({
    operationId: 'setupCloudBackup',
    summary: 'Set up cloud backup',
    description:
      'Claims the bucket for this server with the chosen key (an SSE-C write of frameleaf-backup.json holding the instance id) and turns cloud backup on. Refuses a bucket claimed by another server or holding other files, and a provider without SSE-C.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  setup(@Auth() auth: AuthDto, @Body() dto: CloudBackupSetupDto): Promise<CloudBackupStatusResponseDto> {
    return this.service.setup(auth, dto);
  }

  @Post('key/unlock')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true })
  @Endpoint({
    operationId: 'unlockCloudBackupKey',
    summary: 'Load the backup key into memory',
    description:
      'Own-memory key mode: loads the key after a restart. It is held in memory by this server’s workers only, never saved; backups wait until it is loaded.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  unlock(@Body() dto: CloudBackupUnlockDto): Promise<CloudBackupStatusResponseDto> {
    return this.service.unlock(dto);
  }

  @Delete()
  @Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true })
  @Endpoint({
    operationId: 'turnOffCloudBackup',
    summary: 'Turn cloud backup off',
    description: 'Stops backing up. The bucket, its backups and the key are kept.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  turnOff(@Auth() auth: AuthDto): Promise<CloudBackupStatusResponseDto> {
    return this.service.turnOff(auth);
  }

  @Post('runs')
  @Authenticated({ permission: Permission.AdminCloudBackupRun, admin: true })
  @Endpoint({
    operationId: 'startCloudBackupRun',
    summary: 'Back up now',
    description:
      'Queues a backup run, or answers with the one already queued or running. Only new or changed files upload.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  startRun(@Auth() auth: AuthDto): Promise<CloudBackupStatusResponseDto> {
    return this.service.startRun(auth);
  }

  @Post('runs/:id/pause')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AdminCloudBackupRun, admin: true })
  @Endpoint({
    operationId: 'pauseCloudBackupRun',
    summary: 'Pause a backup run',
    description: 'The run stops after the files in hand and carries on from there when resumed.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  pauseRun(@Param() { id }: UUIDv7ParamDto): Promise<CloudBackupStatusResponseDto> {
    return this.service.pauseRun(id);
  }

  @Post('runs/:id/resume')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AdminCloudBackupRun, admin: true })
  @Endpoint({
    operationId: 'resumeCloudBackupRun',
    summary: 'Resume a backup run',
    description: 'A paused run goes back to the queue and finishes the same manifest.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  resumeRun(@Param() { id }: UUIDv7ParamDto): Promise<CloudBackupStatusResponseDto> {
    return this.service.resumeRun(id);
  }

  @Post('runs/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AdminCloudBackupRun, admin: true })
  @Endpoint({
    operationId: 'cancelCloudBackupRun',
    summary: 'Cancel a backup run',
    description:
      'The run stops without a manifest. Files it already uploaded stay in the bucket and are not uploaded again.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  cancelRun(@Param() { id }: UUIDv7ParamDto): Promise<CloudBackupStatusResponseDto> {
    return this.service.cancelRun(id);
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AdminCloudBackupRun, admin: true })
  @Endpoint({
    operationId: 'verifyCloudBackup',
    summary: 'Check the backed-up files',
    description:
      'Queues a check of the bucket: sample fetches this week’s 1/52 of the files and checks each against its SHA-256; full checks every file a kept backup names is there. Missing or damaged files are uploaded again by the next run.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  verify(@Auth() auth: AuthDto, @Body() dto: CloudBackupVerifyDto): Promise<CloudBackupStatusResponseDto> {
    return this.service.startVerify(auth, dto);
  }

  @Post('prune')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AdminCloudBackupRun, admin: true })
  @Endpoint({
    operationId: 'pruneCloudBackup',
    summary: 'Clean up backups past retention',
    description:
      'Queues a clean-up of runs past the retention settings. Only files no kept backup names are removed. A dry run counts what would go; the clean-up itself needs a dry run from the last day first.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  prune(@Auth() auth: AuthDto, @Body() dto: CloudBackupPruneDto): Promise<CloudBackupStatusResponseDto> {
    return this.service.startPrune(auth, dto);
  }

  @Get('manifests')
  @Authenticated({ permission: Permission.AdminCloudBackupRead, admin: true })
  @Endpoint({
    operationId: 'getCloudBackupManifests',
    summary: 'List the kept backups',
    description: 'The backups retention keeps, newest first, with their size and the database dump each pairs with.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getManifests(): Promise<CloudBackupManifestsResponseDto> {
    return this.service.listManifests();
  }

  @Post('manifests/items')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AdminCloudBackupRead, admin: true })
  @Endpoint({
    operationId: 'searchCloudBackupManifestItems',
    summary: 'Search the items in a backup',
    description:
      'The items one kept backup holds, found by file name, and whether each is still in the library. Reads the backup’s manifest from the bucket.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  searchManifestItems(@Body() dto: CloudBackupManifestItemsDto): Promise<CloudBackupManifestItemsResponseDto> {
    return this.service.listManifestItems(dto);
  }

  @Post('manifests/albums')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AdminCloudBackupRead, admin: true })
  @Endpoint({
    operationId: 'listCloudBackupManifestAlbums',
    summary: 'List the albums a backup can bring back',
    description:
      'The albums one kept backup records that are deleted or no longer hold every item they held then. Reads the backup’s manifest from the bucket.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  listManifestAlbums(@Body() dto: CloudBackupManifestAlbumsDto): Promise<CloudBackupManifestAlbumsResponseDto> {
    return this.service.listManifestAlbums(dto);
  }

  @Post('restore')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true })
  @Endpoint({
    operationId: 'restoreCloudBackup',
    summary: 'Restore from a backup',
    description:
      'Queues a restore from a kept backup: files into a restore folder for Library Care, one item back in place, the database dump for the maintenance restore, or the whole library. Every file is checked against its SHA-256 before it is written; a file in the way is moved aside, never deleted.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  restore(@Auth() auth: AuthDto, @Body() dto: CloudBackupRestoreDto): Promise<CloudBackupStatusResponseDto> {
    return this.service.startRestore(auth, dto);
  }

  @Put('escrow')
  @Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true })
  @Endpoint({
    operationId: 'storeCloudBackupEscrow',
    summary: 'Keep a key copy with Frameleaf Cloud',
    description:
      'Server key mode only: wraps the bucket key under the passphrase (scrypt, then AES-256-GCM) and stores the result with Frameleaf Cloud, which cannot unwrap it. The passphrase is never stored or sent.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  storeEscrow(@Auth() auth: AuthDto, @Body() dto: CloudBackupEscrowDto): Promise<CloudBackupStatusResponseDto> {
    return this.service.storeEscrow(auth, dto);
  }

  @Delete('escrow')
  @Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true })
  @Endpoint({
    operationId: 'removeCloudBackupEscrow',
    summary: 'Remove the key copy from Frameleaf Cloud',
    description: 'Deletes the wrapped key Frameleaf Cloud keeps for this server.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  removeEscrow(@Auth() auth: AuthDto): Promise<CloudBackupStatusResponseDto> {
    return this.service.removeEscrow(auth);
  }
}
