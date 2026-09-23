import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Selectable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import { MediaOperationCheckpointState, MediaOperationKind, MediaOperationStatus } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import {
  MediaOperationCheckpointTable,
  MediaOperationTable,
} from 'src/schema/tables/media-operation.table.js';
import { anyUuid, isLockedAsset } from 'src/utils/database.js';
import {
  CLAIMED_MEDIA_OPERATION_STATUSES,
  MEDIA_OPERATION_AUTO_RETRIES,
  MEDIA_OPERATION_AUTO_RETRY_DELAY_MS,
  PAUSABLE_MEDIA_OPERATION_STATUSES,
  TERMINAL_MEDIA_OPERATION_STATUSES,
} from 'src/utils/media-operation.js';

export type MediaOperation = Selectable<MediaOperationTable>;
export type MediaOperationCheckpoint = Selectable<MediaOperationCheckpointTable>;

export type MediaOperationCreate = Omit<
  Insertable<MediaOperationTable>,
  'id' | 'createdAt' | 'updatedAt' | 'updateId' | 'status' | 'progress' | 'attempt' | 'autoRetries' | 'retryAt'
>;

/**
 * What a worker's failure report did (FL-104).
 *
 * - `retrying`: the job had its automatic retry left, so it went back to the queue instead.
 * - `failed`: it had used it (or a cancel was requested), so the failure is what the owner sees.
 * - `false`: the claim was not ours any more, or the job had already finished; nothing changed.
 */
export type MediaOperationFailOutcome = 'retrying' | 'failed' | false;

/** What one recovery pass over lapsed claims did, by outcome (see `recoverExpiredClaims`). */
export type MediaOperationRecovery = {
  requeued: number;
  retried: number;
  failed: number;
  abandonedCancels: number;
  paused: number;
};

/** What a worker learns from a write: whether to carry on, stop for a cancel, or stop for a pause. */
export type MediaOperationWriteState = {
  status: MediaOperationStatus;
  cancelRequestedAt: Date | null;
  pauseRequestedAt: Date | null;
};

/** The statuses a live claim may report from. `cancelling` is left out: a cancel is never retried. */
const WORKING_STATUSES = [
  MediaOperationStatus.Preparing,
  MediaOperationStatus.Rendering,
  MediaOperationStatus.Validating,
];

/** `now() + ms`, for leases and retry delays. */
const nowPlus = (ms: number) => sql<Date>`now() + ${sql.lit(ms)} * interval '1 millisecond'`;

/**
 * Where a job goes when its worker lets go of it without finishing: back to the queue, or — when
 * the owner has asked for a pause (FL-104) — to `paused`, where no worker will take it.
 */
const pausedIfRequested = () =>
  sql<MediaOperationStatus>`case when "pauseRequestedAt" is not null then ${sql.lit(MediaOperationStatus.Paused)} else ${sql.lit(MediaOperationStatus.Queued)} end`;

/** Statuses with no worker attached: a cancel settles them at once. */
const UNCLAIMED_STATUSES = [MediaOperationStatus.Queued, MediaOperationStatus.Paused];

export type MediaOperationListOptions = {
  ownerId: string;
  kind?: MediaOperationKind;
  statuses?: readonly MediaOperationStatus[];
  /** Finished jobs the owner cleared from Activity are hidden unless explicitly asked for. */
  includeDismissed?: boolean;
  take: number;
  skip: number;
};

/** One server process holding claims (FL-72 worker inventory). Identity only, never whose media. */
export type MediaOperationClaimantRow = {
  workerId: string;
  kind: MediaOperationKind;
  count: number;
  lastHeartbeatAt: Date | null;
};

/** Queued and claimed jobs per destination named in the snapshot (FL-72 worker inventory). */
export type MediaOperationDestinationLoadRow = {
  destinationId: string;
  queued: number;
  active: number;
};

/** What the admin aggregate may contain: counts, ages and destinations. Never media, never names. */
export type MediaOperationAggregateRow = {
  kind: MediaOperationKind;
  status: MediaOperationStatus;
  destination: string;
  count: number;
  oldestQueuedAt: Date | null;
};

/** Every column except the two JSON documents `list` trims rather than returns whole. */
const LIST_COLUMNS = [
  'id',
  'ownerId',
  'kind',
  'status',
  'destination',
  'destinationDetail',
  'label',
  'assetId',
  'resultAssetId',
  'retryOfId',
  'projectId',
  'revisionId',
  'settings',
  'estimate',
  'progress',
  'processedUnits',
  'totalUnits',
  'attempt',
  'maxAttempts',
  'autoRetries',
  'retryAt',
  'claimToken',
  'claimedBy',
  'claimExpiresAt',
  'heartbeatAt',
  'cancelRequestedAt',
  'cancelAcknowledgedAt',
  'pauseRequestedAt',
  'remoteJobId',
  'remoteReleasedAt',
  'error',
  'errorCode',
  'startedAt',
  'finishedAt',
  'dismissedAt',
  'createdAt',
  'updatedAt',
  'updateId',
] as const;

/**
 * Durable media operations (FL-43, FL-104).
 *
 * Every worker-facing write is a conditional UPDATE guarded by the claim token. That is the whole
 * defence against a resurrected worker: the guard is in the WHERE clause, so two workers racing
 * for the same job resolve in Postgres rather than in application code, and a stale token updates
 * zero rows and is reported as such rather than silently succeeding.
 */
@Injectable()
export class MediaOperationRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  async create(operation: MediaOperationCreate): Promise<MediaOperation> {
    const row = await this.db.insertInto('media_operation').values(operation).returningAll().executeTakeFirstOrThrow();
    return row as unknown as MediaOperation;
  }

  /** Owner-scoped read. Anything that answers a request goes through this or `list`. */
  async getForOwner(id: string, ownerId: string): Promise<MediaOperation | undefined> {
    return (await this.db
      .selectFrom('media_operation')
      .selectAll()
      .where('id', '=', id)
      .where('ownerId', '=', ownerId)
      .executeTakeFirst()) as unknown as MediaOperation | undefined;
  }

  async list(options: MediaOperationListOptions): Promise<{ items: MediaOperation[]; total: number }> {
    let query = this.db.selectFrom('media_operation').where('ownerId', '=', options.ownerId);

    if (options.kind) {
      query = query.where('kind', '=', options.kind);
    }

    if (options.statuses?.length) {
      query = query.where('status', 'in', [...options.statuses]);
    }

    if (!options.includeDismissed) {
      query = query.where('dismissedAt', 'is', null);
    }

    const [items, total] = await Promise.all([
      query
        .select(LIST_COLUMNS)
        // A bulk job's snapshot carries every asset id it was frozen with, and its result every
        // recorded refusal, the ids waiting for their automatic retry and the starting dates of a
        // date shift. The list shows none of them, and polling it must not drag them along; the
        // retry pass keeps its count.
        .select(sql<Record<string, unknown>>`"snapshot" - 'assetIds'`.as('snapshot'))
        .select(sql<Record<string, unknown> | null>`("result" - 'items' - 'shiftFrom') #- '{retry,ids}'`.as('result'))
        // Newest first; the id is a v7 uuid so it orders by creation without a second column.
        .orderBy('createdAt', 'desc')
        .orderBy('id', 'desc')
        .limit(options.take)
        .offset(options.skip)
        .execute(),
      query
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .executeTakeFirst()
        .then((row) => Number(row?.count ?? 0)),
    ]);

    return { items: items as unknown as MediaOperation[], total };
  }

  /**
   * The owner's bulk operation submitted under a client idempotency key, if any (FL-32).
   *
   * A double-clicked submit or a browser retrying a request it never saw answered finds the first
   * job here instead of starting a second one over the same items.
   */
  async getBulkByRequestId(ownerId: string, requestId: string): Promise<MediaOperation | undefined> {
    return (await this.db
      .selectFrom('media_operation')
      .selectAll()
      .where('ownerId', '=', ownerId)
      .where('kind', '=', MediaOperationKind.Bulk)
      .where(sql<string>`"snapshot"->>'requestId'`, '=', requestId)
      .orderBy('createdAt', 'asc')
      .limit(1)
      .executeTakeFirst()) as unknown as MediaOperation | undefined;
  }

  /**
   * The owner's job of one kind submitted under a client idempotency key, if any (FL-91).
   *
   * The same rule as bulk submission, for kinds whose snapshot records `requestKey`: a repeated
   * submit answers with the first job instead of queuing the same work twice.
   */
  async getByRequestKey(
    ownerId: string,
    kind: MediaOperationKind,
    requestKey: string,
  ): Promise<MediaOperation | undefined> {
    return (await this.db
      .selectFrom('media_operation')
      .selectAll()
      .where('ownerId', '=', ownerId)
      .where('kind', '=', kind)
      .where(sql<string>`"snapshot"->>'requestKey'`, '=', requestKey)
      .orderBy('createdAt', 'asc')
      .limit(1)
      .executeTakeFirst()) as unknown as MediaOperation | undefined;
  }

  /**
   * Finished bundle exports whose file is past its expiry and has not been swept yet (FL-91).
   * The row stays for lineage; the sweep removes the file and records `expiredAt` in the result.
   */
  async listExpiredBundleExports(
    now: Date,
    limit = 200,
  ): Promise<Array<Pick<MediaOperation, 'id' | 'ownerId' | 'result'>>> {
    return (await this.db
      .selectFrom('media_operation')
      .select(['id', 'ownerId', 'result'])
      .where('kind', '=', MediaOperationKind.StudioBundleExport)
      .where('status', '=', MediaOperationStatus.Completed)
      .where(sql<boolean>`"result"->>'expiredAt' is null`)
      .where(sql<boolean>`("result"->>'expiresAt')::timestamptz < ${now}`)
      .orderBy('finishedAt', 'asc')
      .limit(limit)
      .execute()) as unknown as Array<Pick<MediaOperation, 'id' | 'ownerId' | 'result'>>;
  }

  /** Replace the result of a job no worker holds. Used by sweeps on finished jobs only. */
  async setFinishedResult(id: string, result: Record<string, unknown>): Promise<boolean> {
    const updated = await this.db
      .updateTable('media_operation')
      .set({ result })
      .where('id', '=', id)
      .where('status', 'in', [...TERMINAL_MEDIA_OPERATION_STATUSES])
      .executeTakeFirst();
    return Number(updated.numUpdatedRows) === 1;
  }

  /**
   * How many of these assets are the owner's and locked (FL-32; FL-34: the lock record).
   *
   * The bulk worker acts on Locked items, so the Locked folder's PIN is enforced when the job is
   * submitted: a session that has not been unlocked may not queue a job that reaches them.
   */
  /**
   * Which of these assets are locked right now (FL-34). The bulk worker skips them for a job that
   * was submitted without the PIN: something may have locked them after the job was queued.
   */
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

  async countLockedAssets(ownerId: string, assetIds: string[]): Promise<number> {
    if (assetIds.length === 0) {
      return 0;
    }

    const row = await this.db
      .selectFrom('asset')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('ownerId', '=', ownerId)
      .where('id', '=', anyUuid(assetIds))
      .where((eb) => isLockedAsset(eb))
      .executeTakeFirst();

    return Number(row?.count ?? 0);
  }

  /**
   * Which of these ids are the owner's Locked media (FL-34). An operation keeps the ids it was given;
   * a read from a session that has not been unlocked must not name the ones that are Locked now.
   */
  async getLockedAssetIds(ownerId: string, assetIds: string[]): Promise<Set<string>> {
    if (assetIds.length === 0) {
      return new Set();
    }

    const rows = await this.db
      .selectFrom('asset')
      .select('asset.id')
      .where('asset.ownerId', '=', ownerId)
      .where('asset.id', '=', anyUuid(assetIds))
      .where((eb) => isLockedAsset(eb))
      .execute();
    return new Set(rows.map(({ id }) => id));
  }

  /**
   * The capture date of each of the owner's assets, for a relative date shift's starting points
   * (FL-32). An asset without a metadata row answers null; one that is not the owner's, or is gone,
   * is left out of the answer.
   */
  async getDateTimeOriginals(ownerId: string, assetIds: string[]): Promise<Map<string, Date | null>> {
    if (assetIds.length === 0) {
      return new Map();
    }

    const rows = await this.db
      .selectFrom('asset')
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select(['asset.id', 'asset_exif.dateTimeOriginal'])
      .where('asset.ownerId', '=', ownerId)
      .where('asset.id', '=', anyUuid(assetIds))
      .execute();

    return new Map(
      rows.map((row): [string, Date | null] => {
        const value = row.dateTimeOriginal as unknown as Date | string | null;
        return [row.id, value ? new Date(value) : null];
      }),
    );
  }

  /**
   * A retry of this job that is still running, if there is one.
   *
   * Retry is idempotent on this: asking twice while the first retry is working answers with that
   * retry rather than queueing a second pass over the same items.
   */
  async getActiveRetry(retryOfId: string, ownerId: string): Promise<MediaOperation | undefined> {
    return (await this.db
      .selectFrom('media_operation')
      .selectAll()
      .where('retryOfId', '=', retryOfId)
      .where('ownerId', '=', ownerId)
      .where('status', 'not in', [...TERMINAL_MEDIA_OPERATION_STATUSES])
      .orderBy('createdAt', 'desc')
      .limit(1)
      .executeTakeFirst()) as unknown as MediaOperation | undefined;
  }

  getCheckpoints(operationId: string): Promise<MediaOperationCheckpoint[]> {
    return this.db
      .selectFrom('media_operation_checkpoint')
      .selectAll()
      .where('operationId', '=', operationId)
      .orderBy('sequence', 'asc')
      .execute() as unknown as Promise<MediaOperationCheckpoint[]>;
  }

  /**
   * Clear a finished job out of the owner's Activity list.
   *
   * The row stays: lineage still points at it and an unreleased remote job still has to be
   * cleaned up. Only the owner's view of it changes.
   */
  async dismiss(id: string, ownerId: string): Promise<boolean> {
    const result = await this.db
      .updateTable('media_operation')
      .set({ dismissedAt: sql<Date>`now()` })
      .where('id', '=', id)
      .where('ownerId', '=', ownerId)
      .where('status', 'in', [...TERMINAL_MEDIA_OPERATION_STATUSES])
      .where('dismissedAt', 'is', null)
      .executeTakeFirst();

    return Number(result.numUpdatedRows) === 1;
  }

  /* ------------------------------------------------------------------ */
  /* Claim lifecycle                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Take the oldest queued job of a kind, atomically.
   *
   * `FOR UPDATE SKIP LOCKED` is what makes two workers asking at the same time pick two different
   * jobs instead of both picking the oldest. The returned token is the only way to write to the
   * job afterwards.
   *
   * `holdBack` leaves jobs of the given kinds whose snapshot names one of the given destinations
   * queued for now (FL-72: a full restoration on a worker that shares library analysis's GPU waits
   * while library analysis has work). They are skipped, not failed or moved, and the next claim
   * without them in `holdBack` takes them in their original order.
   */
  async claimNext(options: {
    kinds: readonly MediaOperationKind[];
    workerId: string;
    leaseMs: number;
    holdBack?: { kinds: readonly MediaOperationKind[]; destinationIds: readonly string[] };
  }): Promise<{ operation: MediaOperation; claimToken: string } | undefined> {
    const claimToken = randomUUID();
    const holdBack =
      options.holdBack && options.holdBack.kinds.length > 0 && options.holdBack.destinationIds.length > 0
        ? options.holdBack
        : undefined;

    const row = await this.db
      .updateTable('media_operation')
      .set({
        status: MediaOperationStatus.Preparing,
        claimToken,
        claimedBy: options.workerId,
        claimExpiresAt: sql<Date>`now() + ${sql.lit(options.leaseMs)} * interval '1 millisecond'`,
        heartbeatAt: sql<Date>`now()`,
        startedAt: sql<Date>`coalesce("startedAt", now())`,
        attempt: sql<number>`"attempt" + 1`,
        retryAt: null,
      })
      .where(
        'id',
        '=',
        this.db
          .selectFrom('media_operation')
          .select('id')
          .where('status', '=', MediaOperationStatus.Queued)
          .where('kind', 'in', [...options.kinds])
          .where('cancelRequestedAt', 'is', null)
          // A requeued job waits out its retry delay before anybody may take it.
          .where((eb) => eb.or([eb('retryAt', 'is', null), eb('retryAt', '<=', sql<Date>`now()`)]))
          .$if(!!holdBack, (qb) =>
            qb.where(
              sql<boolean>`not ("kind" = any(${[...holdBack!.kinds]}::text[]) and coalesce("snapshot"->>'destinationId', '') = any(${[...holdBack!.destinationIds]}::text[]))`,
            ),
          )
          .orderBy('createdAt', 'asc')
          .limit(1)
          .forUpdate()
          .skipLocked(),
      )
      .returningAll()
      .executeTakeFirst();

    return row ? { operation: row as unknown as MediaOperation, claimToken } : undefined;
  }

  /** Extend the lease. Returns false when the claim has already been taken away. */
  async heartbeat(id: string, claimToken: string, leaseMs: number): Promise<boolean> {
    const result = await this.db
      .updateTable('media_operation')
      .set({
        heartbeatAt: sql<Date>`now()`,
        claimExpiresAt: sql<Date>`now() + ${sql.lit(leaseMs)} * interval '1 millisecond'`,
      })
      .where('id', '=', id)
      .where('claimToken', '=', claimToken)
      .where('status', 'in', [...CLAIMED_MEDIA_OPERATION_STATUSES])
      .executeTakeFirst();

    return Number(result.numUpdatedRows) === 1;
  }

  /**
   * Record real progress.
   *
   * The status is part of the guarded write so a worker cannot report `rendering` on a job the
   * owner has already asked to cancel: `cancelling` is not in the allowed set, so the update
   * matches nothing and the worker learns its claim no longer authorizes it.
   */
  async reportProgress(
    id: string,
    claimToken: string,
    patch: { status: MediaOperationStatus; processedUnits: number; totalUnits: number | null; progress: number },
  ): Promise<boolean> {
    const result = await this.db
      .updateTable('media_operation')
      .set({
        status: patch.status,
        processedUnits: String(patch.processedUnits),
        totalUnits: patch.totalUnits === null ? null : String(patch.totalUnits),
        progress: patch.progress,
        heartbeatAt: sql<Date>`now()`,
      })
      .where('id', '=', id)
      .where('claimToken', '=', claimToken)
      .where('status', 'in', [
        MediaOperationStatus.Preparing,
        MediaOperationStatus.Rendering,
        MediaOperationStatus.Validating,
      ])
      .executeTakeFirst();

    return Number(result.numUpdatedRows) === 1;
  }

  /**
   * Record what a bulk operation has done so far (FL-32), and extend the lease while doing it.
   *
   * Unlike `reportProgress` this does not change the status, and it is allowed while the job is
   * `cancelling`: a batch that was applied before the owner pressed Cancel really happened, and its
   * outcome has to land on the row even though the job is stopping. The returned status is how the
   * runner learns about that cancel in the same round trip.
   *
   * Returns undefined when the claim is no longer ours, in which case the runner must stop at once.
   * A `pauseRequestedAt` in the answer means the owner asked to pause: the runner stops at this
   * boundary and hands the claim back with `settlePause` (FL-104).
   */
  async setBulkResult(
    id: string,
    claimToken: string,
    patch: {
      result: Record<string, unknown>;
      processedUnits: number;
      totalUnits: number;
      progress: number;
      leaseMs: number;
    },
  ): Promise<MediaOperationWriteState | undefined> {
    const row = await this.db
      .updateTable('media_operation')
      .set({
        result: patch.result,
        processedUnits: String(patch.processedUnits),
        totalUnits: String(patch.totalUnits),
        progress: patch.progress,
        heartbeatAt: sql<Date>`now()`,
        claimExpiresAt: sql<Date>`now() + ${sql.lit(patch.leaseMs)} * interval '1 millisecond'`,
      })
      .where('id', '=', id)
      .where('claimToken', '=', claimToken)
      .where('status', 'in', [...CLAIMED_MEDIA_OPERATION_STATUSES])
      .returning(['status', 'cancelRequestedAt', 'pauseRequestedAt'])
      .executeTakeFirst();

    return row
      ? {
          status: row.status as MediaOperationStatus,
          cancelRequestedAt: (row.cancelRequestedAt as unknown as Date | null) ?? null,
          pauseRequestedAt: (row.pauseRequestedAt as unknown as Date | null) ?? null,
        }
      : undefined;
  }

  /**
   * Publish a validated result.
   *
   * Guarded by the claim and by `status = validating`: an output may only be adopted by the claim
   * that produced it, and only after validation. A previous valid result stays where it is until
   * this succeeds, so a failed attempt never destroys the last good version.
   */
  async complete(
    id: string,
    claimToken: string,
    result: { resultAssetId: string | null; progress?: number },
  ): Promise<boolean> {
    const updated = await this.db
      .updateTable('media_operation')
      .set({
        status: MediaOperationStatus.Completed,
        resultAssetId: result.resultAssetId,
        progress: result.progress ?? 100,
        finishedAt: sql<Date>`now()`,
        claimToken: null,
        claimExpiresAt: null,
        error: null,
        errorCode: null,
        // A pause that arrived too late to be reached has nothing left to hold.
        pauseRequestedAt: null,
      })
      .where('id', '=', id)
      .where('claimToken', '=', claimToken)
      .where('status', '=', MediaOperationStatus.Validating)
      .executeTakeFirst();

    return Number(updated.numUpdatedRows) === 1;
  }

  /** Move a claimed job to `validating`. The last gate before anything is published. */
  async beginValidation(id: string, claimToken: string): Promise<boolean> {
    const result = await this.db
      .updateTable('media_operation')
      .set({ status: MediaOperationStatus.Validating, heartbeatAt: sql<Date>`now()` })
      .where('id', '=', id)
      .where('claimToken', '=', claimToken)
      .where('status', 'in', [MediaOperationStatus.Preparing, MediaOperationStatus.Rendering])
      .executeTakeFirst();

    return Number(result.numUpdatedRows) === 1;
  }

  /**
   * Report a claimed job's failure.
   *
   * Every job gets one automatic retry before a failure is reported (FL-104, owner decision
   * September 22, 2026). While it has one left, a failure puts the job back in the queue instead:
   * the claim is released, `autoRetries` goes up and `retryAt` holds it back for
   * `MEDIA_OPERATION_AUTO_RETRY_DELAY_MS`. The error stays on the row so Activity can say why the
   * job is being retried. A job whose cancellation was requested is never retried.
   *
   * Both writes are guarded by the claim token, so a stale worker changes nothing, and a job that
   * has already finished is not reopened by a late report. The retry resumes from whatever the job
   * recorded, which is why every runner must make a repeated step harmless.
   *
   * This is the one automatic retry for every kind: bulk, render workers (Studio exports and
   * previews, quick edits), restorations and Studio bundles all report failure here and nowhere
   * else, so no runner can add a second retry of its own on top (FL-104).
   */
  async fail(
    id: string,
    claimToken: string,
    failure: { error: string; errorCode: string },
  ): Promise<MediaOperationFailOutcome> {
    const requeued = await this.db
      .updateTable('media_operation')
      .set({
        // The owner asked to pause: the retry waits for them instead of running by itself.
        status: pausedIfRequested(),
        error: failure.error,
        errorCode: failure.errorCode,
        autoRetries: sql<number>`"autoRetries" + 1`,
        retryAt: nowPlus(MEDIA_OPERATION_AUTO_RETRY_DELAY_MS),
        claimToken: null,
        claimedBy: null,
        claimExpiresAt: null,
      })
      .where('id', '=', id)
      .where('claimToken', '=', claimToken)
      .where('status', 'in', WORKING_STATUSES)
      .where('cancelRequestedAt', 'is', null)
      .where('autoRetries', '<', MEDIA_OPERATION_AUTO_RETRIES)
      .executeTakeFirst();

    if (Number(requeued.numUpdatedRows) === 1) {
      return 'retrying';
    }

    const result = await this.db
      .updateTable('media_operation')
      .set({
        status: MediaOperationStatus.Failed,
        error: failure.error,
        errorCode: failure.errorCode,
        finishedAt: sql<Date>`now()`,
        retryAt: null,
        claimToken: null,
        claimExpiresAt: null,
        pauseRequestedAt: null,
      })
      .where('id', '=', id)
      .where('claimToken', '=', claimToken)
      .where('status', 'not in', [...TERMINAL_MEDIA_OPERATION_STATUSES])
      .executeTakeFirst();

    return Number(result.numUpdatedRows) === 1 ? 'failed' : false;
  }

  /**
   * Hand a claimed job back to the queue on purpose, keeping everything it has recorded (FL-32).
   *
   * A bulk job does this when its pass is over and some items failed: the automatic retry of those
   * items runs on the next claim, after `delayMs`, from what the result says. It is not a retry of
   * the job itself and does not use `autoRetries`. Returns false when the claim is gone or a cancel
   * was requested; the caller then settles the cancel instead.
   */
  async requeue(id: string, claimToken: string, options: { delayMs: number }): Promise<boolean> {
    const result = await this.db
      .updateTable('media_operation')
      .set({
        // A pause asked for during the pass holds the job here rather than at its next claim.
        status: pausedIfRequested(),
        retryAt: nowPlus(options.delayMs),
        claimToken: null,
        claimedBy: null,
        claimExpiresAt: null,
      })
      .where('id', '=', id)
      .where('claimToken', '=', claimToken)
      .where('status', 'in', WORKING_STATUSES)
      .where('cancelRequestedAt', 'is', null)
      .executeTakeFirst();

    return Number(result.numUpdatedRows) === 1;
  }

  /* ------------------------------------------------------------------ */
  /* Cancellation                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Record the owner's cancellation.
   *
   * A queued job has no worker to tell, so it is cancelled outright. Anything already claimed
   * goes to `cancelling` and stays there until the remote acknowledges: an unacknowledged cancel
   * is an open obligation, not a finished one.
   *
   * A claimed job keeps its lease on purpose. The worker needs it to answer — and if the worker
   * has died instead, the lease expiring is how recovery finds out. Revoking the token here would
   * leave the job stuck at `cancelling` with nobody able to settle it.
   */
  async requestCancel(id: string, ownerId: string): Promise<MediaOperation | undefined> {
    return (await this.db
      .updateTable('media_operation')
      .set((eb) => ({
        // A paused job has no worker either (FL-104), so it is cancelled outright like a queued one.
        status: eb
          .case()
          .when('status', 'in', UNCLAIMED_STATUSES)
          .then(MediaOperationStatus.Cancelled)
          .else(MediaOperationStatus.Cancelling)
          .end(),
        cancelRequestedAt: sql<Date>`coalesce("cancelRequestedAt", now())`,
        cancelAcknowledgedAt: eb
          .case()
          .when('status', 'in', UNCLAIMED_STATUSES)
          .then(sql<Date>`now()`)
          .else(eb.ref('cancelAcknowledgedAt'))
          .end(),
        finishedAt: eb
          .case()
          .when('status', 'in', UNCLAIMED_STATUSES)
          .then(sql<Date>`now()`)
          .else(eb.ref('finishedAt'))
          .end(),
        // Only a queued or paused job had no worker to revoke.
        claimToken: eb.case().when('status', 'in', UNCLAIMED_STATUSES).then(null).else(eb.ref('claimToken')).end(),
        claimExpiresAt: eb
          .case()
          .when('status', 'in', UNCLAIMED_STATUSES)
          .then(null)
          .else(eb.ref('claimExpiresAt'))
          .end(),
        // Stopping outranks holding: a pause waiting to be reached is dropped.
        pauseRequestedAt: null,
      }))
      .where('id', '=', id)
      .where('ownerId', '=', ownerId)
      .where('status', 'not in', [...TERMINAL_MEDIA_OPERATION_STATUSES])
      .returningAll()
      .executeTakeFirst()) as unknown as MediaOperation | undefined;
  }

  /**
   * The remote confirmed the work stopped.
   *
   * Only then does the job become `cancelled`. `remoteReleasedAt` is recorded separately so an
   * acknowledged cancel whose resources are still being torn down stays visible to the cleanup
   * pass instead of looking finished.
   */
  async acknowledgeCancel(id: string, options: { released: boolean }): Promise<boolean> {
    const result = await this.db
      .updateTable('media_operation')
      .set({
        status: MediaOperationStatus.Cancelled,
        cancelAcknowledgedAt: sql<Date>`now()`,
        ...(options.released ? { remoteReleasedAt: sql<Date>`now()` } : {}),
        finishedAt: sql<Date>`coalesce("finishedAt", now())`,
        claimToken: null,
        claimExpiresAt: null,
      })
      .where('id', '=', id)
      .where('status', '=', MediaOperationStatus.Cancelling)
      .executeTakeFirst();

    return Number(result.numUpdatedRows) === 1;
  }

  /**
   * Cancelled or failed jobs on a remote destination whose cleanup has not been confirmed.
   *
   * These survive owner dismissal on purpose: a RunPod job nobody is watching still costs money
   * and still holds data, so the record is kept until the remote says it is gone.
   */
  getUnreleasedRemoteOperations(limit: number): Promise<MediaOperation[]> {
    return this.db
      .selectFrom('media_operation')
      .selectAll()
      .where('remoteJobId', 'is not', null)
      .where('remoteReleasedAt', 'is', null)
      .where((eb) =>
        eb.or([
          eb('status', 'in', [MediaOperationStatus.Cancelling, MediaOperationStatus.Cancelled]),
          eb('status', '=', MediaOperationStatus.Failed),
        ]),
      )
      .orderBy('createdAt', 'asc')
      .limit(limit)
      .execute() as unknown as Promise<MediaOperation[]>;
  }

  async markRemoteReleased(id: string): Promise<void> {
    await this.db
      .updateTable('media_operation')
      .set({ remoteReleasedAt: sql<Date>`now()` })
      .where('id', '=', id)
      .execute();
  }

  /* ------------------------------------------------------------------ */
  /* Pause and resume (FL-104, owner request September 23, 2026)        */
  /* ------------------------------------------------------------------ */

  /**
   * Record the owner's pause.
   *
   * A queued job has no worker, so it becomes `paused` at once and no claim will take it. A claimed
   * job keeps its status and its lease: the request is written to `pauseRequestedAt` and its worker
   * stops at its next checkpoint, where `settlePause` hands the claim back. Pausing twice is
   * harmless. A job that is finishing, being cancelled or already finished is left alone, which is
   * what the undefined answer means.
   */
  async requestPause(
    id: string,
    ownerId: string,
    kinds: readonly MediaOperationKind[],
  ): Promise<MediaOperation | undefined> {
    return (await this.db
      .updateTable('media_operation')
      .set((eb) => ({
        status: eb
          .case()
          .when('status', '=', MediaOperationStatus.Queued)
          .then(MediaOperationStatus.Paused)
          .else(eb.ref('status'))
          .end(),
        pauseRequestedAt: sql<Date>`coalesce("pauseRequestedAt", now())`,
      }))
      .where('id', '=', id)
      .where('ownerId', '=', ownerId)
      .where('kind', 'in', [...kinds])
      .where('status', 'in', [...PAUSABLE_MEDIA_OPERATION_STATUSES])
      .where('cancelRequestedAt', 'is', null)
      .returningAll()
      .executeTakeFirst()) as unknown as MediaOperation | undefined;
  }

  /**
   * Resume a paused job, or withdraw a pause its worker has not reached yet.
   *
   * A paused job goes back to the queue with everything it recorded, and the next claim carries on
   * from there: a bulk job from its cursor, a render from its checkpoints. A pending retry delay is
   * kept, so resuming never skips the wait before an automatic retry. A running job whose pause is
   * still pending simply keeps running.
   */
  async resume(id: string, ownerId: string): Promise<MediaOperation | undefined> {
    return (await this.db
      .updateTable('media_operation')
      .set((eb) => ({
        status: eb
          .case()
          .when('status', '=', MediaOperationStatus.Paused)
          .then(MediaOperationStatus.Queued)
          .else(eb.ref('status'))
          .end(),
        pauseRequestedAt: null,
      }))
      .where('id', '=', id)
      .where('ownerId', '=', ownerId)
      .where('cancelRequestedAt', 'is', null)
      .where((eb) =>
        eb.or([
          eb('status', '=', MediaOperationStatus.Paused),
          eb.and([eb('pauseRequestedAt', 'is not', null), eb('status', 'in', WORKING_STATUSES)]),
        ]),
      )
      .returningAll()
      .executeTakeFirst()) as unknown as MediaOperation | undefined;
  }

  /**
   * A worker reached a checkpoint with a pause requested and lets go of the job.
   *
   * Guarded by the claim like every worker write, and by the request itself: if the owner resumed
   * in the meantime, nothing changes and the worker is told to carry on. The job keeps everything
   * it recorded, and the attempt it was on is given back, because it did not fail.
   */
  async settlePause(id: string, claimToken: string): Promise<boolean> {
    const result = await this.db
      .updateTable('media_operation')
      .set({
        status: MediaOperationStatus.Paused,
        claimToken: null,
        claimedBy: null,
        claimExpiresAt: null,
        attempt: sql<number>`greatest("attempt" - 1, 0)`,
      })
      .where('id', '=', id)
      .where('claimToken', '=', claimToken)
      // Never while validating: that output is about to be adopted, and a runner that moved there
      // after it last looked must not have it thrown away by a late settle.
      .where('status', 'in', [MediaOperationStatus.Preparing, MediaOperationStatus.Rendering])
      .where('pauseRequestedAt', 'is not', null)
      .where('cancelRequestedAt', 'is', null)
      .executeTakeFirst();

    return Number(result.numUpdatedRows) === 1;
  }

  /* ------------------------------------------------------------------ */
  /* Recovery                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Reclaim jobs whose lease expired: the worker died, the server restarted, the network went.
   *
   * Four outcomes, in order of how the row should honestly read afterwards:
   *
   * - A job with attempts left returns to the queue and resumes from its checkpoints.
   * - One that has exhausted them has failed, and a failure gets its one automatic retry first
   *   (FL-104): it returns to the queue after the retry delay with the error recorded.
   * - One that has also used its automatic retry fails with a stable code rather than looping.
   * - One the owner had already asked to cancel becomes `cancelled`, because it plainly stopped —
   *   but `cancelAcknowledgedAt` stays null, so a remote job whose cleanup nobody confirmed is
   *   still an open obligation for the cleanup pass.
   *
   * Clearing the claim token is what makes all of them safe: if the old worker comes back, none of
   * its writes match any more.
   *
   * A job whose owner asked for a pause is none of the above: it becomes `paused` (FL-104). That
   * step runs first, and the steps after it only match jobs whose status is still claimed, so a
   * paused job is never also requeued or failed. A job that is already `paused` holds no claim to
   * lapse, so recovery never touches it.
   *
   * Every kind is recovered in one pass, and only `MediaOperationSweepService` calls this, so a
   * lapsed claim is judged once, by one set of rules, whichever worker held it (FL-104).
   */
  async recoverExpiredClaims(options: { errorCode: string; error: string }): Promise<MediaOperationRecovery> {
    // A job whose owner asked to pause stays paused when its worker disappears (FL-104): the pause
    // is what the owner wanted, and resuming it later picks up from its checkpoints like a requeue.
    // Unlike `settlePause`, the attempt is not given back: the worker vanished, which is what
    // attempts count, whether or not a pause was also waiting.
    const paused = await this.db
      .updateTable('media_operation')
      .set({ status: MediaOperationStatus.Paused, claimToken: null, claimedBy: null, claimExpiresAt: null })
      .where('status', 'in', WORKING_STATUSES)
      .where('claimExpiresAt', 'is not', null)
      .where('claimExpiresAt', '<', sql<Date>`now()`)
      .where('pauseRequestedAt', 'is not', null)
      .where('cancelRequestedAt', 'is', null)
      .executeTakeFirst();

    // The steps below also land on `paused` if a pause arrived after the step above ran: the steps
    // are separate statements, and a pause request between them must not leave a queued job with a
    // pause pending that nothing would ever settle.
    const requeued = await this.db
      .updateTable('media_operation')
      .set({ status: pausedIfRequested(), claimToken: null, claimedBy: null, claimExpiresAt: null })
      .where('status', 'in', [...CLAIMED_MEDIA_OPERATION_STATUSES])
      .where('claimExpiresAt', 'is not', null)
      .where('claimExpiresAt', '<', sql<Date>`now()`)
      .where(sql<boolean>`"attempt" < "maxAttempts"`)
      // A cancel already requested must not be resurrected as a queued job.
      .where('cancelRequestedAt', 'is', null)
      .executeTakeFirst();

    // Out of attempts is a failure, and every failure gets its one automatic retry first (FL-104).
    const retried = await this.db
      .updateTable('media_operation')
      .set({
        status: pausedIfRequested(),
        error: options.error,
        errorCode: options.errorCode,
        autoRetries: sql<number>`"autoRetries" + 1`,
        retryAt: nowPlus(MEDIA_OPERATION_AUTO_RETRY_DELAY_MS),
        claimToken: null,
        claimedBy: null,
        claimExpiresAt: null,
      })
      .where('status', 'in', [...CLAIMED_MEDIA_OPERATION_STATUSES])
      .where('claimExpiresAt', 'is not', null)
      .where('claimExpiresAt', '<', sql<Date>`now()`)
      .where(sql<boolean>`"attempt" >= "maxAttempts"`)
      .where('autoRetries', '<', MEDIA_OPERATION_AUTO_RETRIES)
      .where('cancelRequestedAt', 'is', null)
      .executeTakeFirst();

    const failed = await this.db
      .updateTable('media_operation')
      .set({
        status: MediaOperationStatus.Failed,
        error: options.error,
        errorCode: options.errorCode,
        finishedAt: sql<Date>`now()`,
        claimToken: null,
        claimedBy: null,
        claimExpiresAt: null,
      })
      .where('status', 'in', [...CLAIMED_MEDIA_OPERATION_STATUSES])
      .where('claimExpiresAt', 'is not', null)
      .where('claimExpiresAt', '<', sql<Date>`now()`)
      .where(sql<boolean>`"attempt" >= "maxAttempts"`)
      .where('autoRetries', '>=', MEDIA_OPERATION_AUTO_RETRIES)
      .where('cancelRequestedAt', 'is', null)
      .executeTakeFirst();

    const abandonedCancels = await this.db
      .updateTable('media_operation')
      .set({
        status: MediaOperationStatus.Cancelled,
        finishedAt: sql<Date>`coalesce("finishedAt", now())`,
        claimToken: null,
        claimedBy: null,
        claimExpiresAt: null,
      })
      .where('status', 'in', [...CLAIMED_MEDIA_OPERATION_STATUSES])
      .where('claimExpiresAt', 'is not', null)
      .where('claimExpiresAt', '<', sql<Date>`now()`)
      .where('cancelRequestedAt', 'is not', null)
      .executeTakeFirst();

    return {
      requeued: Number(requeued.numUpdatedRows),
      retried: Number(retried.numUpdatedRows),
      failed: Number(failed.numUpdatedRows),
      abandonedCancels: Number(abandonedCancels.numUpdatedRows),
      paused: Number(paused.numUpdatedRows),
    };
  }

  /* ------------------------------------------------------------------ */
  /* Checkpoints                                                         */
  /* ------------------------------------------------------------------ */

  /** Record a planned chunk. Re-planning the same sequence replaces its identity and clears it. */
  async upsertCheckpoint(
    operationId: string,
    claimToken: string,
    chunk: Insertable<MediaOperationCheckpointTable>,
  ): Promise<boolean> {
    const claimed = await this.hasClaim(operationId, claimToken);
    if (!claimed) {
      return false;
    }

    await this.db
      .insertInto('media_operation_checkpoint')
      .values({ ...chunk, operationId, claimToken })
      .onConflict((oc) =>
        oc.columns(['operationId', 'sequence']).doUpdateSet({
          state: MediaOperationCheckpointState.Pending,
          chunkKey: chunk.chunkKey,
          inputDigest: chunk.inputDigest,
          historyDigest: chunk.historyDigest,
          configDigest: chunk.configDigest,
          seed: chunk.seed ?? null,
          timebase: chunk.timebase,
          startTicks: chunk.startTicks,
          endTicks: chunk.endTicks,
          prerollTicks: chunk.prerollTicks ?? '0',
          requiresSequentialContext: chunk.requiresSequentialContext ?? false,
          outputPath: null,
          outputChecksum: null,
          sizeInBytes: null,
          completedAt: null,
          claimToken,
          attempt: sql<number>`"media_operation_checkpoint"."attempt" + 1`,
        }),
      )
      .execute();

    return true;
  }

  /**
   * Mark a chunk finished.
   *
   * Guarded twice: the job's claim must still be ours, and the chunk row itself must still carry
   * the same key we claim to have rendered. A worker whose lease lapsed while it was encoding
   * cannot come back and declare a chunk complete that the replacement has since re-planned.
   */
  async completeCheckpoint(
    operationId: string,
    claimToken: string,
    chunk: { sequence: number; chunkKey: string; outputPath: string; outputChecksum: Buffer; sizeInBytes: number },
  ): Promise<boolean> {
    const claimed = await this.hasClaim(operationId, claimToken);
    if (!claimed) {
      return false;
    }

    const result = await this.db
      .updateTable('media_operation_checkpoint')
      .set({
        state: MediaOperationCheckpointState.Complete,
        outputPath: chunk.outputPath,
        outputChecksum: chunk.outputChecksum,
        sizeInBytes: String(chunk.sizeInBytes),
        completedAt: sql<Date>`now()`,
      })
      .where('operationId', '=', operationId)
      .where('sequence', '=', chunk.sequence)
      .where('chunkKey', '=', chunk.chunkKey)
      .where('claimToken', '=', claimToken)
      .executeTakeFirst();

    return Number(result.numUpdatedRows) === 1;
  }

  /** Retire chunks that can no longer describe the work. Invalid chunks are never reused. */
  async invalidateCheckpointsFrom(operationId: string, sequence: number): Promise<void> {
    await this.db
      .updateTable('media_operation_checkpoint')
      .set({ state: MediaOperationCheckpointState.Invalid })
      .where('operationId', '=', operationId)
      .where('sequence', '>=', sequence)
      .execute();
  }

  private async hasClaim(operationId: string, claimToken: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('media_operation')
      .select('id')
      .where('id', '=', operationId)
      .where('claimToken', '=', claimToken)
      .where('status', 'in', [...CLAIMED_MEDIA_OPERATION_STATUSES])
      .executeTakeFirst();

    return !!row;
  }

  /* ------------------------------------------------------------------ */
  /* Operational aggregates                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Counts for the administrator's operational view.
   *
   * Grouped by kind, status and destination and nothing else. No owner, no label, no asset, no
   * path: an administrator can see that eleven renders are queued on RunPod without learning
   * whose media they are.
   */
  async getAggregates(): Promise<MediaOperationAggregateRow[]> {
    const rows = await this.db
      .selectFrom('media_operation')
      .select((eb) => [
        'kind',
        'status',
        'destination',
        eb.fn.countAll<string>().as('count'),
        eb.fn.min('createdAt').as('oldestQueuedAt'),
      ])
      .groupBy(['kind', 'status', 'destination'])
      .execute();

    return rows.map((row) => ({
      kind: row.kind as MediaOperationKind,
      status: row.status as MediaOperationStatus,
      destination: row.destination as string,
      count: Number(row.count),
      oldestQueuedAt: (row.oldestQueuedAt as Date | null) ?? null,
    }));
  }

  /**
   * Who holds claims on these kinds right now, grouped by worker identity and kind (FL-72). The
   * worker identity is the claiming process (`restoration:<host>:<pid>` or a render worker id);
   * no owner, asset or label is read.
   */
  async getClaimants(kinds: readonly MediaOperationKind[]): Promise<MediaOperationClaimantRow[]> {
    if (kinds.length === 0) {
      return [];
    }
    const rows = await this.db
      .selectFrom('media_operation')
      .select((eb) => [
        'claimedBy',
        'kind',
        eb.fn.countAll<string>().as('count'),
        eb.fn.max('heartbeatAt').as('lastHeartbeatAt'),
      ])
      .where('kind', 'in', [...kinds])
      .where('status', 'in', [...CLAIMED_MEDIA_OPERATION_STATUSES])
      .where('claimedBy', 'is not', null)
      .groupBy(['claimedBy', 'kind'])
      .execute();

    return rows.map((row) => ({
      workerId: row.claimedBy as string,
      kind: row.kind as MediaOperationKind,
      count: Number(row.count),
      lastHeartbeatAt: (row.lastHeartbeatAt as Date | null) ?? null,
    }));
  }

  /**
   * Queued and claimed jobs of these kinds per destination the snapshot names (FL-72). Counts
   * only; an administrator learns how busy a worker is, not whose media it holds.
   */
  async getDestinationLoad(kinds: readonly MediaOperationKind[]): Promise<MediaOperationDestinationLoadRow[]> {
    if (kinds.length === 0) {
      return [];
    }
    const destinationId = sql<string>`"snapshot"->>'destinationId'`;
    const rows = await this.db
      .selectFrom('media_operation')
      .select([
        destinationId.as('destinationId'),
        sql<string>`count(*) filter (where "status" = ${MediaOperationStatus.Queued})`.as('queued'),
        sql<string>`count(*) filter (where "status" = any(${[...CLAIMED_MEDIA_OPERATION_STATUSES]}::text[]))`.as('active'),
      ])
      .where('kind', 'in', [...kinds])
      .where('status', 'in', [MediaOperationStatus.Queued, ...CLAIMED_MEDIA_OPERATION_STATUSES])
      .where(destinationId, 'is not', null)
      .groupBy(destinationId)
      .execute();

    return rows
      .map((row) => ({ destinationId: row.destinationId, queued: Number(row.queued), active: Number(row.active) }))
      .filter((row) => row.queued > 0 || row.active > 0);
  }
}
