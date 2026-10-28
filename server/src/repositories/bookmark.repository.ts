import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Kysely, Selectable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { columns } from 'src/database.js';
import { BulkIdErrorReason, BulkIdResponseDto } from 'src/dtos/asset-ids.response.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { BookmarkCreateDto, BookmarkUpdateDto } from 'src/dtos/bookmark.dto.js';
import { AlbumUserRole, AssetVisibility, UserMetadataKey } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { BookmarkTable } from 'src/schema/tables/bookmark.table.js';
import { searchAssetBuilder, tagIsSuppressed } from 'src/utils/database.js';
import { getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { getLockedOwnerId, isLocked } from 'src/utils/locked.js';

export type Bookmark = Selectable<BookmarkTable>;

// Apply the same session boundary to the final write, so a concurrent lock cannot be edited while locked.
const visible = (auth: AuthDto) => sql<boolean>`
  (bookmark."isLocked" = false or bookmark."ownerId" = ${getLockedOwnerId(auth) ?? null}::uuid)
  and not exists (
    select 1 from bookmark_tag
    join tag_closure on tag_closure.id_descendant = bookmark_tag."tagId"
    where bookmark_tag."bookmarkId" = bookmark.id
      and tag_closure.id_ancestor = any(${auth.hiddenContent?.tagIds ?? []}::uuid[])
  )
  and (bookmark."ownerId" = ${getLockedOwnerId(auth) ?? null}::uuid or not exists (
    select 1 from user_metadata as owner_rules
    where owner_rules."userId" = bookmark."ownerId" and owner_rules.key = ${UserMetadataKey.Preferences}
      and exists (
        select 1 from bookmark_tag
        join tag_closure on tag_closure.id_descendant = bookmark_tag."tagId"
        where bookmark_tag."bookmarkId" = bookmark.id and tag_closure.id_ancestor in (
          select (jsonb_path_query(owner_rules.value, '$.privacy.suppression.tagIds[*]') #>> '{}')::uuid
        )
      )
  ))`;
const owned = (auth: AuthDto) => sql<boolean>`bookmark."ownerId" = ${auth.user.id}::uuid
  and ${!auth.sharedLink} and ${visible(auth)}`;

const albumReadable = (auth: AuthDto, albumId: string) => sql<boolean>`exists (
  select 1 from album where album.id = ${albumId}::uuid and album."deletedAt" is null and ${
    auth.sharedLink
      ? sql`exists (select 1 from shared_link where shared_link.id = ${auth.sharedLink.id}::uuid and shared_link."albumId" = album.id)`
      : sql`exists (select 1 from album_user where album_user."albumId" = album.id and album_user."userId" = ${auth.user.id}::uuid)`
  }
)`;

@Injectable()
export class BookmarkRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  create(ownerId: string, dto: BookmarkCreateDto) {
    return this.db
      .insertInto('bookmark')
      .values({ ...dto, ownerId })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  getOwned(auth: AuthDto, id: string, trashed = false) {
    return this.db
      .selectFrom('bookmark')
      .selectAll()
      .where('id', '=', id)
      .where(owned(auth))
      .where('deletedAt', trashed ? 'is not' : 'is', null)
      .executeTakeFirst();
  }

  update(auth: AuthDto, id: string, dto: BookmarkUpdateDto) {
    return this.db
      .updateTable('bookmark')
      .set(dto)
      .where('id', '=', id)
      .where(owned(auth))
      .where('deletedAt', 'is', null)
      .returningAll()
      .executeTakeFirstOrThrow(() => new NotFoundException('Bookmark not found'));
  }

  setTrashed(auth: AuthDto, id: string, trashed: boolean) {
    return this.db
      .updateTable('bookmark')
      .set({ deletedAt: trashed ? new Date() : null })
      .where('id', '=', id)
      .where(owned(auth))
      .returningAll()
      .executeTakeFirstOrThrow(() => new NotFoundException('Bookmark not found'));
  }

  async setTags(auth: AuthDto, id: string, tagIds: string[]): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const bookmark = await tx
        .selectFrom('bookmark')
        .select('id')
        .where('id', '=', id)
        .where(owned(auth))
        .where('deletedAt', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!bookmark) throw new NotFoundException('Bookmark not found');
      const ids = [...new Set(tagIds)];
      if (ids.length > 0) {
        const tags = await tx
          .selectFrom('tag')
          .select('id')
          .where('id', 'in', ids)
          .where('userId', '=', auth.user.id)
          .where(sql<boolean>`not ${tagIsSuppressed(sql.ref('tag.id'), auth.hiddenContent?.tagIds ?? [])}`)
          .forShare()
          .execute();
        if (tags.length !== ids.length) throw new BadRequestException('Tag not found');
      }
      await tx.deleteFrom('bookmark_tag').where('bookmarkId', '=', id).execute();
      if (ids.length > 0)
        await tx
          .insertInto('bookmark_tag')
          .values(ids.map((tagId) => ({ bookmarkId: id, tagId })))
          .execute();
      await tx.updateTable('bookmark').set({ updatedAt: new Date() }).where('id', '=', id).execute();
    });
  }

  async getTagIds(auth: AuthDto, id: string): Promise<string[]> {
    const tags = await this.db
      .selectFrom('bookmark_tag')
      .innerJoin('bookmark', 'bookmark.id', 'bookmark_tag.bookmarkId')
      .select('tagId')
      .where('bookmark.id', '=', id)
      .where(owned(auth))
      .where('bookmark.deletedAt', 'is', null)
      .orderBy('tagId')
      .execute();
    return tags.map(({ tagId }) => tagId);
  }

  getForAlbum(auth: AuthDto, albumId: string, afterId?: string, limit = 200) {
    return this.albumBookmarks(auth, albumId)
      .selectAll('bookmark')
      .$if(!!afterId, (qb) => qb.where('bookmark.id', '>', afterId!))
      .orderBy('bookmark.id')
      .limit(limit)
      .execute();
  }

  private albumBookmarks(auth: AuthDto, albumId: string) {
    return this.db
      .selectFrom('bookmark')
      .innerJoin('album_bookmark', 'album_bookmark.bookmarkId', 'bookmark.id')
      .where('album_bookmark.albumId', '=', albumId)
      .where(albumReadable(auth, albumId))
      .where('bookmark.deletedAt', 'is', null)
      .where(visible(auth));
  }

  private albumAssets(auth: AuthDto, albumId: string) {
    return searchAssetBuilder(
      this.db,
      {
        ...getHiddenContentQueryOptions(auth),
        filter: { albumIds: { any: [albumId] } },
      },
      {
        userIds: [auth.user.id],
        lockedOwnerId: getLockedOwnerId(auth) ?? '',
        viewingUserId: auth.sharedLink ? undefined : auth.user.id,
        sharedLink: !!auth.sharedLink,
        lockedMotion: { lockedOwnerId: getLockedOwnerId(auth) },
      },
    )
      .where(albumReadable(auth, albumId))
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', '!=', AssetVisibility.Hidden);
  }

  getAlbumAssets(auth: AuthDto, albumId: string, afterId?: string, limit = 200) {
    return this.albumAssets(auth, albumId)
      .select(columns.searchAsset)
      .select(isLocked().as('isLocked'))
      .$if(!!afterId, (qb) => qb.where('asset.id', '>', afterId!))
      .orderBy('asset.id')
      .limit(limit)
      .execute();
  }

  async getAlbumCounts(auth: AuthDto, albumId: string) {
    const [assets, bookmarks] = await Promise.all([
      this.albumAssets(auth, albumId)
        .select(sql<number>`count(*)::int`.as('count'))
        .executeTakeFirstOrThrow(),
      this.albumBookmarks(auth, albumId)
        .select(sql<number>`count(*)::int`.as('count'))
        .executeTakeFirstOrThrow(),
    ]);
    return { assetCount: assets.count, bookmarkCount: bookmarks.count, itemCount: assets.count + bookmarks.count };
  }

  async addToAlbum(auth: AuthDto, albumId: string, ids: string[]): Promise<BulkIdResponseDto[]> {
    return this.changeMembership(auth, albumId, ids, false);
  }

  async removeFromAlbum(auth: AuthDto, albumId: string, ids: string[]): Promise<BulkIdResponseDto[]> {
    return this.changeMembership(auth, albumId, ids, true);
  }

  private async changeMembership(
    auth: AuthDto,
    albumId: string,
    ids: string[],
    remove: boolean,
  ): Promise<BulkIdResponseDto[]> {
    return this.db.transaction().execute(async (tx) => {
      const membership = auth.sharedLink
        ? undefined
        : await tx
            .selectFrom('album_user')
            .innerJoin('album', 'album.id', 'album_user.albumId')
            .select('role')
            .where('album_user.albumId', '=', albumId)
            .where('userId', '=', auth.user.id)
            .where('album.deletedAt', 'is', null)
            .where('role', 'in', [AlbumUserRole.Owner, AlbumUserRole.Editor])
            .forShare()
            .executeTakeFirst();
      const results: BulkIdResponseDto[] = [];
      for (const id of [...new Set(ids)].toSorted()) {
        if (!membership) {
          results.push({ id, success: false, error: BulkIdErrorReason.NO_PERMISSION });
          continue;
        }
        const bookmark = await tx
          .selectFrom('bookmark')
          .select('id')
          .where('id', '=', id)
          .where(remove ? visible(auth) : owned(auth))
          .where('deletedAt', 'is', null)
          .$if(remove, (qb) =>
            qb.where((eb) =>
              eb.exists(
                eb
                  .selectFrom('album_bookmark')
                  .select('bookmarkId')
                  .where('albumId', '=', albumId)
                  .where('bookmarkId', '=', id),
              ),
            ),
          )
          .forShare()
          .executeTakeFirst();
        if (!bookmark) {
          results.push({ id, success: false, error: BulkIdErrorReason.NO_PERMISSION });
          continue;
        }
        if (remove) {
          await tx.deleteFrom('album_bookmark').where('albumId', '=', albumId).where('bookmarkId', '=', id).execute();
          results.push({ id, success: true });
          continue;
        }
        const added = await tx
          .insertInto('album_bookmark')
          .values({ albumId, bookmarkId: id })
          .onConflict((oc) => oc.doNothing())
          .returning('bookmarkId')
          .executeTakeFirst();
        results.push(added ? { id, success: true } : { id, success: false, error: BulkIdErrorReason.DUPLICATE });
      }
      return results;
    });
  }
}
