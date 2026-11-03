import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  MySmartAlbumsResponseDto,
  SmartAlbumHiddenDto,
  SmartAlbumKindParamDto,
  SmartAlbumOverviewResponseDto,
  SmartAlbumPreviewDto,
  SmartAlbumPreviewResponseDto,
} from 'src/dtos/smart-album.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { SmartAlbumService } from 'src/services/smart-album.service.js';

/**
 * FL-522: smart albums as each person sees them (and hiding one from your own library), and for an
 * administrator the counts across the household and a preview of a rule change before saving.
 */
@ApiTags(ApiTag.Albums)
@Controller()
export class SmartAlbumController {
  constructor(private service: SmartAlbumService) {}

  @Get('smart-albums/mine')
  @Authenticated({ permission: Permission.AlbumRead })
  @Endpoint({
    summary: 'List your smart albums',
    description:
      'The smart albums offered on this server, each with how many of your photos it holds as you see them, a few of the newest, and whether you hid it.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  getMySmartAlbums(@Auth() auth: AuthDto): Promise<MySmartAlbumsResponseDto> {
    return this.service.getMine(auth);
  }

  @Put('smart-albums/mine/:kind')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Hide or show one of your smart albums',
    description:
      'Hide a smart album from your own library, or show it again. It keeps filling while hidden, and nobody else is affected.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  setMySmartAlbumHidden(
    @Auth() auth: AuthDto,
    @Param() { kind }: SmartAlbumKindParamDto,
    @Body() { hidden }: SmartAlbumHiddenDto,
  ): Promise<MySmartAlbumsResponseDto> {
    return this.service.setMineHidden(auth, kind, hidden);
  }

  @Get('admin/smart-albums')
  @Authenticated({ permission: Permission.SystemConfigRead, admin: true })
  @Endpoint({
    summary: 'Get the smart albums across the household',
    description:
      'For each smart album: photos held across the household, how many people have it with photos in it, how many hid it, and a few pictures from your own album.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  getSmartAlbumOverview(@Auth() auth: AuthDto): Promise<SmartAlbumOverviewResponseDto> {
    return this.service.getOverview(auth);
  }

  @Post('admin/smart-albums/preview')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.SystemConfigRead, admin: true })
  @Endpoint({
    summary: 'Preview a smart album rule',
    description:
      'What a rule would add to and take out of your own album before it is saved, with a few pictures of each. Nothing is changed.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  previewSmartAlbumRule(
    @Auth() auth: AuthDto,
    @Body() dto: SmartAlbumPreviewDto,
  ): Promise<SmartAlbumPreviewResponseDto> {
    return this.service.previewRule(auth, dto);
  }
}
