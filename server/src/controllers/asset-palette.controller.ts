import { Controller, Get, Header, HttpCode, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { AssetPaletteDto } from 'src/dtos/asset-palette.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { AssetPaletteService } from 'src/services/asset-palette.service.js';
import { UUIDParamDto } from 'src/validation.js';

@ApiTags(ApiTag.Assets)
@Controller('assets')
export class AssetPaletteController {
  constructor(private service: AssetPaletteService) {}

  @Get(':id/palette')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AssetRead, sharedLink: true })
  @Endpoint({
    summary: 'Read the current representative palette and extraction state',
    history: new HistoryBuilder().added('v3'),
  })
  getAssetPalette(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<AssetPaletteDto> {
    return this.service.get(auth, id);
  }

  @Post(':id/palette/retry')
  @HttpCode(204)
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'Queue bounded palette extraction for the current source',
    history: new HistoryBuilder().added('v3'),
  })
  retryAssetPalette(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.retry(auth, id);
  }
}
