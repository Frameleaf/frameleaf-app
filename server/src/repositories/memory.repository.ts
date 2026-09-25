import { Injectable } from '@nestjs/common';
import {
  type Insertable,
  type Kysely,
  type OrderByDirection,
  type SelectQueryBuilder,
  type Updateable,
  sql,
} from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { DateTime } from 'luxon';
import { InjectKysely } from 'nestjs-kysely';
import type { IBulkAsset } from 'src/types.js';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { Chunked, ChunkedSet, DummyValue, GenerateSql } from 'src/decorators.js';
import { MemorySearchDto } from 'src/dtos/memory.dto.js';
import {
  AssetFileType,
  AssetOrderWithRandom,
  AssetVisibility,
  MemoryExportStatus,
  MemoryType,
  PetObservationState,
} from 'src/enum.js';
import { lockForkWrites } from 'src/repositories/fork-write-guard.js';
import { DB } from 'src/schema/index.js';
import { MemoryExportTable } from 'src/schema/tables/memory-export.table.js';
import { MemoryTable } from 'src/schema/tables/memory.table.js';
import { asUuid, getHiddenContentFilter, withHiddenContentFilter } from 'src/utils/database.js';
import { isTimelineVisible } from 'src/utils/locked.js';

/**
 * FL-62: the owner's own curation narrows what a search returns — memories they hid, and their
 * "show less" rules. Every field is optional and only changes the query when it is set.
 */
export type MemoryCurationFilter = {
  /** leave these memories out (the ones the owner hid) */
  excludeIds?: string[];
  /** only these memories (the hidden list) */
  onlyIds?: string[];
  /** memory types the owner asked for less of */
  excludeTypes?: string[];
  /** `MM-dd` days the owner asked for less of (on this day and birthdays) */
  excludeDates?: string[];
  /** people and pets the owner asked for less of: their birthdays and recaps */
  excludeSubjectIds?: string[];
  /** people the owner asked for less of: photos of them leave every memory */
  excludePersonIds?: string[];
  /** pets the owner asked for less of: photos of them leave every memory */
  excludePetIds?: string[];
};

type MemoryPrivacyOptions = HiddenContentQueryOptions & MemoryCurationFilter;

export type MemoryShowLessRow = { kind: string; value: string; createdAt: Date };

export type MemoryCurationRow = {
  memoryId: string;
  hiddenAt: Date | null;
  title: string | null;
  assetOrder: string[] | null;
};

const hasItems = (values?: string[]): values is string[] => !!values && values.length > 0;

/**
 * FL-62: which of a memory's items any read of it may return: the viewer's hidden-content filter,
 * never a photo of a person or pet the owner hid, and never one of a person or pet the owner asked to
 * see less of. Search and every single-memory read (get, update, create) share it, so hiding,
 * restoring or renaming a memory can never bring such an item back.
 */
const withMemoryAssetFilters = <O>(
  qb: SelectQueryBuilder<DB, 'asset' | 'memory_asset', O>,
  options: MemoryPrivacyOptions,
) =>
  withHiddenContentFilter(qb, options)
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
    // FL-62: people and pets the owner asked to see less of leave every memory's photos.
    .$if(hasItems(options.excludePersonIds), (qb) =>
      qb.where((eb) =>
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
              .where('asset_face.personGroupId', 'in', options.excludePersonIds!),
          ),
        ),
      ),
    )
    .$if(hasItems(options.excludePetIds), (qb) =>
      qb.where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('pet_observation')
              .select('pet_observation.assetId')
              .whereRef('pet_observation.assetId', '=', 'asset.id')
              .where('pet_observation.state', '=', PetObservationState.Confirmed)
              .where('pet_observation.petId', 'in', options.excludePetIds!),
          ),
        ),
      ),
    );

@Injectable()
export class MemoryRepository implements IBulkAsset {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  async cleanup() {
    await this.db
      .deleteFrom('memory_asset')
      .using('asset')
      .whereRef('memory_asset.assetId', '=', 'asset.id')
      // Stored visibility only, as upstream: a locked asset (FL-34) keeps its place in its memories and
      // every memory read hides it while it is locked, so unlocking it brings it back, as for albums.
      .where('asset.visibility', '!=', AssetVisibility.Timeline)
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
      .$if(options.onlyIds !== undefined, (qb) =>
        hasItems(options.onlyIds) ? qb.where('memory.id', 'in', options.onlyIds) : qb.where(sql<boolean>`false`),
      )
      .$if(hasItems(options.excludeIds), (qb) => qb.where('memory.id', 'not in', options.excludeIds!))
      .$if(hasItems(options.excludeTypes), (qb) =>
        qb.where('memory.type', 'not in', options.excludeTypes! as MemoryType[]),
      )
      .$if(hasItems(options.excludeDates), (qb) =>
        qb.where((eb) =>
          eb.not(
            eb.and([
              eb('memory.type', 'in', [MemoryType.OnThisDay, MemoryType.Birthday]),
              eb(sql`to_char("memory"."memoryAt" at time zone 'UTC', 'MM-DD')`, 'in', options.excludeDates!),
            ]),
          ),
        ),
      )
      .$if(hasItems(options.excludeSubjectIds), (qb) =>
        qb.where((eb) =>
          eb.or([
            // FL-58 pet stories name their pet as `petId`
            eb(sql`coalesce("memory"."data"->>'subjectId', "memory"."data"->>'petId')`, 'is', null),
            eb(
              sql`coalesce("memory"."data"->>'subjectId', "memory"."data"->>'petId')`,
              'not in',
              options.excludeSubjectIds!,
            ),
          ]),
        ),
      )
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
            .$call((qb) => withMemoryAssetFilters(qb, options))
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

  /**
   * Pet stories (FL-58): the photos the owner confirmed each of their named, visible pets in, captured
   * (owner's local time) inside the window. Timeline photos only, so Locked, archived and hidden
   * photos never reach a story; only the owner's own pets and own assets are read.
   */
  // No @GenerateSql: like getEventStoryCandidates, the snapshot needs a live database.
  getPetStoryCandidates(ownerId: string, from: Date, to: Date) {
    return this.db
      .selectFrom('pet_observation')
      .innerJoin('pet', 'pet.id', 'pet_observation.petId')
      .innerJoin('asset', 'asset.id', 'pet_observation.assetId')
      .select([
        'pet.id as petId',
        'pet.name as name',
        'pet.species as species',
        'asset.id as assetId',
        'asset.localDateTime as localDateTime',
      ])
      .where('pet.ownerId', '=', ownerId)
      .where('pet.isHidden', '=', false)
      .where('pet.name', '!=', '')
      .where('pet_observation.state', '=', PetObservationState.Confirmed)
      .where('asset.ownerId', '=', ownerId)
      .where(isTimelineVisible('asset'))
      .where('asset.deletedAt', 'is', null)
      .where('asset.localDateTime', '>=', from)
      .where('asset.localDateTime', '<=', to)
      .orderBy('asset.localDateTime', 'asc')
      .execute();
  }

  /** `petId:month` of every pet story the owner already has in the window, deleted ones included. */
  async getPetStoryKeys(ownerId: string, from: Date, to: Date): Promise<Set<string>> {
    const rows = await this.db
      .selectFrom('memory')
      .select([sql<string>`memory.data->>'petId'`.as('petId'), sql<string>`memory.data->>'month'`.as('month')])
      .where('ownerId', '=', ownerId)
      .where('type', '=', MemoryType.PetStory)
      .where('memoryAt', '>=', from)
      .where('memoryAt', '<=', to)
      .execute();
    return new Set(rows.map(({ petId, month }) => `${petId}:${month}`));
  }

  /** The owner's pets a set of pet stories name, as they are now. */
  getStoryPets(ownerId: string, petIds: string[]) {
    if (petIds.length === 0) {
      return Promise.resolve([]);
    }
    return this.db
      .selectFrom('pet')
      .select(['pet.id', 'pet.name', 'pet.species', 'pet.isHidden'])
      .where('pet.ownerId', '=', ownerId)
      .where('pet.id', 'in', petIds)
      .execute();
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
            .$call((qb) => withMemoryAssetFilters(qb, options)),
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

  /**
   * FL-62: the owner's curation of these memories (hidden, their own title, their item order).
   * Only the owner's own rows are read; a row for a memory that is gone is never looked up.
   */
  async getCurations(ownerId: string, memoryIds: string[]): Promise<Map<string, MemoryCurationRow>> {
    if (memoryIds.length === 0) {
      return new Map();
    }
    const { rows } = await sql<MemoryCurationRow>`
      SELECT "memoryId"::text AS "memoryId", "hiddenAt", title, "assetOrder"::text[] AS "assetOrder"
      FROM immich_fork.memory_curation
      WHERE "ownerId" = ${ownerId}::uuid AND "memoryId" = ANY(${memoryIds}::uuid[])
    `.execute(this.db);
    return new Map(rows.map((row) => [row.memoryId, row]));
  }

  /** FL-62: the ids of the memories the owner hid. */
  async getHiddenMemoryIds(ownerId: string): Promise<string[]> {
    const { rows } = await sql<{ memoryId: string }>`
      SELECT "memoryId"::text AS "memoryId"
      FROM immich_fork.memory_curation
      WHERE "ownerId" = ${ownerId}::uuid AND "hiddenAt" IS NOT NULL
    `.execute(this.db);
    return rows.map(({ memoryId }) => memoryId);
  }

  /**
   * FL-62: saves the owner's curation of one memory. Only the given fields change; `undefined`
   * keeps the stored value. Like every fork-owned writer, it refuses while a handoff runs.
   */
  async setCuration(
    ownerId: string,
    memoryId: string,
    patch: { hidden?: boolean; title?: string | null; assetOrder?: string[] },
  ): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      await lockForkWrites(tx, 'Memory changes are unavailable during database handoff');
      const setHidden = patch.hidden !== undefined;
      const setTitle = patch.title !== undefined;
      const setOrder = patch.assetOrder !== undefined;
      const hiddenAt = patch.hidden ? new Date() : null;
      await sql`
        INSERT INTO immich_fork.memory_curation ("memoryId", "ownerId", "hiddenAt", title, "assetOrder")
        VALUES (
          ${memoryId}::uuid,
          ${ownerId}::uuid,
          ${hiddenAt}::timestamptz,
          ${patch.title ?? null}::text,
          ${patch.assetOrder ?? null}::uuid[]
        )
        ON CONFLICT ("memoryId") DO UPDATE SET
          "hiddenAt" = CASE WHEN ${setHidden}::boolean THEN excluded."hiddenAt" ELSE memory_curation."hiddenAt" END,
          title = CASE WHEN ${setTitle}::boolean THEN excluded.title ELSE memory_curation.title END,
          "assetOrder" = CASE WHEN ${setOrder}::boolean THEN excluded."assetOrder" ELSE memory_curation."assetOrder" END,
          "updatedAt" = clock_timestamp()
        WHERE memory_curation."ownerId" = excluded."ownerId"
      `.execute(tx);
    });
  }

  /** FL-62: curation rows whose memory no longer exists, removed by the memories cleanup job. */
  async cleanupCurations(): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      await lockForkWrites(tx, 'Memory changes are unavailable during database handoff');
      await sql`
        DELETE FROM immich_fork.memory_curation curation
        WHERE NOT EXISTS (SELECT 1 FROM memory WHERE memory.id = curation."memoryId")
      `.execute(tx);
    });
  }

  /** FL-62: the owner's "show less" rules, oldest first. */
  async getShowLess(userId: string): Promise<MemoryShowLessRow[]> {
    const { rows } = await sql<MemoryShowLessRow>`
      SELECT kind, value, "createdAt"
      FROM immich_fork.memory_show_less
      WHERE "userId" = ${userId}::uuid
      ORDER BY "createdAt", kind, value
    `.execute(this.db);
    return rows;
  }

  async addShowLess(userId: string, kind: string, value: string): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      await lockForkWrites(tx, 'Memory changes are unavailable during database handoff');
      await sql`
        INSERT INTO immich_fork.memory_show_less ("userId", kind, value)
        VALUES (${userId}::uuid, ${kind}, ${value})
        ON CONFLICT ("userId", kind, value) DO NOTHING
      `.execute(tx);
    });
  }

  async removeShowLess(userId: string, kind: string, value: string): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      await lockForkWrites(tx, 'Memory changes are unavailable during database handoff');
      await sql`
        DELETE FROM immich_fork.memory_show_less
        WHERE "userId" = ${userId}::uuid AND kind = ${kind} AND value = ${value}
      `.execute(tx);
    });
  }

  /**
   * FL-62: the owner's named people and pets, not hidden, whose birth date falls on one of these
   * `MM-DD` days. Only the owner's own rows are read.
   */
  async getBirthdaySubjects(
    ownerId: string,
    monthDays: string[],
  ): Promise<{ subject: 'person' | 'pet'; id: string; name: string; birthDate: string }[]> {
    if (monthDays.length === 0) {
      return [];
    }
    const { rows } = await sql<{ subject: 'person' | 'pet'; id: string; name: string; birthDate: string }>`
      SELECT 'person' AS subject, "personGroupId"::text AS id, name, to_char("birthDate", 'YYYY-MM-DD') AS "birthDate"
      FROM person
      WHERE "ownerId" = ${ownerId}::uuid AND "isHidden" = false AND name <> '' AND "birthDate" IS NOT NULL
        AND to_char("birthDate", 'MM-DD') = ANY(${monthDays}::text[])
      UNION ALL
      SELECT 'pet' AS subject, id::text AS id, name, to_char("birthDate", 'YYYY-MM-DD') AS "birthDate"
      FROM pet
      WHERE "ownerId" = ${ownerId}::uuid AND "isHidden" = false AND name <> '' AND "birthDate" IS NOT NULL
        AND to_char("birthDate", 'MM-DD') = ANY(${monthDays}::text[])
    `.execute(this.db);
    return rows;
  }

  /**
   * FL-62: the owner's own timeline photos and videos of one of their people or pets, oldest
   * first, optionally within a local-time window. Only items with a preview, never Locked,
   * archived or trashed ones; a person counts only through the owner's own person row.
   */
  getSubjectAssets(
    ownerId: string,
    subject: 'person' | 'pet',
    subjectId: string,
    window?: { from: Date; to: Date },
  ): Promise<{ id: string; localDateTime: Date }[]> {
    return this.db
      .selectFrom('asset')
      .select(['asset.id', 'asset.localDateTime'])
      .where('asset.ownerId', '=', ownerId)
      .where(isTimelineVisible('asset'))
      .where('asset.deletedAt', 'is', null)
      .where((eb) =>
        eb.exists((qb) =>
          qb
            .selectFrom('asset_file')
            .whereRef('asset_file.assetId', '=', 'asset.id')
            .where('asset_file.type', '=', AssetFileType.Preview),
        ),
      )
      .where((eb) =>
        subject === 'person'
          ? eb.exists((qb) =>
              qb
                .selectFrom('asset_face')
                .innerJoin('person', (join) =>
                  join
                    .onRef('person.personGroupId', '=', 'asset_face.personGroupId')
                    .onRef('person.ownerId', '=', 'asset.ownerId'),
                )
                .whereRef('asset_face.assetId', '=', 'asset.id')
                .where('asset_face.deletedAt', 'is', null)
                .where('asset_face.isVisible', '=', true)
                .where('asset_face.personGroupId', '=', subjectId),
            )
          : eb.exists((qb) =>
              qb
                .selectFrom('pet_observation')
                .innerJoin('pet', 'pet.id', 'pet_observation.petId')
                .whereRef('pet_observation.assetId', '=', 'asset.id')
                .whereRef('pet.ownerId', '=', 'asset.ownerId')
                .where('pet_observation.state', '=', PetObservationState.Confirmed)
                .where('pet.id', '=', subjectId),
            ),
      )
      .$if(!!window, (qb) =>
        qb.where('asset.localDateTime', '>=', window!.from).where('asset.localDateTime', '<', window!.to),
      )
      .orderBy('asset.localDateTime', 'asc')
      .limit(5000)
      .execute();
  }

  /**
   * FL-62: the owner's named, visible people and pets with at least `minAssets` of the owner's
   * timeline items in a local-time window, most items first.
   */
  async getRecapSubjects(
    ownerId: string,
    window: { from: Date; to: Date },
    minAssets: number,
    limit: number,
  ): Promise<{ subject: 'person' | 'pet'; id: string; name: string; count: number }[]> {
    const { rows } = await sql<{ subject: 'person' | 'pet'; id: string; name: string; count: number }>`
      SELECT * FROM (
        SELECT 'person' AS subject, person."personGroupId"::text AS id, person.name, count(DISTINCT asset.id)::int AS count
        FROM person
        INNER JOIN asset_face ON asset_face."personGroupId" = person."personGroupId"
          AND asset_face."deletedAt" IS NULL AND asset_face."isVisible" = true
        INNER JOIN asset ON asset.id = asset_face."assetId" AND asset."ownerId" = person."ownerId"
        WHERE person."ownerId" = ${ownerId}::uuid AND person."isHidden" = false AND person.name <> ''
          AND asset.visibility = ${AssetVisibility.Timeline} AND asset."deletedAt" IS NULL
          AND asset."localDateTime" >= ${window.from} AND asset."localDateTime" < ${window.to}
        GROUP BY person."personGroupId", person.name
        UNION ALL
        SELECT 'pet' AS subject, pet.id::text AS id, pet.name, count(DISTINCT asset.id)::int AS count
        FROM pet
        INNER JOIN pet_observation ON pet_observation."petId" = pet.id
          AND pet_observation.state = ${PetObservationState.Confirmed}
        INNER JOIN asset ON asset.id = pet_observation."assetId" AND asset."ownerId" = pet."ownerId"
        WHERE pet."ownerId" = ${ownerId}::uuid AND pet."isHidden" = false AND pet.name <> ''
          AND asset.visibility = ${AssetVisibility.Timeline} AND asset."deletedAt" IS NULL
          AND asset."localDateTime" >= ${window.from} AND asset."localDateTime" < ${window.to}
        GROUP BY pet.id, pet.name
      ) subjects
      WHERE count >= ${minAssets}
      ORDER BY count DESC, name
      LIMIT ${limit}
    `.execute(this.db);
    return rows;
  }

  /** FL-62: the owner's memories of one type whose data names this subject, for duplicate suppression. */
  async hasSubjectMemory(ownerId: string, type: MemoryType, subjectId: string, year: number): Promise<boolean> {
    const row = await this.db
      .selectFrom('memory')
      .select('memory.id')
      .where('ownerId', '=', ownerId)
      .where('type', '=', type)
      .where(sql`"memory"."data"->>'subjectId'`, '=', subjectId)
      .where(sql`("memory"."data"->>'year')::int`, '=', year)
      .limit(1)
      .executeTakeFirst();
    return !!row;
  }

  /** FL-62: names of the owner's own people or pets among these ids; another owner's never match. */
  async getOwnSubjectNames(ownerId: string, subject: 'person' | 'pet', ids: string[]): Promise<Map<string, string>> {
    const valid = ids.filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
    if (valid.length === 0) {
      return new Map();
    }
    const rows =
      subject === 'person'
        ? await this.db
            .selectFrom('person')
            .select(['person.personGroupId as id', 'person.name'])
            .where('person.ownerId', '=', ownerId)
            .where('person.personGroupId', 'in', valid)
            .execute()
        : await this.db
            .selectFrom('pet')
            .select(['pet.id', 'pet.name'])
            .where('pet.ownerId', '=', ownerId)
            .where('pet.id', 'in', valid)
            .execute();
    return new Map(rows.map(({ id, name }) => [id, name]));
  }
}
