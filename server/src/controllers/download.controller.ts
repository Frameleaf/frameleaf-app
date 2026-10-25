import { Body, Controller, HttpCode, HttpStatus, Post, Res, StreamableFile } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { Readable } from 'node:stream';
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
    const abort = new AbortController();
    let stream: Readable | undefined;
    const abandon = () => {
      abort.abort();
      if (!stream?.readableEnded) stream?.destroy();
    };
    res.once('close', abandon);
    if (res.destroyed || res.writableEnded) abandon();
    try {
      const archive = await this.service.downloadArchive(auth, dto, abort.signal);
      stream = archive.stream;
      stream.once('close', () => res.removeListener('close', abandon));
      if (res.destroyed || res.writableEnded) abandon();
      return asStreamableFile(archive);
    } catch (error) {
      res.removeListener('close', abandon);
      throw error;
    }
  }
}
