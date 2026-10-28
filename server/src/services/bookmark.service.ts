import { Injectable, NotFoundException } from '@nestjs/common';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { BookmarkCreateDto, BookmarkResponseDto, BookmarkUpdateDto } from 'src/dtos/bookmark.dto.js';
import { LibraryItemSearchDto } from 'src/dtos/library-search.dto.js';
import { Permission } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { Bookmark, BookmarkRepository } from 'src/repositories/bookmark.repository.js';
import { checkAccess, isGranted, requireAccess, requireElevatedPermission } from 'src/utils/access.js';
import { asDateTimeString } from 'src/utils/date.js';
import { requireSourceFilterAllowed } from 'src/utils/search-filter.js';

@Injectable()
export class BookmarkService {
  constructor(
    private bookmarks: BookmarkRepository,
    private access: AccessRepository,
  ) {}

  async create(auth: AuthDto, dto: BookmarkCreateDto): Promise<BookmarkResponseDto> {
    this.requirePrivateSession(auth);
    if (dto.isLocked) requireElevatedPermission(auth);
    if (dto.previewAssetId)
      await requireAccess(this.access, { auth, permission: Permission.AssetRead, ids: [dto.previewAssetId] });
    return this.map(auth, await this.bookmarks.create(auth.user.id, dto));
  }

  async get(auth: AuthDto, id: string): Promise<BookmarkResponseDto> {
    this.requirePrivateSession(auth);
    const bookmark = await this.bookmarks.getOwned(auth, id);
    if (!bookmark) throw new NotFoundException('Bookmark not found');
    return this.map(auth, bookmark);
  }

  async update(auth: AuthDto, id: string, dto: BookmarkUpdateDto): Promise<BookmarkResponseDto> {
    await this.get(auth, id);
    if (dto.isLocked !== undefined) requireElevatedPermission(auth);
    if (dto.previewAssetId)
      await requireAccess(this.access, { auth, permission: Permission.AssetRead, ids: [dto.previewAssetId] });
    if (Object.keys(dto).length === 0) return this.get(auth, id);
    return this.map(auth, await this.bookmarks.update(auth, id, dto));
  }

  async trash(auth: AuthDto, id: string): Promise<void> {
    this.requirePrivateSession(auth);
    await this.bookmarks.setTrashed(auth, id, true);
  }

  async restore(auth: AuthDto, id: string): Promise<void> {
    this.requirePrivateSession(auth);
    await this.bookmarks.setTrashed(auth, id, false);
  }

  async setTags(auth: AuthDto, id: string, ids: string[]): Promise<void> {
    this.requirePrivateSession(auth);
    await this.bookmarks.setTags(auth, id, ids);
  }

  async getTags(auth: AuthDto, id: string): Promise<{ ids: string[] }> {
    await this.get(auth, id);
    return { ids: await this.bookmarks.getTagIds(auth, id) };
  }

  async getForAlbum(auth: AuthDto, albumId: string, afterId?: string, limit = 200): Promise<BookmarkResponseDto[]> {
    const bookmarks = await this.bookmarks.getForAlbum(auth, albumId, afterId, limit);
    const ids = bookmarks.flatMap(({ previewAssetId }) => (previewAssetId ? [previewAssetId] : []));
    const readable = await checkAccess(this.access, { auth, permission: Permission.AssetRead, ids });
    return Promise.all(bookmarks.map((bookmark) => this.map(auth, bookmark, readable)));
  }

  async getForSearch(auth: AuthDto, query: LibraryItemSearchDto, ids: string[]): Promise<BookmarkResponseDto[]> {
    this.requirePrivateSession(auth);
    if (
      ids.length === 0 ||
      (auth.apiKey && !isGranted({ requested: [Permission.BookmarkRead], current: auth.apiKey.permissions }))
    )
      return [];
    requireSourceFilterAllowed(auth, query.filter);
    const bookmarks = await this.bookmarks.getLibraryBookmarks(auth, query, ids);
    const previewIds = bookmarks.flatMap(({ previewAssetId }) => (previewAssetId ? [previewAssetId] : []));
    const readable = await checkAccess(this.access, { auth, permission: Permission.AssetRead, ids: previewIds });
    return Promise.all(bookmarks.map((bookmark) => this.map(auth, bookmark, readable)));
  }

  private requirePrivateSession(auth: AuthDto) {
    if (auth.sharedLink) throw new NotFoundException('Bookmark not found');
  }

  private async map(auth: AuthDto, bookmark: Bookmark, readable?: Set<string>): Promise<BookmarkResponseDto> {
    const { previewAssetId } = bookmark;
    const visible =
      readable ??
      (previewAssetId
        ? await checkAccess(this.access, { auth, permission: Permission.AssetRead, ids: [previewAssetId] })
        : new Set());
    return {
      id: bookmark.id,
      ownerId: bookmark.ownerId,
      url: bookmark.url,
      title: bookmark.title,
      libraryScope: bookmark.libraryScope,
      isArchived: bookmark.isArchived,
      isLocked: bookmark.isLocked,
      updateId: bookmark.updateId,
      note: !auth.sharedLink && bookmark.ownerId === auth.user.id ? bookmark.note : null,
      previewAssetId: previewAssetId && visible.has(previewAssetId) ? previewAssetId : null,
      createdAt: asDateTimeString(bookmark.createdAt),
      updatedAt: asDateTimeString(bookmark.updatedAt),
      deletedAt: bookmark.deletedAt ? asDateTimeString(bookmark.deletedAt) : null,
    };
  }
}
