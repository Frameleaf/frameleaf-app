import {
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Next,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { parseCookie } from 'cookie';
import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import type { NextFunction, Request, Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { AuthCookie, Permission, RequestHeader } from 'src/enum.js';
import { Auth, Authenticated, FileResponse, HomeNetworkOnly, OriginalTransfer } from 'src/middleware/auth.guard.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DesktopOfflineAlbumService } from 'src/services/desktop-offline-album.service.js';
import { sendFile } from 'src/utils/file.js';
import { UUIDParamDto } from 'src/validation.js';

class OfflineOriginalParams extends createZodDto(z.object({ id: z.uuid(), assetId: z.uuid() })) {}

export function offlineAlbumHost(request: Request, browser: boolean): string {
  const { host, origin, authorization, cookie } = request.headers;
  const peer = request.socket.remoteAddress;
  const hasSessionHeader =
    authorization ||
    [
      RequestHeader.UserToken,
      RequestHeader.SessionToken,
      RequestHeader.ApiKey,
      RequestHeader.SharedLinkKey,
      RequestHeader.SharedLinkSlug,
    ].some((header) => request.headers[header]);
  if (
    !host ||
    !/^127\.0\.0\.1(?::[1-9][0-9]{0,4})?$/.test(host) ||
    Number(host.split(':', 2)[1] ?? 80) > 65_535 ||
    (peer !== '127.0.0.1' && peer !== '::ffff:127.0.0.1') ||
    hasSessionHeader ||
    Object.keys(request.query).length > 0 ||
    (browser ? origin !== `http://${host}` || !parseCookie(cookie || '')[AuthCookie.AccessToken] : !!origin || !!cookie)
  ) {
    throw new NotFoundException('Offline album unavailable');
  }
  return host;
}

@ApiExcludeController()
@Controller('albums')
@HomeNetworkOnly()
export class DesktopOfflineAlbumController {
  constructor(
    private service: DesktopOfflineAlbumService,
    private logger: LoggingRepository,
  ) {}

  @Post(':id/desktop-offline-grant')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AssetDownload, refreshElevation: false })
  issue(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Req() request: Request) {
    return this.service.issue(auth, id, offlineAlbumHost(request, true));
  }

  @Post(':id/desktop-offline/redeem')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ public: true })
  redeem(
    @Param() { id }: UUIDParamDto,
    @Req() request: Request,
    @Headers('x-frameleaf-offline-handoff') token?: string,
  ) {
    return this.service.redeem(id, offlineAlbumHost(request, false), token);
  }

  @Get(':id/desktop-offline')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ public: true })
  plan(@Param() { id }: UUIDParamDto, @Req() request: Request, @Headers('x-frameleaf-offline-grant') token?: string) {
    return this.service.plan(id, offlineAlbumHost(request, false), token);
  }

  @Get(':id/desktop-offline/originals/:assetId')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ public: true })
  @OriginalTransfer()
  @FileResponse()
  async original(
    @Param() { id, assetId }: OfflineOriginalParams,
    @Req() request: Request,
    @Res() response: Response,
    @Next() next: NextFunction,
    @Headers('x-frameleaf-offline-grant') token?: string,
  ) {
    const host = offlineAlbumHost(request, false);
    const original = await this.service.original(id, assetId, host, token, () => response.destroy());
    try {
      await sendFile(response, next, () => original.file, this.logger);
    } finally {
      original.close();
    }
  }
}
