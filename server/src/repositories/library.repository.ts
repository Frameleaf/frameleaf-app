import { Injectable } from '@nestjs/common';
import { type Insertable, type Kysely, type RawBuilder, type Updateable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { LibraryStatsResponseDto, ManagedUploadsStatsResponseDto } from 'src/dtos/library.dto.js';
import { AssetType, AssetVisibility, MediaOperationKind, MediaOperationStatus, UserStatus } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DB } from 'src/schema/index.js';
import { LibraryTable } from 'src/schema/tables/library.table.js';
import { asUuid, isNotLockedAsset } from 'src/utils/database.js';
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
    }));
  }

  /** Fence scan mutations against cancellation, replacement claims and changed library settings. */
  async withScanClaim<T>(
    claim: { operationId: string; claimToken: string; libraryId: string; fingerprint: string },
    mutate: (assets: AssetRepository, library: LibraryRepository) => Promise<T>,
  ): Promise<{ value: T } | { stopReason: LibraryScanStopReason } | undefined> {
    return this.db.transaction().execute(async (tx) => {
      const operation = await tx
        .selectFrom('media_operation')
        .select('id')
        .where('id', '=', claim.operationId)
        .where('claimToken', '=', claim.claimToken)
        .where('kind', '=', MediaOperationKind.LibraryScan)
        .where('status', '=', MediaOperationStatus.Rendering)
        .where('claimExpiresAt', '>', sql<Date>`now()`)
        .where('cancelRequestedAt', 'is', null)
        .where('pauseRequestedAt', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!operation) return;
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
    });
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
}
