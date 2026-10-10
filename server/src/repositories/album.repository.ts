import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import {
  ExpressionBuilder,
  Kysely,
  NotNull,
  Selectable,
  ShallowDehydrateObject,
  Transaction,
  Updateable,
  sql,
} from 'kysely';
import { jsonArrayFrom, jsonObjectFrom } from 'kysely/helpers/postgres';
import { InjectKysely } from 'nestjs-kysely';
import type { Insertable } from 'kysely';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import type { LockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import { columns } from 'src/database.js';
import { Chunked, ChunkedArray, ChunkedSet, DummyValue, GenerateSql } from 'src/decorators.js';
import { AlbumUserCreateDto, MapAlbumDto } from 'src/dtos/album.dto.js';
import { AlbumUserRole } from 'src/enum.js';
import { publicationDatabase } from 'src/queue/transaction.js';
import { SmartAlbumRepository } from 'src/repositories/smart-album.repository.js';
import { DB } from 'src/schema/index.js';
import { AlbumTable } from 'src/schema/tables/album.table.js';
import { AssetExifTable } from 'src/schema/tables/asset-exif.table.js';
import { albumCoverCandidates } from 'src/utils/album-cover.js';
import { albumCoverReplacement, albumNewestCover, getBestPhotoScoreTable } from 'src/utils/cover-references.js';
import {
  anyUuid,
  asUuid,
  dummy,
  withAlbumVisibility,
  withDefaultVisibility,
  withHiddenContentFilter,
} from 'src/utils/database.js';
import { isNotLocked, notLockedOrOwnedBy } from 'src/utils/locked.js';

export interface AlbumAssetCount {
  albumId: string;
  assetCount: number;
  thumbnailAssetId?: string | null;
  startDate: Date | null;
  endDate: Date | null;
  lastModifiedAssetTimestamp: Date | null;
}
/**
 * Privacy options for an album read: the hidden-content (sensitive) filter and, for an elevated
 * session, the viewer as `lockedOwnerId` so their own Locked media is included. See `withAlbumVisibility`.
 */
export type AlbumReadOptions = HiddenContentQueryOptions & LockedVisibilityOptions;
export interface AlbumInfoOptions extends AlbumReadOptions {
  withAssets: boolean;
}
const withAlbumUsers = (authUserId?: string) => (eb: ExpressionBuilder<DB, 'album'>) =>
  jsonArrayFrom(
    eb
      .selectFrom('album_user')
      .innerJoin('user', 'user.id', 'album_user.userId')
      .whereRef('album_user.albumId', '=', 'album.id')
      .select('album_user.role')
      .select((eb) => jsonObjectFrom(eb.selectFrom(dummy).select(columns.user)).$notNull().as('user'))
      .orderBy('album_user.role')
      .$if(!!authUserId, (qb) => qb.orderBy((eb) => eb('album_user.userId', '=', authUserId!), 'desc'))
      .orderBy('user.name', 'asc'),
  )
    .$notNull()
    .as('albumUsers');
const withSharedLink = (eb: ExpressionBuilder<DB, 'album'>) =>
  jsonArrayFrom(
    eb.selectFrom('shared_link').selectAll('shared_link').whereRef('shared_link.albumId', '=', 'album.id'),
  ).as('sharedLinks');
const withAssets = (options: AlbumInfoOptions) => (eb: ExpressionBuilder<DB, 'album'>) => {
  return eb
    .selectFrom((eb) =>
      eb
        .selectFrom('asset')
        .selectAll('asset')
        .leftJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
        .select((eb) =>
          eb.table('asset_exif').$castTo<ShallowDehydrateObject<Selectable<AssetExifTable>>>().as('exifInfo'),
        )
        .innerJoin('album_asset', 'album_asset.assetId', 'asset.id')
        .whereRef('album_asset.albumId', '=', 'album.id')
        .where('asset.deletedAt', 'is', null)
        .$call((qb) => withAlbumVisibility(qb, options.lockedOwnerId))
        .$call((qb) => withHiddenContentFilter(qb, options))
        .orderBy('asset.fileCreatedAt', 'desc')
        .as('asset'),
    )
    .select((eb) => eb.fn.jsonAgg('asset').as('assets'))
    .as('assets');
};
const isAlbumOwned = (ownerId: string) => (eb: ExpressionBuilder<DB, 'album'>) =>
  eb.exists(
    eb
      .selectFrom('album_user')
      .whereRef('album_user.albumId', '=', 'album.id')
      .where('album_user.role', '=', AlbumUserRole.Owner)
      .where('album_user.userId', '=', ownerId),
  );
/** One album as a person's directory sees it, for checking a custom order (FL-52). */
export type DirectoryItem = {
  id: string;
  kind: string;
  parentId: string | null;
};
@Injectable()
export class AlbumRepository {
  private readonly smartAlbums: SmartAlbumRepository;
  constructor(
    @InjectKysely()
    private db: Kysely<DB>,
  ) {
    this.db = publicationDatabase(this.db);
    this.smartAlbums = new SmartAlbumRepository(this.db);
  }

  /** Serialize album membership decisions with source sync, while preserving transaction ownership. */
  async withMembershipWrite<T>(
    albumIds: string[],
    write: (tx: Kysely<DB>, album: AlbumRepository) => Promise<T>,
  ): Promise<T> {
    const execute = async (tx: Kysely<DB>) => {
      if (albumIds.length > 0) {
        await tx
          .selectFrom('album')
          .select('id')
          .where('id', 'in', [...new Set(albumIds)].toSorted())
          .orderBy('id')
          .forNoKeyUpdate()
          .execute();
      }
      return write(tx, new AlbumRepository(tx));
    };
    return this.db.isTransaction ? execute(this.db) : this.db.transaction().execute(execute);
  }

  @GenerateSql({ params: [DummyValue.UUID, { withAssets: true }, DummyValue.UUID] })
  async getById(id: string, options: AlbumInfoOptions, authUserId?: string) {
    const row = await this.db
      .with('album_user', (qb) => qb.selectFrom('album_user').selectAll().where('album_user.albumId', '=', id))
      .selectFrom('album')
      .selectAll('album')
      .where('album.id', '=', id)
      .where('album.deletedAt', 'is', null)
      .select(withAlbumUsers(authUserId))
      .select(withSharedLink)
      .$if(options.withAssets, (eb) => eb.select(withAssets(options)))
      .$narrowType<{
        assets: NotNull;
      }>()
      .executeTakeFirst();
    if (!row) {
      return;
    }
    return row;
  }
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID, { excludeNsfw: true }] })
  async getByAssetId(ownerId: string, assetId: string, options: HiddenContentQueryOptions = {}) {
    const rows = await this.db
      .selectFrom('album')
      .selectAll('album')
      .innerJoin('album_asset', 'album_asset.albumId', 'album.id')
      .$call((qb) =>
        qb.innerJoin('asset', 'asset.id', 'album_asset.assetId').$call((qb) => withHiddenContentFilter(qb, options)),
      )
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('album_user')
            .whereRef('album_user.albumId', '=', 'album.id')
            .where('album_user.userId', '=', ownerId),
        ),
      )
      .where('album_asset.assetId', '=', assetId)
      .where('album.deletedAt', 'is', null)
      .select(withAlbumUsers(ownerId))
      .orderBy('album.createdAt', 'desc')
      .execute();
    return rows;
  }
  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  @ChunkedSet({ paramIndex: 1 })
  async getByAssetIds(ownerId: string, assetIds: string[]): Promise<Map<string, string[]>> {
    if (assetIds.length === 0) {
      return new Map();
    }
    const results = await this.db
      .selectFrom('album')
      .select('album.id')
      .innerJoin('album_asset', 'album_asset.albumId', 'album.id')
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('album_user')
            .whereRef('album_user.albumId', '=', 'album.id')
            .where('album_user.userId', '=', ownerId),
        ),
      )
      .where('album_asset.assetId', 'in', assetIds)
      .where('album.deletedAt', 'is', null)
      .select('album_asset.assetId')
      .execute();
    // Group by assetId
    const map = new Map<string, string[]>();
    for (const row of results) {
      const existing = map.get(row.assetId) ?? [];
      existing.push(row.id);
      map.set(row.assetId, existing);
    }
    return map;
  }
  @GenerateSql({ params: [[DummyValue.UUID]] })
  @ChunkedArray()
  async getMetadataForIds(ids: string[], options: AlbumReadOptions = {}): Promise<AlbumAssetCount[]> {
    // Guard against running invalid query when ids list is empty.
    if (ids.length === 0) {
      return [];
    }
    return (
      this.db
        .selectFrom('asset')
        .$call((qb) => withAlbumVisibility(qb, options.lockedOwnerId))
        .$call((qb) => withHiddenContentFilter(qb, options))
        .innerJoin('album_asset', 'album_asset.assetId', 'asset.id')
        .select('album_asset.albumId as albumId')
        .select((eb) => eb.fn.min(sql<Date>`("asset"."localDateTime" AT TIME ZONE 'UTC'::text)::date`).as('startDate'))
        .select((eb) => eb.fn.max(sql<Date>`("asset"."localDateTime" AT TIME ZONE 'UTC'::text)::date`).as('endDate'))
        // lastModifiedAssetTimestamp is only used in mobile app, please remove if not need
        .select((eb) => eb.fn.max('asset.updatedAt').as('lastModifiedAssetTimestamp'))
        .select(
          sql<string | null>`(array_agg("asset"."id" order by "asset"."fileCreatedAt" desc))[1]`.as('thumbnailAssetId'),
        )
        .select((eb) => sql<number>`${eb.fn.count('asset.id')}::int`.as('assetCount'))
        .where('album_asset.albumId', 'in', ids)
        .where('asset.deletedAt', 'is', null)
        .groupBy('album_asset.albumId')
        .execute()
    );
  }
  /**
   * FL-349: the few items a shared space shows someone invited to it, newest first. Only Timeline and
   * Archive media that is not Locked (so never hidden motion parts), never trashed, and never media
   * marked sensitive, whoever owns it: the same reading as the preview counts.
   */
  async getSpacePreviewAssetIds(albumId: string, limit: number): Promise<string[]> {
    const rows = await this.db
      .selectFrom('asset')
      .$call((qb) => withDefaultVisibility(qb))
      .$call((qb) => withHiddenContentFilter(qb, { excludeNsfw: true }))
      .innerJoin('album_asset', 'album_asset.assetId', 'asset.id')
      .select('asset.id')
      .where('album_asset.albumId', '=', albumId)
      .where('asset.deletedAt', 'is', null)
      .orderBy('asset.fileCreatedAt', 'desc')
      .orderBy('asset.id', 'asc')
      .limit(limit)
      .execute();
    return rows.map(({ id }) => id);
  }
  private buildAlbumBaseQuery(
    ownerId: string,
    {
      isOwned,
      isShared,
    }: {
      isOwned?: boolean;
      isShared?: boolean;
    },
  ) {
    return this.db
      .selectFrom('album')
      .innerJoin('album_user', (join) =>
        join.onRef('album_user.albumId', '=', 'album.id').on('album_user.userId', '=', ownerId),
      )
      .where('album.deletedAt', 'is', null)
      .$if(isOwned === true, (qb) => qb.where('album_user.role', '=', sql.lit(AlbumUserRole.Owner)))
      .$if(isOwned === false, (qb) => qb.where('album_user.role', '!=', sql.lit(AlbumUserRole.Owner)))
      .$if(isShared !== undefined, (qb) =>
        qb.where((eb) => {
          const isSharedAlbum = eb.or([
            eb.exists(
              eb
                .selectFrom('album_user as au')
                .whereRef('au.albumId', '=', 'album.id')
                .where('au.role', '!=', sql.lit(AlbumUserRole.Owner)),
            ),
            eb.exists(eb.selectFrom('shared_link').whereRef('shared_link.albumId', '=', 'album.id')),
          ]);
          return isShared ? isSharedAlbum : eb.not(isSharedAlbum);
        }),
      );
  }
  @GenerateSql({ params: [DummyValue.UUID, { isOwned: true, isShared: true }] })
  async getAll(
    ownerId: string,
    options: {
      id?: string;
      isOwned?: boolean;
      isShared?: boolean;
      name?: string;
    } = {},
  ): Promise<MapAlbumDto[]> {
    const rows = await this.buildAlbumBaseQuery(ownerId, options)
      .selectAll('album')
      .select(withAlbumUsers(ownerId))
      .select(withSharedLink)
      .$if(!!options.id, (qb) => qb.where('album.id', '=', options.id!))
      .$if(!!options.name, (qb) => qb.where('album.albumName', '=', options.name!))
      .orderBy('album.sortOrder', sql`asc nulls last`)
      .orderBy('album.createdAt', 'desc')
      .execute();
    const albums = rows;
    return albums.sort((left, right) => {
      if (left.sortOrder === null && right.sortOrder !== null) {
        return 1;
      }
      if (left.sortOrder !== null && right.sortOrder === null) {
        return -1;
      }
      return (left.sortOrder ?? 0) - (right.sortOrder ?? 0) || right.createdAt.getTime() - left.createdAt.getTime();
    });
  }
  @GenerateSql({ params: [DummyValue.UUID, { isOwned: true, isShared: true }] })
  async getAllIds(
    ownerId: string,
    options: {
      isOwned?: boolean;
      isShared?: boolean;
    } = {},
  ): Promise<string[]> {
    const rows = await this.buildAlbumBaseQuery(ownerId, options)
      .select('album.id')
      .orderBy('album.createdAt', 'desc')
      .execute();
    return rows.map((r) => r.id);
  }
  async restoreAll(userId: string): Promise<void> {
    await this.db.updateTable('album').set({ deletedAt: null }).where(isAlbumOwned(userId)).execute();
  }
  async softDeleteAll(userId: string): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      // Match derivative publication's album order before the bulk update acquires any row locks.
      const albums = await tx
        .selectFrom('album')
        .select('id')
        .where(isAlbumOwned(userId))
        .orderBy('id')
        .forNoKeyUpdate()
        .execute();
      await tx
        .updateTable('album')
        .set({ deletedAt: new Date() })
        .where('id', '=', anyUuid(albums.map(({ id }) => id)))
        .execute();
    });
  }
  async deleteAll(userId: string): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const albums = await tx.selectFrom('album').select('id').where(isAlbumOwned(userId)).execute();
      await this.smartAlbums.deleteAlbums(
        albums.map(({ id }) => id),
        tx,
      );
      await this.smartAlbums.deleteOwner(userId, tx);
      await this.deletePositions({ albumIds: albums.map(({ id }) => id), userId }, tx);
      await this.deleteCoverFollowsNewest(
        albums.map(({ id }) => id),
        tx,
      );
      await tx.deleteFrom('album').where(isAlbumOwned(userId)).execute();
    });
  }
  @GenerateSql({ params: [[DummyValue.UUID]] })
  @Chunked()
  async removeAssetsFromAll(assetIds: string[]): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }
    const execute = async (tx: Kysely<DB>) => {
      const albums = await tx.selectFrom('album_asset').select('albumId').where('assetId', 'in', assetIds).execute();
      const repository = new AlbumRepository(tx);
      await repository.withMembershipWrite(
        albums.map(({ albumId }) => albumId),
        async () => {
          const removed = await tx
            .deleteFrom('album_asset')
            .where('assetId', 'in', assetIds)
            .returning(['albumId', 'assetId'])
            .execute();
          await repository.invalidateSourceMemberships(removed);
        },
      );
    };
    await (this.db.isTransaction ? execute(this.db) : this.db.transaction().execute(execute));
  }
  @Chunked({ paramIndex: 1 })
  async removeAssetIds(albumId: string, assetIds: string[]): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }

    await this.withMembershipWrite([albumId], async (tx) => {
      const removed = await tx
        .deleteFrom('album_asset')
        .where('albumId', '=', albumId)
        .where('assetId', 'in', assetIds)
        .returning('assetId')
        .execute();
      await new AlbumRepository(tx).invalidateSourceMemberships(removed.map(({ assetId }) => ({ albumId, assetId })));
    });
  }

  /** Only actual removals end source ownership. A future manual re-add is a new membership. */
  private async invalidateSourceMemberships(removed: { albumId: string; assetId: string }[]): Promise<void> {
    if (removed.length === 0) {
      return;
    }
    await sql`DELETE FROM public.album_source_asset provenance
      USING public.album_source_link link,
        unnest(${removed.map(({ albumId }) => albumId)}::uuid[], ${removed.map(({ assetId }) => assetId)}::uuid[])
          AS removed("albumId", "assetId")
      WHERE provenance."linkId" = link.id AND link."albumId" = removed."albumId"
        AND provenance."assetId" = removed."assetId"`.execute(this.db);
  }
  /**
   * Get asset IDs for the given album ID.
   *
   * @param albumId Album ID to get asset IDs for.
   * @param assetIds Optional list of asset IDs to filter on.
   * @returns Set of Asset IDs for the given album ID.
   */
  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  @ChunkedSet({ paramIndex: 1 })
  async getAssetIds(albumId: string, assetIds: string[]): Promise<Set<string>> {
    if (assetIds.length === 0) {
      return new Set();
    }
    return this.db
      .selectFrom('album_asset')
      .selectAll()
      .where('album_asset.albumId', '=', albumId)
      .where('album_asset.assetId', 'in', assetIds)
      .execute()
      .then((results) => new Set(results.map(({ assetId }) => assetId)));
  }
  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  async addAssetIds(albumId: string, assetIds: string[]): Promise<void> {
    await this.addAssetIdsReturning(albumId, assetIds);
  }

  /** Return only memberships this insertion actually created, including their exact generations. */
  async addAssetIdsReturning(albumId: string, assetIds: string[]): Promise<{ assetId: string; updateId: string }[]> {
    if (assetIds.length === 0) {
      return [];
    }

    return this.withMembershipWrite([albumId], async (tx) =>
      tx
        .insertInto('album_asset')
        .expression((eb) =>
          eb.selectFrom(dummy).select([asUuid(albumId).as('albumId'), sql`unnest(${assetIds}::uuid[])`.as('assetId')]),
        )
        .onConflict((oc) => oc.doNothing())
        .returning(['assetId', 'updateId'])
        .execute(),
    );
  }
  @GenerateSql({
    params: [
      { albumName: DummyValue.STRING },
      [],
      [{ userId: DummyValue.UUID, role: AlbumUserRole.Owner }, DummyValue.UUID],
    ],
  })
  async create(
    album: Insertable<AlbumTable>,
    assetIds: string[],
    albumUsers: AlbumUserCreateDto[],
    authUserId: string,
  ) {
    if (albumUsers.every((u) => u.role !== AlbumUserRole.Owner)) {
      throw new Error('Album must have an owner');
    }
    const userIds = albumUsers.map((u) => u.userId);
    const roles = albumUsers.map((u) => u.role);
    const execute = async (tx: Kysely<DB>) => {
      const result = await tx
        .with('album', (db) => db.insertInto('album').values(album).returningAll())
        .with('album_user', (db) =>
          db
            .insertInto('album_user')
            .expression((eb) =>
              eb
                .selectFrom('album')
                .select(({ ref }) => [
                  ref('album.id').as('albumId'),
                  sql`unnest(${userIds}::uuid[])`.as('userId'),
                  sql`unnest(array[${sql.join(roles)}]::album_user_role_enum[])`.as('role'),
                ]),
            )
            .returning(['album_user.albumId', 'album_user.userId', 'album_user.role']),
        )
        .with('album_asset', (db) =>
          db
            .insertInto('album_asset')
            .expression((eb) =>
              eb
                .selectFrom('album')
                .select(({ ref }) => [ref('album.id').as('albumId'), sql`unnest(${assetIds}::uuid[])`.as('assetId')]),
            )
            .onConflict((oc) => oc.doNothing())
            .returning(['album_asset.albumId', 'album_asset.assetId']),
        )
        .selectFrom('album')
        .selectAll('album')
        .select(withAlbumUsers(authUserId))
        .select(withAssets({ withAssets: true }))
        .$narrowType<{
          assets: NotNull;
        }>()
        .executeTakeFirstOrThrow();
      // Closure table: every album is its own ancestor.
      await tx.insertInto('album_closure').values({ id_ancestor: result.id, id_descendant: result.id }).execute();
      // If parented, copy every ancestor of the parent to be an ancestor of this new node.
      if (result.parentId) {
        const newId = result.id;
        await tx
          .insertInto('album_closure')
          .columns(['id_ancestor', 'id_descendant'])
          .expression(
            tx
              .selectFrom('album_closure')
              .where('id_descendant', '=', result.parentId)
              .select(['id_ancestor', sql<string>`${newId}::uuid`.as('id_descendant')]),
          )
          .execute();
      }
      return result;
    };
    return this.db.isTransaction ? execute(this.db) : this.db.transaction().execute(execute);
  }
  update(id: string, album: Updateable<AlbumTable>, authUserId: string) {
    return this.db.transaction().execute(async (tx) => {
      const result = await tx
        .updateTable('album')
        .set(album)
        .where('album.id', '=', id)
        .returningAll('album')
        .returning(withSharedLink)
        .returning(withAlbumUsers(authUserId))
        .executeTakeFirstOrThrow();
      return result;
    });
  }

  /** Caller holds the album row fence; a source name can only replace the last followed name. */
  async updateSourceName(id: string, expectedName: string, albumName: string): Promise<boolean> {
    const result = await this.db
      .updateTable('album')
      .set({ albumName })
      .where('id', '=', id)
      .where('albumName', '=', expectedName)
      .where('deletedAt', 'is', null)
      .returning('id')
      .executeTakeFirst();
    return !!result;
  }

  async delete(id: string): Promise<void> {
    await this.db.transaction().execute((tx) => this.deleteIn(tx, id));
  }
  /**
   * FL-146: delete a collection and keep its albums, which move to the collection's own parent (the
   * top level when it has none), as the prototype does. One transaction: a collection whose delete fails
   * keeps every album, and no album is left pointing at a collection that is gone.
   */
  async deleteCollection(id: string): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const collection = await tx
        .selectFrom('album')
        .select('parentId')
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!collection) {
        return;
      }
      const children = await tx.selectFrom('album').select('id').where('parentId', '=', id).forUpdate().execute();
      for (const child of children) {
        await this.reparentIn(tx, child.id, collection.parentId);
      }
      await this.deleteIn(tx, id);
    });
  }
  private async deleteIn(tx: Transaction<DB>, id: string): Promise<void> {
    const _subtree = await tx
      .selectFrom('album_closure')
      .select('id_descendant')
      .where('id_ancestor', '=', id)
      .execute();
    const subtreeIds = _subtree.length > 0 ? _subtree.map(({ id_descendant }) => id_descendant) : [id];
    await this.smartAlbums.deleteAlbums(subtreeIds, tx);
    await this.deletePositions({ albumIds: subtreeIds }, tx);
    await this.deleteCoverFollowsNewest(subtreeIds, tx);
    await tx.deleteFrom('album').where('id', '=', id).execute();
  }
  /**
   * FL-52: forget custom-order rows for deleted albums, or for a deleted person. Cleanup never
   * blocks the delete itself: while the fork schema is not writable (a handoff runs) the rows are
   * left, and reading the order ignores albums nobody can see any more.
   */
  private async deletePositions(
    {
      albumIds = [],
      userId,
    }: {
      albumIds?: string[];
      userId?: string;
    },
    tx: Transaction<DB>,
  ): Promise<void> {
    if (albumIds.length === 0 && !userId) {
      return;
    }
    await sql`
      DELETE FROM public.album_position
      WHERE "albumId" = ANY(${albumIds}::uuid[]) OR "userId" = ${userId ?? null}::uuid
    `.execute(tx);
  }
  /**
   * FL-83: forget "cover follows the newest item" for deleted albums. Like `deletePositions`, cleanup
   * never blocks the delete; a row whose album is gone is never read.
   */
  private async deleteCoverFollowsNewest(albumIds: string[], tx: Transaction<DB>): Promise<void> {
    if (albumIds.length === 0) {
      return;
    }
    await sql`
      DELETE FROM public.album_cover_follows_newest WHERE "albumId" = ANY(${albumIds}::uuid[])
    `.execute(tx);
  }
  @GenerateSql({ params: [DummyValue.UUID] })
  async getDescendantIds(id: string): Promise<Set<string>> {
    const rows = await this.db
      .selectFrom('album_closure')
      .select('id_descendant')
      .where('id_ancestor', '=', id)
      .where('id_descendant', '!=', id)
      .execute();
    return new Set(rows.map((r) => r.id_descendant));
  }
  /** Direct children only (albums whose parent is `id`), in display order. */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getChildIds(id: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('album')
      .select('id')
      .where('parentId', '=', id)
      .where('deletedAt', 'is', null)
      .orderBy('sortOrder', sql`asc nulls last`)
      .orderBy('createdAt', 'desc')
      .execute();
    return rows.map((row) => row.id);
  }
  @GenerateSql({ params: [DummyValue.UUID] })
  async getAncestorIds(id: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('album_closure')
      .select('id_ancestor')
      .where('id_descendant', '=', id)
      .where('id_ancestor', '!=', id)
      .execute();
    return rows.map((r) => r.id_ancestor);
  }
  @GenerateSql({ params: [DummyValue.UUID] })
  async getDescendantCount(id: string): Promise<number> {
    const row = await this.db
      .selectFrom('album_closure')
      .select((eb) => sql<number>`${eb.fn.count('id_descendant')}::int`.as('count'))
      .where('id_ancestor', '=', id)
      .where('id_descendant', '!=', id)
      .executeTakeFirstOrThrow();
    return row.count;
  }
  /**
   * Move an album (and its entire subtree) to a new parent. Closure-table rewrite
   * uses the standard two-step algorithm:
   *   1. Delete all ancestor->descendant rows where the descendant is in the moving
   *      subtree but the ancestor is NOT (clears stale paths from the old parent chain).
   *   2. If newParentId is set, insert a row for every (oldParentAncestor, subtreeNode)
   *      pair so the subtree picks up the new chain.
   * Self-rows are preserved by step 1 (subtree ancestors are also subtree descendants).
   *
   * Cycle prevention is atomic: the descendant check below runs inside the same
   * transaction as the parent update, reading `album_closure` under the
   * transaction's snapshot. This closes the TOCTOU window that existed when the
   * caller checked descendants in a separate statement before calling reparent.
   * The DB-level `album_parent_cycle_check` trigger (migration 2100000000020) is
   * the final backstop and will abort the transaction if a concurrent writer
   * still manages to introduce a cycle.
   */
  async reparent(id: string, newParentId: string | null, expectedParentId?: string | null): Promise<void> {
    await this.db.transaction().execute((tx) => this.reparentIn(tx, id, newParentId, expectedParentId));
  }
  async reparentIn(
    tx: Transaction<DB>,
    id: string,
    newParentId: string | null,
    expectedParentId?: string | null,
  ): Promise<void> {
    if (expectedParentId !== undefined) {
      // FL-52: a move made from an outdated directory (the album was moved elsewhere since the
      // client loaded it) is refused rather than silently undoing the other change.
      const current = await tx
        .selectFrom('album')
        .select('parentId')
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!current || current.parentId !== expectedParentId) {
        throw new ConflictException('The album was moved since the directory was loaded');
      }
    }
    const _subtree = await tx
      .selectFrom('album_closure')
      .select('id_descendant')
      .where('id_ancestor', '=', id)
      .execute();
    if (newParentId !== null) {
      const cycle = await tx
        .selectFrom('album_closure')
        .select('id_descendant')
        .where('id_ancestor', '=', id)
        .where('id_descendant', '=', newParentId)
        .where('id_descendant', '!=', id)
        .executeTakeFirst();
      if (cycle) {
        throw new BadRequestException('Cannot move an album under one of its own descendants');
      }
    }
    await tx.updateTable('album').set({ parentId: newParentId }).where('id', '=', id).execute();
    await tx
      .deleteFrom('album_closure')
      .where('id_descendant', 'in', (eb) =>
        eb.selectFrom('album_closure as sub').select('sub.id_descendant').where('sub.id_ancestor', '=', id),
      )
      .where('id_ancestor', 'not in', (eb) =>
        eb.selectFrom('album_closure as sub2').select('sub2.id_descendant').where('sub2.id_ancestor', '=', id),
      )
      .execute();
    if (newParentId !== null) {
      await tx
        .insertInto('album_closure')
        .columns(['id_ancestor', 'id_descendant'])
        .expression(
          tx
            .selectFrom('album_closure as supertree')
            .innerJoin('album_closure as subtree', (j) => j.onTrue())
            .where('supertree.id_descendant', '=', newParentId)
            .where('subtree.id_ancestor', '=', id)
            .select(['supertree.id_ancestor as id_ancestor', 'subtree.id_descendant as id_descendant']),
        )
        .execute();
    }
  }
  /**
   * FL-52: the custom order one person gave their album directory, as album id → position. Only
   * that person's rows are read; an album they can no longer see is simply never looked up.
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getPositions(userId: string): Promise<Map<string, number>> {
    const { rows } = await sql<{
      albumId: string;
      position: number;
    }>`
      SELECT "albumId"::text AS "albumId", position
      FROM public.album_position
      WHERE "userId" = ${userId}::uuid
    `.execute(this.db);
    return new Map(rows.map(({ albumId, position }) => [albumId, position]));
  }
  /**
   * FL-52: saves one group of the person's directory in the given order (index = position).
   * Organization only — no album, membership or access row is touched. Like every fork-owned
   * writer, it refuses while the fork schema is not writable or a handoff runs.
   */
  async setPositions(userId: string, albumIds: string[], validate?: (visible: DirectoryItem[]) => void): Promise<void> {
    if (albumIds.length === 0) {
      return;
    }
    await this.db.transaction().execute(async (tx) => {
      if (validate) {
        // Everything the person can see, as it is now, locked until the order is written.
        const rows = await tx
          .selectFrom('album')
          .innerJoin('album_user', (join) =>
            join.onRef('album_user.albumId', '=', 'album.id').on('album_user.userId', '=', userId),
          )
          .where('album.deletedAt', 'is', null)
          .select(['album.id', 'album.icon', 'album.parentId', 'album.sortOrder', 'album.kind'])
          .modifyEnd(sql`FOR SHARE OF album`)
          .execute();
        validate(rows);
      }
      await sql`
        INSERT INTO public.album_position ("userId", "albumId", position)
        SELECT ${userId}::uuid, ordered.id, (ordered.ordinality - 1)::integer
        FROM unnest(${albumIds}::uuid[]) WITH ORDINALITY AS ordered(id, ordinality)
        ON CONFLICT ("userId", "albumId")
        DO UPDATE SET position = excluded.position, "updatedAt" = clock_timestamp()
      `.execute(tx);
    });
  }
  @Chunked({ chunkSize: 30_000 })
  async addAssetIdsToAlbums(
    values: {
      albumId: string;
      assetId: string;
    }[],
  ): Promise<void> {
    if (values.length === 0) {
      return;
    }
    await this.withMembershipWrite(
      values.map(({ albumId }) => albumId),
      async (tx) => {
        await tx
          .insertInto('album_asset')
          .values(values)
          // Allow idempotent album sync without failing on existing album memberships.
          .onConflict((oc) => oc.columns(['albumId', 'assetId']).doNothing())
          .execute();
      },
    );
  }
  /**
   * Makes sure all thumbnails for albums are updated by:
   * - Removing thumbnails from albums without assets
   * - Removing references of thumbnails to assets outside the album
   * - Setting a thumbnail when none is set and the album contains assets
   * - Replacing a Locked or trashed thumbnail (see `albumCoverCandidates`)
   *
   * The replacement is the same picker `releaseLockedCoverReferences` uses when a Locked photo
   * releases the cover it was (FL-53, `albumCoverReplacement`): a Best Photo first, the highest score
   * first, then the newest; never Locked or trashed, and never sensitive for an album someone besides
   * its owner sees (a member, a shared link, or one linked into a shared space). One picker, so an
   * automatic cover never disagrees with what a Locked or trashed cover falls back to.
   *
   * @returns Amount of updated album thumbnails or undefined when unknown
   */
  async updateThumbnails(): Promise<number | undefined> {
    // Albums whose cover follows the newest item (FL-83) take it first; the rules below then only
    // touch albums that have no valid cover.
    await this.updateNewestCovers();
    // Subquery for getting a new thumbnail.
    const scores = await getBestPhotoScoreTable(this.db);
    const result = await this.db
      .updateTable('album')
      .set((eb) => ({ albumThumbnailAssetId: albumCoverReplacement(eb, scores) }))
      .where((eb) =>
        eb.or([
          eb.and([
            eb('albumThumbnailAssetId', 'is', null),
            eb.exists(albumCoverCandidates(eb).select(sql`1`.as('1'))), // Has assets
          ]),
          eb.and([
            eb('albumThumbnailAssetId', 'is not', null),
            eb.not(
              eb.exists(
                albumCoverCandidates(eb)
                  .select(sql`1`.as('1'))
                  .whereRef('album.albumThumbnailAssetId', '=', 'album_asset.assetId'),
              ),
            ),
          ]),
        ]),
      )
      .execute();
    return Number(result[0].numUpdatedRows);
  }
  /**
   * FL-83 (AL-13): whether the album's cover follows its newest item.
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  async isCoverFollowingNewest(albumId: string): Promise<boolean> {
    const { rows } = await sql<{
      albumId: string;
    }>`
      SELECT "albumId" FROM public.album_cover_follows_newest WHERE "albumId" = ${albumId}::uuid
    `.execute(this.db);
    return rows.length > 0;
  }
  /**
   * FL-83 (AL-13): turns "Always use the newest item" on or off for an album. Turning it on makes the
   * newest item the cover straight away; turning it off keeps the current cover. Like every
   * fork-owned writer, it refuses while the fork schema is not writable or a handoff runs.
   */
  async setCoverFollowsNewest(albumId: string, enabled: boolean): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      if (!enabled) {
        await sql`DELETE FROM public.album_cover_follows_newest WHERE "albumId" = ${albumId}::uuid`.execute(tx);
        return;
      }
      await sql`
        INSERT INTO public.album_cover_follows_newest ("albumId")
        VALUES (${albumId}::uuid)
        ON CONFLICT ("albumId") DO UPDATE SET "updatedAt" = clock_timestamp()
      `.execute(tx);
      await this.updateNewestCovers([albumId], tx);
    });
  }
  /**
   * FL-83 (AL-13): points every album whose cover follows the newest item (or only `albumIds`) at
   * its newest item (`albumNewestCover`); an album left without a possible cover gets none. Albums
   * whose cover is already right are not written.
   */
  async updateNewestCovers(albumIds?: string[], kysely: Kysely<DB> = this.db): Promise<void> {
    if (albumIds?.length === 0) {
      return;
    }
    await kysely
      .updateTable('album')
      .set((eb) => ({ albumThumbnailAssetId: albumNewestCover(eb) }))
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom(sql.table('public.album_cover_follows_newest').as('newest'))
            .select(sql.lit(1).as('1'))
            .where(sql.ref('newest.albumId'), '=', sql.ref('album.id')),
        ),
      )
      .$if(albumIds !== undefined, (qb) => qb.where('album.id', '=', anyUuid(albumIds!)))
      .where((eb) => eb('album.albumThumbnailAssetId', 'is distinct from', albumNewestCover(eb)))
      .execute();
  }
  /**
   * The first of `assetIds`, in the given order, that may become an album cover: a Locked item never
   * does, whoever adds it. Undefined when every candidate is Locked or gone.
   */
  async getFirstCoverCandidate(assetIds: string[]): Promise<string | undefined> {
    if (assetIds.length === 0) {
      return undefined;
    }
    const row = await this.db
      .selectFrom('asset')
      .select('asset.id')
      .where('asset.id', '=', anyUuid(assetIds))
      .where('asset.deletedAt', 'is', null)
      .where(isNotLocked('asset'))
      .orderBy(sql`array_position(${assetIds}::uuid[], "asset"."id")`)
      .limit(1)
      .executeTakeFirst();
    return row?.id;
  }
  /**
   * Get per-user asset contribution counts for a single album.
   * Excludes deleted assets; orders by count desc.
   *
   * Hidden items (such as the video half of a Live Photo) still count toward the person who added
   * them (owner decision, September 22, 2026), so this does not use `withAlbumVisibility`. Locked
   * media counts only for its owner in an elevated session (`lockedOwnerId`); anyone else's Locked
   * media never counts, so the numbers never reveal it.
   */
  @GenerateSql({ params: [DummyValue.UUID, { excludeNsfw: true }] })
  getContributorCounts(id: string, options: AlbumReadOptions = {}) {
    const { lockedOwnerId } = options;
    return this.db
      .selectFrom('album_asset')
      .innerJoin('asset', 'asset.id', 'assetId')
      .where('asset.deletedAt', 'is', sql.lit(null))
      .where('album_asset.albumId', '=', id)
      .where(notLockedOrOwnedBy(lockedOwnerId, 'asset'))
      .$call((qb) => withHiddenContentFilter(qb, options))
      .select('asset.ownerId as userId')
      .select((eb) => eb.fn.countAll<number>().as('assetCount'))
      .groupBy('asset.ownerId')
      .orderBy('assetCount', 'desc')
      .execute();
  }
  @GenerateSql({ params: [{ sourceAssetId: DummyValue.UUID, targetAssetId: DummyValue.UUID }] })
  async copyAlbums({ sourceAssetId, targetAssetId }: { sourceAssetId: string; targetAssetId: string }) {
    return this.db
      .insertInto('album_asset')
      .expression((eb) =>
        eb
          .selectFrom('album_asset')
          .select((eb) => ['album_asset.albumId', eb.val(targetAssetId).as('assetId')])
          .where('album_asset.assetId', '=', sourceAssetId),
      )
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
}
