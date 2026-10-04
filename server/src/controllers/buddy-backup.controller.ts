import { Body, Controller, Get, Header, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  BuddyAcceptDto,
  BuddyApplyDto,
  BuddyApplyResponseDto,
  BuddyBrowseDto,
  BuddyControlDto,
  BuddyEscrowDto,
  BuddyEscrowImportDto,
  BuddyEscrowWrapDto,
  BuddyInviteDto,
  BuddyInviteResponseDto,
  BuddyKitDto,
  BuddyPageDto,
  BuddyPreflightDto,
  BuddyPreflightRequestDto,
  BuddyProbeResponseDto,
  BuddyRelationshipDto,
  BuddyRestoreCheckpointDto,
  BuddyRestoreDto,
  BuddyRestoreResponseDto,
  BuddyRestoreStatusDto,
  BuddySettingsDto,
  BuddySnapshotListDto,
  BuddyStatusDto,
} from 'src/dtos/buddy-backup.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { BuddyBackupRestoreService } from 'src/services/buddy-backup-restore.service.js';
import { BuddyBackupService } from 'src/services/buddy-backup.service.js';
import { unwrapBuddyKeyring, wrapBuddyKeyring } from 'src/utils/buddy-backup-crypto.js';
import { UUIDParamDto, UUIDv7ParamDto } from 'src/validation.js';

const history = new HistoryBuilder().added('v3.2.0').alpha('v3.2.0');

@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/buddy-backup')
export class BuddyBackupAdminController {
  constructor(
    private service: BuddyBackupService,
    private restore: BuddyBackupRestoreService,
  ) {}

  @Get('restores')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AdminCloudBackupRead, admin: true, refreshElevation: false })
  @Endpoint({
    operationId: 'getBuddyRestoreCheckpoint',
    summary: 'Resume the current owner restore or staged recovery',
    history,
  })
  async checkpoint(@Auth() auth: AuthDto): Promise<BuddyRestoreCheckpointDto> {
    await this.restore.administrator(auth);
    return this.restore.checkpoint(auth);
  }

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AdminCloudBackupRead, admin: true, refreshElevation: false })
  @Endpoint({ operationId: 'getBuddyBackupStatus', summary: 'Get Buddy Backup and hosting status', history })
  status(): Promise<BuddyStatusDto> {
    return this.service.status();
  }

  @Post('preflight')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AdminCloudBackupRead, admin: true, refreshElevation: false })
  @Endpoint({
    operationId: 'checkBuddyBackupCoverage',
    summary: 'Check backup size, storage and configuration coverage',
    history,
  })
  async preflight(@Auth() auth: AuthDto, @Body() dto: BuddyPreflightRequestDto): Promise<BuddyPreflightDto> {
    await this.restore.administrator(auth);
    return this.service.preflight(dto);
  }

  @Post('refresh')
  @Authenticated({ permission: Permission.AdminCloudBackupRead, admin: true, refreshElevation: false })
  @Endpoint({ operationId: 'refreshBuddyBackup', summary: 'Refresh the Cloud pairing', history })
  async refresh(): Promise<BuddyStatusDto> {
    await this.service.peer.pairing();
    return this.service.status();
  }

  @Put('settings')
  @Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true, refreshElevation: false })
  @Endpoint({
    operationId: 'configureBuddyBackup',
    summary: 'Configure hosting, schedules and transfer limits',
    history,
  })
  async settings(@Auth() auth: AuthDto, @Body() dto: BuddySettingsDto): Promise<BuddyStatusDto> {
    await this.restore.administrator(auth);
    return this.service.setup(dto);
  }

  @Post('invitations')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true, refreshElevation: false })
  @Endpoint({
    operationId: 'inviteBackupBuddy',
    summary: 'Invite a Cloud account to pair its Frameleaf server',
    history,
  })
  async invite(@Auth() auth: AuthDto, @Body() dto: BuddyInviteDto): Promise<BuddyInviteResponseDto> {
    await this.restore.administrator(auth);
    return this.service.invite(dto);
  }

  @Post('invitations/accept')
  @Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true, refreshElevation: false })
  @Endpoint({
    operationId: 'acceptBackupBuddy',
    summary: 'Accept a Buddy invitation with this hosting capacity',
    history,
  })
  async accept(@Auth() auth: AuthDto, @Body() dto: BuddyAcceptDto): Promise<BuddyStatusDto> {
    await this.restore.administrator(auth);
    return this.service.accept(dto);
  }

  @Post('relationship')
  @Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true, refreshElevation: false })
  @Endpoint({
    operationId: 'changeBuddyRelationship',
    summary: 'Confirm, end, or immediately block a pairing',
    history,
  })
  async relationship(@Auth() auth: AuthDto, @Body() dto: BuddyRelationshipDto): Promise<BuddyStatusDto> {
    await this.restore.administrator(auth);
    return this.service.relationship(dto.action);
  }

  @Post('key')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true, refreshElevation: false })
  @Endpoint({
    operationId: 'generateBuddyRecoveryKit',
    summary: 'Generate and return a new recovery kit once',
    history,
  })
  async generate(@Auth() auth: AuthDto): Promise<BuddyKitDto> {
    await this.restore.administrator(auth);
    return this.service.generateKit();
  }

  @Post('key/escrow')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true, refreshElevation: false })
  @Endpoint({
    operationId: 'wrapBuddyRecoveryKit',
    summary: 'Encrypt a recovery kit locally with a passphrase',
    history,
  })
  async wrap(@Auth() auth: AuthDto, @Body() dto: BuddyEscrowWrapDto): Promise<BuddyEscrowDto> {
    await this.restore.administrator(auth);
    return wrapBuddyKeyring(await this.service.keyring(), dto.passphrase);
  }

  @Post('key/escrow/import')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true, refreshElevation: false })
  @Endpoint({
    operationId: 'unlockBuddyRecoveryKit',
    summary: 'Unlock and import an encrypted recovery package locally',
    history,
  })
  async unlock(@Auth() auth: AuthDto, @Body() dto: BuddyEscrowImportDto): Promise<BuddyStatusDto> {
    await this.restore.administrator(auth);
    return this.service.importKit(await unwrapBuddyKeyring(dto.escrow, dto.passphrase));
  }

  @Post('key/verify')
  @Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true, refreshElevation: false })
  @Endpoint({ operationId: 'verifyBuddyRecoveryKit', summary: 'Verify the recovery kit the owner saved', history })
  async verify(@Auth() auth: AuthDto, @Body() dto: BuddyKitDto): Promise<BuddyStatusDto> {
    await this.restore.administrator(auth);
    return this.service.verifyKit(dto);
  }

  @Post('key/import')
  @Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true, refreshElevation: false })
  @Endpoint({ operationId: 'importBuddyRecoveryKit', summary: 'Import a recovery kit on the rebound server', history })
  async import(@Auth() auth: AuthDto, @Body() dto: BuddyKitDto): Promise<BuddyStatusDto> {
    await this.restore.administrator(auth);
    return this.service.importKit(dto);
  }

  @Post('key/rotate')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true, refreshElevation: false })
  @Endpoint({
    operationId: 'rotateBuddyRecoveryKit',
    summary: 'Rotate encryption while retaining historical keys',
    history,
  })
  async rotate(@Auth() auth: AuthDto): Promise<BuddyKitDto> {
    await this.restore.administrator(auth);
    return this.service.rotateKit();
  }

  @Post('probe')
  @Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true, refreshElevation: false })
  @Endpoint({ operationId: 'testBuddyBackup', summary: 'Verify an encrypted round trip', history })
  async probe(@Auth() auth: AuthDto): Promise<BuddyProbeResponseDto> {
    await this.restore.administrator(auth);
    return this.service.probe();
  }

  @Post('control')
  @Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true, refreshElevation: false })
  @Endpoint({
    operationId: 'controlBuddyBackup',
    summary: 'Start, pause, resume, restart or verify Buddy Backup',
    history,
  })
  async control(@Auth() auth: AuthDto, @Body() dto: BuddyControlDto): Promise<BuddyStatusDto> {
    await this.restore.administrator(auth);
    return this.service.control(auth, dto);
  }

  @Get('snapshots')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AdminCloudBackupRead, admin: true, refreshElevation: false })
  @Endpoint({ operationId: 'listBuddyBackupSnapshots', summary: 'List complete Buddy restore points', history })
  async snapshots(@Auth() auth: AuthDto, @Query() page: BuddyPageDto): Promise<BuddySnapshotListDto> {
    await this.restore.administrator(auth);
    return this.restore.snapshots(auth, true, page.offset);
  }

  @Get('snapshots/:id')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AdminCloudBackupRead, admin: true, refreshElevation: false })
  @Endpoint({ operationId: 'browseBuddyBackup', summary: 'Browse a decrypted restore point', history })
  browse(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Query() page: BuddyPageDto): Promise<BuddyBrowseDto> {
    return this.restore.browse(auth, id, true, page.offset);
  }

  @Post('restore')
  @Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true, refreshElevation: false })
  @Endpoint({ operationId: 'restoreBuddyBackup', summary: 'Preview or start a verified restore', history })
  prepare(@Auth() auth: AuthDto, @Body() dto: BuddyRestoreDto): Promise<BuddyRestoreResponseDto> {
    return this.restore.prepare(auth, dto, true);
  }

  @Get('restores/:id')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AdminCloudBackupRead, admin: true, refreshElevation: false })
  @Endpoint({ operationId: 'getBuddyRestoreStatus', summary: 'Get restore or staging progress', history })
  progress(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<BuddyRestoreStatusDto> {
    return this.restore.status(auth, id);
  }

  @Post('restore/apply')
  @Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true, refreshElevation: false })
  @Endpoint({
    operationId: 'applyBuddyRecovery',
    summary: 'Apply staged settings or server recovery in maintenance mode',
    history,
  })
  apply(@Auth() auth: AuthDto, @Body() dto: BuddyApplyDto): Promise<BuddyApplyResponseDto> {
    return this.restore.apply(auth, dto.operationId);
  }
}

@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('users/me/buddy-backup')
export class BuddyBackupOwnerController {
  constructor(private restore: BuddyBackupRestoreService) {}

  @Get('restores')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AssetRead, refreshElevation: false })
  @Endpoint({ operationId: 'getOwnBuddyRestoreCheckpoint', summary: 'Resume an own Buddy restore', history })
  checkpoint(@Auth() auth: AuthDto): Promise<BuddyRestoreCheckpointDto> {
    return this.restore.checkpoint(auth);
  }
  @Get('snapshots')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AssetRead, refreshElevation: false })
  @Endpoint({ operationId: 'listOwnBuddySnapshots', summary: 'List own accessible Buddy restore points', history })
  snapshots(@Auth() auth: AuthDto, @Query() page: BuddyPageDto): Promise<BuddySnapshotListDto> {
    return this.restore.snapshots(auth, false, page.offset);
  }
  @Get('snapshots/:id')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AssetRead, refreshElevation: false })
  @Endpoint({
    operationId: 'browseOwnBuddyBackup',
    summary: 'Browse own accessible backed-up items and albums',
    history,
  })
  browse(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Query() page: BuddyPageDto): Promise<BuddyBrowseDto> {
    return this.restore.browse(auth, id, false, page.offset);
  }
  @Post('restore')
  @Authenticated({ permission: Permission.AssetUpdate, refreshElevation: false })
  @Endpoint({ operationId: 'restoreOwnBuddyBackup', summary: 'Preview or restore own items or an album', history })
  prepare(@Auth() auth: AuthDto, @Body() dto: BuddyRestoreDto): Promise<BuddyRestoreResponseDto> {
    return this.restore.prepare(auth, dto, false);
  }
  @Get('restores/:id')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AssetRead, refreshElevation: false })
  @Endpoint({ operationId: 'getOwnBuddyRestoreStatus', summary: 'Get own Buddy restore progress', history })
  progress(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<BuddyRestoreStatusDto> {
    return this.restore.status(auth, id);
  }
}
