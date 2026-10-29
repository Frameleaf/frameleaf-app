import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { type Expression, type Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import type { LockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import { AssetAnnotationItemsSchema } from 'src/dtos/asset-annotation.dto.js';
import { LibraryManifestDto } from 'src/dtos/library-manifest.dto.js';
import { AlbumUserRole, AssetFileType, AssetType, AssetVisibility, LibraryScope } from 'src/enum.js';
import { assetAnnotationRevision } from 'src/repositories/asset-annotation.repository.js';
import { BookmarkRepository } from 'src/repositories/bookmark.repository.js';
import { DB } from 'src/schema/index.js';
import {
  anyUuid,
  hiddenFromSession,
  withAlbumVisibility,
  withHiddenContentFilter,
  withLockedOwnerScope,
} from 'src/utils/database.js';
import { getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { portableCaptureSource } from 'src/utils/library-manifest.js';
import { getLockedOwnerId, isLocked, isNotLocked } from 'src/utils/locked.js';

type DownloadPrivacyOptions = HiddenContentQueryOptions & LockedVisibilityOptions;

const builder = (db: Kysely<DB>, options: DownloadPrivacyOptions = {}) =>
  db
    .selectFrom('asset')
    .innerJoin('asset_exif', 'assetId', 'id')
    .select(['asset.id', 'asset.livePhotoVideoId', 'asset_exif.fileSizeInByte as size'])
    .where('asset.deletedAt', 'is', null)
    .$call((qb) => withHiddenContentFilter(qb, options));

@Injectable()
export class DownloadRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  downloadAssetIds(ids: string[], options?: DownloadPrivacyOptions) {
    return builder(this.db, options).where('asset.id', '=', anyUuid(ids)).stream();
  }

  downloadMotionAssetIds(ids: string[], options?: DownloadPrivacyOptions) {
    return builder(this.db, options).select(['asset.originalPath']).where('asset.id', '=', anyUuid(ids)).stream();
  }

  /** An album download holds the same media the album shows this viewer (see `withAlbumVisibility`). */
  downloadAlbumId(albumId: string, options?: DownloadPrivacyOptions) {
    return builder(this.db, options)
      .innerJoin('album_asset', 'asset.id', 'album_asset.assetId')
      .where('album_asset.albumId', '=', albumId)
      .$call((qb) => withAlbumVisibility(qb, options?.lockedOwnerId))
      .stream();
  }

  /**
   * ACCOUNT-P5: the details file (XMP sidecar) of each of these assets that has one; the original's own
   * sidecar first when an asset also has an edited one.
   */
  getSidecars(ids: string[]) {
    return this.db
      .selectFrom('asset_file')
      .select(['asset_file.assetId', 'asset_file.path'])
      .where('asset_file.assetId', '=', anyUuid(ids))
      .where('asset_file.type', '=', AssetFileType.Sidecar)
      .orderBy('asset_file.isEdited', 'asc')
      .execute();
  }

  /** A whole-library download holds the owner's Locked media only for their elevated session (FL-34). */
  downloadUserId(userId: string, options?: DownloadPrivacyOptions) {
    return builder(this.db, options)
      .where('asset.ownerId', '=', userId)
      .where('asset.visibility', '!=', AssetVisibility.Hidden)
      .$call((qb) => withLockedOwnerScope(qb, options?.lockedOwnerId))
      .stream();
  }
  async getLibraryManifest(
    auth: AuthDto,
    files: { id: string; file: string }[],
    bookmarkIds: string[],
    includeSources: boolean,
  ): Promise<LibraryManifestDto> {
    if (auth.sharedLink || auth.apiKey || auth.system)
      throw new ForbiddenException('Private library export requires a signed-in account');
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async (tx) => {
        const assetIds = files.map(({ id }) => id);
        const assetRows =
          assetIds.length === 0
            ? []
            : await tx
                .selectFrom('asset')
                .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
                .select([
                  'asset.id',
                  'asset.checksum',
                  'asset.libraryScope',
                  'asset.type',
                  'asset.isFavorite',
                  'asset.visibility',
                  'asset_exif.description',
                  'asset_exif.rating',
                ])
                .select(isLocked().as('isLocked'))
                .where('asset.id', 'in', assetIds)
                .where('asset.ownerId', '=', auth.user.id)
                .where('asset.deletedAt', 'is', null)
                .where('asset.isOffline', '=', false)
                .where('asset.visibility', '!=', AssetVisibility.Hidden)
                .where(sql<boolean>`not ${hiddenFromSession(getHiddenContentQueryOptions(auth))}`)
                .$if(!getLockedOwnerId(auth), (query) => query.where(isNotLocked()))
                .execute();
        const bookmarks = new BookmarkRepository(tx);
        const query = { mode: 'text' as const, query: '', limit: 200 };
        const bookmarkRows =
          bookmarkIds.length === 0
            ? []
            : new Map(
                (
                  await Promise.all([
                    bookmarks.getLibraryBookmarks(
                      auth,
                      { ...query, filter: { libraryScope: LibraryScope.Personal } },
                      bookmarkIds,
                    ),
                    bookmarks.getLibraryBookmarks(
                      auth,
                      { ...query, filter: { libraryScope: LibraryScope.Design } },
                      bookmarkIds,
                    ),
                  ])
                )
                  .flat()
                  .map((row) => [row.id, row]),
              )
                .values()
                .toArray();
        if (assetRows.length !== new Set(assetIds).size || bookmarkRows.length !== new Set(bookmarkIds).size)
          throw new ForbiddenException('Selected library records unavailable');
        const owned = (albumId: Expression<string>) =>
          sql<boolean>`exists (select 1 from album_user member where member."albumId" = ${albumId} and member."userId" = ${auth.user.id}::uuid and member.role = ${AlbumUserRole.Owner})`;
        const assetMemberships =
          assetIds.length === 0
            ? []
            : await tx
                .selectFrom('album_asset')
                .select(['albumId', 'assetId'])
                .where('assetId', 'in', assetIds)
                .where(owned(sql.ref('album_asset.albumId')))
                .execute();
        const bookmarkMemberships =
          bookmarkIds.length === 0
            ? []
            : await tx
                .selectFrom('album_bookmark')
                .select(['albumId', 'bookmarkId'])
                .where('bookmarkId', 'in', bookmarkIds)
                .where(owned(sql.ref('album_bookmark.albumId')))
                .execute();
        const selectedAlbums = [
          ...new Set([...assetMemberships, ...bookmarkMemberships].map(({ albumId }) => albumId)),
        ];
        const albums =
          selectedAlbums.length === 0
            ? []
            : await tx
                .selectFrom('album')
                .select([
                  'album.id',
                  'album.parentId',
                  'album.albumName',
                  'album.description',
                  'album.kind',
                  'album.libraryScope',
                  'album.icon',
                  'album.sortOrder',
                ])
                .where('album.deletedAt', 'is', null)
                .where(owned(sql.ref('album.id')))
                .where(
                  'album.id',
                  'in',
                  tx.selectFrom('album_closure').select('id_ancestor').where('id_descendant', 'in', selectedAlbums),
                )
                .orderBy('album.id')
                .execute();
        const albumIds = new Set(albums.map(({ id }) => id));
        const assetTags =
          assetIds.length === 0
            ? []
            : await tx
                .selectFrom('tag_asset')
                .innerJoin('tag', 'tag.id', 'tag_asset.tagId')
                .select(['tag_asset.tagId', 'tag_asset.assetId'])
                .where('assetId', 'in', assetIds)
                .where('tag.userId', '=', auth.user.id)
                .execute();
        const bookmarkTags =
          bookmarkIds.length === 0
            ? []
            : await tx
                .selectFrom('bookmark_tag')
                .innerJoin('tag', 'tag.id', 'bookmark_tag.tagId')
                .select(['bookmark_tag.tagId', 'bookmark_tag.bookmarkId'])
                .where('bookmarkId', 'in', bookmarkIds)
                .where('tag.userId', '=', auth.user.id)
                .execute();
        const selectedTags = [...new Set([...assetTags, ...bookmarkTags].map(({ tagId }) => tagId))];
        const tags =
          selectedTags.length === 0
            ? []
            : await tx
                .selectFrom('tag')
                .select(['tag.id', 'tag.value', 'tag.parentId', 'tag.color'])
                .where('tag.userId', '=', auth.user.id)
                .where(
                  'tag.id',
                  'in',
                  tx.selectFrom('tag_closure').select('id_ancestor').where('id_descendant', 'in', selectedTags),
                )
                .orderBy('tag.id')
                .execute();
        const sources =
          includeSources && assetIds.length > 0
            ? await tx.selectFrom('asset_source').selectAll().where('assetId', 'in', assetIds).orderBy('id').execute()
            : [];
        // FL-652: Boards annotations travel with Boards pictures only, as the item details show them.
        // The archive always holds the original file, while annotations are drawn over the picture as
        // shown. `matchesFile` says whether they line up with the exported bytes: the picture has no
        // edits or develop version and has not changed since they were saved. Otherwise they are kept
        // but flagged, never silently placed on a picture they weren't drawn on.
        const annotatedIds = assetRows
          .filter((row) => row.type === AssetType.Image && row.libraryScope !== LibraryScope.Personal)
          .map(({ id }) => id);
        const annotations = new Map(
          annotatedIds.length === 0
            ? []
            : (
                await tx
                  .selectFrom('asset_annotation')
                  .innerJoin('asset', 'asset.id', 'asset_annotation.assetId')
                  .select(['asset_annotation.assetId', 'asset_annotation.items'])
                  .select(
                    sql<boolean>`(
                      asset_annotation."sourceRevision" = ${assetAnnotationRevision()}
                      and not asset."isEdited"
                      and not exists (select 1 from asset_edit e where e."assetId" = asset.id)
                      and not exists (
                        select 1 from asset_develop_revision d
                        where d."assetId" = asset.id and d."ownerId" = asset."ownerId" and d."isCurrent"
                      )
                    )`.as('matchesFile'),
                  )
                  .where('asset_annotation.assetId', 'in', annotatedIds)
                  .where('asset_annotation.version', '=', 1)
                  .execute()
              ).flatMap(({ assetId, items, matchesFile }) => {
                const parsed = AssetAnnotationItemsSchema.safeParse(items);
                return parsed.success && parsed.data.length > 0
                  ? [[assetId, { items: parsed.data, matchesFile }] as const]
                  : [];
              }),
        );
        const albumsByAsset = Map.groupBy(
          assetMemberships.filter((row) => albumIds.has(row.albumId)),
          (row) => row.assetId,
        );
        const albumsByBookmark = Map.groupBy(
          bookmarkMemberships.filter((row) => albumIds.has(row.albumId)),
          (row) => row.bookmarkId,
        );
        const tagsByAsset = Map.groupBy(assetTags, (row) => row.assetId);
        const tagsByBookmark = Map.groupBy(bookmarkTags, (row) => row.bookmarkId);
        const sourcesByAsset = Map.groupBy(sources, (row) => row.assetId);
        const fileById = new Map(files.map(({ id, file }) => [id, file]));
        const spaceAlbums =
          albumIds.size === 0
            ? []
            : await tx
                .selectFrom('shared_space_album')
                .select(['albumId as spaceId', 'linkedAlbumId as albumId'])
                .where('albumId', 'in', [...albumIds])
                .where('linkedAlbumId', 'in', [...albumIds])
                .orderBy('albumId')
                .orderBy('linkedAlbumId')
                .execute();
        const manifest = LibraryManifestDto.schema.safeParse({
          version: 1,
          albums: albums.map((row) => ({
            ...row,
            parentId: row.parentId && albumIds.has(row.parentId) ? row.parentId : null,
          })),
          tags,
          assets: assetRows.map((row) => ({
            id: row.id,
            file: fileById.get(row.id),
            checksum: {
              algorithm: row.checksum.length === 20 ? 'sha1' : 'sha256',
              value: row.checksum.toString('hex'),
            },
            libraryScope: row.libraryScope,
            description: row.description ?? '',
            rating: row.rating,
            isFavorite: row.isFavorite,
            isArchived: row.visibility === AssetVisibility.Archive,
            isLocked: row.isLocked,
            albumIds: (albumsByAsset.get(row.id) ?? []).map((m) => m.albumId).sort(),
            tagIds: (tagsByAsset.get(row.id) ?? []).map((m) => m.tagId).sort(),
            ...(includeSources
              ? { sources: (sourcesByAsset.get(row.id) ?? []).map((source) => portableCaptureSource(source)) }
              : {}),
            ...(annotations.has(row.id)
              ? {
                  annotations: annotations.get(row.id)!.items,
                  annotationsMatchFile: annotations.get(row.id)!.matchesFile,
                }
              : {}),
          })),
          bookmarks: bookmarkRows.map((row) => ({
            id: row.id,
            title: row.title,
            url: row.url,
            note: row.note,
            rating: row.rating,
            libraryScope: row.libraryScope,
            isArchived: row.isArchived,
            isLocked: row.isLocked,
            previewAssetId: row.previewAssetId && fileById.has(row.previewAssetId) ? row.previewAssetId : null,
            albumIds: (albumsByBookmark.get(row.id) ?? []).map((m) => m.albumId).sort(),
            tagIds: (tagsByBookmark.get(row.id) ?? []).map((m) => m.tagId).sort(),
            ...(includeSources ? { source: row.source ? portableCaptureSource(row.source) : null } : {}),
          })),
          spaceAlbums,
        });
        if (!manifest.success) throw new BadRequestException('Selected metadata exceeds portable inventory limits');
        return manifest.data;
      });
  }
}
