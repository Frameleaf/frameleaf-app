import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Selectable, Updateable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { AssetRestorationStatus } from 'src/dtos/asset-restoration.dto.js';
import { MediaOperationStatus } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { AssetRestorationTable } from 'src/schema/tables/asset-restoration.table.js';
import { EXPIRING_RESULT_STATUSES } from 'src/utils/restoration.js';

export type AssetRestoration = Selectable<AssetRestorationTable>;
export type RestoredForPlayback = Pick<
  AssetRestoration,
  'id' | 'isCurrent' | 'resultPath' | 'resultPreviewPath' | 'sourceType'
>;

export type AssetRestorationCreate = Omit<
  Insertable<AssetRestorationTable>,
  'id' | 'revision' | 'createdAt' | 'updatedAt' | 'updateId' | 'isCurrent' | 'status'
> & { status?: AssetRestorationStatus };

export type AssetRestorationUpdate = Omit<
  Updateable<AssetRestorationTable>,
  'id' | 'assetId' | 'ownerId' | 'revision' | 'createdAt' | 'updatedAt' | 'updateId'
>;

export type RestorationFilePaths = Pick<
  AssetRestoration,
  'id' | 'previewBeforePath' | 'previewAfterPath' | 'resultPath' | 'resultPreviewPath'
>;

/**
 * Storage for restoration revisions (FL-115).
 *
 * Rows are append-only history: a new request always takes the asset's next revision number, a
 * decision only changes status and dates, and `isCurrent` is moved by one transaction so the
 * partial unique index never sees two current rows. Nothing here reads or writes the original.
 *
 * Owner-facing reads take the owner id in the query itself so a restoration that is not yours and
 * one that never existed give the same answer. Background reads (`get`, `listExpired…`) carry no
 * owner and no visibility filter on purpose: a job the owner asked for on a Locked asset runs
 * exactly like any other (owner decision, FL-115); exposure is decided at the API, not here.
 */
@Injectable()
export class AssetRestorationRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /** Inserts the asset's next revision; the number is assigned inside the statement. */
  async create(input: AssetRestorationCreate): Promise<AssetRestoration> {
    const row = await this.db
      .insertInto('asset_restoration')
      .values({
        ...input,
        revision: sql<number>`(SELECT coalesce(max("revision"), 0) + 1 FROM "asset_restoration" WHERE "assetId" = ${input.assetId})`,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return row as unknown as AssetRestoration;
  }

  async get(id: string): Promise<AssetRestoration | undefined> {
    return (await this.db.selectFrom('asset_restoration').selectAll().where('id', '=', id).executeTakeFirst()) as
      AssetRestoration | undefined;
  }

  /** Owner-scoped read; the asset id is part of the key so a URL cannot mix two assets. */
  async getForOwner(id: string, assetId: string, ownerId: string): Promise<AssetRestoration | undefined> {
    return (await this.db
      .selectFrom('asset_restoration')
      .selectAll()
      .where('id', '=', id)
      .where('assetId', '=', assetId)
      .where('ownerId', '=', ownerId)
      .executeTakeFirst()) as AssetRestoration | undefined;
  }

  async listByAsset(assetId: string): Promise<AssetRestoration[]> {
    return (await this.db
      .selectFrom('asset_restoration')
      .selectAll()
      .where('assetId', '=', assetId)
      .orderBy('revision', 'desc')
      .execute()) as unknown as AssetRestoration[];
  }

  async getCurrent(assetId: string): Promise<AssetRestoration | undefined> {
    return (await this.db
      .selectFrom('asset_restoration')
      .selectAll()
      .where('assetId', '=', assetId)
      .where('isCurrent', '=', true)
      .executeTakeFirst()) as AssetRestoration | undefined;
  }

  /**
   * The owner's finished restorations of an asset, for playback: which one (if any) is chosen, and
   * whether a switch between versions is possible at all (FL-115).
   */
  async listRestoredForPlayback(assetId: string, ownerId: string): Promise<RestoredForPlayback[]> {
    return (await this.db
      .selectFrom('asset_restoration')
      .select(['id', 'isCurrent', 'resultPath', 'resultPreviewPath', 'sourceType'])
      .where('assetId', '=', assetId)
      .where('ownerId', '=', ownerId)
      .where('status', '=', AssetRestorationStatus.Restored)
      .where('resultPath', 'is not', null)
      .execute()) as RestoredForPlayback[];
  }

  async update(id: string, patch: AssetRestorationUpdate): Promise<AssetRestoration | undefined> {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (entries.length === 0) {
      return this.get(id);
    }
    return (await this.db
      .updateTable('asset_restoration')
      .set(Object.fromEntries(entries) as AssetRestorationUpdate)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst()) as AssetRestoration | undefined;
  }

  /**
   * Guarded status change: only applies when the row is still in one of `from`. This is how a
   * worker's late write loses to an owner's decision instead of overwriting it.
   */
  async transition(
    id: string,
    from: readonly AssetRestorationStatus[],
    patch: AssetRestorationUpdate & { status: AssetRestorationStatus },
    /** A transaction to write in, when the transition must land together with the job's completion. */
    executor: Kysely<DB> = this.db,
  ): Promise<AssetRestoration | undefined> {
    return (await executor
      .updateTable('asset_restoration')
      .set(patch)
      .where('id', '=', id)
      .where('status', 'in', [...from])
      .returningAll()
      .executeTakeFirst()) as AssetRestoration | undefined;
  }

  /**
   * Moves the asset's current flag to the given restoration, or clears it for the original. Two
   * statements inside one transaction so the partial unique index never sees two current rows.
   */
  async setCurrent(assetId: string, restorationId: string | null): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('asset_restoration')
        .set({ isCurrent: false })
        .where('assetId', '=', assetId)
        .where('isCurrent', '=', true)
        .execute();
      if (restorationId) {
        await trx
          .updateTable('asset_restoration')
          .set({ isCurrent: true })
          .where('id', '=', restorationId)
          .where('assetId', '=', assetId)
          .execute();
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Retention                                                           */
  /* ------------------------------------------------------------------ */

  /** Restorations whose preview files are past their retention date and still on disk. */
  async listExpiredPreviews(now: Date, limit: number): Promise<AssetRestoration[]> {
    return (await this.db
      .selectFrom('asset_restoration')
      .selectAll()
      .where('previewExpiresAt', 'is not', null)
      .where('previewExpiresAt', '<=', now)
      .where((eb) => eb.or([eb('previewBeforePath', 'is not', null), eb('previewAfterPath', 'is not', null)]))
      .orderBy('previewExpiresAt', 'asc')
      .limit(limit)
      .execute()) as unknown as AssetRestoration[];
  }

  /**
   * Failed or cancelled full renders whose leftovers (chunk checkpoints, any partial result) are
   * past their retention date. A finished result never carries an expiry (FL-115).
   */
  async listExpiredResults(now: Date, limit: number): Promise<AssetRestoration[]> {
    return (await this.db
      .selectFrom('asset_restoration')
      .selectAll()
      .where('resultExpiresAt', 'is not', null)
      .where('resultExpiresAt', '<=', now)
      .where('status', 'in', [...EXPIRING_RESULT_STATUSES])
      .orderBy('resultExpiresAt', 'asc')
      .limit(limit)
      .execute()) as unknown as AssetRestoration[];
  }

  /**
   * Clears an expired result's paths only while the row is still in the status the retention sweep
   * read and still past its retention date. A retry or another change since the read makes this a
   * no-op (undefined), and the sweep then leaves the row's files and work folder alone.
   */
  async clearExpiredResult(
    id: string,
    status: AssetRestorationStatus,
    now: Date,
  ): Promise<AssetRestoration | undefined> {
    return (await this.db
      .updateTable('asset_restoration')
      .set({ resultPath: null, resultPreviewPath: null, resultExpiresAt: null })
      .where('id', '=', id)
      .where('status', '=', status)
      .where('resultExpiresAt', 'is not', null)
      .where('resultExpiresAt', '<=', now)
      .returningAll()
      .executeTakeFirst()) as AssetRestoration | undefined;
  }

  /**
   * Bring rows into line with jobs that finished without the worker writing back: a queued job
   * the owner cancelled from Activity, or one that recovery failed after its attempts ran out.
   * Only rows still in an active status change, so a decision already recorded is never undone.
   */
  async alignWithOperations(resultExpiresAt: Date): Promise<{ preview: number; full: number }> {
    const preview = await this.db
      .updateTable('asset_restoration')
      .set((eb) => ({
        status: eb
          .case()
          .when(
            eb.exists(
              eb
                .selectFrom('media_operation')
                .select('media_operation.id')
                .whereRef('media_operation.id', '=', 'asset_restoration.previewOperationId')
                .where('media_operation.status', '=', MediaOperationStatus.Cancelled),
            ),
          )
          .then(AssetRestorationStatus.PreviewCancelled)
          .else(AssetRestorationStatus.PreviewFailed)
          .end(),
        error: eb
          .selectFrom('media_operation')
          .select('media_operation.error')
          .whereRef('media_operation.id', '=', 'asset_restoration.previewOperationId'),
      }))
      .where('status', 'in', [AssetRestorationStatus.PreviewQueued, AssetRestorationStatus.PreviewRendering])
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('media_operation')
            .select('media_operation.id')
            .whereRef('media_operation.id', '=', 'asset_restoration.previewOperationId')
            .where('media_operation.status', 'in', [MediaOperationStatus.Cancelled, MediaOperationStatus.Failed]),
        ),
      )
      .executeTakeFirst();

    const full = await this.db
      .updateTable('asset_restoration')
      .set((eb) => ({
        status: eb
          .case()
          .when(
            eb.exists(
              eb
                .selectFrom('media_operation')
                .select('media_operation.id')
                .whereRef('media_operation.id', '=', 'asset_restoration.fullOperationId')
                .where('media_operation.status', '=', MediaOperationStatus.Cancelled),
            ),
          )
          .then(AssetRestorationStatus.RestoreCancelled)
          .else(AssetRestorationStatus.RestoreFailed)
          .end(),
        error: eb
          .selectFrom('media_operation')
          .select('media_operation.error')
          .whereRef('media_operation.id', '=', 'asset_restoration.fullOperationId'),
        resultExpiresAt,
      }))
      .where('status', 'in', [AssetRestorationStatus.Accepted, AssetRestorationStatus.Restoring])
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('media_operation')
            .select('media_operation.id')
            .whereRef('media_operation.id', '=', 'asset_restoration.fullOperationId')
            .where('media_operation.status', 'in', [MediaOperationStatus.Cancelled, MediaOperationStatus.Failed]),
        ),
      )
      .executeTakeFirst();

    return { preview: Number(preview.numUpdatedRows), full: Number(full.numUpdatedRows) };
  }

  /* ------------------------------------------------------------------ */
  /* Asset lifecycle                                                     */
  /* ------------------------------------------------------------------ */

  /** Every file path the asset's restorations produced, for cleanup when the asset goes. */
  async getFilePaths(assetId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('asset_restoration')
      .select(['previewBeforePath', 'previewAfterPath', 'resultPath', 'resultPreviewPath'])
      .where('assetId', '=', assetId)
      .execute();
    return rows
      .flatMap((row) => [row.previewBeforePath, row.previewAfterPath, row.resultPath, row.resultPreviewPath])
      .filter((path): path is string => !!path);
  }

  async deleteByAsset(assetId: string): Promise<void> {
    await this.db.deleteFrom('asset_restoration').where('assetId', '=', assetId).execute();
  }
}
