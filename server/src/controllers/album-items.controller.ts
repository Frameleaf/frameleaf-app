import { Body, Controller, Delete, Get, Param, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { BulkIdResponseDto } from 'src/dtos/asset-ids.response.dto.js';
import { BookmarkIdsDto, LibraryItemsQueryDto, LibraryItemsResponseDto } from 'src/dtos/library-item.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { AlbumItemsService } from 'src/services/album-items.service.js';
import { UUIDParamDto } from 'src/validation.js';

@ApiTags(ApiTag.Albums)
@Controller('albums')
export class AlbumItemsController {
  constructor(private service: AlbumItemsService) {}

  @Get(':id/items')
  @Authenticated({ permission: Permission.AlbumRead, sharedLink: true })
  @Endpoint({
    summary: 'Retrieve a page of assets and bookmarks in an album',
    description:
      'Ordered by kind then ID. Counts apply media privacy filters and keep assetCount separate from bookmarkCount.',
    history: new HistoryBuilder().added('v3'),
  })
  getAlbumItems(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Query() query: LibraryItemsQueryDto,
  ): Promise<LibraryItemsResponseDto> {
    return this.service.get(auth, id, query);
  }

  @Put(':id/bookmarks')
  @Authenticated({ permission: Permission.AlbumAssetCreate })
  @Endpoint({ summary: 'Add owned bookmarks to an album', history: new HistoryBuilder().added('v3') })
  addBookmarksToAlbum(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: BookmarkIdsDto,
  ): Promise<BulkIdResponseDto[]> {
    return this.service.addBookmarks(auth, id, dto.ids);
  }

  @Delete(':id/bookmarks')
  @Authenticated({ permission: Permission.AlbumAssetDelete })
  @Endpoint({
    summary: 'Remove bookmark memberships without deleting bookmarks',
    history: new HistoryBuilder().added('v3'),
  })
  removeBookmarksFromAlbum(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: BookmarkIdsDto,
  ): Promise<BulkIdResponseDto[]> {
    return this.service.removeBookmarks(auth, id, dto.ids);
  }
}
