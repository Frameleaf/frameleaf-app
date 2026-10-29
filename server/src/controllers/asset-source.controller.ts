import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { AssetAddedDateDto, AssetSourceImportDto, AssetSourceResponseDto } from 'src/dtos/bookmark.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { AssetSourceService } from 'src/services/asset-source.service.js';
import { UUIDParamDto } from 'src/validation.js';

@ApiTags(ApiTag.Assets)
@Controller('assets')
export class AssetSourceController {
  constructor(private service: AssetSourceService) {}

  @Get(':id/sources')
  @Authenticated({ permission: Permission.AssetSourceRead })
  @Endpoint({
    summary: 'Retrieve private capture provenance for an owned asset',
    history: new HistoryBuilder().added('v3'),
  })
  getAssetSources(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<AssetSourceResponseDto[]> {
    return this.service.getAll(auth, id);
  }

  @Post(':id/sources')
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'Add an imported source address to an owned asset',
    description:
      'Records a web address an import brought over, such as from an Eagle library, as the item’s source. An address the item already has is returned as it is.',
    history: new HistoryBuilder().added('v3'),
  })
  addImportedAssetSource(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: AssetSourceImportDto,
  ): Promise<AssetSourceResponseDto> {
    return this.service.addImported(auth, id, dto);
  }

  @Put(':id/added-date')
  @Authenticated({ permission: Permission.AssetUpdate })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Set the Added date of an imported Boards item',
    description:
      'Moves the Added date of an owned item that is in Boards only to an earlier time in the past, such as when it was last changed in the app it was imported from.',
    history: new HistoryBuilder().added('v3'),
  })
  setAssetAddedDate(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: AssetAddedDateDto,
  ): Promise<void> {
    return this.service.setAddedDate(auth, id, dto);
  }
}
