import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Next,
  Param,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { NextFunction, Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { LoginDetails } from 'src/services/auth.service.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  BackupRestoreVerificationRecordDto,
  BackupRestoreVerificationResponseDto,
  DatabaseBackupDeleteDto,
  DatabaseBackupListResponseDto,
  DatabaseBackupUploadDto,
} from 'src/dtos/database-backup.dto.js';
import { ApiTag, ImmichCookie, Permission } from 'src/enum.js';
import { Auth, Authenticated, FileResponse, GetLoginDetails, OriginalTransfer } from 'src/middleware/auth.guard.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DatabaseBackupService } from 'src/services/database-backup.service.js';
import { MaintenanceService } from 'src/services/maintenance.service.js';
import { sendFile } from 'src/utils/file.js';
import { respondWithCookie } from 'src/utils/response.js';
import { FilenameParamDto } from 'src/validation.js';

@ApiTags(ApiTag.DatabaseBackups)
@Controller('admin/database-backups')
export class DatabaseBackupController {
  constructor(
    private logger: LoggingRepository,
    private service: DatabaseBackupService,
    private maintenanceService: MaintenanceService,
  ) {}

  @Get()
  @Endpoint({
    summary: 'List database backups',
    description: 'Get the list of the successful and failed backups',
    history: new HistoryBuilder().added('v2.5.0').alpha('v2.5.0'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  listDatabaseBackups(): Promise<DatabaseBackupListResponseDto> {
    return this.service.listBackups();
  }

  // FL-71 (CC-9): "Prove your backup can restore" (CommandCenter.jsx:1752-1800). Before `:filename`.
  @Get('restore-verification')
  @Endpoint({
    summary: 'Get backup restore verification',
    description: 'When restoring the database and the original files was last proved, and whether a test is due',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  getBackupRestoreVerification(): Promise<BackupRestoreVerificationResponseDto> {
    return this.service.getRestoreVerification();
  }

  @Post('restore-verification')
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Record a backup restore test',
    description: 'Records that restoring the database, the original files or both was proved just now',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  recordBackupRestoreVerification(
    @Auth() auth: AuthDto,
    @Body() dto: BackupRestoreVerificationRecordDto,
  ): Promise<BackupRestoreVerificationResponseDto> {
    return this.service.recordRestoreVerification(auth, dto);
  }

  @Get(':filename')
  @FileResponse()
  @Endpoint({
    summary: 'Download database backup',
    description: 'Downloads the database backup file',
    history: new HistoryBuilder().added('v2.5.0').alpha('v2.5.0'),
  })
  @Authenticated({ permission: Permission.BackupDownload, admin: true })
  @OriginalTransfer()
  async downloadDatabaseBackup(
    @Param() { filename }: FilenameParamDto,
    @Res() res: Response,
    @Next() next: NextFunction,
  ): Promise<void> {
    await sendFile(res, next, () => this.service.downloadBackup(filename), this.logger);
  }

  @Delete()
  @Endpoint({
    summary: 'Delete database backup',
    description: 'Delete a backup by its filename',
    history: new HistoryBuilder().added('v2.5.0').alpha('v2.5.0'),
  })
  @Authenticated({ permission: Permission.BackupDelete, admin: true })
  async deleteDatabaseBackup(@Body() dto: DatabaseBackupDeleteDto): Promise<void> {
    return this.service.deleteBackup(dto.backups);
  }

  @Post('start-restore')
  @Endpoint({
    summary: 'Start database backup restore flow',
    description: 'Put Frameleaf into maintenance mode to restore a backup (Frameleaf must not be configured)',
    history: new HistoryBuilder().added('v2.5.0').alpha('v2.5.0'),
  })
  @Authenticated({ public: true, setup: true })
  async startDatabaseRestoreFlow(
    @GetLoginDetails() loginDetails: LoginDetails,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const { jwt } = await this.maintenanceService.startRestoreFlow();
    return respondWithCookie(res, undefined, {
      isSecure: loginDetails.isSecure,
      values: [{ key: ImmichCookie.MaintenanceToken, value: jwt }],
    });
  }

  @Post('upload')
  @Authenticated({ permission: Permission.BackupUpload, admin: true })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ description: 'Backup Upload', type: DatabaseBackupUploadDto })
  @Endpoint({
    summary: 'Upload database backup',
    description: 'Uploads .sql/.sql.gz file to restore backup from',
    history: new HistoryBuilder().added('v2.5.0').alpha('v2.5.0'),
  })
  @UseInterceptors(FileInterceptor('file'))
  uploadDatabaseBackup(
    @UploadedFile()
    file: Express.Multer.File,
  ): Promise<void> {
    return this.service.uploadBackup(file);
  }
}
