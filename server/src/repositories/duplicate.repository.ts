import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, NotNull, Selectable, ShallowDehydrateObject, Transaction, sql } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { InjectKysely } from 'nestjs-kysely';
import type { AssetDuplicateResult } from 'src/repositories/search.repository.js';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { columns } from 'src/database.js';
import { Chunked, DummyValue, GenerateSql } from 'src/decorators.js';
import { MapAsset } from 'src/dtos/asset-response.dto.js';
import { AssetStatus, AssetType, QueueName } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { publicationDatabase, publicationTransaction } from 'src/queue/transaction.js';
import { DB } from 'src/schema/index.js';
import { AssetExifTable } from 'src/schema/tables/asset-exif.table.js';
import { AssetVideoFingerprintTable } from 'src/schema/tables/asset-video-fingerprint.table.js';
import { anyUuid, asUuid, withDefaultVisibility, withHiddenContentFilter } from 'src/utils/database.js';
import { isLocked } from 'src/utils/locked.js';
import { mimeTypes } from 'src/utils/mime-types.js';

// Maximum number of candidate duplicates to return from vector search
const DUPLICATE_SEARCH_LIMIT = 64;
interface DuplicateSearch {
  assetId: string;
  embedding: string;
  maxDistance: number;
  type: AssetType;
  userIds: string[];
}
interface DuplicateMergeOptions {
  targetId: string | null;
  assetIds: string[];
  sourceIds: string[];
}
type DuplicatePrivacyOptions = HiddenContentQueryOptions;
@Injectable()
export class DuplicateRepository {
  constructor(
    @InjectKysely()
    private db: Kysely<DB>,
  ) {
    this.db = publicationDatabase(db);
  }
  /** One atomic decision; concurrent membership changes abort rather than partially dispose. */
  async withResolutionLock<T>(duplicateId: string, callback: (tx: Transaction<DB>) => Promise<T>): Promise<T> {
    return this.db
      .transaction()
      .setIsolationLevel('serializable')
      .execute(async (tx) => {
        await sql`SET LOCAL lock_timeout = '5s'`.execute(tx);
        const context = queueExecution.getStore();
        context?.signal.throwIfAborted();
        const queues = [...new Set([QueueName.BackgroundTask, ...(context ? [context.claim.queue] : [])])].toSorted();
        // Queue fences precede domain locks, as they do during normal worker publication.
        await sql`select name from job_queue where name = any(${queues}::text[]) order by name for no key update`.execute(
          tx,
        );
        if (context) {
          const { rows } =
            await sql`select id from job where id = ${context.claim.id}::uuid and token = ${context.claim.token}::uuid and state = 'active' and "leaseExpiresAt" > clock_timestamp() and "cancelRequestedAt" is null for update`.execute(
              tx,
            );
          if (rows.length === 0) throw new Error('Duplicate decision lost its claim');
        }
        const members = await tx
          .selectFrom('asset')
          .select(['id', 'livePhotoVideoId'])
          .where('duplicateId', '=', asUuid(duplicateId))
          .execute();
        if (members.length > 512) throw new Error('Duplicate group exceeds atomic resolution limit');
        const ids = [
          ...new Set(members.flatMap(({ id, livePhotoVideoId }) => (livePhotoVideoId ? [id, livePhotoVideoId] : [id]))),
        ].toSorted();
        for (const id of ids) await sql`SELECT pg_advisory_xact_lock(-1, hashtext(${id})::int)`.execute(tx);
        for (const { id } of members.toSorted((a, b) => a.id.localeCompare(b.id))) {
          await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`asset_develop_revision:${id}`}, 0))`.execute(tx);
        }
        if (ids.length > 0)
          await tx.selectFrom('asset').select('id').where('id', '=', anyUuid(ids)).orderBy('id').forUpdate().execute();
        return publicationTransaction.run(tx, () => callback(tx));
      });
  }

  /** A reference may move only when every disposable motion proves the same owned pair. */
  async findMotionTransfer(ownerId: string, keeperId: string, trashIds: string[]): Promise<string | undefined> {
    if (trashIds.length === 0) return;
    const keeper = await this.db
      .selectFrom('asset')
      .select(['originalFileName', 'livePhotoVideoId'])
      .where('id', '=', keeperId)
      .where('ownerId', '=', ownerId)
      .executeTakeFirst();
    if (!keeper || keeper.livePhotoVideoId || !mimeTypes.isHeic(keeper.originalFileName)) return;
    const sources = await this.db
      .selectFrom('asset')
      .select(['id', 'livePhotoVideoId'])
      .where('id', '=', anyUuid(trashIds))
      .where('livePhotoVideoId', 'is not', null)
      .execute();
    if (sources.length === 0 || new Set(sources.map(({ livePhotoVideoId }) => livePhotoVideoId)).size !== 1) return;
    const { rows } = await sql<{ id: string; motionId: string }>`
      select source.id, video.id as "motionId" from asset source
      join asset keeper on keeper.id = ${keeperId}::uuid
      join asset video on video.id = source."livePhotoVideoId"
      join asset_exif source_exif on source_exif."assetId" = source.id
      join asset_exif keeper_exif on keeper_exif."assetId" = keeper.id
      join asset_exif video_exif on video_exif."assetId" = video.id
      where source.id = any(${trashIds}::uuid[])
        and source."ownerId" = ${ownerId}::uuid and keeper."ownerId" = source."ownerId" and video."ownerId" = source."ownerId"
        and source."duplicateId" = keeper."duplicateId"
        and source.type = ${AssetType.Image} and keeper.type = ${AssetType.Image} and video.type = ${AssetType.Video}
        and source."deletedAt" is null and keeper."deletedAt" is null and video."deletedAt" is null
        and source.status = ${AssetStatus.Active} and keeper.status = ${AssetStatus.Active} and video.status = ${AssetStatus.Active}
        and keeper."livePhotoVideoId" is null
        and source."libraryId" is not distinct from keeper."libraryId" and video."libraryId" is not distinct from keeper."libraryId"
        and btrim(keeper_exif."livePhotoCID") <> ''
        and source_exif."livePhotoCID" = keeper_exif."livePhotoCID" and video_exif."livePhotoCID" = keeper_exif."livePhotoCID"
        and not ${isLocked('video')}
    `.execute(this.db);
    return rows.length === sources.length ? rows[0]?.motionId : undefined;
  }
  /** Read-only owner projection using the same eligibility predicates as getAll. */
  @GenerateSql({ params: [DummyValue.UUID, { excludeNsfw: true }] })
  getSyncGroups(userId: string, options: DuplicatePrivacyOptions = {}, groupId?: string) {
    return (
      this.db
        .selectFrom('asset')
        .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
        .$call((qb) => withDefaultVisibility(qb, options.revealLockedOwnerId))
        .where('asset.ownerId', '=', asUuid(userId))
        .where('asset.duplicateId', 'is not', null)
        .$narrowType<{
          duplicateId: NotNull;
        }>()
        .$if(!!groupId, (qb) => qb.where('asset.duplicateId', '=', asUuid(groupId!)))
        .where('asset.deletedAt', 'is', null)
        .where('asset.stackId', 'is', null)
        .$call((qb) => withHiddenContentFilter(qb, options))
        .select('asset.duplicateId as groupId')
        .$narrowType<{
          groupId: NotNull;
        }>()
        .select(sql<string[]>`array_agg(asset.id order by asset.id)`.as('assetIds'))
        .groupBy('asset.duplicateId')
        .having((eb) => eb.fn.count('asset.id'), '>', 1)
        // Keep ordering in PostgreSQL: JS Date would discard sub-millisecond precision.
        .orderBy(sql`max(asset."localDateTime")`, 'desc')
        .orderBy('asset.duplicateId', 'desc')
        .execute()
    );
  }
  @GenerateSql({ params: [DummyValue.UUID, { excludeNsfw: true }] })
  getAll(userId: string, options: DuplicatePrivacyOptions = {}) {
    return (
      this.db
        .with('duplicates', (qb) =>
          qb
            .selectFrom('asset')
            // FL-195: the owner's own revealed locks group like any other item in an unlocked session
            .$call((qb) => withDefaultVisibility(qb, options.revealLockedOwnerId))
            // Use innerJoinLateral to build a composite object per asset that includes
            // exifInfo and tags. This "asset2" object is then aggregated via jsonAgg.
            // Tags must be included here (not via separate joins) so they appear in the
            // final MapAsset[] output - needed for tag synchronization during resolution.
            .innerJoinLateral(
              (qb) =>
                qb
                  .selectFrom('asset_exif')
                  .selectAll('asset')
                  .select(isLocked('asset').as('isLocked'))
                  .select((eb) =>
                    eb.fn
                      .toJson('asset_exif')
                      .$castTo<ShallowDehydrateObject<Selectable<AssetExifTable>>>()
                      .as('exifInfo'),
                  )
                  .select((eb) =>
                    jsonArrayFrom(
                      eb
                        .selectFrom('tag')
                        .select(columns.tag)
                        .innerJoin('tag_asset', 'tag.id', 'tag_asset.tagId')
                        .whereRef('tag_asset.assetId', '=', 'asset.id'),
                    ).as('tags'),
                  )
                  .whereRef('asset_exif.assetId', '=', 'asset.id')
                  .as('asset2'),
              (join) => join.onTrue(),
            )
            .select('asset.duplicateId')
            .select((eb) =>
              eb.fn.jsonAgg('asset2').orderBy('asset.localDateTime', 'asc').$castTo<MapAsset[]>().as('assets'),
            )
            .where('asset.ownerId', '=', asUuid(userId))
            .where('asset.duplicateId', 'is not', null)
            .$narrowType<{
              duplicateId: NotNull;
            }>()
            .where('asset.deletedAt', 'is', null)
            .where('asset.stackId', 'is', null)
            .$call((qb) => withHiddenContentFilter(qb, options))
            .groupBy('asset.duplicateId'),
        )
        .selectFrom('duplicates')
        .selectAll()
        // Filter out singleton groups (only 1 asset) directly in the query
        .where((eb) => eb(eb.fn('json_array_length', ['assets']), '>', 1))
        .execute()
    );
  }
  @GenerateSql({ params: [DummyValue.UUID] })
  async cleanupSingletonGroups(userId: string): Promise<void> {
    // Remove duplicateId from assets that are the only member of their duplicate group
    await this.db
      .with('singletons', (qb) =>
        qb
          .selectFrom('asset')
          .select('duplicateId')
          .where('ownerId', '=', asUuid(userId))
          .where('duplicateId', 'is not', null)
          .$narrowType<{
            duplicateId: NotNull;
          }>()
          .where('deletedAt', 'is', null)
          .where('stackId', 'is', null)
          .groupBy('duplicateId')
          .having((eb) => eb.fn.count('id'), '=', 1),
      )
      .updateTable('asset')
      .set({ duplicateId: null })
      .from('singletons')
      .whereRef('asset.duplicateId', '=', 'singletons.duplicateId')
      .execute();
  }
  /** FL-519: groups of two or more of the owner's timeline photos waiting for a decision. */
  @GenerateSql({ params: [DummyValue.UUID] })
  async countGroupsForOwner(ownerId: string): Promise<number> {
    const { count } = await this.db
      .selectFrom((qb) =>
        qb
          .selectFrom('asset')
          .$call((qb) => withDefaultVisibility(qb))
          .select('asset.duplicateId')
          .where('asset.ownerId', '=', asUuid(ownerId))
          .where('asset.duplicateId', 'is not', null)
          .where('asset.deletedAt', 'is', null)
          .where('asset.stackId', 'is', null)
          .groupBy('asset.duplicateId')
          .having((eb) => eb.fn.count('asset.id'), '>', 1)
          .as('grouped'),
      )
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .executeTakeFirstOrThrow();
    return Number(count);
  }

  @GenerateSql({ params: [DummyValue.UUID, { excludeNsfw: true }] })
  async get(
    duplicateId: string,
    options: DuplicatePrivacyOptions = {},
  ): Promise<
    | {
        duplicateId: string;
        assets: MapAsset[];
      }
    | undefined
  > {
    const result = await this.db
      .selectFrom('asset')
      .$call((qb) => withDefaultVisibility(qb, options.revealLockedOwnerId))
      // Use innerJoinLateral to build a composite object per asset that includes
      // exifInfo and tags. This "asset2" object is then aggregated via jsonAgg.
      // Tags must be included here (not via separate joins) so they appear in the
      // final MapAsset[] output - needed for tag synchronization during resolution.
      .innerJoinLateral(
        (qb) =>
          qb
            .selectFrom('asset_exif')
            .selectAll('asset')
            .select(isLocked('asset').as('isLocked'))
            .select((eb) => eb.fn.toJson('asset_exif').as('exifInfo'))
            .select((eb) =>
              jsonArrayFrom(
                eb
                  .selectFrom('tag')
                  .select(columns.tag)
                  .innerJoin('tag_asset', 'tag.id', 'tag_asset.tagId')
                  .whereRef('tag_asset.assetId', '=', 'asset.id'),
              ).as('tags'),
            )
            .whereRef('asset_exif.assetId', '=', 'asset.id')
            .as('asset2'),
        (join) => join.onTrue(),
      )
      .select('asset.duplicateId')
      .select((eb) => eb.fn.jsonAgg('asset2').orderBy('asset.localDateTime', 'asc').$castTo<MapAsset[]>().as('assets'))
      .where('asset.duplicateId', '=', asUuid(duplicateId))
      .where('asset.deletedAt', 'is', null)
      .where('asset.stackId', 'is', null)
      .$call((qb) => withHiddenContentFilter(qb, options))
      .groupBy('asset.duplicateId')
      .executeTakeFirst();
    if (!result || !result.duplicateId) {
      return;
    }
    return { duplicateId: result.duplicateId, assets: result.assets };
  }
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  async delete(userId: string, id: string): Promise<void> {
    await this.db
      .updateTable('asset')
      .set({ duplicateId: null })
      .where('ownerId', '=', userId)
      .where('duplicateId', '=', id)
      .execute();
  }
  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  @Chunked({ paramIndex: 1 })
  async deleteAll(userId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.db
      .updateTable('asset')
      .set({ duplicateId: null })
      .where('ownerId', '=', userId)
      .where('duplicateId', 'in', ids)
      .execute();
  }
  @GenerateSql({
    params: [
      {
        assetId: DummyValue.UUID,
        embedding: DummyValue.VECTOR,
        maxDistance: 0.6,
        type: AssetType.Image,
        userIds: [DummyValue.UUID],
      },
    ],
  })
  search({ assetId, embedding, maxDistance, type, userIds }: DuplicateSearch) {
    return this.db.transaction().execute(async (trx) => {
      await sql`set local hnsw.ef_search = 100`.execute(trx);
      return await trx
        .with('cte', (qb) =>
          qb
            .selectFrom('asset')
            .$call(withDefaultVisibility)
            .select([
              'asset.id as assetId',
              'asset.duplicateId',
              sql<number>`smart_search.embedding <=> ${embedding}`.as('distance'),
            ])
            .innerJoin('smart_search', 'asset.id', 'smart_search.assetId')
            .where('asset.ownerId', '=', anyUuid(userIds))
            .where('asset.deletedAt', 'is', null)
            .where('asset.type', '=', type)
            .where('asset.id', '!=', asUuid(assetId))
            .where('asset.stackId', 'is', null)
            .orderBy('distance')
            .limit(DUPLICATE_SEARCH_LIMIT),
        )
        .selectFrom('cte')
        .selectAll()
        .where('cte.distance', '<=', maxDistance as number)
        .execute();
    });
  }
  /**
   * FL-520: for a random sample of photos and videos that can be compared, the distance to the nearest
   * other item of the same kind in the same library (`Infinity` when it has none). The look-alike
   * estimate reads how many fall under each "How alike" choice; the time taken is the time estimate.
   */
  sampleNearestDistances(sampleSize: number): Promise<number[]> {
    return this.db.transaction().execute(async (trx) => {
      await sql`set local hnsw.ef_search = 100`.execute(trx);
      const sample = await trx
        .selectFrom('asset')
        .$call(withDefaultVisibility)
        .innerJoin('smart_search', 'asset.id', 'smart_search.assetId')
        .select(['asset.id', 'asset.ownerId', 'asset.type', 'smart_search.embedding'])
        .where('asset.deletedAt', 'is', null)
        .where('asset.stackId', 'is', null)
        .where('asset.type', 'in', [AssetType.Image, AssetType.Video])
        .orderBy(sql`random()`)
        .limit(sampleSize)
        .execute();
      const distances: number[] = [];
      for (const item of sample) {
        const nearest = await trx
          .selectFrom('asset')
          .$call(withDefaultVisibility)
          .innerJoin('smart_search', 'asset.id', 'smart_search.assetId')
          .select(sql<number>`smart_search.embedding <=> ${item.embedding}`.as('distance'))
          .where('asset.ownerId', '=', item.ownerId)
          .where('asset.id', '!=', item.id)
          .where('asset.type', '=', item.type)
          .where('asset.deletedAt', 'is', null)
          .where('asset.stackId', 'is', null)
          .orderBy('distance')
          .limit(1)
          .executeTakeFirst();
        distances.push(nearest ? Number(nearest.distance) : Infinity);
      }
      return distances;
    });
  }

  /** FL-520: photos and videos that duplicate detection compares, and the look-alike groups it has made. */
  async countComparable(): Promise<{ comparable: number; groups: number; grouped: number }> {
    const { rows } = await sql<{ comparable: number; groups: number; grouped: number }>`
      SELECT
        (SELECT count(*)::int FROM public.asset a JOIN public.smart_search s ON s."assetId" = a.id
          WHERE a."deletedAt" IS NULL AND a."stackId" IS NULL AND a.type IN ('IMAGE', 'VIDEO')) AS comparable,
        count(*)::int AS groups,
        coalesce(sum(g.members), 0)::int AS grouped
      FROM (
        SELECT count(*) AS members FROM public.asset
        WHERE "duplicateId" IS NOT NULL AND "deletedAt" IS NULL
        GROUP BY "duplicateId" HAVING count(*) > 1
      ) g`.execute(this.db);
    return rows[0];
  }

  @GenerateSql({
    params: [{ targetDuplicateId: DummyValue.UUID, duplicateIds: [DummyValue.UUID], assetIds: [DummyValue.UUID] }],
  })
  async merge(options: DuplicateMergeOptions): Promise<void> {
    await this.db
      .updateTable('asset')
      .set({ duplicateId: options.targetId })
      .where((eb) =>
        eb.or([eb('duplicateId', '=', anyUuid(options.sourceIds)), eb('id', '=', anyUuid(options.assetIds))]),
      )
      .execute();
  }
  getVideoFingerprints(assetIds: string[]) {
    if (assetIds.length === 0) {
      return Promise.resolve([]);
    }
    return this.db.selectFrom('asset_video_fingerprint').selectAll().where('assetId', '=', anyUuid(assetIds)).execute();
  }

  /** FL-651: the other members of the look-alike group an asset is in. */
  async getGroupMateIds(assetId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('asset')
      .select('asset.id')
      .where('asset.duplicateId', '=', (eb) =>
        eb.selectFrom('asset as member').select('member.duplicateId').where('member.id', '=', asUuid(assetId)),
      )
      .where('asset.id', '!=', asUuid(assetId))
      .where('asset.deletedAt', 'is', null)
      .execute();
    return rows.map(({ id }) => id);
  }

  async upsertVideoFingerprint(fingerprint: Insertable<AssetVideoFingerprintTable>) {
    await this.db
      .insertInto('asset_video_fingerprint')
      .values(fingerprint)
      .onConflict((oc) =>
        oc.column('assetId').doUpdateSet((eb) => ({
          durationMs: eb.ref('excluded.durationMs'),
          hashes: eb.ref('excluded.hashes'),
        })),
      )
      .execute();
  }

  /**
   * FL-651: the same videos `search` may return, here found by a filmstrip frame within `maxBits` of
   * one of `hashes`, so copies whose first frame differs are still compared.
   * ponytail: scans the owner's fingerprints (~120 hashes each); an index on frame hashes if large
   * video libraries make the duplicate queue slow.
   */
  async searchVideoFingerprints(options: {
    assetId: string;
    hashes: string[];
    maxBits: number;
    userIds: string[];
  }): Promise<AssetDuplicateResult[]> {
    if (options.hashes.length === 0) {
      return [];
    }
    return this.db
      .selectFrom('asset')
      .$call(withDefaultVisibility)
      .innerJoin('asset_video_fingerprint as fingerprint', 'fingerprint.assetId', 'asset.id')
      .select(['asset.id as assetId', 'asset.duplicateId', sql<number>`0`.as('distance')])
      .where('asset.ownerId', '=', anyUuid(options.userIds))
      .where('asset.deletedAt', 'is', null)
      .where('asset.type', '=', AssetType.Video)
      .where('asset.id', '!=', asUuid(options.assetId))
      .where('asset.stackId', 'is', null)
      .where(
        sql<boolean>`exists (
          select 1 from unnest(fingerprint.hashes) frame, unnest(${options.hashes}::bigint[]) wanted
          where bit_count((frame # wanted)::bit(64)) <= ${options.maxBits}
        )`,
      )
      .limit(DUPLICATE_SEARCH_LIMIT)
      .execute();
  }
}
