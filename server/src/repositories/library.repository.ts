import { Injectable } from '@nestjs/common';
import { type Insertable, type Kysely, type RawBuilder, type Transaction, type Updateable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { LibraryStatsResponseDto, ManagedUploadsStatsResponseDto } from 'src/dtos/library.dto.js';
import {
  AlbumKind,
  AssetType,
  AssetVisibility,
  MediaOperationKind,
  MediaOperationStatus,
  UserStatus,
} from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DB } from 'src/schema/index.js';
import { LibraryFolderAlbumTable } from 'src/schema/tables/library-folder-album.table.js';
import { LibraryTable } from 'src/schema/tables/library.table.js';
import { asUuid, isNotLockedAsset } from 'src/utils/database.js';
import { folderOf, isFolderPhoto } from 'src/utils/folder-albums.js';
import { LibraryScanStopReason, libraryPathsFingerprint } from 'src/utils/library-scan.js';
import { isNotLocked } from 'src/utils/locked.js';

/**
 * What removing a library would take with it (FL-78). Counts only: never a path, a name or an id of
 * anything inside it. Locked media is left out of every count an administrator sees (FL-34); the
 * removal still covers it, which the review says in general terms.
 */
export type LibraryRemovalCounts = {
  photos: number;
  videos: number;
  usage: number;
  offline: number;
  albums: number;
  sharedLinks: number;
  faces: number;
  /** Every item, Locked included. Only used to notice a change between review and removal. */
  all: number;
};

/** Size of each distinct original once: files shared between items count once (FL-78). */
const physicalUsage = (scope: RawBuilder<unknown>) =>
  sql<number>`(
    SELECT coalesce(sum("size"), 0)::bigint FROM (
      SELECT DISTINCT ON ("scoped"."originalPath") "scoped_exif"."fileSizeInByte" AS "size"
      FROM "asset" AS "scoped"
      LEFT JOIN "asset_exif" AS "scoped_exif" ON "scoped_exif"."assetId" = "scoped"."id"
      WHERE "scoped"."deletedAt" IS NULL AND ${isNotLocked('scoped')} AND ${scope}
    ) AS "distinct_originals"
  )`;

export enum AssetSyncResult {
  DO_NOTHING,
  UPDATE,
  OFFLINE,
  CHECK_OFFLINE,
}

@Injectable()
export class LibraryRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [DummyValue.UUID] })
  get(id: string, withDeleted = false) {
    return this.db
      .selectFrom('library')
      .selectAll('library')
      .where('library.id', '=', id)
      .$if(!withDeleted, (qb) => qb.where('library.deletedAt', 'is', null))
      .executeTakeFirst();
  }

  @GenerateSql({ params: [] })
  getAll(withDeleted = false) {
    return this.db
      .selectFrom('library')
      .selectAll('library')
      .orderBy('createdAt', 'asc')
      .$if(!withDeleted, (qb) => qb.where('library.deletedAt', 'is', null))
      .execute();
  }

  /** Items in each library, counted as its statistics' `total`: photos and videos, no hidden or Locked media. */
  async getAssetCounts(ids: string[]): Promise<Map<string, number>> {
    if (ids.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .selectFrom('asset')
      .select((eb) => ['asset.libraryId', eb.fn.countAll<number>().as('count')])
      .where(
        'asset.libraryId',
        'in',
        ids.map((id) => asUuid(id)),
      )
      .where('asset.deletedAt', 'is', null)
      .where('asset.type', 'in', [AssetType.Image, AssetType.Video])
      .where('asset.visibility', '!=', AssetVisibility.Hidden)
      .where(isNotLocked('asset'))
      .groupBy('asset.libraryId')
      .execute();
    return new Map(rows.map((row) => [row.libraryId!, Number(row.count)]));
  }

  @GenerateSql()
  getAllDeleted() {
    return this.db
      .selectFrom('library')
      .selectAll('library')
      .where('library.deletedAt', 'is not', null)
      .orderBy('createdAt', 'asc')
      .execute();
  }

  create(library: Insertable<LibraryTable>) {
    return this.db.insertInto('library').values(library).returningAll().executeTakeFirstOrThrow();
  }

  async delete(id: string) {
    await this.db.deleteFrom('library').where('library.id', '=', id).execute();
  }

  async softDelete(id: string) {
    await this.db.updateTable('library').set({ deletedAt: new Date() }).where('library.id', '=', id).execute();
  }

  update(id: string, library: Updateable<LibraryTable>) {
    return this.db
      .updateTable('library')
      .set(library)
      .where('library.id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getStatistics(id: string): Promise<LibraryStatsResponseDto | undefined> {
    const stats = await this.db
      .selectFrom('library')
      .innerJoin('asset', 'asset.libraryId', 'library.id')
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select((eb) =>
        eb.fn
          .countAll<number>()
          .filterWhere((eb) =>
            eb.and([
              eb('asset.type', '=', AssetType.Image),
              eb('asset.visibility', '!=', AssetVisibility.Hidden),
              // an administrator's library counts never include Locked media (FL-34)
              isNotLockedAsset(eb),
            ]),
          )
          .as('photos'),
      )
      .select((eb) =>
        eb.fn
          .countAll<number>()
          .filterWhere((eb) =>
            eb.and([
              eb('asset.type', '=', AssetType.Video),
              eb('asset.visibility', '!=', AssetVisibility.Hidden),
              isNotLockedAsset(eb),
            ]),
          )
          .as('videos'),
      )
      .select((eb) => eb.fn.coalesce((eb) => eb.fn.sum('asset_exif.fileSizeInByte'), eb.val(0)).as('usage'))
      .where('asset.deletedAt', 'is', null)
      .where(isNotLocked('asset'))
      .groupBy('library.id')
      .where('library.id', '=', id)
      .executeTakeFirst();

    // possibly a new library with 0 assets
    if (!stats) {
      const zero = sql<number>`0::int`;
      return this.db
        .selectFrom('library')
        .select(zero.as('photos'))
        .select(zero.as('videos'))
        .select(zero.as('usage'))
        .select(zero.as('usagePhysical'))
        .select(zero.as('total'))
        .where('library.id', '=', id)
        .executeTakeFirst();
    }

    const physical = await this.db
      .selectNoFrom(physicalUsage(sql`"scoped"."libraryId" = ${asUuid(id)}`).as('usagePhysical'))
      .executeTakeFirstOrThrow();

    return {
      photos: stats.photos,
      videos: stats.videos,
      usage: stats.usage,
      usagePhysical: Number(physical.usagePhysical),
      total: stats.photos + stats.videos,
    };
  }

  /**
   * Every active account's managed uploads (FL-78): the items and original sizes that live in
   * Frameleaf's own storage, as opposed to external folders. The same counting rules as a library's
   * statistics: no Locked or hidden media in the counts.
   */
  @GenerateSql()
  async getManagedUploadStatistics(): Promise<ManagedUploadsStatsResponseDto[]> {
    const rows = await this.db
      .selectFrom('user')
      .leftJoin('asset', (join) =>
        join
          .onRef('asset.ownerId', '=', 'user.id')
          .on('asset.libraryId', 'is', null)
          .on('asset.deletedAt', 'is', null)
          .on(isNotLocked('asset')),
      )
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select('user.id as ownerId')
      .select((eb) =>
        eb.fn
          .countAll<number>()
          .filterWhere((eb) =>
            eb.and([
              eb('asset.type', '=', AssetType.Image),
              eb('asset.visibility', '!=', AssetVisibility.Hidden),
              isNotLockedAsset(eb),
            ]),
          )
          .as('photos'),
      )
      .select((eb) =>
        eb.fn
          .countAll<number>()
          .filterWhere((eb) =>
            eb.and([
              eb('asset.type', '=', AssetType.Video),
              eb('asset.visibility', '!=', AssetVisibility.Hidden),
              isNotLockedAsset(eb),
            ]),
          )
          .as('videos'),
      )
      .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('asset_exif.fileSizeInByte'), eb.lit(0)).as('usage'))
      .select(physicalUsage(sql`"scoped"."libraryId" IS NULL AND "scoped"."ownerId" = "user"."id"`).as('usagePhysical'))
      // When the newest counted item was added, for "Last photo added …" (the prototype's uploads rows)
      .select((eb) =>
        eb.fn
          .max('asset.createdAt')
          .filterWhere((eb) =>
            eb.and([
              eb('asset.type', 'in', [AssetType.Image, AssetType.Video]),
              eb('asset.visibility', '!=', AssetVisibility.Hidden),
              isNotLockedAsset(eb),
            ]),
          )
          .as('lastAddedAt'),
      )
      .where('user.deletedAt', 'is', null)
      .where('user.status', '=', UserStatus.Active)
      .groupBy('user.id')
      .orderBy('user.createdAt', 'asc')
      .execute();

    return rows.map((row) => ({
      ownerId: row.ownerId,
      photos: Number(row.photos),
      videos: Number(row.videos),
      total: Number(row.photos) + Number(row.videos),
      usage: Number(row.usage),
      usagePhysical: Number(row.usagePhysical),
      lastAddedAt: row.lastAddedAt ? new Date(row.lastAddedAt) : null,
    }));
  }

  /** Fence scan mutations against cancellation, replacement claims and changed library settings. */
  async withScanClaim<T>(
    claim: { operationId: string; claimToken: string; libraryId: string; fingerprint: string; leaseMs?: number },
    mutate: (assets: AssetRepository, library: LibraryRepository) => Promise<T>,
    executor?: Transaction<DB>,
  ): Promise<{ value: T } | { stopReason: LibraryScanStopReason } | undefined> {
    const work = async (
      tx: Transaction<DB>,
    ): Promise<{ value: T } | { stopReason: LibraryScanStopReason } | undefined> => {
      const operation = await tx
        .selectFrom('media_operation')
        .select('id')
        .where('id', '=', claim.operationId)
        .where('claimToken', '=', claim.claimToken)
        .where('kind', '=', MediaOperationKind.LibraryScan)
        .where('status', '=', MediaOperationStatus.Rendering)
        .where('claimExpiresAt', '>', sql<Date>`clock_timestamp()`)
        .where('cancelRequestedAt', 'is', null)
        .where('pauseRequestedAt', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!operation) return;
      if (claim.leaseMs) {
        // FL-1590: the scan's keep-alive waits on this row lock, so a long batch renews the claim it holds itself.
        await tx
          .updateTable('media_operation')
          .set({
            // clock_timestamp(): now() is when this transaction began, before any wait for the lock
            heartbeatAt: sql<Date>`clock_timestamp()`,
            claimExpiresAt: sql<Date>`greatest("claimExpiresAt", clock_timestamp() + ${sql.lit(claim.leaseMs)} * interval '1 millisecond')`,
          })
          .where('id', '=', claim.operationId)
          .execute();
      }
      const library = await tx
        .selectFrom('library')
        .selectAll()
        .where('id', '=', claim.libraryId)
        .forShare()
        .executeTakeFirst();
      if (!library || library.deletedAt) return { stopReason: 'library_removed' };
      if (libraryPathsFingerprint(library) !== claim.fingerprint) return { stopReason: 'paths_changed' };
      const owner = await tx
        .selectFrom('user')
        .select(['id', 'deletedAt', 'status'])
        .where('id', '=', library.ownerId)
        .forShare()
        .executeTakeFirst();
      if (!owner || owner.deletedAt || owner.status !== UserStatus.Active) return { stopReason: 'owner_deleted' };
      return { value: await mutate(new AssetRepository(tx), new LibraryRepository(tx)) };
    };
    return executor ? work(executor) : this.db.transaction().execute(work);
  }

  /** One page of a library's item ids in id order, after `afterId` (FL-78 scan check phase). */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID, 1000] })
  getAssetIdPage(libraryId: string, afterId: string | null, take: number) {
    return this.db
      .selectFrom('asset')
      .select('asset.id')
      .where('asset.libraryId', '=', asUuid(libraryId))
      .$if(afterId !== null, (qb) => qb.where('asset.id', '>', asUuid(afterId!)))
      .orderBy('asset.id', 'asc')
      .limit(take)
      .execute();
  }

  /**
   * Items still online and not in the trash under one import folder (FL-78). A folder that turns
   * up empty while this is not zero is a folder that went away, not photos that were deleted.
   */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING] })
  async countOnlineAssetsUnder(libraryId: string, folder: string): Promise<number> {
    const prefix = folder === '/' ? '/' : `${folder}/`;
    const { count } = await this.db
      .selectFrom('asset')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('asset.libraryId', '=', asUuid(libraryId))
      .where('asset.isOffline', '=', false)
      .where('asset.deletedAt', 'is', null)
      .where(sql<boolean>`starts_with("asset"."originalPath", ${prefix})`)
      .executeTakeFirstOrThrow();
    return Number(count);
  }

  /** The consequences of removing a library, for the two-stage removal review (FL-78). */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getRemovalCounts(libraryId: string): Promise<LibraryRemovalCounts> {
    const id = asUuid(libraryId);
    const visible = this.db
      .selectFrom('asset')
      .select('asset.id')
      .where('asset.libraryId', '=', id)
      .where((eb) => isNotLockedAsset(eb));

    const row = await this.db
      .selectNoFrom((eb) => [
        eb
          .selectFrom('asset')
          .select((eb) =>
            eb.fn
              .countAll<number>()
              .filterWhere((eb) =>
                eb.and([
                  eb('asset.type', '=', AssetType.Image),
                  eb('asset.visibility', '!=', AssetVisibility.Hidden),
                  isNotLockedAsset(eb),
                ]),
              )
              .as('count'),
          )
          .where('asset.libraryId', '=', id)
          .as('photos'),
        eb
          .selectFrom('asset')
          .select((eb) =>
            eb.fn
              .countAll<number>()
              .filterWhere((eb) =>
                eb.and([
                  eb('asset.type', '=', AssetType.Video),
                  eb('asset.visibility', '!=', AssetVisibility.Hidden),
                  isNotLockedAsset(eb),
                ]),
              )
              .as('count'),
          )
          .where('asset.libraryId', '=', id)
          .as('videos'),
        eb
          .selectFrom('asset')
          .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
          .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('asset_exif.fileSizeInByte'), eb.lit(0)).as('usage'))
          .where('asset.libraryId', '=', id)
          .where((eb) => isNotLockedAsset(eb))
          .as('usage'),
        eb
          .selectFrom('asset')
          .select((eb) => eb.fn.countAll<number>().as('count'))
          .where('asset.libraryId', '=', id)
          .where('asset.isOffline', '=', true)
          .where((eb) => isNotLockedAsset(eb))
          .as('offline'),
        eb
          .selectFrom('album_asset')
          .select((eb) => eb.fn.count<number>('album_asset.albumId').distinct().as('count'))
          .where('album_asset.assetId', 'in', visible)
          .as('albums'),
        eb
          .selectFrom('shared_link_asset')
          .select((eb) => eb.fn.count<number>('shared_link_asset.sharedLinkId').distinct().as('count'))
          .where('shared_link_asset.assetId', 'in', visible)
          .as('sharedLinks'),
        eb
          .selectFrom('asset_face')
          .select((eb) => eb.fn.countAll<number>().as('count'))
          .where('asset_face.assetId', 'in', visible)
          .where('asset_face.deletedAt', 'is', null)
          .as('faces'),
        eb
          .selectFrom('asset')
          .select((eb) => eb.fn.countAll<number>().as('count'))
          .where('asset.libraryId', '=', id)
          .as('all'),
      ])
      .executeTakeFirstOrThrow();

    return {
      photos: Number(row.photos ?? 0),
      videos: Number(row.videos ?? 0),
      usage: Number(row.usage ?? 0),
      offline: Number(row.offline ?? 0),
      albums: Number(row.albums ?? 0),
      sharedLinks: Number(row.sharedLinks ?? 0),
      faces: Number(row.faces ?? 0),
      all: Number(row.all ?? 0),
    };
  }

  streamAssetIds(libraryId: string) {
    return this.db.selectFrom('asset').select(['id']).where('libraryId', '=', libraryId).stream();
  }

  /* FL-838: folder albums ------------------------------------------------ */

  /**
   * Each folder holding items, with how many photos and videos a folder album shows directly in it and how many items
   * it holds that are online and neither Locked nor trashed (FL-1837: a folder whose items are none of them shown is "empty").
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getFolderPhotoCounts(libraryId: string): Promise<{ folderPath: string; photos: number; items: number }[]> {
    const { rows } = await sql<{ folderPath: string; photos: string; items: string }>`
      SELECT ${folderOf('asset')} AS "folderPath", count(*) FILTER (WHERE ${isFolderPhoto('asset')}) AS photos,
        count(*) AS items
      FROM asset
      WHERE asset."libraryId" = ${asUuid(libraryId)} AND asset."isOffline" = false AND asset."deletedAt" IS NULL
        AND ${isNotLocked('asset')}
      GROUP BY 1`.execute(this.db);
    return rows.map((row) => ({ folderPath: row.folderPath, photos: Number(row.photos), items: Number(row.items) }));
  }

  /** FL-1837: every folder the library has items in, offline and trashed ones too (not Locked ones). */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getFolderPaths(libraryId: string): Promise<string[]> {
    const { rows } = await sql<{ folderPath: string }>`
      SELECT DISTINCT ${folderOf('asset')} AS "folderPath"
      FROM asset
      WHERE asset."libraryId" = ${asUuid(libraryId)} AND ${isNotLocked('asset')}`.execute(this.db);
    return rows.map(({ folderPath }) => folderPath);
  }

  /** FL-1837: how many folder albums a library has, and how many of them show nothing. */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getFolderAlbumCounts(libraryId: string): Promise<{ albums: number; empty: number }> {
    const { rows } = await sql<{ albums: string; empty: string }>`
      SELECT count(*) AS albums,
        count(*) FILTER (WHERE album.kind = ${sql.lit(AlbumKind.Album)} AND NOT EXISTS (
          SELECT 1 FROM album_asset member JOIN asset ON asset.id = member."assetId"
          WHERE member."albumId" = album.id AND asset."deletedAt" IS NULL
        )) AS empty
      FROM library_folder_album link
      JOIN album ON album.id = link."albumId" AND album."deletedAt" IS NULL
      WHERE link."libraryId" = ${asUuid(libraryId)}`.execute(this.db);
    return { albums: Number(rows[0]?.albums ?? 0), empty: Number(rows[0]?.empty ?? 0) };
  }

  /** FL-1837: albums made so far stay as they are (`kept`) or follow the library's rules again. */
  @GenerateSql({ params: [DummyValue.UUID, true] })
  async setFolderAlbumsKept(libraryId: string, kept: boolean): Promise<void> {
    await this.db
      .updateTable('library_folder_album')
      .set({ isKept: kept })
      .where('libraryId', '=', asUuid(libraryId))
      .execute();
  }

  /** The library's folder albums, with the album's name, place and kind as they are now. */
  @GenerateSql({ params: [DummyValue.UUID] })
  getFolderAlbums(libraryId: string) {
    return this.db
      .selectFrom('library_folder_album')
      .innerJoin('album', 'album.id', 'library_folder_album.albumId')
      .select([
        'library_folder_album.id',
        'library_folder_album.libraryId',
        'library_folder_album.folderPath',
        'library_folder_album.albumId',
        'library_folder_album.isUserEdited',
        'library_folder_album.isKept',
        'album.albumName',
        'album.parentId',
        'album.kind',
        'album.deletedAt',
      ])
      .where('library_folder_album.libraryId', '=', asUuid(libraryId))
      .orderBy('library_folder_album.folderPath')
      .execute();
  }

  createFolderAlbum(value: Insertable<LibraryFolderAlbumTable>) {
    return this.db.insertInto('library_folder_album').values(value).returningAll().executeTakeFirstOrThrow();
  }

  async updateFolderAlbum(id: string, value: Updateable<LibraryFolderAlbumTable>): Promise<void> {
    await this.db.updateTable('library_folder_album').set(value).where('id', '=', id).execute();
  }

  async deleteFolderAlbum(id: string): Promise<void> {
    await this.db.deleteFrom('library_folder_album').where('id', '=', id).execute();
  }

  /** Forget every folder album of the library; the albums themselves are left as they are. */
  @GenerateSql({ params: [DummyValue.UUID] })
  async deleteFolderAlbums(libraryId: string): Promise<{ albumId: string; folderPath: string }[]> {
    return this.db
      .deleteFrom('library_folder_album')
      .where('libraryId', '=', asUuid(libraryId))
      .returning(['albumId', 'folderPath'])
      .execute();
  }

  /**
   * What tells a moved folder's files apart: name and modification time, which a folder rename keeps while the
   * files' items are made anew. `goneFolders` are read with every item they ever held (offline ones included);
   * `newFolders` with the photos a folder album would show.
   */
  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.STRING], [DummyValue.STRING]] })
  async getFolderFileKeys(
    libraryId: string,
    goneFolders: string[],
    newFolders: string[],
  ): Promise<{ folderPath: string; originalFileName: string; fileModifiedAt: Date; gone: boolean }[]> {
    if (goneFolders.length === 0 || newFolders.length === 0) {
      return [];
    }
    const { rows } = await sql<{ folderPath: string; originalFileName: string; fileModifiedAt: Date; gone: boolean }>`
      SELECT folder.path AS "folderPath", asset."originalFileName", asset."fileModifiedAt", folder.gone
      FROM asset
      JOIN (
        SELECT unnest(${goneFolders}::text[]) AS path, true AS gone
        UNION ALL
        SELECT unnest(${newFolders}::text[]) AS path, false AS gone
      ) folder ON folder.path = ${folderOf('asset')}
      WHERE asset."libraryId" = ${asUuid(libraryId)} AND (folder.gone OR ${isFolderPhoto('asset')})`.execute(this.db);
    return rows;
  }

  /**
   * The folder albums holding something that is not one of their folder's own items: a photo the owner put in
   * by hand. `folders` may name more than one folder for an album (its folder before and after a rename).
   */
  @GenerateSql({ params: [DummyValue.UUID, [{ folderPath: DummyValue.STRING, albumId: DummyValue.UUID }]] })
  async getFolderAlbumsWithOtherItems(
    libraryId: string,
    folders: { folderPath: string; albumId: string }[],
  ): Promise<Set<string>> {
    if (folders.length === 0) {
      return new Set();
    }
    const albumIds = [...new Set(folders.map(({ albumId }) => albumId))];
    const { rows } = await sql<{ albumId: string }>`
      SELECT DISTINCT member."albumId"
      FROM album_asset member
      JOIN asset ON asset.id = member."assetId"
      WHERE member."albumId" = ANY(${albumIds}::uuid[])
        AND NOT (
          asset."libraryId" IS NOT DISTINCT FROM ${asUuid(libraryId)}
          AND EXISTS (
            SELECT 1
            FROM unnest(${folders.map(({ folderPath }) => folderPath)}::text[], ${folders.map(({ albumId }) => albumId)}::uuid[])
              AS folder(path, "albumId")
            WHERE folder."albumId" = member."albumId" AND folder.path = ${folderOf('asset')}
          )
        )`.execute(this.db);
    return new Set(rows.map(({ albumId }) => albumId));
  }
}
