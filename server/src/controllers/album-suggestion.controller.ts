import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { AlbumSuggestionAutoAddDto, AlbumSuggestionsResponseDto } from 'src/dtos/album-suggestion.dto.js';
import { BulkIdsDto } from 'src/dtos/asset-ids.response.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { AlbumSuggestionService } from 'src/services/album-suggestion.service.js';
import { UUIDParamDto } from 'src/validation.js';

@ApiTags(ApiTag.Albums)
@Controller('albums')
export class AlbumSuggestionController {
  constructor(private service: AlbumSuggestionService) {}

  @Get(':id/suggestions')
  @Authenticated({ permission: Permission.AlbumRead })
  @Endpoint({
    summary: 'Suggest photos for an album',
    description:
      "Photos from your library that look like they belong to this album's trip: ones taken during it, and ones with no trustworthy date (with a suggested date). Needs permission to add to the album. Nothing is changed.",
    history: new HistoryBuilder().added('v3'),
  })
  getAlbumSuggestions(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<AlbumSuggestionsResponseDto> {
    return this.service.getSuggestions(auth, id);
  }

  @Post(':id/suggestions/dismiss')
  @Authenticated({ permission: Permission.AlbumAssetCreate })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Dismiss album suggestions',
    description: 'Mark photos as not from this trip so they are never suggested for this album again.',
    history: new HistoryBuilder().added('v3'),
  })
  dismissAlbumSuggestions(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: BulkIdsDto,
  ): Promise<void> {
    return this.service.dismiss(auth, id, dto);
  }

  @Put(':id/suggestions/auto-add')
  @Authenticated({ permission: Permission.AlbumAssetCreate })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Keep adding photos from this trip',
    description:
      'Turn on or off adding your new photos taken during this trip at its places as they finish processing. Photos without a trustworthy date always wait for review.',
    history: new HistoryBuilder().added('v3'),
  })
  setAlbumSuggestionAutoAdd(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: AlbumSuggestionAutoAddDto,
  ): Promise<void> {
    return this.service.setAutoAdd(auth, id, dto);
  }
}
