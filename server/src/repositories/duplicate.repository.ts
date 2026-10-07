import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, NotNull, Selectable, ShallowDehydrateObject, Transaction, sql } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { InjectKysely } from 'nestjs-kysely';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { columns } from 'src/database.js';
import { Chunked, DummyValue, GenerateSql } from 'src/decorators.js';
import { MapAsset } from 'src/dtos/asset-response.dto.js';
import { AssetType, QueueName } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { publicationDatabase, publicationTransaction } from 'src/queue/transaction.js';
import { DB } from 'src/schema/index.js';
import { AssetExifTable } from 'src/schema/tables/asset-exif.table.js';
import { AssetVideoDuplicateFrameTable } from 'src/schema/tables/asset-video-duplicate-frame.table.js';
import { anyUuid, asUuid, withDefaultVisibility, withHiddenContentFilter } from 'src/utils/database.js';
import { isLocked } from 'src/utils/locked.js';

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
type VideoDuplicateFrameInsert = Pick<
  Insertable<AssetVideoDuplicateFrameTable>,
  'assetId' | 'frameIndex' | 'timestampMs' | 'path' | 'embedding'
>;
type VideoDuplicateFrameMatchOptions = {
  assetId: string;
  candidateAssetIds: string[];
  maxDistance: number;
  minMatchingFrames: number;
};
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
  async getVideoDuplicateFrames(assetIds: string[]) {
    if (assetIds.length === 0) {
      return [];
    }

    return this.db
      .withSchema('public')
      .selectFrom('asset_video_duplicate_frame')
      .selectAll()
      .where('assetId', '=', anyUuid(assetIds))
      .orderBy('assetId')
      .orderBy('frameIndex')
      .execute();
  }
  async replaceVideoDuplicateFrames(assetId: string, frames: VideoDuplicateFrameInsert[]): Promise<string[]> {
    return this.db.transaction().execute(async (trx) => {
      if (frames.some((frame) => frame.assetId !== assetId)) {
        throw new Error(`Cannot replace video duplicate frames for multiple assets`);
      }
      const stalePaths: string[] = await this.replaceFramesIn(trx.withSchema('public'), assetId, frames);
      return stalePaths;
    });
  }
  private async replaceFramesIn(
    db: Kysely<DB>,
    assetId: string,
    frames: VideoDuplicateFrameInsert[],
  ): Promise<string[]> {
    const existing = await db
      .selectFrom('asset_video_duplicate_frame')
      .select('path')
      .where('assetId', '=', asUuid(assetId))
      .execute();
    const nextPaths = new Set(frames.map(({ path }) => path));
    const stalePaths = existing.map(({ path }) => path).filter((path) => !nextPaths.has(path));
    await db.deleteFrom('asset_video_duplicate_frame').where('assetId', '=', asUuid(assetId)).execute();
    if (frames.length > 0) {
      await db.insertInto('asset_video_duplicate_frame').values(frames).execute();
    }
    return stalePaths;
  }
  async getVideoDuplicateFrameMatches({
    assetId,
    candidateAssetIds,
    maxDistance,
    minMatchingFrames,
  }: VideoDuplicateFrameMatchOptions): Promise<string[]> {
    if (candidateAssetIds.length === 0) {
      return [];
    }

    const framesTable = sql.raw('public.asset_video_duplicate_frame');
    const { rows } = await sql<{
      assetId: string;
    }>`
      select candidate."assetId" as "assetId"
      from ${framesTable} source
      inner join ${framesTable} candidate
        on candidate."frameIndex" = source."frameIndex"
        and candidate."assetId" = ${anyUuid(candidateAssetIds)}
      where source."assetId" = ${asUuid(assetId)}
        and source."embedding" <=> candidate."embedding" <= ${maxDistance}
      group by candidate."assetId"
      having count(*) >= ${minMatchingFrames}
    `.execute(this.db);
    return rows.map(({ assetId }) => assetId);
  }
}
