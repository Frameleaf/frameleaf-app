import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { mapAsset } from 'src/dtos/asset-response.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { LibraryItem } from 'src/dtos/library-item.dto.js';
import { LibraryItemSearchDto, LibraryItemSearchResponseDto } from 'src/dtos/library-search.dto.js';
import { SMART_SEARCH_COUNT_CAP } from 'src/dtos/search.dto.js';
import { Permission } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { BookmarkRepository } from 'src/repositories/bookmark.repository.js';
import { BookmarkService } from 'src/services/bookmark.service.js';
import { SearchService } from 'src/services/search.service.js';
import { isGranted, requireAccess } from 'src/utils/access.js';
import { decodeLibraryCursor, encodeLibraryCursor, libraryQueryHash } from 'src/utils/library-search-cursor.js';

@Injectable()
export class LibraryItemService {
  constructor(
    private repo: BookmarkRepository,
    private bookmarks: BookmarkService,
    private searches: SearchService,
    private access: AccessRepository,
  ) {}

  async search(auth: AuthDto, query: LibraryItemSearchDto): Promise<LibraryItemSearchResponseDto> {
    if (auth.sharedLink) throw new NotFoundException('Library search unavailable');
    const kinds = query.kinds ?? ['asset', 'bookmark'];
    const includeAssets = kinds.includes('asset');
    const includeBookmarks =
      kinds.includes('bookmark') &&
      (!auth.apiKey || isGranted({ requested: [Permission.BookmarkRead], current: auth.apiKey.permissions }));
    const { filter, scope } = await this.searches.resolveSearchScopeV3(auth, query);
    const effective = { ...query, filter };
    const queryHash = libraryQueryHash({
      version: 1,
      userId: auth.user.id,
      filter,
      query: query.query,
      queryAssetId: query.queryAssetId,
      mode: query.mode,
      sort: query.mode === 'smart' ? 'relevance' : (query.sort ?? 'added'),
      includeAssets,
      includeBookmarks,
      hiddenContent: auth.hiddenContent,
      hideNsfwAssets: auth.hideNsfwAssets,
      elevated: !!auth.session?.hasElevatedPermission,
    });
    const cursor = decodeLibraryCursor(query.cursor, queryHash);
    if (cursor && cursor.mode !== query.mode) throw new BadRequestException('Cursor mode changed');
    if (query.mode === 'smart' && !includeAssets) return { items: [], count: 0, countCapped: false, nextCursor: null };
    if (query.mode === 'smart') {
      const body = {
        filter,
        query: query.query || undefined,
        queryAssetId: query.queryAssetId,
        size: SMART_SEARCH_COUNT_CAP,
      };
      const [ranked, total] = await Promise.all([
        this.searches.searchSmart(auth, body),
        this.searches.searchSmartStatistics(auth, body),
      ]);
      const assets = ranked.assets.items;
      const universeHash = libraryQueryHash(assets.map(({ id }) => id));
      if (cursor?.mode === 'smart' && cursor.universeHash !== universeHash)
        throw new BadRequestException('Semantic results changed; restart pagination');
      const offset = cursor?.mode === 'smart' ? cursor.offset : 0;
      const page = assets.slice(offset, offset + query.limit);
      await requireAccess(this.access, { auth, permission: Permission.AssetRead, ids: page.map(({ id }) => id) });
      return {
        items: page.map((asset) => ({ kind: 'asset', asset })),
        count: assets.length,
        countCapped: total.capped || assets.length < total.total,
        nextCursor:
          offset + page.length < assets.length
            ? encodeLibraryCursor({ mode: 'smart', queryHash, universeHash, offset: offset + page.length })
            : null,
      };
    }
    const { count, candidates } = await this.repo.searchLibrary(
      auth,
      effective,
      scope,
      { assets: includeAssets, bookmarks: includeBookmarks },
      cursor?.mode === 'text' ? cursor : undefined,
    );
    const page = candidates.slice(0, query.limit);
    const assetIds = page.filter(({ kind }) => kind === 'asset').map(({ id }) => id);
    const bookmarkIds = page.filter(({ kind }) => kind === 'bookmark').map(({ id }) => id);
    const [assets, bookmarks] = await Promise.all([
      assetIds.length > 0 ? this.repo.getLibraryAssets(auth, effective, scope, assetIds) : [],
      bookmarkIds.length > 0 ? this.bookmarks.getForSearch(auth, effective, bookmarkIds) : [],
    ]);
    const items = new Map<string, LibraryItem>([
      ...assets.map((asset): [string, LibraryItem] => [
        `asset:${asset.id}`,
        { kind: 'asset', asset: mapAsset(asset, { auth }) },
      ]),
      ...bookmarks.map((bookmark): [string, LibraryItem] => [
        `bookmark:${bookmark.id}`,
        { kind: 'bookmark', bookmark },
      ]),
    ]);
    if (page.some(({ id, kind }) => !items.has(`${kind}:${id}`)))
      throw new BadRequestException('Library items changed; restart search');
    await requireAccess(this.access, { auth, permission: Permission.AssetRead, ids: assetIds });
    await this.searches.resolveSearchScopeV3(auth, query);
    const last = page.at(-1);
    return {
      items: page.map(({ id, kind }) => items.get(`${kind}:${id}`)!),
      count,
      countCapped: false,
      nextCursor:
        candidates.length > query.limit && last
          ? encodeLibraryCursor({
              mode: 'text',
              queryHash,
              kind: last.kind,
              id: last.id,
              after:
                query.sort === 'color' || query.sort === 'rating'
                  ? { sort: query.sort, value: last.rank }
                  : query.sort === 'name'
                    ? { sort: 'name', value: last.nameKey }
                    : { sort: 'added', value: last.dateKey },
            })
          : null,
    };
  }
}
