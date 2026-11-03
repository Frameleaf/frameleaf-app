import { Injectable } from '@nestjs/common';
import { BulkIdResponseDto } from 'src/dtos/asset-ids.response.dto.js';
import { mapAsset } from 'src/dtos/asset-response.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { LibraryItem, LibraryItemsQueryDto, LibraryItemsResponseDto } from 'src/dtos/library-item.dto.js';
import { Permission } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { BookmarkRepository } from 'src/repositories/bookmark.repository.js';
import { BookmarkService } from 'src/services/bookmark.service.js';
import { requireAccess } from 'src/utils/access.js';

@Injectable()
export class AlbumItemsService {
  constructor(
    private repo: BookmarkRepository,
    private bookmarks: BookmarkService,
    private access: AccessRepository,
  ) {}

  addBookmarks(auth: AuthDto, albumId: string, ids: string[]): Promise<BulkIdResponseDto[]> {
    return this.repo.addToAlbum(auth, albumId, ids);
  }

  removeBookmarks(auth: AuthDto, albumId: string, ids: string[]): Promise<BulkIdResponseDto[]> {
    return this.repo.removeFromAlbum(auth, albumId, ids);
  }

  async get(auth: AuthDto, albumId: string, query: LibraryItemsQueryDto): Promise<LibraryItemsResponseDto> {
    const access = { auth, permission: Permission.AlbumRead, ids: [albumId] };
    await requireAccess(this.access, access);
    // Stable (kind, UUID) ordering leaves existing photo-only pagination untouched.
    const assets =
      query.afterKind === 'bookmark'
        ? []
        : await this.repo.getAlbumAssets(auth, albumId, query.afterId, query.limit + 1);
    const bookmarks =
      assets.length > query.limit
        ? []
        : await this.bookmarks.getForAlbum(
            auth,
            albumId,
            query.afterKind === 'bookmark' ? query.afterId : undefined,
            query.limit + 1 - assets.length,
          );
    const candidates: LibraryItem[] = [
      ...assets.map((asset): LibraryItem => ({
        kind: 'asset',
        asset: mapAsset(asset, { auth, stripMetadata: auth.sharedLink ? !auth.sharedLink.showExif : false }),
      })),
      ...bookmarks.map((bookmark): LibraryItem => ({ kind: 'bookmark', bookmark })),
    ];
    const items = candidates.slice(0, query.limit);
    const last = items.at(-1);
    const nextCursor =
      candidates.length > query.limit && last
        ? { kind: last.kind, id: last.kind === 'asset' ? last.asset.id : last.bookmark.id }
        : null;
    const counts = await this.repo.getAlbumCounts(auth, albumId);
    await requireAccess(this.access, access);
    return { items, nextCursor, ...counts };
  }
}
