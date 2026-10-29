import { Body, Controller, Get, Header, Param, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { AssetAnnotationsDto, AssetAnnotationsUpdateDto } from 'src/dtos/asset-annotation.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { AssetAnnotationService } from 'src/services/asset-annotation.service.js';
import { UUIDParamDto } from 'src/validation.js';

@ApiTags(ApiTag.Assets)
@Controller('assets')
export class AssetAnnotationController {
  constructor(private service: AssetAnnotationService) {}

  @Get(':id/annotations')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AssetRead, sharedLink: true })
  @Endpoint({
    summary: 'Read the Boards annotations drawn over a picture',
    description:
      'Returns the versioned annotation document kept beside the asset. Positions are fractions (0..1) of the picture. Anyone who can see the picture can read them; a picture outside Boards returns none.',
    history: new HistoryBuilder().added('v3'),
  })
  getAssetAnnotations(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<AssetAnnotationsDto> {
    return this.service.get(auth, id);
  }

  @Put(':id/annotations')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'Replace the Boards annotations drawn over a picture',
    description:
      'Replaces the whole annotation document for a picture the caller owns; an empty list removes them. The original file is never changed and no edit runs.',
    history: new HistoryBuilder().added('v3'),
  })
  replaceAssetAnnotations(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: AssetAnnotationsUpdateDto,
  ): Promise<AssetAnnotationsDto> {
    return this.service.replace(auth, id, dto);
  }
}
