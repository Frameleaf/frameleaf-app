import { Injectable } from '@nestjs/common';
import { type Insertable, type Kysely, type OrderByDirection, type Updateable, sql } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { DateTime } from 'luxon';
import { InjectKysely } from 'nestjs-kysely';
import type { IBulkAsset } from 'src/types.js';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { Chunked, ChunkedSet, DummyValue, GenerateSql } from 'src/decorators.js';
import { MemorySearchDto } from 'src/dtos/memory.dto.js';
import {
  AssetOrderWithRandom,
  MemoryExportStatus,
  MemoryType,
  PetObservationState,
} from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { MemoryExportTable } from 'src/schema/tables/memory-export.table.js';
import { MemoryTable } from 'src/schema/tables/memory.table.js';
import { asUuid, getHiddenContentFilter, withHiddenContentFilter } from 'src/utils/database.js';
import { isTimelineVisible } from 'src/utils/locked.js';

type MemoryPrivacyOptions = HiddenContentQueryOptions;

@Injectable()
export class MemoryRepository implements IBulkAsset {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  async cleanup() {
    await this.db
      .deleteFrom('memory_asset')
      .using('asset')
      .whereRef('memory_asset.assetId', '=', 'asset.id')
      // locked media (FL-34) leaves memories as it always did
      .where(sql<boolean>`not ${isTimelineVisible('asset')}`)
      .execute();

    return this.db
      .deleteFrom('memory')
      .where('createdAt', '<', DateTime.now().minus({ days: 30 }).toJSDate())
      .where('isSaved', '=', false)
      .execute();
  }

  searchBuilder(ownerId: string, dto: MemorySearchDto, options: MemoryPrivacyOptions = {}) {
    return this.db
      .selectFrom('memory')
      .$if(dto.isSaved !== undefined, (qb) => qb.where('isSaved', '=', dto.isSaved!))
      .$if(dto.type !== undefined, (qb) => qb.where('type', '=', dto.type!))
      .$if(dto.for !== undefined, (qb) =>
        qb
          .where((where) => where.or([where('showAt', 'is', null), where('showAt', '<=', dto.for!)]))
          .where((where) => where.or([where('hideAt', 'is', null), where('hideAt', '>=', dto.for!)])),
      )
      .$if(dto.isUpcoming !== undefined, (qb) => {
        const now = DateTime.now().toJSDate();
        return dto.isUpcoming
          ? qb.where('showAt', '>', now)
          : qb.where((where) => where.or([where('showAt', 'is', null), where('showAt', '<=', now)]));
      })
      .where('deletedAt', dto.isTrashed ? 'is not' : 'is', null)
      .where('ownerId', '=', ownerId)
      .$if(!!getHiddenContentFilter(options), (qb) =>
        qb.where((eb) =>
          eb.or([
            eb.not((eb) =>
              eb.exists(
                eb
                  .selectFrom('memory_asset')
                  .select('memory_asset.memoriesId')
                  .whereRef('memory_asset.memoriesId', '=', 'memory.id'),
              ),
            ),
            eb.exists(
              eb
                .selectFrom('memory_asset')
                .innerJoin('asset', 'asset.id', 'memory_asset.assetId')
                .select('memory_asset.memoriesId')
                .whereRef('memory_asset.memoriesId', '=', 'memory.id')
                .where(isTimelineVisible('asset'))
                .where('asset.deletedAt', 'is', null)
                .$call((qb) => withHiddenContentFilter(qb, options)),
            ),
          ]),
        ),
      );
  }

  @GenerateSql(
    { params: [DummyValue.UUID, {}, { excludeNsfw: true }] },
    { name: 'date filter', params: [DummyValue.UUID, { for: DummyValue.DATE }, { excludeNsfw: true }] },
  )
  statistics(ownerId: string, dto: MemorySearchDto, options: MemoryPrivacyOptions = {}) {
    return this.searchBuilder(ownerId, dto, options)
      .select((qb) => qb.fn.countAll<number>().as('total'))
      .executeTakeFirstOrThrow();
  }

  @GenerateSql(
    { params: [DummyValue.UUID, {}, { excludeNsfw: true }] },
    { name: 'date filter', params: [DummyValue.UUID, { for: DummyValue.DATE }, { excludeNsfw: true }] },
    { name: 'upcoming filter', params: [DummyValue.UUID, { isUpcoming: true }, { excludeNsfw: true }] },
    { name: 'not upcoming filter', params: [DummyValue.UUID, { isUpcoming: false }, { excludeNsfw: true }] },
  )
  search(ownerId: string, dto: MemorySearchDto, options: MemoryPrivacyOptions = {}) {
    return this.searchBuilder(ownerId, dto, options)
      .select((eb) =>
        jsonArrayFrom(
          eb
            .selectFrom('asset')
            .selectAll('asset')
            .innerJoin('memory_asset', 'asset.id', 'memory_asset.assetId')
            .whereRef('memory_asset.memoriesId', '=', 'memory.id')
            .where(isTimelineVisible('asset'))
            .where('asset.deletedAt', 'is', null)
            .$call((qb) => withHiddenContentFilter(qb, options))
            .where((eb) =>
              eb.not(
                eb.exists(
                  eb
                    .selectFrom('asset_face')
                    .innerJoin('person', (join) =>
                      join
                        .onRef('person.personGroupId', '=', 'asset_face.personGroupId')
                        .onRef('person.ownerId', '=', 'asset.ownerId'),
                    )
                    .select((eb) => eb.val(1).as('one'))
                    .whereRef('asset_face.assetId', '=', 'asset.id')
                    .where('person.isHidden', '=', true),
                ),
              ),
            )
            // FL-62: a photo of a pet its owner hid stays out of memories, as a photo of a hidden person
            // does. Only the owner's confirmed observations count; literals keep the parameter list
            // unchanged.
            .where((eb) =>
              eb.not(
                eb.exists(
                  eb
                    .selectFrom('pet_observation')
                    .innerJoin('pet', (join) =>
                      join.onRef('pet.id', '=', 'pet_observation.petId').onRef('pet.ownerId', '=', 'asset.ownerId'),
                    )
                    .select('pet_observation.assetId')
                    .whereRef('pet_observation.assetId', '=', 'asset.id')
                    .where('pet_observation.state', '=', sql.lit(PetObservationState.Confirmed))
                    .where('pet.isHidden', 'is', true),
                ),
              ),
            )
            .orderBy('asset.fileCreatedAt', 'asc'),
        ).as('assets'),
      )
      .selectAll('memory')
      .$call((qb) => {
        if (dto.order === AssetOrderWithRandom.Random) {
          return qb.orderBy(sql`RANDOM()`);
        }

        const direction = (dto.order?.toLowerCase() || 'desc') as OrderByDirection;
        return qb
          .orderBy('showAt', (ob) => (direction === 'asc' ? ob.asc() : ob.desc()).nullsLast())
          .orderBy('memoryAt', direction);
      })
      .$if(dto.id !== undefined, (qb) => qb.where('id', '=', dto.id!))
      .$if(dto.size !== undefined, (qb) => qb.limit(dto.size!))
      .$if(dto.page !== undefined && dto.size !== undefined, (qb) => qb.offset((dto.page! - 1) * dto.size!))
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, { excludeNsfw: true }] })
  get(id: string, options: MemoryPrivacyOptions = {}) {
    return this.getByIdBuilder(id, options).executeTakeFirst();
  }

  async create(memory: Insertable<MemoryTable>, assetIds: Set<string>) {
    const id = await this.db.transaction().execute(async (tx) => {
      const { id } = await tx.insertInto('memory').values(memory).returning('id').executeTakeFirstOrThrow();

      if (assetIds.size > 0) {
        const values = [...assetIds].map((assetId) => ({ memoriesId: id, assetId }));
        await tx.insertInto('memory_asset').values(values).execute();
      }

      return id;
    });

    return this.getByIdBuilder(id).executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID, { ownerId: DummyValue.UUID, isSaved: true }, { excludeNsfw: true }] })
  async update(id: string, memory: Updateable<MemoryTable>, options: MemoryPrivacyOptions = {}) {
    await this.db.updateTable('memory').set(memory).where('id', '=', id).execute();
    return this.getByIdBuilder(id, options).executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async delete(id: string) {
    await this.db.deleteFrom('memory').where('id', '=', id).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  @ChunkedSet({ paramIndex: 1 })
  async getAssetIds(id: string, assetIds: string[]) {
    if (assetIds.length === 0) {
      return new Set<string>();
    }

    const results = await this.db
      .selectFrom('memory_asset')
      .select(['assetId'])
      .where('memoriesId', '=', id)
      .where('assetId', 'in', assetIds)
      .execute();

    return new Set(results.map(({ assetId }) => assetId));
  }

  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  async addAssetIds(id: string, assetIds: string[]) {
    if (assetIds.length === 0) {
      return;
    }

    await this.db
      .insertInto('memory_asset')
      .values(assetIds.map((assetId) => ({ memoriesId: id, assetId })))
      .execute();
  }

  @Chunked({ paramIndex: 1 })
  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  async removeAssetIds(id: string, assetIds: string[]) {
    if (assetIds.length === 0) {
      return;
    }

    await this.db.deleteFrom('memory_asset').where('memoriesId', '=', id).where('assetId', 'in', assetIds).execute();
  }

  /**
   * The `memoryAt` instants of the owner's existing memories of one type in a window, used
   * to avoid regenerating a story that already exists. Deleted memories count: a story the
   * owner threw away must not come straight back on the next generation pass.
   */
  // No @GenerateSql here: the committed snapshots under server/src/queries are generated
  // against a live database, which this slice could not run. The integration owner can add
  // the decorator and regenerate in the same pass as the migration.
  async getExistingMemoryDates(ownerId: string, type: MemoryType, from: Date, to: Date): Promise<Date[]> {
    const rows = await this.db
      .selectFrom('memory')
      .select(['memoryAt'])
      .where('ownerId', '=', ownerId)
      .where('type', '=', type)
      .where('memoryAt', '>=', from)
      .where('memoryAt', '<=', to)
      .execute();

    return rows.map(({ memoryAt }) => memoryAt);
  }

  // Private highlight exports (FL-62). These live here rather than in their own repository
  // so the memory service keeps a single collaborator and `BaseService`'s shared dependency
  // list is untouched.

  async createExport(entry: Insertable<MemoryExportTable>) {
    return this.db.insertInto('memory_export').values(entry).returningAll().executeTakeFirstOrThrow();
  }

  /** Every export read is owner-scoped by construction; there is no unscoped getter. */
  getExport(id: string, ownerId: string) {
    return this.db
      .selectFrom('memory_export')
      .selectAll()
      .where('id', '=', asUuid(id))
      .where('ownerId', '=', ownerId)
      .executeTakeFirst();
  }

  /** The worker's own read: it has no `AuthDto`, so it reads by id and reports the owner. */
  getExportForJob(id: string) {
    return this.db.selectFrom('memory_export').selectAll().where('id', '=', asUuid(id)).executeTakeFirst();
  }

  searchExports(ownerId: string, { memoryId, status }: { memoryId?: string; status?: MemoryExportStatus[] } = {}) {
    return this.db
      .selectFrom('memory_export')
      .selectAll()
      .where('ownerId', '=', ownerId)
      .$if(memoryId !== undefined, (qb) => qb.where('memoryId', '=', asUuid(memoryId!)))
      .$if(status !== undefined && status.length > 0, (qb) => qb.where('status', 'in', status!))
      .orderBy('createdAt', 'desc')
      .execute();
  }

  async updateExport(id: string, update: Updateable<MemoryExportTable>) {
    return this.db
      .updateTable('memory_export')
      .set({ ...update, updatedAt: new Date() })
      .where('id', '=', asUuid(id))
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * Moves a run from `pending` to `running` in one statement. A duplicate delivery of the
   * same queue job, or a worker that restarts while the row still says `running`, therefore
   * cannot produce two writers for one archive: only the update that matches `pending` wins.
   */
  async claimExport(id: string) {
    return this.db
      .updateTable('memory_export')
      .set({
        status: MemoryExportStatus.Running,
        startedAt: new Date(),
        processedAssets: 0,
        updatedAt: new Date(),
      })
      .where('id', '=', asUuid(id))
      .where('status', '=', MemoryExportStatus.Pending)
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * Records the owner's cancel request. It only applies to a run that has not reached a
   * terminal state, and the worker is what actually finishes the run as cancelled.
   */
  async requestExportCancel(id: string, ownerId: string) {
    return this.db
      .updateTable('memory_export')
      .set({ cancelRequestedAt: new Date(), updatedAt: new Date() })
      .where('id', '=', asUuid(id))
      .where('ownerId', '=', ownerId)
      .where('status', 'in', [MemoryExportStatus.Pending, MemoryExportStatus.Running])
      .returningAll()
      .executeTakeFirst();
  }

  async deleteExport(id: string, ownerId: string) {
    return this.db
      .deleteFrom('memory_export')
      .where('id', '=', asUuid(id))
      .where('ownerId', '=', ownerId)
      .returningAll()
      .executeTakeFirst();
  }

  /** Runs whose archive has outlived its window, and runs abandoned by a lost worker. */
  getReclaimableExports(now: Date, staleBefore: Date) {
    return this.db
      .selectFrom('memory_export')
      .selectAll()
      .where((eb) =>
        eb.or([
          eb.and([eb('status', '=', MemoryExportStatus.Ready), eb('expiresAt', '<=', now)]),
          eb.and([
            eb('status', 'in', [MemoryExportStatus.Pending, MemoryExportStatus.Running, MemoryExportStatus.Cancelling]),
            eb('updatedAt', '<=', staleBefore),
          ]),
        ]),
      )
      .execute();
  }

  private getByIdBuilder(id: string, options: MemoryPrivacyOptions = {}) {
    return this.db
      .selectFrom('memory')
      .selectAll('memory')
      .select((eb) =>
        jsonArrayFrom(
          eb
            .selectFrom('asset')
            .selectAll('asset')
            .innerJoin('memory_asset', 'asset.id', 'memory_asset.assetId')
            .whereRef('memory_asset.memoriesId', '=', 'memory.id')
            .orderBy('asset.fileCreatedAt', 'asc')
            .where(isTimelineVisible('asset'))
            .where('asset.deletedAt', 'is', null)
            .$call((qb) => withHiddenContentFilter(qb, options)),
        ).as('assets'),
      )
      .where('id', '=', id)
      .where('deletedAt', 'is', null)
      .$if(!!getHiddenContentFilter(options), (qb) =>
        qb.where((eb) =>
          eb.or([
            eb.not((eb) =>
              eb.exists(
                eb
                  .selectFrom('memory_asset')
                  .select('memory_asset.memoriesId')
                  .whereRef('memory_asset.memoriesId', '=', 'memory.id'),
              ),
            ),
            eb.exists(
              eb
                .selectFrom('memory_asset')
                .innerJoin('asset', 'asset.id', 'memory_asset.assetId')
                .select('memory_asset.memoriesId')
                .whereRef('memory_asset.memoriesId', '=', 'memory.id')
                .where(isTimelineVisible('asset'))
                .where('asset.deletedAt', 'is', null)
                .$call((qb) => withHiddenContentFilter(qb, options)),
            ),
          ]),
        ),
      );
  }
}
