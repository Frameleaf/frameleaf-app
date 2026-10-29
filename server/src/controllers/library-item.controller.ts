import { Body, Controller, Header, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { LibraryItemSearchDto, LibraryItemSearchResponseDto } from 'src/dtos/library-search.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { LibraryItemService } from 'src/services/library-item.service.js';

@ApiTags(ApiTag.Search)
@Controller('library/items')
export class LibraryItemController {
  constructor(private service: LibraryItemService) {}

  @Post('search')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Search accessible assets and bookmarks with one query and cursor',
    history: new HistoryBuilder().added('v3'),
    description:
      'Bookmark rows require bookmark.read for API keys. Semantic mode ranks up to 1000 filtered asset candidates and reports an explicit candidate count cap. Source filters require assetSource.read.',
  })
  searchLibraryItems(@Auth() auth: AuthDto, @Body() dto: LibraryItemSearchDto): Promise<LibraryItemSearchResponseDto> {
    return this.service.search(auth, dto);
  }
}
