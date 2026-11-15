import { Body, Controller, Header, HttpCode, Param, Post } from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { PhotoSourceCatalogMetadataDto, PhotoSourceCatalogMetadataResponseDto } from 'src/dtos/photo-source.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { PhotoSourceCatalogService } from 'src/services/photo-source-catalog.service.js';
import { UUIDParamDto } from 'src/validation.js';

@ApiTags(ApiTag.Libraries)
@Controller('photo-sources')
export class PhotoSourceCatalogController {
  constructor(private service: PhotoSourceCatalogService) {}
  @Post(':id/catalog-metadata')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AssetUpdate })
  @ApiResponse({ status: 200, type: PhotoSourceCatalogMetadataResponseDto })
  @Endpoint({
    summary: 'Apply ratings, flags, labels, keywords, captions and collections read from a photo catalog',
    description:
      'Turns what Frameleaf Desktop reads from a Lightroom Classic, Capture One or Apple Photos catalog into ratings, ' +
      'tags, descriptions and albums on the photos this source copied. Additive and repeatable: tags and albums are ' +
      'only added, sending the same batch again changes nothing, and a field changed in Frameleaf since the last ' +
      'read-in is kept. Items whose copy is not verified yet come back as notReady without failing the batch.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  applyPhotoSourceCatalogMetadata(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: PhotoSourceCatalogMetadataDto,
  ): Promise<PhotoSourceCatalogMetadataResponseDto> {
    return this.service.apply(auth, id, dto);
  }
}
