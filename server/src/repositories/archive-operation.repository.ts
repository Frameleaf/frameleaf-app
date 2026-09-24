import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Kysely, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { ArchiveOperationScope } from 'src/dtos/archive-operation.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { AssetVisibility } from 'src/enum.js';
import { isForkWriteEnabled, isLegacyAuthoritative } from 'src/fork-schema/authority.js';
import { ForkSchemaPhase } from 'src/repositories/fork-schema.repository.js';
import { DB } from 'src/schema/index.js';
import { BULK_MAX_ITEMS } from 'src/utils/bulk-operation.js';
import { withHiddenContentFilter } from 'src/utils/database.js';
import { getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { getLockedOwnerId, isLocked, visibilityIs } from 'src/utils/locked.js';

/** How long a prepared, unconfirmed matching selection can still be confirmed. */
export const ARCHIVE_PREPARED_TTL_MINUTES = 30;

/** How many recent operations the list answers with. */
export const ARCHIVE_OPERATION_LIST_LIMIT = 20;

export type ArchiveItemStatus = 'pending' | 'archived' | 'skipped' | 'undone' | 'conflict';

export type ArchiveOperationRow = {
  id: string;
  ownerId: string;
  sessionId: string | null;
  requestKey: string;
  scope: ArchiveOperationScope;
  descriptor: unknown;
  prepared: boolean;
  preparedElevated: boolean;
  expiresAt: Date | null;
  archiveJobId: string | null;
  undoJobId: string | null;
  createdAt: Date;
};

export type ArchiveOperationSummary = ArchiveOperationRow & {
  count: number;
  pending: number;
  archived: number;
  skipped: number;
  undone: number;
  conflict: number;
  /** Status of the archive job, when there is one. */
  archiveJobStatus: string | null;
};

/** What one item of a batch answered, for the bulk worker to report. */
export type ArchiveItemAnswer =
  'archived' | 'undone' | 'skipped' | 'not-archived' | 'conflict' | 'cancelled' | 'missing';

/** How the bulk worker reports one archive-operation answer. */
export const archiveAnswerOutcome = (answer: ArchiveItemAnswer): { status: 'ok' | 'skipped'; reasonKey?: string } => {
  switch (answer) {
    case 'archived':
    case 'undone': {
      return { status: 'ok' };
    }
    case 'conflict': {
      return { status: 'skipped', reasonKey: 'frameleaf_bulk_reason_archive_undo_changed' };
    }
    case 'cancelled': {
      return { status: 'skipped', reasonKey: 'frameleaf_bulk_reason_cancelled' };
    }
    case 'not-archived': {
      return { status: 'skipped', reasonKey: 'frameleaf_bulk_reason_archive_not_archived' };
    }
    case 'missing': {
      return { status: 'skipped', reasonKey: 'frameleaf_bulk_reason_not_found' };
    }
    default: {
      return { status: 'skipped', reasonKey: 'frameleaf_bulk_reason_archive_moved' };
    }
  }
};

/**
 * Transactional archive operations (FL-32, ported from PR #133's `ArchiveOperationRepository`).
 *
 * The rules it keeps:
 *
 * - **Membership is frozen before anything changes.** An explicit selection is stored as submitted;
 *   a matching selection is counted and stored by one SQL statement, so neither loaded pages nor
 *   bucket totals are the authority for what an archive covers.
 * - **The durable bulk job does the work.** Publication runs one bulk batch per transaction, with
 *   the item rows and assets locked, and records each item's previous visibility and the
 *   `updateId` the archive published.
 * - **Undo never overwrites newer work.** An item is restored only while it is still archived with
 *   the `updateId` this operation published; anything else is a conflict and is left alone. An item
 *   the archive has not reached yet is marked skipped under the same lock, so a cancelled archive
 *   that is still finishing its last batch can never archive it after the undo.
 * - **No writes during a database handoff** or while the fork schema is inactive, the same guard
 *   the other fork-owned writers use.
 */
@Injectable()
export class ArchiveOperationRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  private async lockWrites(tx: Transaction<DB>) {
    const { rows } = await sql<{
      phase: ForkSchemaPhase;
    }>`SELECT phase FROM immich_fork.state WHERE id = 1 FOR SHARE`.execute(tx);
    const handoff = await sql`
      SELECT 1 FROM immich_fork.migration_audit
      WHERE status = 'running' AND name IN ('official-handoff-preparation', 'fork-return-reconciliation')
      LIMIT 1
    `.execute(tx);
    // as for every fork-owned writer: legacy-authoritative or fork-writable, never while a handoff runs
    const phase = rows[0]?.phase;
    if (!phase || !(isLegacyAuthoritative(phase) || isForkWriteEnabled(phase)) || handoff.rows.length > 0) {
      throw new ConflictException('Archive operations are unavailable during database handoff');
    }
  }

  private async lockOwned(tx: Transaction<DB>, ownerId: string, id: string) {
    const { rows } = await sql<ArchiveOperationRow>`
      SELECT * FROM immich_fork.archive_operation WHERE id = ${id}::uuid AND "ownerId" = ${ownerId}::uuid FOR UPDATE
    `.execute(tx);
    return rows[0];
  }

  private async lockByKey(tx: Transaction<DB>, ownerId: string, requestKey: string) {
    const { rows } = await sql<ArchiveOperationRow>`
      SELECT * FROM immich_fork.archive_operation
      WHERE "ownerId" = ${ownerId}::uuid AND "requestKey" = ${requestKey}::uuid FOR UPDATE
    `.execute(tx);
    return rows[0];
  }

  /** Freeze an explicit selection. The same request key with the same ids answers with the same operation. */
  async createSelected(auth: AuthDto, requestKey: string, assetIds: string[]): Promise<string> {
    const ids = [...new Set(assetIds)];
    return this.db.transaction().execute(async (tx) => {
      await this.lockWrites(tx);
      const { rows } = await sql<{ id: string }>`
        INSERT INTO immich_fork.archive_operation ("ownerId", "sessionId", "requestKey", scope)
        VALUES (${auth.user.id}::uuid, ${auth.session?.id ?? null}::uuid, ${requestKey}::uuid,
          ${ArchiveOperationScope.SelectedOwnedAssets})
        ON CONFLICT ("ownerId", "requestKey") DO NOTHING
        RETURNING id
      `.execute(tx);

      if (rows[0]) {
        await sql`
          INSERT INTO immich_fork.archive_operation_item ("operationId", "assetId", ordinal)
          SELECT ${rows[0].id}::uuid, item.id, item.ordinal::int
          FROM unnest(${ids}::uuid[]) WITH ORDINALITY AS item(id, ordinal)
        `.execute(tx);
        return rows[0].id;
      }

      const existing = await this.lockByKey(tx, auth.user.id, requestKey);
      const frozen = await this.orderedAssetIds(existing.id, tx);
      if (existing.scope !== ArchiveOperationScope.SelectedOwnedAssets || frozen.join(',') !== ids.join(',')) {
        throw new ConflictException('The request key belongs to a different selection');
      }
      return existing.id;
    });
  }

  /**
   * Count and freeze every asset of the owner's normal Timeline this session can see, in one
   * statement, and hold it until the owner confirms that count. Shared, partner, trashed, Locked
   * (unless this session is unlocked) and privacy-suppressed assets never join it.
   */
  async prepareMatching(auth: AuthDto, requestKey: string): Promise<string> {
    const elevated = auth.session?.hasElevatedPermission === true;
    const descriptor = { scope: ArchiveOperationScope.MatchingOwnedTimeline, elevated };
    return this.db.transaction().execute(async (tx) => {
      await this.lockWrites(tx);
      // housekeeping: this owner's unconfirmed selections that can no longer be confirmed
      await sql`
        DELETE FROM immich_fork.archive_operation
        WHERE "ownerId" = ${auth.user.id}::uuid AND prepared AND "expiresAt" <= clock_timestamp()
          AND "requestKey" <> ${requestKey}::uuid
      `.execute(tx);

      const { rows } = await sql<{ id: string }>`
        INSERT INTO immich_fork.archive_operation
          ("ownerId", "sessionId", "requestKey", scope, descriptor, prepared, "preparedElevated", "expiresAt")
        VALUES (${auth.user.id}::uuid, ${auth.session?.id ?? null}::uuid, ${requestKey}::uuid,
          ${ArchiveOperationScope.MatchingOwnedTimeline}, ${JSON.stringify(descriptor)}::text::jsonb, true,
          ${elevated}, clock_timestamp() + make_interval(mins => ${ARCHIVE_PREPARED_TTL_MINUTES}))
        ON CONFLICT ("ownerId", "requestKey") DO NOTHING
        RETURNING id
      `.execute(tx);

      if (!rows[0]) {
        const existing = await this.lockByKey(tx, auth.user.id, requestKey);
        if (existing.scope !== ArchiveOperationScope.MatchingOwnedTimeline) {
          throw new ConflictException('The request key belongs to a different selection');
        }
        return existing.id;
      }

      const id = rows[0].id;
      const candidates = tx
        .selectFrom('asset')
        // the Timeline lists only assets with an EXIF row
        .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
        .select(['asset.id', 'asset.fileCreatedAt'])
        .where('asset.ownerId', '=', auth.user.id)
        .where('asset.deletedAt', 'is', null)
        .where(visibilityIs(AssetVisibility.Timeline, 'asset', getLockedOwnerId(auth)))
        // the Timeline's own stack representative: a stacked asset shows only as its stack's primary
        .where(
          sql<boolean>`not exists (
            select 1 from stack where stack.id = asset."stackId" and stack."primaryAssetId" <> asset.id
          )`,
        )
        .$call((qb) => withHiddenContentFilter(qb, getHiddenContentQueryOptions(auth)));

      // One statement freezes membership; nothing loaded in a browser is the authority.
      await sql`
        INSERT INTO immich_fork.archive_operation_item ("operationId", "assetId", ordinal)
        SELECT ${id}::uuid, candidate.id,
          (row_number() OVER (ORDER BY candidate."fileCreatedAt" DESC, candidate.id))::int
        FROM (${candidates}) AS candidate
      `.execute(tx);

      const count = await this.countItems(id, tx);
      if (count > BULK_MAX_ITEMS) {
        throw new BadRequestException(
          `This selection has ${count} items; archive at most ${BULK_MAX_ITEMS} at a time by narrowing the view`,
        );
      }
      return id;
    });
  }

  /**
   * Turn a prepared selection into a runnable one. Confirming again is harmless; confirming after
   * it expired, after it was replaced, or from a session that lost the unlock it was prepared
   * under is refused.
   */
  async confirm(auth: AuthDto, id: string, requestKey: string): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      await this.lockWrites(tx);
      const operation = await this.lockOwned(tx, auth.user.id, id);
      if (!operation) {
        throw new NotFoundException();
      }
      if (operation.scope !== ArchiveOperationScope.MatchingOwnedTimeline || operation.requestKey !== requestKey) {
        throw new ConflictException('Confirmation does not identify the prepared selection');
      }
      if (!operation.prepared) {
        return;
      }
      const { rows } = await sql<{ expired: boolean }>`
        SELECT ${operation.expiresAt}::timestamptz <= clock_timestamp() AS expired
      `.execute(tx);
      if (rows[0]?.expired) {
        throw new GoneException('This selection expired; select everything matching again');
      }
      if (operation.preparedElevated && !auth.session?.hasElevatedPermission) {
        throw new ForbiddenException('Unlock again before confirming this selection');
      }
      await sql`
        UPDATE immich_fork.archive_operation SET prepared = false, "sessionId" = ${auth.session?.id ?? null}::uuid
        WHERE id = ${id}::uuid
      `.execute(tx);
    });
  }

  async countItems(id: string, runner: Kysely<DB> = this.db): Promise<number> {
    const { rows } = await sql<{ count: number }>`
      SELECT count(*)::int AS count FROM immich_fork.archive_operation_item WHERE "operationId" = ${id}::uuid
    `.execute(runner);
    return rows[0]?.count ?? 0;
  }

  /** The frozen set in the order the job works through it. */
  async orderedAssetIds(id: string, runner: Kysely<DB> = this.db): Promise<string[]> {
    const { rows } = await sql<{ assetId: string }>`
      SELECT "assetId" FROM immich_fork.archive_operation_item WHERE "operationId" = ${id}::uuid ORDER BY ordinal
    `.execute(runner);
    return rows.map(({ assetId }) => assetId);
  }

  /** The items not reached yet, in the order the job works through them. */
  async pendingAssetIds(id: string): Promise<string[]> {
    const { rows } = await sql<{ assetId: string }>`
      SELECT "assetId" FROM immich_fork.archive_operation_item
      WHERE "operationId" = ${id}::uuid AND status = 'pending'
      ORDER BY ordinal
    `.execute(this.db);
    return rows.map(({ assetId }) => assetId);
  }

  /**
   * Leave out, as skipped, every unreached item that is Locked now (FL-34). A session without the
   * PIN never archives a Locked item, and the operation answers only with a count, so nothing about
   * which items were Locked leaves the server. Returns how many were left out.
   */
  async skipLocked(ownerId: string, id: string): Promise<number> {
    return this.db.transaction().execute(async (tx) => {
      await this.lockWrites(tx);
      const { rows } = await sql`
        UPDATE immich_fork.archive_operation_item item SET status = 'skipped'
        FROM asset
        WHERE item."operationId" = ${id}::uuid AND item.status = 'pending'
          AND asset.id = item."assetId" AND asset."ownerId" = ${ownerId}::uuid
          AND ${isLocked('asset')}
        RETURNING item."assetId"
      `.execute(tx);
      return rows.length;
    });
  }

  /**
   * Forget operations nobody can act on any more (nightly): unconfirmed selections that expired,
   * and operations older than `days` whose archive and undo jobs are no longer running.
   */
  async prune(days: number): Promise<number> {
    return this.db.transaction().execute(async (tx) => {
      await this.lockWrites(tx);
      const { rows } = await sql`
        DELETE FROM immich_fork.archive_operation o
        WHERE (o.prepared AND o."expiresAt" <= clock_timestamp())
          OR (
            o."createdAt" < clock_timestamp() - make_interval(days => ${days})
            AND NOT EXISTS (
              SELECT 1 FROM media_operation job
              WHERE job.id IN (o."archiveJobId", o."undoJobId")
                AND job.status IN ('queued', 'preparing', 'rendering', 'validating', 'cancelling', 'paused')
            )
          )
        RETURNING o.id
      `.execute(tx);
      return rows.length;
    });
  }

  /** Summaries, newest first. No asset identity leaves this method; counts share one snapshot. */
  async list(ownerId: string, id?: string): Promise<ArchiveOperationSummary[]> {
    const { rows } = await sql<ArchiveOperationSummary>`
      SELECT o.*,
        count(i."assetId")::int AS count,
        count(*) FILTER (WHERE i.status = 'pending')::int AS pending,
        count(*) FILTER (WHERE i.status = 'archived')::int AS archived,
        count(*) FILTER (WHERE i.status = 'skipped')::int AS skipped,
        count(*) FILTER (WHERE i.status = 'undone')::int AS undone,
        count(*) FILTER (WHERE i.status = 'conflict')::int AS conflict,
        (SELECT job.status FROM media_operation job WHERE job.id = o."archiveJobId") AS "archiveJobStatus"
      FROM immich_fork.archive_operation o
      LEFT JOIN immich_fork.archive_operation_item i ON i."operationId" = o.id
      WHERE o."ownerId" = ${ownerId}::uuid AND (${id ?? null}::uuid IS NULL OR o.id = ${id ?? null}::uuid)
      GROUP BY o.id
      ORDER BY o."createdAt" DESC
      LIMIT ${ARCHIVE_OPERATION_LIST_LIMIT}
    `.execute(this.db);
    return rows;
  }

  async get(ownerId: string, id: string): Promise<ArchiveOperationSummary | undefined> {
    const [operation] = await this.list(ownerId, id);
    return operation;
  }

  /** Record the archive job; a second link to a different job is refused. */
  async linkArchiveJob(id: string, jobId: string): Promise<boolean> {
    const { rows } = await sql`
      UPDATE immich_fork.archive_operation SET "archiveJobId" = ${jobId}::uuid
      WHERE id = ${id}::uuid AND NOT prepared AND ("archiveJobId" IS NULL OR "archiveJobId" = ${jobId}::uuid)
      RETURNING id
    `.execute(this.db);
    return rows.length > 0;
  }

  /** Record the undo job; only the first undo is ever linked. */
  async linkUndoJob(id: string, jobId: string): Promise<boolean> {
    const { rows } = await sql`
      UPDATE immich_fork.archive_operation SET "undoJobId" = ${jobId}::uuid
      WHERE id = ${id}::uuid AND ("undoJobId" IS NULL OR "undoJobId" = ${jobId}::uuid)
      RETURNING id
    `.execute(this.db);
    return rows.length > 0;
  }

  /**
   * One archive batch of the bulk job, in one transaction. The job must be the operation's own
   * (claimed here if the link was not written yet). Returns what each id answered.
   */
  async publish(ownerId: string, operationId: string, jobId: string, ids: string[]) {
    return this.db.transaction().execute(async (tx) => {
      await this.lockWrites(tx);
      const answers = new Map<string, ArchiveItemAnswer>(ids.map((id) => [id, 'missing']));
      const operation = await this.lockOwned(tx, ownerId, operationId);
      if (!operation || operation.prepared || (operation.archiveJobId && operation.archiveJobId !== jobId)) {
        return answers;
      }
      if (!operation.archiveJobId) {
        await sql`UPDATE immich_fork.archive_operation SET "archiveJobId" = ${jobId}::uuid WHERE id = ${operationId}::uuid`.execute(
          tx,
        );
      }

      const items = await this.lockItems(tx, operationId, ids);
      const pending = items.filter(({ status }) => status === 'pending').map(({ assetId }) => assetId);
      const eligible =
        pending.length === 0
          ? []
          : (
              await sql<{ id: string }>`
                SELECT id FROM asset
                WHERE id = ANY(${pending}::uuid[]) AND "ownerId" = ${ownerId}::uuid AND "deletedAt" IS NULL
                  AND visibility = ${AssetVisibility.Timeline}::asset_visibility_enum
                ORDER BY id
                FOR UPDATE
              `.execute(tx)
            ).rows.map(({ id }) => id);

      const published =
        eligible.length === 0
          ? []
          : (
              await sql<{ id: string; updateId: string }>`
                UPDATE asset SET visibility = ${AssetVisibility.Archive}::asset_visibility_enum
                WHERE id = ANY(${eligible}::uuid[])
                RETURNING id, "updateId"
              `.execute(tx)
            ).rows;

      if (published.length > 0) {
        await sql`
          UPDATE immich_fork.archive_operation_item item
          SET status = 'archived', "previousVisibility" = ${AssetVisibility.Timeline}, "publishedUpdateId" = changed."updateId"
          FROM unnest(${published.map(({ id }) => id)}::uuid[], ${published.map(({ updateId }) => updateId)}::uuid[])
            AS changed("assetId", "updateId")
          WHERE item."operationId" = ${operationId}::uuid AND item."assetId" = changed."assetId"
        `.execute(tx);
      }
      const archived = new Set(published.map(({ id }) => id));
      const left = pending.filter((id) => !archived.has(id));
      if (left.length > 0) {
        await this.setStatus(tx, operationId, left, 'skipped');
      }

      for (const { assetId, status } of items) {
        answers.set(assetId, status === 'archived' || archived.has(assetId) ? 'archived' : 'skipped');
      }
      return answers;
    });
  }

  /**
   * One undo batch of the bulk job, in one transaction. Restores an item only while it is still
   * archived with the `updateId` this operation published; an item the archive has not reached is
   * marked skipped so the archive never reaches it afterwards.
   */
  async restore(ownerId: string, operationId: string, jobId: string, ids: string[]) {
    return this.db.transaction().execute(async (tx) => {
      await this.lockWrites(tx);
      const answers = new Map<string, ArchiveItemAnswer>(ids.map((id) => [id, 'missing']));
      const operation = await this.lockOwned(tx, ownerId, operationId);
      if (!operation || (operation.undoJobId && operation.undoJobId !== jobId)) {
        return answers;
      }
      if (!operation.undoJobId) {
        await sql`UPDATE immich_fork.archive_operation SET "undoJobId" = ${jobId}::uuid WHERE id = ${operationId}::uuid`.execute(
          tx,
        );
      }

      const items = await this.lockItems(tx, operationId, ids);
      const unreached = items.filter(({ status }) => status === 'pending').map(({ assetId }) => assetId);
      if (unreached.length > 0) {
        await this.setStatus(tx, operationId, unreached, 'skipped');
      }

      const archived = items.filter(({ status }) => status === 'archived').map(({ assetId }) => assetId);
      const restored =
        archived.length === 0
          ? new Set<string>()
          : new Set(
              (
                await sql<{ id: string }>`
                  UPDATE asset SET visibility = item."previousVisibility"::asset_visibility_enum
                  FROM immich_fork.archive_operation_item item
                  WHERE item."operationId" = ${operationId}::uuid AND item."assetId" = asset.id
                    AND asset.id = ANY(${archived}::uuid[]) AND asset."ownerId" = ${ownerId}::uuid
                    AND asset."deletedAt" IS NULL
                    AND asset.visibility = ${AssetVisibility.Archive}::asset_visibility_enum
                    AND asset."updateId" = item."publishedUpdateId"
                    AND item."previousVisibility" IS NOT NULL
                  RETURNING asset.id
                `.execute(tx)
              ).rows.map(({ id }) => id),
            );
      if (restored.size > 0) {
        await this.setStatus(tx, operationId, [...restored], 'undone');
      }
      const changed = archived.filter((id) => !restored.has(id));
      if (changed.length > 0) {
        await this.setStatus(tx, operationId, changed, 'conflict');
      }

      for (const { assetId, status } of items) {
        if (restored.has(assetId) || status === 'undone') {
          answers.set(assetId, 'undone');
        } else if (status === 'conflict' || changed.includes(assetId)) {
          answers.set(assetId, 'conflict');
        } else if (status === 'pending') {
          answers.set(assetId, 'cancelled');
        } else {
          answers.set(assetId, 'not-archived');
        }
      }
      return answers;
    });
  }

  private async lockItems(tx: Transaction<DB>, operationId: string, ids: string[]) {
    const { rows } = await sql<{ assetId: string; status: ArchiveItemStatus }>`
      SELECT "assetId", status FROM immich_fork.archive_operation_item
      WHERE "operationId" = ${operationId}::uuid AND "assetId" = ANY(${ids}::uuid[])
      ORDER BY "assetId"
      FOR UPDATE
    `.execute(tx);
    return rows;
  }

  private async setStatus(tx: Transaction<DB>, operationId: string, ids: string[], status: ArchiveItemStatus) {
    await sql`
      UPDATE immich_fork.archive_operation_item SET status = ${status}
      WHERE "operationId" = ${operationId}::uuid AND "assetId" = ANY(${ids}::uuid[])
    `.execute(tx);
  }
}
