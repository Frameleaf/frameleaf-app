import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Selectable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { AssetStatus, AssetVisibility, MediaOperationBulkAction, MediaOperationKind } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { DuplicateDecisionTable } from 'src/schema/tables/duplicate-decision.table.js';
import { anyUuid, asUuid, withDefaultVisibility } from 'src/utils/database.js';
import { ACTIVE_MEDIA_OPERATION_STATUSES } from 'src/utils/media-operation.js';

export type DuplicateDecision = Selectable<DuplicateDecisionTable>;

/**
 * A value for a `jsonb` column. Arrays in particular: the driver would otherwise send a Postgres array.
 * The text cast matters: a parameter typed `jsonb` is JSON-encoded again by the driver, storing a JSON string.
 */
const toJson = <T>(value: T) => sql<T>`${JSON.stringify(value)}::text::jsonb`;

/** One member of a duplicate group, as the review reads it: who owns it and nothing else. */
export type DuplicateGroupMember = { id: string; duplicateId: string; ownerId: string };

/** Where one photo stands when a decision or its undo reaches it. */
export type DuplicateAssetState = {
  id: string;
  ownerId: string;
  duplicateId: string | null;
  stackId: string | null;
  status: AssetStatus;
  deletedAt: Date | null;
};

/**
 * The keeper fields a decision's metadata merge can change (`DuplicateService.resolve`), recorded
 * before and after so the undo can put back only what nothing has changed since.
 */
export type DuplicateKeeperState = {
  isFavorite: boolean;
  visibility: AssetVisibility;
  rating: number | null;
  description: string;
  latitude: number | null;
  longitude: number | null;
  albumIds: string[];
  tagIds: string[];
};

/** A durable decision job that has not finished, as the review page needs it after a reload. */
export type ActiveDuplicateOperation = {
  id: string;
  action: MediaOperationBulkAction;
  duplicateGroups: unknown;
};

/**
 * Reads and writes for duplicate review decisions (FL-61).
 *
 * The group reads here are deliberately wider than the review list: they ignore the session's hidden
 * content filter and every owner filter, so a group whose members the session cannot all see, or that
 * holds another account's photo, is recognised as such and never decided on a partial view. Nothing
 * they return leaves the server except as a count.
 */
@Injectable()
export class DuplicateDecisionRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /**
   * Every photo carrying these duplicate ids that duplicate review could show anyone: not deleted, not
   * in a stack, on the timeline or in the archive and not Locked — the same rule the review list and
   * `DuplicateService.resolve` read a group with, minus the session's own filters.
   */
  getGroupMembers(duplicateIds: string[]): Promise<DuplicateGroupMember[]> {
    if (duplicateIds.length === 0) {
      return Promise.resolve([]);
    }

    return (
      this.db
        .selectFrom('asset')
        .select(['asset.id', 'asset.ownerId'])
        .select((eb) => eb.ref('asset.duplicateId').$castTo<string>().as('duplicateId'))
        .$call(withDefaultVisibility)
        // the same join the review list and resolve read a group through: a photo without metadata is in neither
        .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
        .where('asset.duplicateId', '=', anyUuid(duplicateIds))
        .where('asset.deletedAt', 'is', null)
        .where('asset.stackId', 'is', null)
        .execute()
    );
  }

  /** Where each of these photos stands now. Photos that no longer exist are simply absent. */
  getAssetStates(assetIds: string[]): Promise<DuplicateAssetState[]> {
    if (assetIds.length === 0) {
      return Promise.resolve([]);
    }

    return this.db
      .selectFrom('asset')
      .select(['asset.id', 'asset.ownerId', 'asset.duplicateId', 'asset.stackId', 'asset.status', 'asset.deletedAt'])
      .where('asset.id', '=', anyUuid(assetIds))
      .execute() as Promise<DuplicateAssetState[]>;
  }

  /** The keeper fields a metadata merge can change, for each of these photos. */
  async getKeeperStates(assetIds: string[]): Promise<Map<string, DuplicateKeeperState>> {
    if (assetIds.length === 0) {
      return new Map();
    }

    const rows = await this.db
      .selectFrom('asset')
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select([
        'asset.id',
        'asset.isFavorite',
        'asset.visibility',
        'asset_exif.rating',
        'asset_exif.description',
        'asset_exif.latitude',
        'asset_exif.longitude',
      ])
      .select((eb) => [
        eb.fn
          .coalesce(
            eb
              .selectFrom('album_asset')
              .select((eb) => eb.fn.jsonAgg(eb.ref('album_asset.albumId')).as('ids'))
              .whereRef('album_asset.assetId', '=', 'asset.id'),
            sql<string[]>`'[]'::json`,
          )
          .$castTo<string[]>()
          .as('albumIds'),
        eb.fn
          .coalesce(
            eb
              .selectFrom('tag_asset')
              .select((eb) => eb.fn.jsonAgg(eb.ref('tag_asset.tagId')).as('ids'))
              .whereRef('tag_asset.assetId', '=', 'asset.id'),
            sql<string[]>`'[]'::json`,
          )
          .$castTo<string[]>()
          .as('tagIds'),
      ])
      .where('asset.id', '=', anyUuid(assetIds))
      .execute();

    return new Map(
      rows.map((row) => [
        row.id,
        {
          isFavorite: row.isFavorite,
          visibility: row.visibility,
          rating: row.rating ?? null,
          description: row.description ?? '',
          latitude: row.latitude ?? null,
          longitude: row.longitude ?? null,
          albumIds: [...(row.albumIds ?? [])].sort(),
          tagIds: [...(row.tagIds ?? [])].sort(),
        },
      ]),
    );
  }

  /** Which of these photos are Locked now (FL-34: a lock record). */
  async getLockedIds(assetIds: string[]): Promise<Set<string>> {
    if (assetIds.length === 0) {
      return new Set();
    }

    const rows = await this.db
      .selectFrom('asset_lock')
      .select('asset_lock.assetId')
      .where('asset_lock.assetId', '=', anyUuid(assetIds))
      .execute();
    return new Set(rows.map(({ assetId }) => assetId));
  }

  /** The photos in a stack, or an empty list when the stack is gone. */
  async getStackAssetIds(stackId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('asset')
      .select('asset.id')
      .where('asset.stackId', '=', asUuid(stackId))
      .execute();
    return rows.map(({ id }) => id);
  }

  /**
   * Put these photos back in their group. Only the owner's photos that belong to no group now are
   * touched, so an undo never pulls a photo out of a group it has joined since.
   */
  async relink(ownerId: string, assetIds: string[], duplicateId: string): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }

    await this.db
      .updateTable('asset')
      .set({ duplicateId })
      .where('asset.ownerId', '=', asUuid(ownerId))
      .where('asset.id', '=', anyUuid(assetIds))
      .where((eb) => eb.or([eb('asset.duplicateId', 'is', null), eb('asset.duplicateId', '=', asUuid(duplicateId))]))
      .execute();
  }

  /**
   * Take these photos out of their group — and only these: a photo that joined the group after the
   * owner reviewed it, or one the review never showed, stays in it (FL-61 keep-all and stack).
   */
  async unlink(ownerId: string, assetIds: string[], duplicateId: string): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }

    await this.db
      .updateTable('asset')
      .set({ duplicateId: null })
      .where('asset.ownerId', '=', asUuid(ownerId))
      .where('asset.id', '=', anyUuid(assetIds))
      .where('asset.duplicateId', '=', asUuid(duplicateId))
      .execute();
  }

  /** A durable job's status and lineage, for deciding who may carry on a decision it started. */
  getOperation(id: string): Promise<{ id: string; status: string; retryOfId: string | null } | undefined> {
    return this.db
      .selectFrom('media_operation')
      .select(['media_operation.id', 'media_operation.status', 'media_operation.retryOfId'])
      .where('media_operation.id', '=', asUuid(id))
      .executeTakeFirst();
  }

  /** Hand an unfinished decision to the job that retries the one that started it. */
  async adopt(id: string, operationId: string): Promise<void> {
    await this.db
      .updateTable('duplicate_decision')
      .set({ operationId })
      .where('id', '=', id)
      .where('appliedAt', 'is', null)
      .execute();
  }

  /**
   * Close a decision whose job ended without applying it and that nothing is retrying, so the group
   * can be decided again. It is closed, not undone: `appliedAt` stays empty, and it is never offered
   * for undo.
   */
  async close(id: string): Promise<void> {
    await this.db
      .updateTable('duplicate_decision')
      .set({ undoneAt: new Date() })
      .where('id', '=', id)
      .where('appliedAt', 'is', null)
      .execute();
  }

  /**
   * Record a decision before anything is changed. A replayed batch finds the row its first attempt
   * wrote (same job, same group) and gets that back instead of a second one.
   */
  async create(values: Insertable<DuplicateDecisionTable>): Promise<DuplicateDecision> {
    const created = await this.db
      .insertInto('duplicate_decision')
      .values({
        ...values,
        memberIds: toJson(values.memberIds),
        keepAssetIds: toJson(values.keepAssetIds),
        trashAssetIds: toJson(values.trashAssetIds),
        state: toJson(values.state ?? {}),
      })
      .onConflict((oc) => oc.columns(['operationId', 'duplicateId']).doNothing())
      .returningAll()
      .executeTakeFirst();
    if (created) {
      return created;
    }

    return this.db
      .selectFrom('duplicate_decision')
      .selectAll()
      .where('ownerId', '=', values.ownerId)
      .where('operationId', '=', values.operationId as string)
      .where('duplicateId', '=', values.duplicateId)
      .executeTakeFirstOrThrow();
  }

  /**
   * The decision for this group that a job started and never finished: the job died, failed as a
   * whole, or was cancelled mid-group. Whichever job reaches the group next finishes it.
   */
  getUnfinished(ownerId: string, duplicateId: string): Promise<DuplicateDecision | undefined> {
    return this.db
      .selectFrom('duplicate_decision')
      .selectAll()
      .where('ownerId', '=', asUuid(ownerId))
      .where('duplicateId', '=', asUuid(duplicateId))
      .where('appliedAt', 'is', null)
      .where('undoneAt', 'is', null)
      .orderBy('createdAt', 'desc')
      .executeTakeFirst();
  }

  getForOperation(ownerId: string, operationId: string, duplicateId: string): Promise<DuplicateDecision | undefined> {
    return this.db
      .selectFrom('duplicate_decision')
      .selectAll()
      .where('ownerId', '=', asUuid(ownerId))
      .where('operationId', '=', asUuid(operationId))
      .where('duplicateId', '=', asUuid(duplicateId))
      .executeTakeFirst();
  }

  getById(ownerId: string, id: string): Promise<DuplicateDecision | undefined> {
    return this.db
      .selectFrom('duplicate_decision')
      .selectAll()
      .where('ownerId', '=', asUuid(ownerId))
      .where('id', '=', asUuid(id))
      .executeTakeFirst();
  }

  /** The owner's decisions with these ids. Anyone else's are simply absent. */
  getByIds(ownerId: string, ids: string[]): Promise<DuplicateDecision[]> {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }
    return this.db
      .selectFrom('duplicate_decision')
      .selectAll()
      .where('ownerId', '=', asUuid(ownerId))
      .where('id', '=', anyUuid(ids))
      .execute();
  }

  /** Complete a decision: it is applied, and this is the keepers' state it left behind. */
  async markApplied(id: string, values: { stackId: string | null; state: Record<string, unknown> }): Promise<void> {
    await this.db
      .updateTable('duplicate_decision')
      .set({ appliedAt: new Date(), stackId: values.stackId, state: toJson(values.state) })
      .where('id', '=', id)
      .execute();
  }

  /**
   * Claim a decision for an undo job. Succeeds when nothing is undoing it yet, when this same job
   * already is (a replayed batch), or when `takeOverFrom` — an undo job that has ended without
   * finishing — held it. Returns false when a running undo has it or it is already undone.
   */
  async beginUndo(id: string, undoOperationId: string, takeOverFrom?: string): Promise<boolean> {
    const row = await this.db
      .updateTable('duplicate_decision')
      .set({ undoOperationId })
      .where('id', '=', id)
      .where('undoneAt', 'is', null)
      .where('appliedAt', 'is not', null)
      .where((eb) =>
        eb.or([
          eb('undoOperationId', 'is', null),
          eb('undoOperationId', '=', undoOperationId),
          ...(takeOverFrom ? [eb('undoOperationId', '=', takeOverFrom)] : []),
        ]),
      )
      .returning('id')
      .executeTakeFirst();
    return !!row;
  }

  async markUndone(id: string): Promise<void> {
    await this.db.updateTable('duplicate_decision').set({ undoneAt: new Date() }).where('id', '=', id).execute();
  }

  /**
   * The owner's most recent decision jobs, newest first, with every decision each one recorded. The
   * review page builds its undo history from these, so an undo survives a reload.
   */
  async listRecent(ownerId: string, operations: number): Promise<DuplicateDecision[]> {
    const recent = await this.db
      .selectFrom('duplicate_decision')
      .select('operationId')
      .select((eb) => eb.fn.max('createdAt').as('latest'))
      .where('ownerId', '=', asUuid(ownerId))
      .where('operationId', 'is not', null)
      .groupBy('operationId')
      .orderBy('latest', 'desc')
      .limit(operations)
      .execute();
    const ids = recent.map(({ operationId }) => operationId).filter((id): id is string => !!id);
    if (ids.length === 0) {
      return [];
    }

    return this.db
      .selectFrom('duplicate_decision')
      .selectAll()
      .where('ownerId', '=', asUuid(ownerId))
      .where('operationId', '=', anyUuid(ids))
      .orderBy('createdAt', 'asc')
      .execute();
  }

  /**
   * The owner's duplicate decision jobs that have not finished, with the groups each one holds, so the
   * review can show which groups are still being worked on after a reload.
   */
  async listActiveOperations(ownerId: string): Promise<ActiveDuplicateOperation[]> {
    const rows = await this.db
      .selectFrom('media_operation')
      .select(['media_operation.id'])
      .select(sql<string>`"media_operation"."snapshot"->>'action'`.as('action'))
      .select(sql<unknown>`"media_operation"."snapshot"->'payload'->'duplicateGroups'`.as('duplicateGroups'))
      .where('media_operation.ownerId', '=', asUuid(ownerId))
      .where('media_operation.kind', '=', MediaOperationKind.Bulk)
      .where('media_operation.status', 'in', [...ACTIVE_MEDIA_OPERATION_STATUSES])
      .where(sql<string>`"media_operation"."snapshot"->>'action'`, 'in', [
        MediaOperationBulkAction.ResolveDuplicates,
        MediaOperationBulkAction.UndoDuplicates,
      ])
      .orderBy('media_operation.createdAt', 'asc')
      .execute();

    return rows.map((row) => ({
      id: row.id,
      action: row.action as MediaOperationBulkAction,
      duplicateGroups: row.duplicateGroups,
    }));
  }
}
