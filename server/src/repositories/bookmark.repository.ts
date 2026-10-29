import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Expression, ExpressionBuilder, Kysely, Selectable, SqlBool, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { AssetSearchScope } from 'src/repositories/search.repository.js';
import type { LibraryCursor } from 'src/utils/library-search-cursor.js';
import { columns } from 'src/database.js';
import { BulkIdErrorReason, BulkIdResponseDto } from 'src/dtos/asset-ids.response.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { BookmarkCreateDto, BookmarkUpdateDto } from 'src/dtos/bookmark.dto.js';
import { LibraryItemSearchDto } from 'src/dtos/library-search.dto.js';
import { SearchFilterBranch, isAlbumConfined } from 'src/dtos/search.dto.js';
import { AlbumUserRole, AssetType, AssetVisibility, LibraryScope, UserMetadataKey } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { BookmarkTable } from 'src/schema/tables/bookmark.table.js';
import { assetColorDistance, assetColorPredicate, assetTransparencyPredicate } from 'src/utils/asset-palette-query.js';
import {
  anyUuid,
  comparisonPredicates,
  hiddenContentBookmarkIdExists,
  hiddenFromSession,
  idsPredicates,
  searchAssetBuilder,
  searchFilterPredicate,
  tagIsSuppressed,
} from 'src/utils/database.js';
import { getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { libraryScopePredicate } from 'src/utils/library-scope.js';
import { getLockedOwnerId, isLocked } from 'src/utils/locked.js';

export type Bookmark = Selectable<BookmarkTable>;
export type LibraryCandidate = {
  id: string;
  kind: 'asset' | 'bookmark';
  dateKey: string;
  rank: number;
  nameKey: string;
};
const bookmarkFields = new Set([
  'id',
  'visibility',
  'hasAlbums',
  'hasTags',
  'rating',
  'createdAt',
  'updatedAt',
  'trashedAt',
  'tagIds',
  'albumIds',
  'albumSubtreeIds',
  'source',
  'text',
  'color',
  'hasTransparency',
  'or',
  'libraryScope',
]);

const bookmarkTextPredicate = (text: string, viewerId: string) =>
  sql<SqlBool>`strpos(lower(f_unaccent(concat_ws(' ', bookmark.title, bookmark.url,
    case when bookmark."ownerId" = ${viewerId}::uuid then bookmark.note else null end))), lower(f_unaccent(${text}))) > 0`;

// Apply the same session boundary to the final write, so a concurrent lock cannot be edited while locked.
const visible = (auth: AuthDto) => sql<boolean>`
  (bookmark."isLocked" = false or bookmark."ownerId" = ${getLockedOwnerId(auth) ?? null}::uuid)
  and not ${auth.hiddenContent ? hiddenContentBookmarkIdExists(sql.ref('bookmark.id'), auth.hiddenContent) : sql`false`}
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

const albumReadable = (auth: AuthDto, albumId: string | Expression<unknown>) => sql<boolean>`exists (
  select 1 from album where album.id = ${albumId}::uuid and album."deletedAt" is null and ${
    auth.sharedLink
      ? sql`exists (select 1 from shared_link where shared_link.id = ${auth.sharedLink.id}::uuid and shared_link."albumId" = album.id)`
      : sql`exists (select 1 from album_user where album_user."albumId" = album.id and album_user."userId" = ${auth.user.id}::uuid)`
  }
)`;

@Injectable()
export class BookmarkRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  private libraryAssets(auth: AuthDto, query: LibraryItemSearchDto, scope: AssetSearchScope) {
    return searchAssetBuilder(
      this.db,
      { filter: query.filter, ...getHiddenContentQueryOptions(auth), withExif: true },
      scope,
    )
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', '!=', AssetVisibility.Hidden)
      .$if(!!query.query, (qb) =>
        qb.where((eb) =>
          searchFilterPredicate(
            eb,
            {
              or: [
                { originalFileName: { like: query.query } },
                { description: { like: query.query } },
                { ocr: { matches: query.query } },
              ],
            },
            auth.user.id,
          ),
        ),
      );
  }

  private readablePreview(auth: AuthDto, branch: SearchFilterBranch) {
    return this.db
      .selectFrom('asset')
      .where(sql<boolean>`asset.id = bookmark."previewAssetId"`)
      .where('asset.ownerId', '=', auth.user.id)
      .where('asset.deletedAt', 'is', null)
      .where('asset.type', 'in', [AssetType.Image, AssetType.Video])
      .where('asset.visibility', '!=', AssetVisibility.Hidden)
      .where(sql<boolean>`not ${hiddenFromSession(getHiddenContentQueryOptions(auth))}`)
      .$if(!!branch.color, (qb) => qb.where(assetColorPredicate(branch.color!, auth.user.id)))
      .$if(!!branch.hasTransparency, (qb) =>
        qb.where(assetTransparencyPredicate(branch.hasTransparency!.eq, auth.user.id)),
      );
  }

  private bookmarkBranch(
    eb: ExpressionBuilder<DB, 'bookmark'>,
    branch: SearchFilterBranch,
    auth: AuthDto,
  ): Expression<SqlBool>[] {
    if (Object.entries(branch).some(([field, value]) => value !== undefined && !bookmarkFields.has(field)))
      return [eb.lit(false)];
    const state = sql<AssetVisibility>`case when bookmark."isLocked" then 'locked' when bookmark."isArchived" then 'archive' else 'timeline' end`;
    const predicates: Expression<SqlBool>[] = [
      ...(branch.text ? [bookmarkTextPredicate(branch.text.contains, auth.user.id)] : []),
      ...comparisonPredicates(eb, 'bookmark.id', branch.id),
      ...comparisonPredicates(eb, state, branch.visibility),
      ...comparisonPredicates(eb, 'bookmark.createdAt', branch.createdAt),
      ...comparisonPredicates(eb, 'bookmark.updatedAt', branch.updatedAt),
      ...comparisonPredicates(eb, 'bookmark.deletedAt', branch.trashedAt),
      ...(branch.rating
        ? [eb('bookmark.ownerId', '=', auth.user.id), ...comparisonPredicates(eb, 'bookmark.rating', branch.rating)]
        : []),
    ];
    const tags = (ids: string[]) =>
      eb
        .selectFrom('bookmark_tag')
        .innerJoin('tag_closure', 'tag_closure.id_descendant', 'bookmark_tag.tagId')
        .whereRef('bookmark_tag.bookmarkId', '=', 'bookmark.id')
        .where('tag_closure.id_ancestor', '=', anyUuid(ids));
    predicates.push(
      ...idsPredicates(eb, branch.tagIds, {
        matchesAny: (ids) => eb.exists(tags(ids)),
        matchesAll: (ids) =>
          eb.exists(
            tags(ids)
              .select('bookmark_tag.bookmarkId')
              .groupBy('bookmark_tag.bookmarkId')
              .having((eb) => eb.fn.count('tag_closure.id_ancestor').distinct(), '=', ids.length),
          ),
      }),
    );
    for (const field of ['albumIds', 'albumSubtreeIds'] as const) {
      const subtree = field === 'albumSubtreeIds';
      const column = subtree ? 'album_closure.id_ancestor' : 'album_bookmark.albumId';
      const matching = (ids: string[]) =>
        eb
          .selectFrom('album_bookmark')
          .innerJoin('album_closure', 'album_closure.id_descendant', 'album_bookmark.albumId')
          .whereRef('album_bookmark.bookmarkId', '=', 'bookmark.id')
          .where(column, '=', anyUuid(ids))
          .where(albumReadable(auth, sql.ref('album_bookmark.albumId')))
          .$if(subtree, (qb) => qb.where(albumReadable(auth, sql.ref('album_closure.id_ancestor'))));
      predicates.push(
        ...idsPredicates(eb, branch[field], {
          matchesAny: (ids) => eb.exists(matching(ids)),
          matchesAll: (ids) =>
            eb.exists(
              matching(ids)
                .select('album_bookmark.bookmarkId')
                .groupBy('album_bookmark.bookmarkId')
                .having((eb) => eb.fn.count(column).distinct(), '=', ids.length),
            ),
        }),
      );
    }
    if (branch.hasTags) {
      const exists = eb.exists(eb.selectFrom('bookmark_tag').whereRef('bookmark_tag.bookmarkId', '=', 'bookmark.id'));
      predicates.push(branch.hasTags.eq ? exists : eb.not(exists));
    }
    if (branch.hasAlbums) {
      const exists = eb.exists(
        eb.selectFrom('album_bookmark').whereRef('album_bookmark.bookmarkId', '=', 'bookmark.id'),
      );
      predicates.push(branch.hasAlbums.eq ? exists : eb.not(exists));
    }
    if (branch.source)
      predicates.push(sql<boolean>`bookmark."ownerId" = ${auth.user.id}::uuid and
      strpos(lower(f_unaccent(concat_ws(' ', bookmark.source->>'pageUrl', bookmark.source->>'mediaUrl', bookmark.source->>'title',
        bookmark.source->>'note', bookmark.source->>'creator', bookmark.source->>'licenseUrl'))), lower(f_unaccent(${branch.source.contains}))) > 0`);
    if (branch.color || branch.hasTransparency)
      predicates.push(eb.exists(this.readablePreview(auth, branch).select('asset.id')));
    return predicates;
  }

  private libraryBookmarks(auth: AuthDto, query: LibraryItemSearchDto) {
    const filter = query.filter;
    const branches = filter.or ?? [];
    const topConfined = isAlbumConfined(filter);
    const perBranch = !topConfined && branches.some((branch) => isAlbumConfined(branch));
    const global = !topConfined && !perBranch;
    return this.db
      .selectFrom('bookmark')
      .where(visible(auth))
      .where('bookmark.deletedAt', 'is', null)
      .$if(global, (qb) => qb.where('bookmark.ownerId', '=', auth.user.id))
      .$if(!!filter.libraryScope || global, (qb) =>
        qb.where(libraryScopePredicate(filter.libraryScope ?? LibraryScope.Personal, 'bookmark')),
      )
      .where((eb) =>
        eb.and([
          ...this.bookmarkBranch(eb, filter, auth),
          ...(branches.length > 0
            ? [
                eb.or(
                  branches.map((branch) =>
                    eb.and([
                      ...this.bookmarkBranch(eb, branch, auth),
                      ...(perBranch && !isAlbumConfined(branch)
                        ? [
                            eb('bookmark.ownerId', '=', auth.user.id),
                            ...(!filter.libraryScope ? [libraryScopePredicate(LibraryScope.Personal, 'bookmark')] : []),
                          ]
                        : []),
                    ]),
                  ),
                ),
              ]
            : []),
        ]),
      )
      .$if(!!query.query, (qb) => qb.where(bookmarkTextPredicate(query.query, auth.user.id)));
  }

  async searchLibrary(
    auth: AuthDto,
    query: LibraryItemSearchDto,
    scope: AssetSearchScope,
    include: { assets: boolean; bookmarks: boolean },
    cursor?: Extract<LibraryCursor, { mode: 'text' }>,
  ): Promise<{ count: number; candidates: LibraryCandidate[] }> {
    const sort = query.sort ?? 'added';
    if (cursor && cursor.after.sort !== sort) throw new BadRequestException('Cursor sort changed');
    // Rating: best first, unrated after rated, rejected (-1) last.
    const ratingRank = (column: string) =>
      sql<number>`(case when ${sql.ref(column)} = -1 then 1 else -coalesce(${sql.ref(column)}, 0) end)::double precision`;
    const assetRank =
      sort === 'color'
        ? assetColorDistance(query.filter.color!, auth.user.id)
        : sort === 'rating'
          ? ratingRank('asset_exif.rating')
          : sql<number>`0::double precision`;
    const bookmarkRank =
      sort === 'color'
        ? this.readablePreview(auth, query.filter)
            .select(assetColorDistance(query.filter.color!, auth.user.id).as('rank'))
            .limit(1)
        : sql<number>`0::double precision`;
    const assets = this.libraryAssets(auth, query, scope)
      .where(sql<boolean>`${include.assets}`)
      .clearSelect()
      .select([
        'asset.id',
        sql<string>`'asset'::text`.as('kind'),
        'asset.createdAt',
        sql<string>`to_char(asset."createdAt" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as('dateKey'),
        assetRank.as('rank'),
        sql<string>`left(lower(asset."originalFileName"), 512)`.as('nameKey'),
      ]);
    const bookmarks = this.libraryBookmarks(auth, query)
      .where(sql<boolean>`${include.bookmarks}`)
      .select([
        'bookmark.id',
        sql<string>`'bookmark'::text`.as('kind'),
        'bookmark.createdAt',
        sql<string>`to_char(bookmark."createdAt" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as('dateKey'),
        (sort === 'rating'
          ? ratingRank('bookmark.rating')
          : sql<number>`coalesce((${bookmarkRank}), 3)::double precision`
        ).as('rank'),
        sql<string>`left(lower(coalesce(nullif(bookmark.title, ''), bookmark.url)), 512)`.as('nameKey'),
      ]);
    const after = !cursor
      ? sql`true`
      : cursor.after.sort === 'added'
        ? sql`("createdAt" < ${cursor.after.value}::timestamptz or ("createdAt" = ${cursor.after.value}::timestamptz and (kind,id) > (${cursor.kind}::text,${cursor.id}::uuid)))`
        : cursor.after.sort === 'name'
          ? sql`("nameKey",kind,id) > (${cursor.after.value}::text,${cursor.kind}::text,${cursor.id}::uuid)`
          : sql`(rank,kind,id) > (${cursor.after.value}::double precision,${cursor.kind}::text,${cursor.id}::uuid)`;
    const order =
      sort === 'added'
        ? sql`"createdAt" desc, kind, id`
        : sort === 'name'
          ? sql`"nameKey", kind, id`
          : sql`rank, kind, id`;
    const aggregateOrder =
      sort === 'added'
        ? sql`page."createdAt" desc, page.kind, page.id`
        : sort === 'name'
          ? sql`page."nameKey", page.kind, page.id`
          : sql`page.rank, page.kind, page.id`;
    const {
      rows: [result],
    } = await sql<{ count: number; candidates: LibraryCandidate[] }>`
      with matched as materialized (${assets} union all ${bookmarks})
      select (select count(*)::int from matched) as count,
        coalesce((select jsonb_agg(to_jsonb(page) order by ${aggregateOrder}) from (
          select id, kind, "dateKey", rank, "nameKey", "createdAt" from matched where ${after} order by ${order} limit ${query.limit + 1}
        ) page), '[]'::jsonb) as candidates`.execute(this.db);
    return result;
  }

  getLibraryAssets(auth: AuthDto, query: LibraryItemSearchDto, scope: AssetSearchScope, ids: string[]) {
    return this.libraryAssets(auth, query, scope)
      .where('asset.id', 'in', ids)
      .select(columns.searchAsset)
      .select(isLocked().as('isLocked'))
      .execute();
  }

  selectPreservationBookmarks(auth: AuthDto, query: LibraryItemSearchDto, ids: string[] | undefined, limit: number) {
    return this.libraryBookmarks(auth, query)
      .where('bookmark.ownerId', '=', auth.user.id)
      .$if(ids !== undefined, (qb) => qb.where('bookmark.id', '=', anyUuid(ids!)))
      .select('bookmark.id')
      .orderBy('bookmark.id')
      .limit(limit)
      .execute();
  }

  async countPreservationBookmarks(auth: AuthDto, filter: LibraryItemSearchDto['filter'], ids?: string[]) {
    const queryFor = (libraryScope: LibraryScope.Personal | LibraryScope.Design) =>
      this.libraryBookmarks(auth, { mode: 'text', query: '', limit: 200, filter: { ...filter, libraryScope } })
        .where('bookmark.ownerId', '=', auth.user.id)
        .$if(ids !== undefined, (qb) => qb.where('bookmark.id', '=', anyUuid(ids!)))
        .select('bookmark.id');
    const selected = queryFor(filter.libraryScope ?? LibraryScope.Personal);
    const all = filter.libraryScope ? selected : selected.union(queryFor(LibraryScope.Design));
    const row = await this.db
      .selectFrom(all.as('selected'))
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  getPreservationDetails(auth: AuthDto, query: LibraryItemSearchDto, ids: string[], packageId: string) {
    return this.libraryBookmarks(auth, query)
      .where('bookmark.ownerId', '=', auth.user.id)
      .where('bookmark.id', '=', anyUuid(ids))
      .selectAll('bookmark')
      .select([
        sql<string[]>`array(select membership."albumId" from album_bookmark membership
          join album on album.id = membership."albumId" and album."deletedAt" is null
          join album_user member on member."albumId" = album.id and member."userId" = ${auth.user.id}::uuid and member.role = ${AlbumUserRole.Owner}
          where membership."bookmarkId" = bookmark.id order by membership."albumId")`.as('albumIds'),
        sql<string[]>`array(select tag.value from bookmark_tag membership
          join tag on tag.id = membership."tagId" and tag."userId" = ${auth.user.id}::uuid
          where membership."bookmarkId" = bookmark.id order by tag.value)`.as('tags'),
        sql<string | null>`case when exists (select 1 from preservation_item item
          join asset preview on preview.id = item."assetId" and preview."ownerId" = ${auth.user.id}::uuid
          where item."packageId" = ${packageId}::uuid and item.state = 'copied' and item."assetId" = bookmark."previewAssetId")
          then bookmark."previewAssetId" else null end`.as('packagedPreviewAssetId'),
      ])
      .orderBy('bookmark.id')
      .execute();
  }

  getLibraryBookmarks(auth: AuthDto, query: LibraryItemSearchDto, ids: string[]) {
    return this.libraryBookmarks(auth, query).where('bookmark.id', 'in', ids).selectAll('bookmark').execute();
  }

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

  async setTags(auth: AuthDto, id: string, tagIds: string[], append = false): Promise<void> {
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
      const existing = append
        ? await tx.selectFrom('bookmark_tag').select('tagId').where('bookmarkId', '=', id).execute()
        : [];
      if (new Set([...existing.map((row) => row.tagId), ...ids]).size > 500)
        throw new BadRequestException('Bookmark tag limit exceeded');
      if (!append) await tx.deleteFrom('bookmark_tag').where('bookmarkId', '=', id).execute();
      if (ids.length > 0)
        await tx
          .insertInto('bookmark_tag')
          .values(ids.map((tagId) => ({ bookmarkId: id, tagId })))
          .onConflict((oc) => oc.doNothing())
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
