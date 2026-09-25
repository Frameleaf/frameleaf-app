import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Selectable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { SearchFilter } from 'src/dtos/search.dto.js';
import { AlbumKind, AlbumUserRole, AssetStatus, MediaOperationKind, SourceType, VideoMomentSource } from 'src/enum.js';
import { lockPublicForkWrites, withPublicForkWrites } from 'src/repositories/fork-write-guard.js';
import { MediaOperation } from 'src/repositories/media-operation.repository.js';
import { DB } from 'src/schema/index.js';
import {
  PreservationItemTable,
  PreservationPackageTable,
  PreservationRestoreItemTable,
  PreservationRestoreTable,
} from 'src/schema/tables/preservation.table.js';
import { anyUuid, searchAssetBuilder } from 'src/utils/database.js';
import { isLocked, isNotLocked } from 'src/utils/locked.js';

/** FL-44 (FN-304): what every write here answers while a database handoff holds the schema. */
export const PRESERVATION_HANDOFF_REFUSAL = 'Preservation packages are unavailable during database handoff';

export type PreservationPackage = Selectable<PreservationPackageTable>;
export type PreservationItem = Selectable<PreservationItemTable>;
export type PreservationRestore = Selectable<PreservationRestoreTable>;
export type PreservationRestoreItem = Selectable<PreservationRestoreItemTable>;

/** What an export may select: a structured filter, or items chosen one by one. Never both. */
export type PreservationSelection = { filter?: SearchFilter; assetIds?: string[] };

/** A package's items by state, how many are Locked, and the bytes of what was copied. */
export type PreservationItemCounts = {
  states: Record<string, number>;
  locked: number;
  bytes: number;
  /**
   * Skipped items whose original could not be read — gone, trashed or no longer this owner's — as
   * opposed to Locked items a package deliberately left out. A package missing any of them is not
   * complete (FL-74).
   */
  unavailable: number;
};

export type PreservationPreviewCounts = {
  items: number;
  bytes: number;
  lockedItems: number;
  lockedBytes: number;
};

/**
 * A jsonb value, serialized exactly once. The driver JSON-encodes a parameter it is told is jsonb, so
 * the already-serialized text is cast through `text`; a bare `::jsonb` would store a JSON string.
 */
const jsonb = (value: unknown) => sql<any>`${JSON.stringify(value)}::text::jsonb`;

const toNumber = (value: unknown) => Number(value ?? 0);

/**
 * A package item is Locked when it was written Locked or its original has been locked in the library
 * since. Background work reads every item; an ordinary (not unlocked) session is never told such an
 * item exists, not even as a count (owner decision, September 22, 2026).
 */
const lockedPackageItem = sql<boolean>`(preservation_item.locked or exists (
  select 1 from asset_lock where asset_lock."assetId" = preservation_item."assetId"
))`;

/**
 * A restoration item is Locked when the package says so or the original it matched in the library is
 * Locked there: its current values would otherwise reach an ordinary session as a conflict.
 */
const lockedRestoreItem = sql<boolean>`(preservation_restore_item.locked or exists (
  select 1 from asset_lock where asset_lock."assetId" = preservation_restore_item."assetId"
))`;

/**
 * The database side of preservation packages (FL-74).
 *
 * Every read that answers a request is scoped to the owner in the query itself; a package or a
 * restoration that is not yours reads as absent. The worker's writes are conditional on the state
 * they expect, so an item that a previous attempt already finished is never done twice.
 */
@Injectable()
export class PreservationRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /** FL-44 (FN-304): a write, refused while a database handoff holds the schema. */
  private write<T>(query: (db: Kysely<DB>) => Promise<T>): Promise<T> {
    return withPublicForkWrites(this.db, query, PRESERVATION_HANDOFF_REFUSAL);
  }

  /* ---------------------------------------------------------------- */
  /* Selection                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * The owner's own originals a selection matches: never a partner's, a shared album's or a shared
   * space's, never one in the trash, and Locked ones only when `includeLocked` says so.
   */
  private selection(db: Kysely<DB>, ownerId: string, selection: PreservationSelection, includeLocked: boolean) {
    return searchAssetBuilder(
      db,
      { filter: selection.assetIds ? {} : (selection.filter ?? {}), userIds: [ownerId] },
      {
        userIds: [ownerId],
        lockedOwnerId: includeLocked ? ownerId : '',
        lockedMotion: { lockedOwnerId: includeLocked ? ownerId : undefined },
      },
    )
      .$if(!!selection.assetIds, (qb) => qb.where('asset.id', '=', anyUuid(selection.assetIds!)))
      .where('asset.ownerId', '=', ownerId)
      .where('asset.deletedAt', 'is', null)
      .where('asset.status', '=', AssetStatus.Active)
      .$if(!includeLocked, (qb) => qb.where(isNotLocked('asset')));
  }

  /** How many items a selection holds and how large they are, split by whether they are Locked. */
  async previewSelection(ownerId: string, selection: PreservationSelection): Promise<PreservationPreviewCounts> {
    const matched = this.selection(this.db, ownerId, selection, true).select([
      'asset.id',
      isLocked('asset').as('locked'),
      'asset_exif.fileSizeInByte as bytes',
    ]);
    const row = await this.db
      .selectFrom(matched.as('matched'))
      .select([
        sql<string>`count(*) filter (where not matched.locked)`.as('items'),
        sql<string>`coalesce(sum(matched.bytes) filter (where not matched.locked), 0)`.as('bytes'),
        sql<string>`count(*) filter (where matched.locked)`.as('lockedItems'),
        sql<string>`coalesce(sum(matched.bytes) filter (where matched.locked), 0)`.as('lockedBytes'),
      ])
      .executeTakeFirst();
    return {
      items: toNumber(row?.items),
      bytes: toNumber(row?.bytes),
      lockedItems: toNumber(row?.lockedItems),
      lockedBytes: toNumber(row?.lockedBytes),
    };
  }

  /**
   * Create an export package and freeze its selection as items, in one transaction. The Live Photo
   * video of every selected still comes with it. Returns null, and writes nothing, when the
   * selection holds more than `maxItems`.
   */
  async createExport(
    input: Omit<Insertable<PreservationPackageTable>, 'path'>,
    pathFor: (packageId: string) => string,
    selection: PreservationSelection,
    includeLocked: boolean,
    maxItems: number,
  ): Promise<{ package: PreservationPackage; items: number } | null> {
    return this.db
      .transaction()
      .execute(async (tx) => {
        await lockPublicForkWrites(tx, PRESERVATION_HANDOFF_REFUSAL);
        const inserted = await tx
          .insertInto('preservation_package')
          .values({ ...input, path: '' })
          .returning('id')
          .executeTakeFirstOrThrow();
        // The folder is named after the package, whose id the database assigns.
        const created = await tx
          .updateTable('preservation_package')
          .set({ path: pathFor(inserted.id) })
          .where('id', '=', inserted.id)
          .returningAll()
          .executeTakeFirstOrThrow();

        const chosen = this.selection(tx, input.ownerId, selection, includeLocked).select((eb) => [
          sql<string>`${created.id}::uuid`.as('packageId'),
          eb.ref('asset.id').as('sourceAssetId'),
          eb.ref('asset.id').as('assetId'),
          isLocked('asset').as('locked'),
        ]);
        await tx
          .insertInto('preservation_item')
          .columns(['packageId', 'sourceAssetId', 'assetId', 'locked'])
          .expression(chosen)
          .onConflict((oc) => oc.doNothing())
          .execute();

        // The video half of a selected Live Photo, when it is the owner's and allowed in this package.
        await sql`
        insert into preservation_item ("packageId", "sourceAssetId", "assetId", "locked")
        select ${created.id}::uuid, motion.id, motion.id, ${isLocked('motion')}
        from preservation_item item
        inner join asset still on still.id = item."assetId"
        inner join asset motion on motion.id = still."livePhotoVideoId"
        where item."packageId" = ${created.id}::uuid
          and motion."ownerId" = ${input.ownerId}::uuid
          and motion."deletedAt" is null
          and (${includeLocked} or not ${isLocked('motion')})
        on conflict do nothing
      `.execute(tx);

        const counted = await tx
          .selectFrom('preservation_item')
          .select((eb) => eb.fn.countAll<string>().as('count'))
          .where('packageId', '=', created.id)
          .executeTakeFirstOrThrow();
        const items = Number(counted.count);
        if (items > maxItems) {
          // Rolls the package and its items back.
          throw new SelectionTooLargeError(items);
        }
        return { package: created, items };
      })
      .catch((error) => {
        if (error instanceof SelectionTooLargeError) {
          return null;
        }
        throw error;
      });
  }

  /* ---------------------------------------------------------------- */
  /* Packages                                                          */
  /* ---------------------------------------------------------------- */

  async createPackage(input: Insertable<PreservationPackageTable>): Promise<PreservationPackage> {
    return this.write((db) =>
      db.insertInto('preservation_package').values(input).returningAll().executeTakeFirstOrThrow(),
    );
  }

  getPackage(id: string, ownerId: string): Promise<PreservationPackage | undefined> {
    return this.db
      .selectFrom('preservation_package')
      .selectAll()
      .where('id', '=', id)
      .where('ownerId', '=', ownerId)
      .executeTakeFirst();
  }

  /** For the worker, which acts for the owner named on the job. */
  getPackageById(id: string): Promise<PreservationPackage | undefined> {
    return this.db.selectFrom('preservation_package').selectAll().where('id', '=', id).executeTakeFirst();
  }

  listPackages(ownerId: string, take = 100): Promise<PreservationPackage[]> {
    return this.db
      .selectFrom('preservation_package')
      .selectAll()
      .where('ownerId', '=', ownerId)
      .where('removedAt', 'is', null)
      .orderBy('createdAt', 'desc')
      .limit(take)
      .execute();
  }

  async updatePackage(
    id: string,
    patch: {
      status?: string;
      manifest?: Record<string, unknown> | null;
      verification?: Record<string, unknown> | null;
      verifiedAt?: Date | null;
      sizeBytes?: number | null;
      removedAt?: Date | null;
    },
  ): Promise<void> {
    await this.write((db) =>
      db
        .updateTable('preservation_package')
        .set({
          ...(patch.status !== undefined && { status: patch.status }),
          ...(patch.manifest !== undefined && { manifest: patch.manifest === null ? null : jsonb(patch.manifest) }),
          ...(patch.verification !== undefined && {
            verification: patch.verification === null ? null : jsonb(patch.verification),
          }),
          ...(patch.verifiedAt !== undefined && { verifiedAt: patch.verifiedAt }),
          ...(patch.sizeBytes !== undefined && { sizeBytes: patch.sizeBytes }),
          ...(patch.removedAt !== undefined && { removedAt: patch.removedAt }),
        })
        .where('id', '=', id)
        .execute(),
    );
  }

  /** Uploaded packages past their expiry whose files are still on disk. */
  listExpiredUploads(now: Date, limit = 100): Promise<PreservationPackage[]> {
    return this.db
      .selectFrom('preservation_package')
      .selectAll()
      .where('origin', '=', 'upload')
      .where('removedAt', 'is', null)
      .where('expiresAt', '<', now)
      .orderBy('expiresAt', 'asc')
      .limit(limit)
      .execute();
  }

  /**
   * Item counts by state, and how many are Locked, for each package. `excludeLocked` leaves Locked
   * items out of every count, for a session that has not unlocked.
   */
  async countItems(
    packageIds: string[],
    options: { excludeLocked?: boolean } = {},
  ): Promise<Map<string, PreservationItemCounts>> {
    const counts = new Map<string, PreservationItemCounts>();
    if (packageIds.length === 0) {
      return counts;
    }
    const rows = await this.db
      .selectFrom('preservation_item')
      .select([
        'packageId',
        'state',
        sql<string>`count(*)`.as('count'),
        sql<string>`count(*) filter (where ${lockedPackageItem})`.as('locked'),
        sql<string>`coalesce(sum(("entry"->'original'->>'bytes')::bigint), 0)`.as('bytes'),
        sql<string>`count(*) filter (where preservation_item.state = 'skipped' and preservation_item."reasonKey" is distinct from 'locked_excluded')`.as(
          'unavailable',
        ),
      ])
      .where('packageId', '=', anyUuid(packageIds))
      .$if(!!options.excludeLocked, (qb) => qb.where(sql<boolean>`not ${lockedPackageItem}`))
      .groupBy(['packageId', 'state'])
      .execute();
    for (const row of rows) {
      const entry = counts.get(row.packageId) ?? { states: {}, locked: 0, bytes: 0, unavailable: 0 };
      entry.states[row.state] = Number(row.count);
      entry.locked += Number(row.locked);
      entry.bytes += Number(row.bytes);
      entry.unavailable += Number(row.unavailable);
      counts.set(row.packageId, entry);
    }
    return counts;
  }

  /** Verification results for a package, by result. */
  async countVerified(packageId: string): Promise<Record<string, number>> {
    const rows = await this.db
      .selectFrom('preservation_item')
      .select(['verifyState', sql<string>`count(*)`.as('count')])
      .where('packageId', '=', packageId)
      .where('entry', 'is not', null)
      .groupBy('verifyState')
      .execute();
    return Object.fromEntries(rows.map((row) => [row.verifyState ?? 'unchecked', Number(row.count)]));
  }

  /** The newest job for each package or restoration, keyed by the id its snapshot names. */
  async latestOperations(
    ownerId: string,
    key: 'packageId' | 'restoreId',
    ids: string[],
  ): Promise<Map<string, MediaOperation>> {
    const latest = new Map<string, MediaOperation>();
    if (ids.length === 0) {
      return latest;
    }
    const rows = await sql<MediaOperation & { subject: string }>`
      select distinct on (subject) *
      from (
        select media_operation.*, media_operation."snapshot"->>${key} as subject
        from media_operation
        where media_operation."ownerId" = ${ownerId}::uuid
          and media_operation."kind" in (${sql.join([
            MediaOperationKind.PreservationExport,
            MediaOperationKind.PreservationVerify,
            MediaOperationKind.PreservationReview,
            MediaOperationKind.PreservationRestore,
          ])})
          and media_operation."snapshot"->>${key} = any(${`{${ids}}`}::text[])
      ) as operation
      order by subject, "createdAt" desc, id desc
    `.execute(this.db);
    for (const row of rows.rows) {
      latest.set(row.subject, row);
    }
    return latest;
  }

  /** A job on this package or restoration that has not finished, if any. */
  async activeOperation(
    ownerId: string,
    key: 'packageId' | 'restoreId',
    id: string,
  ): Promise<MediaOperation | undefined> {
    const { rows } = await sql<MediaOperation>`
      select * from media_operation
      where "ownerId" = ${ownerId}::uuid
        and "snapshot"->>${key} = ${id}
        and "status" not in ('completed', 'cancelled', 'failed')
      order by "createdAt" desc
      limit 1
    `.execute(this.db);
    return rows[0];
  }

  /** Another job on the same package or restoration that a worker holds right now. */
  async otherClaimedOperation(
    ownerId: string,
    key: 'packageId' | 'restoreId',
    id: string,
    selfId: string,
  ): Promise<boolean> {
    const { rows } = await sql<{ id: string }>`
      select id from media_operation
      where "ownerId" = ${ownerId}::uuid
        and "snapshot"->>${key} = ${id}
        and id <> ${selfId}::uuid
        and "status" in ('preparing', 'rendering', 'validating', 'cancelling')
        and "claimExpiresAt" > now()
      limit 1
    `.execute(this.db);
    return rows.length > 0;
  }

  /* ---------------------------------------------------------------- */
  /* Items                                                             */
  /* ---------------------------------------------------------------- */

  async listItems(
    packageId: string,
    options: { state?: string; verifyState?: string; take: number; skip: number; excludeLocked?: boolean },
  ): Promise<{ items: PreservationItem[]; total: number }> {
    let query = this.db.selectFrom('preservation_item').where('packageId', '=', packageId);
    if (options.excludeLocked) {
      query = query.where(sql<boolean>`not ${lockedPackageItem}`);
    }
    if (options.state) {
      query = query.where('state', '=', options.state);
    }
    if (options.verifyState) {
      query = query.where('verifyState', '=', options.verifyState);
    }
    const [items, total] = await Promise.all([
      query.selectAll().orderBy('id').limit(options.take).offset(options.skip).execute(),
      query
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .executeTakeFirst()
        .then((row) => Number(row?.count ?? 0)),
    ]);
    return { items, total };
  }

  /** The next export items still to do: never tried, or failed with their automatic retry left. */
  exportWork(
    packageId: string,
    afterId: string | null,
    take: number,
    maxAttempts: number,
  ): Promise<PreservationItem[]> {
    return this.db
      .selectFrom('preservation_item')
      .selectAll()
      .where('packageId', '=', packageId)
      .where((eb) =>
        eb.or([eb('state', '=', 'pending'), eb.and([eb('state', '=', 'failed'), eb('attempts', '<', maxAttempts)])]),
      )
      .$if(!!afterId, (qb) => qb.where('id', '>', afterId!))
      .orderBy('id')
      .limit(take)
      .execute();
  }

  async countExportWork(packageId: string, maxAttempts: number): Promise<number> {
    const row = await this.db
      .selectFrom('preservation_item')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('packageId', '=', packageId)
      .where((eb) =>
        eb.or([eb('state', '=', 'pending'), eb.and([eb('state', '=', 'failed'), eb('attempts', '<', maxAttempts)])]),
      )
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  /** Record an attempt at an item before it is made, so a crash still counts it. */
  async beginItemAttempt(id: string): Promise<void> {
    await this.write((db) =>
      db
        .updateTable('preservation_item')
        .set((eb) => ({ attempts: eb('attempts', '+', 1) }))
        .where('id', '=', id)
        .execute(),
    );
  }

  async finishItem(
    id: string,
    patch: {
      state: string;
      entry?: Record<string, unknown> | null;
      locked?: boolean;
      reasonKey?: string | null;
      error?: string | null;
    },
  ): Promise<void> {
    await this.write((db) =>
      db
        .updateTable('preservation_item')
        .set({
          state: patch.state,
          ...(patch.entry !== undefined && { entry: patch.entry === null ? null : jsonb(patch.entry) }),
          ...(patch.locked !== undefined && { locked: patch.locked }),
          reasonKey: patch.reasonKey ?? null,
          error: patch.error ?? null,
          verifyState: null,
        })
        .where('id', '=', id)
        .execute(),
    );
  }

  /** A manual retry: every failed item gets its attempts, and its automatic retry, back. */
  async resetFailedItems(packageId: string): Promise<number> {
    const result = await this.write((db) =>
      db
        .updateTable('preservation_item')
        .set({ attempts: 0 })
        .where('packageId', '=', packageId)
        .where('state', '=', 'failed')
        .executeTakeFirst(),
    );
    return Number(result.numUpdatedRows);
  }

  /** Items in the package, in index order, a page at a time. */
  listedItems(packageId: string, afterSourceId: string | null, take: number): Promise<PreservationItem[]> {
    return this.db
      .selectFrom('preservation_item')
      .selectAll()
      .where('packageId', '=', packageId)
      .where('entry', 'is not', null)
      .where('state', 'in', ['copied', 'listed'])
      .$if(!!afterSourceId, (qb) => qb.where('sourceAssetId', '>', afterSourceId!))
      .orderBy('sourceAssetId')
      .limit(take)
      .execute();
  }

  /**
   * Record the index of a package this server did not write. An item is added once; reading the
   * index again replaces its entry but never its identity.
   */
  async upsertListedItems(
    packageId: string,
    entries: Array<{ sourceAssetId: string; locked: boolean; entry: Record<string, unknown> }>,
  ) {
    if (entries.length === 0) {
      return;
    }
    await this.write((db) =>
      db
        .insertInto('preservation_item')
        .values(
          entries.map((item) => ({
            packageId,
            sourceAssetId: item.sourceAssetId,
            state: 'listed',
            locked: item.locked,
            entry: jsonb(item.entry),
          })),
        )
        .onConflict((oc) =>
          oc.columns(['packageId', 'sourceAssetId']).doUpdateSet((eb) => ({
            entry: eb.ref('excluded.entry'),
            locked: eb.ref('excluded.locked'),
            verifyState: null,
          })),
        )
        .execute(),
    );
  }

  /** Items whose export entry the index does not match, found while reading it back. */
  async itemIdsBySource(packageId: string, sourceAssetIds: string[]): Promise<Map<string, PreservationItem>> {
    if (sourceAssetIds.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .selectFrom('preservation_item')
      .selectAll()
      .where('packageId', '=', packageId)
      .where('sourceAssetId', '=', anyUuid(sourceAssetIds))
      .execute();
    return new Map(rows.map((row) => [row.sourceAssetId, row]));
  }

  /** Start a verification: every listed item is unchecked again. */
  async resetVerification(packageId: string): Promise<void> {
    await this.write((db) =>
      db
        .updateTable('preservation_item')
        .set({ verifyState: null })
        .where('packageId', '=', packageId)
        .where('entry', 'is not', null)
        .execute(),
    );
  }

  verificationWork(packageId: string, afterId: string | null, take: number): Promise<PreservationItem[]> {
    return this.db
      .selectFrom('preservation_item')
      .selectAll()
      .where('packageId', '=', packageId)
      .where('entry', 'is not', null)
      .where('state', 'in', ['copied', 'listed'])
      .where('verifyState', 'is', null)
      .$if(!!afterId, (qb) => qb.where('id', '>', afterId!))
      .orderBy('id')
      .limit(take)
      .execute();
  }

  async setVerifyState(id: string, verifyState: string, reasonKey: string | null): Promise<void> {
    await this.write((db) =>
      db.updateTable('preservation_item').set({ verifyState, reasonKey }).where('id', '=', id).execute(),
    );
  }

  /** Items the index lists that a verification marked unexpected: listed but not in the package's own journal. */
  async markUnlisted(packageId: string, sourceAssetIds: string[]): Promise<void> {
    if (sourceAssetIds.length === 0) {
      return;
    }
    await this.write((db) =>
      db
        .updateTable('preservation_item')
        .set({ verifyState: 'changed', reasonKey: 'package_index_changed' })
        .where('packageId', '=', packageId)
        .where('sourceAssetId', '=', anyUuid(sourceAssetIds))
        .execute(),
    );
  }

  /** Whether any item of the package is Locked in the library now, or was when it was written. */
  async hasLockedItems(packageId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('preservation_item')
      .select('preservation_item.id')
      .leftJoin('asset', 'asset.id', 'preservation_item.assetId')
      .where('preservation_item.packageId', '=', packageId)
      .where('preservation_item.state', 'in', ['copied', 'listed'])
      .where((eb) =>
        eb.or([
          eb('preservation_item.locked', '=', true),
          eb.and([eb('asset.id', 'is not', null), sql<boolean>`${isLocked('asset')}`]),
        ]),
      )
      .limit(1)
      .executeTakeFirst();
    return !!row;
  }

  /** Which of these package items are Locked now or were when written: withheld from an ordinary session. */
  async lockedItemIds(items: Array<Pick<PreservationItem, 'id' | 'assetId' | 'locked'>>): Promise<Set<string>> {
    const hidden = new Set(items.filter((item) => item.locked).map((item) => item.id));
    const assetIds = items.filter((item) => !item.locked && item.assetId).map((item) => item.assetId!);
    if (assetIds.length > 0) {
      const rows = await this.db
        .selectFrom('asset_lock')
        .select('assetId')
        .where('assetId', '=', anyUuid(assetIds))
        .execute();
      const locked = new Set(rows.map((row) => row.assetId));
      for (const item of items) {
        if (item.assetId && locked.has(item.assetId)) {
          hidden.add(item.id);
        }
      }
    }
    return hidden;
  }

  /* ---------------------------------------------------------------- */
  /* Export reads: one original and what the library knows about it    */
  /* ---------------------------------------------------------------- */

  getExportAsset(id: string) {
    return this.db
      .selectFrom('asset')
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select([
        'asset.id',
        'asset.ownerId',
        'asset.type',
        'asset.originalPath',
        'asset.originalFileName',
        'asset.checksum',
        'asset.fileCreatedAt',
        'asset.fileModifiedAt',
        'asset.localDateTime',
        'asset.isFavorite',
        'asset.visibility',
        'asset.livePhotoVideoId',
        'asset.stackId',
        'asset.isEdited',
        'asset.isOffline',
        'asset.deletedAt',
        'asset.status',
        'asset.width',
        'asset.height',
        'asset_exif.dateTimeOriginal',
        'asset_exif.timeZone',
        'asset_exif.latitude',
        'asset_exif.longitude',
        'asset_exif.city',
        'asset_exif.state',
        'asset_exif.country',
        'asset_exif.description',
        'asset_exif.rating',
        'asset_exif.make',
        'asset_exif.model',
        'asset_exif.lensModel',
        'asset_exif.fNumber',
        'asset_exif.focalLength',
        'asset_exif.iso',
        'asset_exif.exposureTime',
        'asset_exif.exifImageWidth',
        'asset_exif.exifImageHeight',
        'asset_exif.orientation',
        'asset_exif.projectionType',
        isLocked('asset').as('isLocked'),
      ])
      .where('asset.id', '=', id)
      .executeTakeFirst();
  }

  getLock(assetId: string) {
    return this.db
      .selectFrom('asset_lock')
      .select(['reason', 'lockedAt'])
      .where('assetId', '=', assetId)
      .executeTakeFirst();
  }

  async getTagValues(assetId: string, ownerId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('tag_asset')
      .innerJoin('tag', 'tag.id', 'tag_asset.tagId')
      .select('tag.value')
      .where('tag_asset.assetId', '=', assetId)
      .where('tag.userId', '=', ownerId)
      .orderBy('tag.value')
      .execute();
    return rows.map((row) => row.value);
  }

  /** Albums and collections the owner owns that hold this asset. Shared spaces are sharing, not included. */
  async getOwnedAlbumIds(assetId: string, ownerId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('album_asset')
      .innerJoin('album', 'album.id', 'album_asset.albumId')
      .innerJoin('album_user', (join) =>
        join
          .onRef('album_user.albumId', '=', 'album.id')
          .on('album_user.userId', '=', ownerId)
          .on('album_user.role', '=', AlbumUserRole.Owner),
      )
      .select('album.id')
      .where('album_asset.assetId', '=', assetId)
      .where('album.deletedAt', 'is', null)
      .where('album.kind', 'in', [AlbumKind.Album, AlbumKind.Collection])
      .orderBy('album.id')
      .execute();
    return rows.map((row) => row.id);
  }

  /** The owner's named people in this asset, with the face regions they were named in. */
  getNamedFaces(assetId: string, ownerId: string) {
    return this.db
      .selectFrom('asset_face')
      .innerJoin('person', (join) =>
        join.onRef('person.personGroupId', '=', 'asset_face.personGroupId').on('person.ownerId', '=', ownerId),
      )
      .select([
        'asset_face.personGroupId',
        'asset_face.imageWidth',
        'asset_face.imageHeight',
        'asset_face.boundingBoxX1',
        'asset_face.boundingBoxY1',
        'asset_face.boundingBoxX2',
        'asset_face.boundingBoxY2',
        'asset_face.sourceType',
      ])
      .where('asset_face.assetId', '=', assetId)
      .where('asset_face.deletedAt', 'is', null)
      .where('asset_face.isVisible', '=', true)
      .where('person.name', '!=', '')
      .execute();
  }

  getEditRecipe(assetId: string) {
    return this.db
      .selectFrom('asset_edit')
      .select(['action', 'parameters'])
      .where('assetId', '=', assetId)
      .orderBy('sequence')
      .execute();
  }

  getDocumentEdits(assetId: string) {
    return this.db
      .selectFrom('asset_document_edit')
      .select(['key', 'action', 'value', 'x1', 'y1', 'x2', 'y2', 'x3', 'y3', 'x4', 'y4'])
      .where('assetId', '=', assetId)
      .orderBy('key')
      .execute();
  }

  getMoments(assetId: string) {
    return this.db
      .selectFrom('video_moment')
      .select(['source', 'timestampMs', 'endMs', 'caption', 'transcript', 'provenance'])
      .where('assetId', '=', assetId)
      .orderBy('timestampMs')
      .orderBy('id')
      .execute();
  }

  getStackPrimary(stackId: string) {
    return this.db.selectFrom('stack').select(['id', 'primaryAssetId']).where('id', '=', stackId).executeTakeFirst();
  }

  getEnrichmentMetadata(assetId: string) {
    return this.db
      .selectFrom('asset_metadata')
      .select('value')
      .where('assetId', '=', assetId)
      .where('key', '=', 'ml-enrichment')
      .executeTakeFirst();
  }

  /** The owner's albums the copied items belong to, with the collections that hold them. */
  async getPackageAlbums(packageId: string, ownerId: string) {
    const { rows } = await sql<{
      id: string;
      albumName: string;
      description: string | null;
      kind: string;
      parentId: string | null;
      icon: string | null;
      order: string | null;
    }>`
      with owned as (
        select album.id, album."albumName", album.description, album.kind, album."parentId", album.icon, album."order"
        from album
        inner join album_user on album_user."albumId" = album.id
          and album_user."userId" = ${ownerId}::uuid and album_user.role = ${AlbumUserRole.Owner}
        where album."deletedAt" is null and album.kind in (${AlbumKind.Album}, ${AlbumKind.Collection})
      ),
      holding as (
        select distinct owned.* from owned
        inner join album_asset on album_asset."albumId" = owned.id
        inner join preservation_item item on item."assetId" = album_asset."assetId"
          and item."packageId" = ${packageId}::uuid and item.state = 'copied'
      )
      select * from holding
      union
      select owned.* from owned inner join holding on holding."parentId" = owned.id
    `.execute(this.db);
    return rows;
  }

  /** The owner's named people with a face in a copied item. */
  async getPackagePeople(packageId: string, ownerId: string) {
    const { rows } = await sql<{
      personGroupId: string;
      name: string;
      birthDate: Date | string | null;
      isHidden: boolean;
      isFavorite: boolean;
      color: string | null;
    }>`
      select distinct person."personGroupId", person.name, person."birthDate", person."isHidden", person."isFavorite", person.color
      from preservation_item item
      inner join asset_face face on face."assetId" = item."assetId" and face."deletedAt" is null and face."isVisible"
      inner join person on person."personGroupId" = face."personGroupId" and person."ownerId" = ${ownerId}::uuid
      where item."packageId" = ${packageId}::uuid and item.state = 'copied' and person.name <> ''
    `.execute(this.db);
    return rows;
  }

  /** The owner's tags on copied items. */
  async getPackageTags(packageId: string, ownerId: string) {
    const { rows } = await sql<{ value: string; color: string | null }>`
      select distinct tag.value, tag.color
      from preservation_item item
      inner join tag_asset on tag_asset."assetId" = item."assetId"
      inner join tag on tag.id = tag_asset."tagId" and tag."userId" = ${ownerId}::uuid
      where item."packageId" = ${packageId}::uuid and item.state = 'copied'
      order by tag.value
    `.execute(this.db);
    return rows;
  }

  /* ---------------------------------------------------------------- */
  /* Restorations                                                      */
  /* ---------------------------------------------------------------- */

  createRestore(input: Insertable<PreservationRestoreTable>): Promise<PreservationRestore> {
    return this.write((db) =>
      db
        .insertInto('preservation_restore')
        .values({ ...input, options: jsonb(input.options) })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  getRestore(id: string, ownerId: string): Promise<PreservationRestore | undefined> {
    return this.db
      .selectFrom('preservation_restore')
      .selectAll()
      .where('id', '=', id)
      .where('ownerId', '=', ownerId)
      .executeTakeFirst();
  }

  getRestoreById(id: string): Promise<PreservationRestore | undefined> {
    return this.db.selectFrom('preservation_restore').selectAll().where('id', '=', id).executeTakeFirst();
  }

  listRestores(ownerId: string, take = 50): Promise<PreservationRestore[]> {
    return this.db
      .selectFrom('preservation_restore')
      .selectAll()
      .where('ownerId', '=', ownerId)
      .orderBy('createdAt', 'desc')
      .limit(take)
      .execute();
  }

  async updateRestore(
    id: string,
    patch: {
      status?: string;
      packageIdentity?: string | null;
      options?: Record<string, unknown>;
      summary?: Record<string, unknown> | null;
    },
  ): Promise<void> {
    await this.write((db) =>
      db
        .updateTable('preservation_restore')
        .set({
          ...(patch.status !== undefined && { status: patch.status }),
          ...(patch.packageIdentity !== undefined && { packageIdentity: patch.packageIdentity }),
          ...(patch.options !== undefined && { options: jsonb(patch.options) }),
          ...(patch.summary !== undefined && { summary: patch.summary === null ? null : jsonb(patch.summary) }),
        })
        .where('id', '=', id)
        .execute(),
    );
  }

  /** Record the package's index as restoration items; reading it again adds nothing twice. */
  async addRestoreItems(
    restoreId: string,
    entries: Array<{ sourceAssetId: string; locked: boolean; entry: Record<string, unknown> }>,
  ): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    await this.write((db) =>
      db
        .insertInto('preservation_restore_item')
        .values(
          entries.map((item) => ({
            restoreId,
            sourceAssetId: item.sourceAssetId,
            state: 'pending',
            locked: item.locked,
            entry: jsonb(item.entry),
          })),
        )
        .onConflict((oc) => oc.columns(['restoreId', 'sourceAssetId']).doNothing())
        .execute(),
    );
  }

  reviewWork(restoreId: string, afterId: string | null, take: number): Promise<PreservationRestoreItem[]> {
    return this.db
      .selectFrom('preservation_restore_item')
      .selectAll()
      .where('restoreId', '=', restoreId)
      .where('state', '=', 'pending')
      .$if(!!afterId, (qb) => qb.where('id', '>', afterId!))
      .orderBy('id')
      .limit(take)
      .execute();
  }

  /** Items the restore still has to apply: reviewed, not applied, with their automatic retry left. */
  restoreWork(
    restoreId: string,
    afterId: string | null,
    take: number,
    maxAttempts: number,
  ): Promise<PreservationRestoreItem[]> {
    return this.db
      .selectFrom('preservation_restore_item')
      .selectAll()
      .where('restoreId', '=', restoreId)
      .where('appliedAt', 'is', null)
      .where((eb) =>
        eb.or([
          eb('state', '=', 'ready'),
          eb('state', '=', 'creating'),
          eb.and([eb('state', '=', 'failed'), eb('match', 'is not', null), eb('attempts', '<', maxAttempts)]),
        ]),
      )
      .$if(!!afterId, (qb) => qb.where('id', '>', afterId!))
      .orderBy('id')
      .limit(take)
      .execute();
  }

  async countRestoreWork(restoreId: string, maxAttempts: number): Promise<number> {
    const row = await this.db
      .selectFrom('preservation_restore_item')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('restoreId', '=', restoreId)
      .where('appliedAt', 'is', null)
      .where((eb) =>
        eb.or([
          eb('state', '=', 'ready'),
          eb('state', '=', 'creating'),
          eb.and([eb('state', '=', 'failed'), eb('match', 'is not', null), eb('attempts', '<', maxAttempts)]),
        ]),
      )
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  /** Applied items, a page at a time, for the relationship pass. */
  appliedItems(restoreId: string, afterId: string | null, take: number): Promise<PreservationRestoreItem[]> {
    return this.db
      .selectFrom('preservation_restore_item')
      .selectAll()
      .where('restoreId', '=', restoreId)
      .where('appliedAt', 'is not', null)
      .where('assetId', 'is not', null)
      .$if(!!afterId, (qb) => qb.where('id', '>', afterId!))
      .orderBy('id')
      .limit(take)
      .execute();
  }

  /** Restored items carrying a finding, a page at a time. */
  restoreItemsWithFinding(
    restoreId: string,
    finding: string,
    afterId: string | null,
    take: number,
  ): Promise<PreservationRestoreItem[]> {
    return this.db
      .selectFrom('preservation_restore_item')
      .selectAll()
      .where('restoreId', '=', restoreId)
      .where(sql<boolean>`coalesce("findings", '[]'::jsonb) ? ${finding}`)
      .$if(!!afterId, (qb) => qb.where('id', '>', afterId!))
      .orderBy('id')
      .limit(take)
      .execute();
  }

  getRestoreItemBySource(restoreId: string, sourceAssetId: string): Promise<PreservationRestoreItem | undefined> {
    return this.db
      .selectFrom('preservation_restore_item')
      .selectAll()
      .where('restoreId', '=', restoreId)
      .where('sourceAssetId', '=', sourceAssetId)
      .executeTakeFirst();
  }

  async updateRestoreItem(
    id: string,
    patch: {
      state?: string;
      match?: string | null;
      assetId?: string | null;
      sidecar?: Record<string, unknown> | null;
      conflicts?: Record<string, unknown>[] | null;
      findings?: string[] | null;
      reasonKey?: string | null;
      error?: string | null;
      creatingAt?: Date | null;
      appliedAt?: Date | null;
      attempt?: boolean;
    },
  ): Promise<void> {
    await this.write((db) =>
      db
        .updateTable('preservation_restore_item')
        .set((eb) => ({
          ...(patch.state !== undefined && { state: patch.state }),
          ...(patch.match !== undefined && { match: patch.match }),
          ...(patch.assetId !== undefined && { assetId: patch.assetId }),
          ...(patch.sidecar !== undefined && { sidecar: patch.sidecar === null ? null : jsonb(patch.sidecar) }),
          ...(patch.conflicts !== undefined && {
            conflicts: patch.conflicts === null ? null : jsonb(patch.conflicts),
          }),
          ...(patch.findings !== undefined && { findings: patch.findings === null ? null : jsonb(patch.findings) }),
          ...(patch.reasonKey !== undefined && { reasonKey: patch.reasonKey }),
          ...(patch.error !== undefined && { error: patch.error }),
          ...(patch.creatingAt !== undefined && { creatingAt: patch.creatingAt }),
          ...(patch.appliedAt !== undefined && { appliedAt: patch.appliedAt }),
          ...(patch.attempt && { attempts: eb('attempts', '+', 1) }),
        }))
        .where('id', '=', id)
        .execute(),
    );
  }

  async listRestoreItems(
    restoreId: string,
    options: {
      filter?: 'conflicts' | 'failed' | 'findings';
      state?: string;
      take: number;
      skip: number;
      excludeLocked?: boolean;
    },
  ): Promise<{ items: PreservationRestoreItem[]; total: number }> {
    let query = this.db.selectFrom('preservation_restore_item').where('restoreId', '=', restoreId);
    if (options.excludeLocked) {
      query = query.where(sql<boolean>`not ${lockedRestoreItem}`);
    }
    if (options.state) {
      query = query.where('state', '=', options.state);
    }
    switch (options.filter) {
      case 'conflicts': {
        query = query.where(sql<boolean>`jsonb_array_length(coalesce("conflicts", '[]'::jsonb)) > 0`);

        break;
      }
      case 'failed': {
        query = query.where('state', '=', 'failed');

        break;
      }
      case 'findings': {
        query = query.where(sql<boolean>`jsonb_array_length(coalesce("findings", '[]'::jsonb)) > 0`);

        break;
      }
      // No default
    }
    const [items, total] = await Promise.all([
      query.selectAll().orderBy('id').limit(options.take).offset(options.skip).execute(),
      query
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .executeTakeFirst()
        .then((row) => Number(row?.count ?? 0)),
    ]);
    return { items, total };
  }

  /**
   * Counts for a restoration: by state, by what the review matched, conflicts and findings.
   * `excludeLocked` leaves Locked items out of every count, for a session that has not unlocked.
   */
  async countRestoreItems(restoreId: string, options: { excludeLocked?: boolean } = {}) {
    const row = await this.db
      .selectFrom('preservation_restore_item')
      .select([
        sql<string>`count(*)`.as('total'),
        sql<string>`count(*) filter (where state = 'pending')`.as('pending'),
        sql<string>`count(*) filter (where state = 'ready')`.as('ready'),
        sql<string>`count(*) filter (where state = 'failed')`.as('failed'),
        sql<string>`count(*) filter (where state = 'restored')`.as('restored'),
        sql<string>`count(*) filter (where state = 'matched')`.as('matched'),
        sql<string>`count(*) filter (where state = 'skipped')`.as('skipped'),
        sql<string>`count(*) filter (where match = 'new')`.as('new'),
        sql<string>`count(*) filter (where match = 'existing')`.as('existing'),
        sql<string>`count(*) filter (where match = 'trashed')`.as('trashed'),
        sql<string>`count(*) filter (where ${lockedRestoreItem})`.as('locked'),
        sql<string>`count(*) filter (where jsonb_array_length(coalesce("conflicts", '[]'::jsonb)) > 0)`.as('conflicts'),
        sql<string>`count(*) filter (where jsonb_array_length(coalesce("findings", '[]'::jsonb)) > 0)`.as('findings'),
      ])
      .where('restoreId', '=', restoreId)
      .$if(!!options.excludeLocked, (qb) => qb.where(sql<boolean>`not ${lockedRestoreItem}`))
      .executeTakeFirst();
    const count = (value: unknown) => Number(value ?? 0);
    return {
      total: count(row?.total),
      pending: count(row?.pending),
      ready: count(row?.ready),
      failed: count(row?.failed),
      restored: count(row?.restored),
      matched: count(row?.matched),
      skipped: count(row?.skipped),
      new: count(row?.new),
      existing: count(row?.existing),
      trashed: count(row?.trashed),
      locked: count(row?.locked),
      conflicts: count(row?.conflicts),
      findings: count(row?.findings),
    };
  }

  /**
   * Asking to restore again gives the items that failed after a good review their automatic retry
   * back. Items the review could not verify stay failed: their files are what is wrong.
   */
  async resetFailedRestoreItems(restoreId: string): Promise<number> {
    const result = await this.write((db) =>
      db
        .updateTable('preservation_restore_item')
        .set({ attempts: 0 })
        .where('restoreId', '=', restoreId)
        .where('state', '=', 'failed')
        .where('match', 'is not', null)
        .where('appliedAt', 'is', null)
        .executeTakeFirst(),
    );
    return Number(result.numUpdatedRows);
  }

  /** Which of these restoration items are Locked, in the package or in the library. */
  async lockedRestoreItemIds(restoreId: string, ids: string[]): Promise<string[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.db
      .selectFrom('preservation_restore_item')
      .select('id')
      .where('restoreId', '=', restoreId)
      .where('id', '=', anyUuid(ids))
      .where(lockedRestoreItem)
      .execute();
    return rows.map((row) => row.id);
  }

  /** The owner's choices for items not yet applied. Applied items keep what was done with them. */
  async setDecisions(
    restoreId: string,
    items: Array<{ id: string; decisions: Record<string, unknown> }>,
  ): Promise<number> {
    let updated = 0;
    for (const item of items) {
      const result = await this.write((db) =>
        db
          .updateTable('preservation_restore_item')
          .set({ decisions: jsonb(item.decisions) })
          .where('id', '=', item.id)
          .where('restoreId', '=', restoreId)
          .where('appliedAt', 'is', null)
          .executeTakeFirst(),
      );
      updated += Number(result.numUpdatedRows);
    }
    return updated;
  }

  /* ---------------------------------------------------------------- */
  /* Restore: the library side                                         */
  /* ---------------------------------------------------------------- */

  /**
   * The owner's assets with these bytes: the SHA-256 of new uploads and the SHA-1 of older rows and
   * external libraries. The trash counts, so a restore never adds a second copy of something the
   * owner put there.
   */
  findByChecksum(ownerId: string, sha256: string, sha1: string) {
    return (
      this.db
        .selectFrom('asset')
        .select(['asset.id', 'asset.deletedAt', 'asset.createdAt', isLocked('asset').as('isLocked')])
        .where('asset.ownerId', '=', ownerId)
        .where('asset.checksum', 'in', [Buffer.from(sha256, 'hex'), Buffer.from(sha1, 'hex')])
        // An original in the library first, then one in the trash; the oldest of equals.
        .orderBy(sql`asset."deletedAt" is not null`)
        .orderBy('asset.createdAt', 'asc')
        .execute()
    );
  }

  getOwnedAsset(id: string, ownerId: string) {
    return this.db
      .selectFrom('asset')
      .select(['asset.id', 'asset.deletedAt', 'asset.createdAt', 'asset.livePhotoVideoId', 'asset.stackId'])
      .where('asset.id', '=', id)
      .where('asset.ownerId', '=', ownerId)
      .executeTakeFirst();
  }

  /** What the library holds for an original, to compare with a package. */
  async getLibraryState(assetId: string) {
    const row = await this.db
      .selectFrom('asset')
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select([
        'asset.isFavorite',
        'asset.visibility',
        'asset_exif.dateTimeOriginal',
        'asset_exif.description',
        'asset_exif.latitude',
        'asset_exif.longitude',
        'asset_exif.rating',
        isLocked('asset').as('isLocked'),
      ])
      .where('asset.id', '=', assetId)
      .executeTakeFirst();
    if (!row) {
      return;
    }
    const editRecipe = await this.getEditRecipe(assetId);
    return {
      dateTimeOriginal: row.dateTimeOriginal ? new Date(row.dateTimeOriginal as unknown as string).toISOString() : null,
      description: row.description ?? null,
      latitude: row.latitude ?? null,
      longitude: row.longitude ?? null,
      rating: row.rating ?? null,
      isFavorite: row.isFavorite,
      visibility: row.visibility as string,
      locked: !!row.isLocked,
      editRecipe: editRecipe.map(({ action, parameters }) => ({
        action: action as string,
        parameters: parameters as unknown,
      })),
    };
  }

  /** Keep the reason a restored lock had in the package; the lock itself was made by the asset service. */
  async setLockReason(assetId: string, reason: string): Promise<void> {
    await this.write((db) =>
      db
        .updateTable('asset_lock')
        .set({ reason: reason as any })
        .where('assetId', '=', assetId)
        .execute(),
    );
  }

  /** An album the owner owns, by id. */
  getOwnedAlbum(ownerId: string, albumId: string) {
    return this.db
      .selectFrom('album')
      .innerJoin('album_user', (join) =>
        join
          .onRef('album_user.albumId', '=', 'album.id')
          .on('album_user.userId', '=', ownerId)
          .on('album_user.role', '=', AlbumUserRole.Owner),
      )
      .select(['album.id', 'album.kind', 'album.parentId'])
      .where('album.id', '=', albumId)
      .where('album.deletedAt', 'is', null)
      .executeTakeFirst();
  }

  /** Whether an album id is taken by anybody, owned or not, trashed or not. */
  async albumExists(albumId: string): Promise<boolean> {
    return !!(await this.db.selectFrom('album').select('id').where('id', '=', albumId).executeTakeFirst());
  }

  /** The owner's albums with exactly this name, kind and parent: a match only when there is one. */
  findOwnedAlbumsByName(ownerId: string, name: string, kind: string, parentId: string | null) {
    return this.db
      .selectFrom('album')
      .innerJoin('album_user', (join) =>
        join
          .onRef('album_user.albumId', '=', 'album.id')
          .on('album_user.userId', '=', ownerId)
          .on('album_user.role', '=', AlbumUserRole.Owner),
      )
      .select('album.id')
      .where('album.albumName', '=', name)
      .where('album.kind', '=', kind as AlbumKind)
      .where('album.deletedAt', 'is', null)
      .$if(parentId === null, (qb) => qb.where('album.parentId', 'is', null))
      .$if(parentId !== null, (qb) => qb.where('album.parentId', '=', parentId!))
      .limit(2)
      .execute();
  }

  /** A person of the owner's, by person id. */
  getOwnedPerson(ownerId: string, personGroupId: string) {
    return this.db
      .selectFrom('person')
      .select(['personGroupId', 'name'])
      .where('ownerId', '=', ownerId)
      .where('personGroupId', '=', personGroupId)
      .executeTakeFirst();
  }

  findPeopleByName(ownerId: string, name: string) {
    return this.db
      .selectFrom('person')
      .select('personGroupId')
      .where('ownerId', '=', ownerId)
      .where('name', '=', name)
      .limit(2)
      .execute();
  }

  /**
   * A person for the owner with a given id, in the owner's cluster group, like `PersonService.create`
   * makes one. Creating the same id twice is harmless: the second does nothing.
   */
  async createPerson(
    ownerId: string,
    personGroupId: string,
    person: { name: string; birthDate: string | null; isHidden: boolean; isFavorite: boolean; color: string | null },
  ): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      await lockPublicForkWrites(tx, PRESERVATION_HANDOFF_REFUSAL);
      await sql`
        insert into person_group (id, "clusterGroupId")
        select ${personGroupId}::uuid, "user"."clusterGroupId" from "user" where "user".id = ${ownerId}::uuid
        on conflict do nothing
      `.execute(tx);
      await tx
        .insertInto('person')
        .values({
          ownerId,
          personGroupId,
          name: person.name,
          birthDate: person.birthDate,
          isHidden: person.isHidden,
          isFavorite: person.isFavorite,
          color: person.color,
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
    });
  }

  getFaces(assetId: string) {
    return this.db
      .selectFrom('asset_face')
      .select([
        'id',
        'personGroupId',
        'imageWidth',
        'imageHeight',
        'boundingBoxX1',
        'boundingBoxY1',
        'boundingBoxX2',
        'boundingBoxY2',
      ])
      .where('assetId', '=', assetId)
      .where('deletedAt', 'is', null)
      .execute();
  }

  async addFace(face: {
    assetId: string;
    personGroupId: string;
    imageWidth: number;
    imageHeight: number;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    sourceType: string;
  }): Promise<void> {
    await this.write((db) =>
      db
        .insertInto('asset_face')
        .values({
          assetId: face.assetId,
          personGroupId: face.personGroupId,
          imageWidth: face.imageWidth,
          imageHeight: face.imageHeight,
          boundingBoxX1: Math.round(face.x1),
          boundingBoxY1: Math.round(face.y1),
          boundingBoxX2: Math.round(face.x2),
          boundingBoxY2: Math.round(face.y2),
          sourceType: face.sourceType as SourceType,
        })
        .execute(),
    );
  }

  /** Name a face nobody has named yet; a face somebody named keeps its person. */
  async nameFace(faceId: string, personGroupId: string): Promise<void> {
    await this.write((db) =>
      db
        .updateTable('asset_face')
        .set({ personGroupId })
        .where('id', '=', faceId)
        .where('personGroupId', 'is', null)
        .execute(),
    );
  }

  /** Add a document decision the owner made, unless one is already recorded for the same thing. */
  async addDocumentEdit(
    assetId: string,
    ownerId: string,
    edit: {
      key: string;
      action: string;
      value: string | null;
      region: { x1: number; y1: number; x2: number; y2: number; x3: number; y3: number; x4: number; y4: number } | null;
    },
  ): Promise<boolean> {
    const result = await this.write((db) =>
      db
        .insertInto('asset_document_edit')
        .values({
          assetId,
          key: edit.key,
          action: edit.action as any,
          value: edit.value,
          sourceText: null,
          editedById: ownerId,
          ...edit.region,
        })
        .onConflict((oc) => oc.columns(['assetId', 'key']).doNothing())
        .executeTakeFirst(),
    );
    return Number(result.numInsertedOrUpdatedRows ?? 0) > 0;
  }

  /** Add a moment note the owner wrote, unless the same note is already there. */
  async addManualMoment(
    assetId: string,
    ownerId: string,
    moment: { timestampMs: number; endMs: number | null; caption: string | null; transcript: string | null },
  ): Promise<boolean> {
    const existing = await this.db
      .selectFrom('video_moment')
      .select('id')
      .where('assetId', '=', assetId)
      .where('source', '=', VideoMomentSource.Manual)
      .where('timestampMs', '=', moment.timestampMs)
      .where((eb) => (moment.caption === null ? eb('caption', 'is', null) : eb('caption', '=', moment.caption)))
      .executeTakeFirst();
    if (existing) {
      return false;
    }
    await this.write((db) =>
      db
        .insertInto('video_moment')
        .values({
          assetId,
          source: VideoMomentSource.Manual,
          timestampMs: moment.timestampMs,
          endMs: moment.endMs,
          caption: moment.caption,
          transcript: moment.transcript,
          createdById: ownerId,
        })
        .execute(),
    );
    return true;
  }

  /** Deleting an account removes its rows by cascade; this lists what it leaves on disk first. */
  listOwnedPackagePaths(ownerId: string) {
    return this.db
      .selectFrom('preservation_package')
      .select(['id', 'origin', 'path'])
      .where('ownerId', '=', ownerId)
      .where('removedAt', 'is', null)
      .execute();
  }
}

/** Thrown inside `createExport` to roll back a selection that is too large. */
class SelectionTooLargeError extends Error {
  constructor(readonly items: number) {
    super(`The selection holds ${items} items`);
  }
}
