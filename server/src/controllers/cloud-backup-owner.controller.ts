import { Body, Controller, Get, Header, Param, Post, Query, Req, StreamableFile } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  CloudBackupOwnerSetupResponseDto,
  OwnerBackupHistoryDto,
  OwnerBackupHistoryResponseDto,
  OwnerBackupPageDto,
  OwnerBackupRestoreDto,
  OwnerBackupRestoreResponseDto,
  OwnerBackupsResponseDto,
} from 'src/dtos/cloud-backup-owner.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated, FileResponse } from 'src/middleware/auth.guard.js';
import { requestVia } from 'src/middleware/frameleaf-via.middleware.js';
import { AuthService } from 'src/services/auth.service.js';
import { CloudBackupService } from 'src/services/cloud-backup.service.js';
import { UUIDParamDto } from 'src/validation.js';

@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('users/me/cloud-backup')
export class CloudBackupOwnerController {
  constructor(
    private service: CloudBackupService,
    private authService: AuthService,
  ) {}
  private refresh(request: Request, permission = Permission.AssetRead) {
    return () =>
      this.authService.authenticate({
        headers: request.headers,
        queryParams: request.query as Record<string, string>,
        metadata: {
          sharedLinkRoute: false,
          adminRoute: false,
          permission,
          uri: request.path,
          via: requestVia(request),
          refreshElevation: false,
        },
      });
  }
  @Get('setup')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AdminCloudBackupRead, admin: true, refreshElevation: false })
  @Endpoint({
    summary: 'Get the cloud backup setup progress',
    description:
      'Read-only activation chain for the server owner (an administrator) to poll: plan entitlement seen, bucket claimed, key loaded, first run, next scheduled run. Never the bucket, endpoint, key, usage or file names. Other users are refused.',
    history: new HistoryBuilder().added('v3'),
  })
  getOwnSetupProgress(@Auth() auth: AuthDto): Promise<CloudBackupOwnerSetupResponseDto> {
    return this.service.getOwnerSetup(auth);
  }

  @Post('restore')
  @Authenticated({ permission: Permission.AssetUpdate, refreshElevation: false })
  @Endpoint({
    summary: 'Restore own items from a chosen kept backup',
    description:
      '1–100 unique own items; a current PIN-elevated session is required throughout execution. SHA256 verified staging, guarded owner destinations and details; unknown historical evidence refuses. Returns only the operation identity, never admin-global backup status.',
    history: new HistoryBuilder().added('v3'),
  })
  restoreOwnBackupItems(
    @Auth() auth: AuthDto,
    @Body() dto: OwnerBackupRestoreDto,
    @Req() request: Request,
  ): Promise<OwnerBackupRestoreResponseDto> {
    return this.service.startOwnerRestore(auth, dto, this.refresh(request, Permission.AssetUpdate));
  }

  @Get('backups')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AssetRead, refreshElevation: false })
  @Endpoint({
    summary: 'List own kept backups with accessible deleted history',
    description:
      'Owner-only discovery. Foreign/private/unknown history is excluded before paging; no global counts. Search across all backups is not provided by this endpoint.',
    history: new HistoryBuilder().added('v3'),
  })
  listOwnKeptBackups(
    @Auth() auth: AuthDto,
    @Query() page: OwnerBackupPageDto,
    @Req() request: Request,
  ): Promise<OwnerBackupsResponseDto> {
    return this.service.listOwnerBackups(auth, page, this.refresh(request));
  }
  @Get('history')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AssetRead, refreshElevation: false })
  @Endpoint({
    summary: 'Search own deleted history in one kept backup',
    description:
      'Caller-owned trashed/deleted entries from a chosen kept manifest. Unknown physical deletion dates are explicit; file modification and backup dates are never deletion dates. Historical missing owner/privacy evidence is excluded. Does not restore items.',
    history: new HistoryBuilder().added('v3'),
  })
  getOwnBackupHistory(
    @Auth() auth: AuthDto,
    @Query() dto: OwnerBackupHistoryDto,
    @Req() request: Request,
  ): Promise<OwnerBackupHistoryResponseDto> {
    return this.service.listOwnerHistory(auth, dto, this.refresh(request));
  }
  @Get('history/:id/thumbnail')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @Authenticated({ permission: Permission.AssetView, refreshElevation: false })
  @FileResponse()
  @Endpoint({
    summary: 'Read an authorized kept backup thumbnail',
    description:
      'Only recorded thumbnail objects, actual SHA256 and size verified, maximum8MiB. Normal credentials/privacy and kept membership are rechecked after remote reads.',
    history: new HistoryBuilder().added('v3'),
  })
  async getOwnBackupThumbnail(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Query() dto: OwnerBackupHistoryDto,
    @Req() request: Request,
  ): Promise<StreamableFile> {
    return new StreamableFile(
      await this.service.readOwnerThumbnail(auth, id, dto.manifestKey, this.refresh(request, Permission.AssetView)),
      {
        type: 'application/octet-stream',
      },
    );
  }
}
