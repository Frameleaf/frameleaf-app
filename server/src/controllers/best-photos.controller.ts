import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { BestPhotosQueryDto, BestPhotosResponseDto } from 'src/dtos/best-photos.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { BestPhotosService } from 'src/services/best-photos.service.js';

@ApiTags(ApiTag.Views)
@Controller('best-photos')
export class BestPhotosController {
  constructor(private service: BestPhotosService) {}

  @Get()
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Retrieve best photos',
    description: 'Retrieve visible photo assets ranked by the locally computed Best Photos score.',
    history: new HistoryBuilder().added('v2.7.0').beta('v2.7.0'),
  })
  getBestPhotos(@Auth() auth: AuthDto, @Query() dto: BestPhotosQueryDto): Promise<BestPhotosResponseDto> {
    return this.service.getBestPhotos(auth, dto);
  }
}
