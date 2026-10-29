import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { AssetSourceResponseDto } from 'src/dtos/bookmark.dto.js';
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
}
