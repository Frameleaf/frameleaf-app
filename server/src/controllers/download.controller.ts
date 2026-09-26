import { Body, Controller, HttpCode, HttpStatus, Post, Res, StreamableFile } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { DownloadArchiveDto, DownloadInfoDto, DownloadResponseDto } from 'src/dtos/download.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated, FileResponse, OriginalTransfer } from 'src/middleware/auth.guard.js';
import { DownloadService } from 'src/services/download.service.js';
import { asStreamableFile } from 'src/utils/file.js';

@ApiTags(ApiTag.Download)
@Controller('download')
export class DownloadController {
  constructor(private service: DownloadService) {}

  @Post('info')
  @Authenticated({ permission: Permission.AssetDownload, sharedLink: true })
  @Endpoint({
    summary: 'Retrieve download information',
    description:
      'Retrieve information about how to request a download for the specified assets or album. The response includes groups of assets that can be downloaded together.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getDownloadInfo(@Auth() auth: AuthDto, @Body() dto: DownloadInfoDto): Promise<DownloadResponseDto> {
    return this.service.getDownloadInfo(auth, dto);
  }

  @Post('archive')
  @Authenticated({ permission: Permission.AssetDownload, sharedLink: true })
  @OriginalTransfer()
  @FileResponse()
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Download asset archive',
    description:
      'Download a ZIP archive containing the specified assets. The assets must have been previously requested via the "getDownloadInfo" endpoint.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  async downloadArchive(
    @Auth() auth: AuthDto,
    @Body() dto: DownloadArchiveDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const archive = await this.service.downloadArchive(auth, dto);
    // FL-54: a client that goes away must not leave the archive, and any copy it is writing, waiting forever
    const abandon = () => {
      if (!archive.stream.readableEnded) {
        archive.stream.destroy();
      }
    };
    res.once('close', abandon);
    // a client that dropped while the archive was being prepared has already closed: stop at once
    if (res.destroyed || res.writableEnded) {
      abandon();
    }
    return asStreamableFile(archive);
  }
}
