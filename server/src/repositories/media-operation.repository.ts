import { Injectable } from '@nestjs/common';
import { ExpressionBuilder, Insertable, Kysely, Selectable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import type { PostgresError } from 'postgres';
import { DatabaseLock, MediaOperationCheckpointState, MediaOperationKind, MediaOperationStatus } from 'src/enum.js';
import { lockPublicForkWrites, withPublicForkWrites } from 'src/repositories/fork-write-guard.js';
import { DB } from 'src/schema/index.js';
import { MediaOperationCheckpointTable, MediaOperationTable } from 'src/schema/tables/media-operation.table.js';
import { anyUuid, isLockedAsset } from 'src/utils/database.js';
import { JOB_QUEUE_CLAIMANT, JOB_QUEUE_EXECUTOR, notJobQueueExecuted } from 'src/utils/edit-operation.js';
import {
  CLAIMED_MEDIA_OPERATION_STATUSES,
  MEDIA_OPERATION_AUTO_RETRIES,
  MEDIA_OPERATION_AUTO_RETRY_DELAY_MS,
  MEDIA_OPERATION_LOST_CLAIM_RESUMES,
  PAUSABLE_MEDIA_OPERATION_STATUSES,
  RESUMABLE_MEDIA_OPERATION_KINDS,
  TERMINAL_MEDIA_OPERATION_STATUSES,
} from 'src/utils/media-operation.js';

/** FL-44 (FN-304): what every write here answers while a database handoff holds the schema. */
export const MEDIA_OPERATION_HANDOFF_REFUSAL = 'Media operations are unavailable during database handoff';

export type MediaOperation = Selectable<MediaOperationTable>;

/** One unfinished retry per job (migration 2100000000590, FL-43). */
export const MEDIA_OPERATION_ACTIVE_RETRY_CONSTRAINT = 'media_operation_retryOfId_active_uq';
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

/**
 * The stages a progress report may come from, by the stage it reports (FL-43). A report may stay
 * in its stage or move forward, never back; anything else is not a progress report.
 */
const PROGRESS_FROM: Readonly<Partial<Record<MediaOperationStatus, readonly MediaOperationStatus[]>>> = {
  [MediaOperationStatus.Preparing]: [MediaOperationStatus.Preparing],
  [MediaOperationStatus.Rendering]: [MediaOperationStatus.Preparing, MediaOperationStatus.Rendering],
  [MediaOperationStatus.Validating]: [
    MediaOperationStatus.Preparing,
    MediaOperationStatus.Rendering,
    MediaOperationStatus.Validating,
  ],
};

/** `now() + ms`, for leases and retry delays. */
const nowPlus = (ms: number) => sql<Date>`now() + ${sql.lit(ms)} * interval '1 millisecond'`;

/**
 * Where a job goes when its worker lets go of it without finishing: back to the queue, or — when
 * the owner has asked for a pause (FL-104) — to `paused`, where no worker will take it.
 */
const pausedIfRequested = () =>
  sql<MediaOperationStatus>`case when "pauseRequestedAt" is not null then ${sql.lit(MediaOperationStatus.Paused)} else ${sql.lit(MediaOperationStatus.Queued)} end`;

/**
 * A lapsed claim this job may resume from (FL-43): a resumable kind that has not used up its
 * resumes. The SQL twin of `canResumeLostClaim`; recovery requeues exactly these and treats every
 * other lapse as a failure.
 */
const resumesLostClaim = () =>
  sql<boolean>`("kind" = any(${[...RESUMABLE_MEDIA_OPERATION_KINDS]}::text[]) and "attempt" < least("maxAttempts", ${sql.lit(1 + MEDIA_OPERATION_LOST_CLAIM_RESUMES)}))`;

/** Statuses with no worker attached: a cancel settles them at once. */
const UNCLAIMED_STATUSES = [MediaOperationStatus.Queued, MediaOperationStatus.Paused];

/** A row whose state changed: who to tell, and which job (FL-43 `on_media_operation_update`). */
export type MediaOperationChange = { id: string; ownerId: string };

export type MediaOperationListOptions = {
  ownerId: string;
  kind?: MediaOperationKind;
  statuses?: readonly MediaOperationStatus[];
  /** Finished jobs the owner cleared from Activity are hidden unless explicitly asked for. */
  includeDismissed?: boolean;
  /**
   * Unfinished jobs before finished ones, each newest first (FL-43). Activity asks for a page of
   * recent jobs; with this, a job still running is on that page however many finished since.
   */
  unfinishedFirst?: boolean;
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
  private listeners = new Set<(changes: MediaOperationChange[]) => void>();

  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /** FL-44 (FN-304): a write, refused while a database handoff holds the schema. */
  private write<T>(query: (db: Kysely<DB>) => Promise<T>): Promise<T> {
    return withPublicForkWrites(this.db, query, MEDIA_OPERATION_HANDOFF_REFUSAL);
  }

  /**
   * Be told about rows whose status, stage or progress changed through this repository (FL-43).
   * The owner's open Activity pages are nudged to ask again; nothing about the job travels with it.
   */
  onChange(listener: (changes: MediaOperationChange[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed<T extends Partial<MediaOperationChange> | undefined>(rows: T | T[]): void {
    const changes = (Array.isArray(rows) ? rows : [rows]).filter(
      (row): row is T & MediaOperationChange => !!row?.id && !!row?.ownerId,
    );
    if (changes.length === 0) {
      return;
    }
    for (const listener of this.listeners) {
      try {
        listener(changes.map(({ id, ownerId }) => ({ id, ownerId })));
      } catch {
        // a nudge that cannot be sent never undoes the write it reports
      }
    }
  }

  async create(operation: MediaOperationCreate): Promise<MediaOperation> {
    const row = await this.write((db) =>
      db.insertInto('media_operation').values(operation).returningAll().executeTakeFirstOrThrow(),
    );
    this.changed(row as unknown as MediaOperationChange);
    return row as unknown as MediaOperation;
  }

  /** A worker's read of its own job, not scoped to an owner. Never answers a request. */
  async getForWorker(id: string): Promise<MediaOperation | undefined> {
    return (await this.db
      .selectFrom('media_operation')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()) as unknown as MediaOperation | undefined;
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

  /**
   * A job of one kind by id, whoever submitted it (FL-73). Only for kinds whose page every
   * administrator shares, like physical deduplication; the caller decides what of it to answer with.
   */
  async getOfKind(id: string, kind: MediaOperationKind): Promise<MediaOperation | undefined> {
    return (await this.db
      .selectFrom('media_operation')
      .selectAll()
      .where('id', '=', id)
      .where('kind', '=', kind)
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
        .$if(!!options.unfinishedFirst, (qb) =>
          qb.orderBy(
            sql`case when "status" in (${sql.join(TERMINAL_MEDIA_OPERATION_STATUSES.map((status) => sql.lit(status)))}) then 1 else 0 end`,
          ),
        )
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
   * The newest jobs of one kind across every account (FL-73).
   *
   * Only for work an administrator runs for the whole server — applying a reviewed physical
   * deduplication plan — which every administrator's page shows so nobody applies a second plan on
   * top of a running one. The copy list in the snapshot and the per-copy outcomes in the result
   * name other accounts' media, so neither leaves the database here; the counts do.
   */
  listRecentOfKind(kind: MediaOperationKind, take: number): Promise<MediaOperation[]> {
    return this.db
      .selectFrom('media_operation')
      .select(LIST_COLUMNS)
      .select(
        sql<Record<string, unknown>>`"snapshot" - 'items' - 'retained' - 'excludedRetainedAssetIds'`.as('snapshot'),
      )
      .select(sql<Record<string, unknown> | null>`("result" - 'items' - 'inFlight') #- '{retry,ids}'`.as('result'))
      .where('kind', '=', kind)
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .limit(take)
      .execute() as unknown as Promise<MediaOperation[]>;
  }

  /**
   * Create a job of a kind that runs one at a time across the whole server, or answer with the one
   * already unfinished (FL-73). The check and the insert happen under one transaction-scoped
   * advisory lock, so two administrators applying at the same moment cannot both start a job.
   */
  async createExclusive(
    operation: MediaOperationCreate,
    lock: DatabaseLock,
  ): Promise<{ created: MediaOperation } | { active: { id: string; ownerId: string; fingerprint: string | null } }> {
    return this.db.transaction().execute(async (trx) => {
      await lockPublicForkWrites(trx, MEDIA_OPERATION_HANDOFF_REFUSAL);
      await sql`SELECT pg_advisory_xact_lock(${lock})`.execute(trx);

      const active = await trx
        .selectFrom('media_operation')
        .select(['id', 'ownerId'])
        .select(sql<string | null>`"snapshot"->>'fingerprint'`.as('fingerprint'))
        .where('kind', '=', operation.kind)
        .where('status', 'not in', [...TERMINAL_MEDIA_OPERATION_STATUSES])
        .orderBy('createdAt', 'asc')
        .limit(1)
        .executeTakeFirst();
      if (active) {
        return { active };
      }

      const created = await trx
        .insertInto('media_operation')
        .values(operation)
        .returningAll()
        .executeTakeFirstOrThrow();
      this.changed(created as unknown as MediaOperationChange);
      return { created: created as unknown as MediaOperation };
    });
  }

  /**
   * Create a job unless one of the same kind is already unfinished for the same subject, named by a
   * snapshot key (FL-78: one scan per library). The check and the insert happen under one
   * transaction-scoped advisory lock on the subject, so two requests at the same moment cannot both
   * start a job; the loser is answered with the job that won.
   */
  async createUnlessActive(
    operation: MediaOperationCreate,
    subject: { key: string; value: string; lock: DatabaseLock },
  ): Promise<{ created: MediaOperation } | { active: MediaOperation }> {
    return this.db.transaction().execute(async (trx) => {
      await lockPublicForkWrites(trx, MEDIA_OPERATION_HANDOFF_REFUSAL);
      await sql`SELECT pg_advisory_xact_lock(${subject.lock}::int, hashtext(${subject.value}))`.execute(trx);

      const active = await trx
        .selectFrom('media_operation')
        .selectAll()
        .where('kind', '=', operation.kind)
        .where(sql<boolean>`"snapshot"->>${subject.key} = ${subject.value}`)
        .where('status', 'not in', [...TERMINAL_MEDIA_OPERATION_STATUSES])
        .orderBy('createdAt', 'asc')
        .limit(1)
        .executeTakeFirst();
      if (active) {
        return { active: active as unknown as MediaOperation };
      }

      const created = await trx
        .insertInto('media_operation')
        .values(operation)
        .returningAll()
        .executeTakeFirstOrThrow();
      this.changed(created as unknown as MediaOperationChange);
      return { created: created as unknown as MediaOperation };
    });
  }

  /**
   * The newest job of one kind for each of these subjects, named by a snapshot key (FL-78: each
   * library's latest scan), whoever owns it. Unfinished ones first would hide a finished retry, so
   * this is simply the newest.
   */
  async getLatestBySubject(kind: MediaOperationKind, key: string, values: string[]): Promise<MediaOperation[]> {
    if (values.length === 0) {
      return [];
    }

    return (
      (await this.db
        .selectFrom('media_operation')
        .selectAll()
        // the key is inlined, not bound: DISTINCT ON must match ORDER BY textually
        .distinctOn(sql`"snapshot"->>${sql.lit(key)}`)
        .where('kind', '=', kind)
        .where(sql<boolean>`"snapshot"->>${sql.lit(key)} = any(${values}::text[])`)
        .orderBy(sql`"snapshot"->>${sql.lit(key)}`)
        .orderBy('createdAt', 'desc')
        .orderBy('id', 'desc')
        .execute()) as unknown as MediaOperation[]
    );
  }

  /** The unfinished job of one kind for one subject, whoever owns it (FL-78). */
  async getActiveBySubject(kind: MediaOperationKind, key: string, value: string): Promise<MediaOperation | undefined> {
    return (await this.db
      .selectFrom('media_operation')
      .selectAll()
      .where('kind', '=', kind)
      .where(sql<boolean>`"snapshot"->>${key} = ${value}`)
      .where('status', 'not in', [...TERMINAL_MEDIA_OPERATION_STATUSES])
      .orderBy('createdAt', 'asc')
      .limit(1)
      .executeTakeFirst()) as unknown as MediaOperation | undefined;
  }

  /** Whether any job of these kinds is waiting for a worker right now (FL-78 scan wake-up). */
  async hasClaimable(kinds: readonly MediaOperationKind[]): Promise<boolean> {
    const row = await this.db
      .selectFrom('media_operation')
      .select('id')
      .where('status', '=', MediaOperationStatus.Queued)
      .where('kind', 'in', [...kinds])
      .where('cancelRequestedAt', 'is', null)
      .where((eb) => eb.or([eb('retryAt', 'is', null), eb('retryAt', '<=', sql<Date>`now()`)]))
      .limit(1)
      .executeTakeFirst();
    return !!row;
  }

  /** Any unfinished job of one kind, whoever owns it (FL-73), with the plan it is applying. */
  async getActiveOfKind(kind: MediaOperationKind): Promise<{ id: string; fingerprint: string | null } | undefined> {
    return this.db
      .selectFrom('media_operation')
      .select(['id'])
      .select(sql<string | null>`"snapshot"->>'fingerprint'`.as('fingerprint'))
      .where('kind', '=', kind)
      .where('status', 'not in', [...TERMINAL_MEDIA_OPERATION_STATUSES])
      .orderBy('createdAt', 'asc')
      .limit(1)
      .executeTakeFirst();
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
    const updated = await this.write((db) =>
      db
        .updateTable('media_operation')
        .set({ result })
        .where('id', '=', id)
        .where('status', 'in', [...TERMINAL_MEDIA_OPERATION_STATUSES])
        .executeTakeFirst(),
    );
    return Number(updated.numUpdatedRows) === 1;
  }

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

  /**
   * How many of these assets are the owner's and locked (FL-32; FL-34: the lock record).
   *
   * The bulk worker acts on Locked items, so the Locked folder's PIN is enforced when the job is
   * submitted: a session that has not been unlocked may not queue a job that reaches them.
   */
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

  /**
   * Queue a retry of a job, or answer with the one already unfinished (FL-43).
   *
   * The caller looks for an unfinished retry first; this closes the window between that look and
   * the insert. `media_operation_retryOfId_active_uq` admits one unfinished row per `retryOfId`, so
   * of two requests racing, one inserts and the other finds the winner here.
   */
  async createRetry(operation: MediaOperationCreate & { retryOfId: string }): Promise<{
    operation: MediaOperation;
    created: boolean;
  }> {
    try {
      return { operation: await this.create(operation), created: true };
    } catch (error) {
      if ((error as PostgresError | null)?.constraint_name !== MEDIA_OPERATION_ACTIVE_RETRY_CONSTRAINT) {
        throw error;
      }
      const existing = await this.getActiveRetry(operation.retryOfId, operation.ownerId);
      if (!existing) {
        // The winner finished between its insert and this read; let the caller ask again.
        throw error;
      }
      return { operation: existing, created: false };
    }
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
    const result = await this.write((db) =>
      db
        .updateTable('media_operation')
        .set({ dismissedAt: sql<Date>`now()` })
        .where('id', '=', id)
        .where('ownerId', '=', ownerId)
        .where('status', 'in', [...TERMINAL_MEDIA_OPERATION_STATUSES])
        .where('dismissedAt', 'is', null)
        .executeTakeFirst(),
    );

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

    const row = await this.write((db) =>
      db
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
            // FL-43: an edit the job queue runs is claimed only by its own job.
            .where(notJobQueueExecuted())
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
        .executeTakeFirst(),
    );

    this.changed(row as unknown as MediaOperationChange | undefined);
    return row ? { operation: row as unknown as MediaOperation, claimToken } : undefined;
  }

  /**
   * FL-163: record the remote job a claimed operation started (a Frameleaf Cloud job id), so a cancel or
   * failure that happens while nobody holds the claim still leaves the remote job to be released by the
   * cleanup pass (`getUnreleasedRemoteOperations`). Guarded by the claim, and never overwrites a remote
   * job already recorded: one operation is one remote job.
   */
  async setRemoteJobId(id: string, claimToken: string, remoteJobId: string): Promise<boolean> {
    const result = await this.write((db) =>
      db
        .updateTable('media_operation')
        .set({ remoteJobId })
        .where('id', '=', id)
        .where('claimToken', '=', claimToken)
        .where('status', 'in', [...CLAIMED_MEDIA_OPERATION_STATUSES])
        .where((eb) => eb.or([eb('remoteJobId', 'is', null), eb('remoteJobId', '=', remoteJobId)]))
        .executeTakeFirst(),
    );

    return Number(result.numUpdatedRows) === 1;
  }

  /** Extend the lease. Returns false when the claim has already been taken away. */
  async heartbeat(id: string, claimToken: string, leaseMs: number): Promise<boolean> {
    const result = await this.write((db) =>
      db
        .updateTable('media_operation')
        .set({
          heartbeatAt: sql<Date>`now()`,
          claimExpiresAt: sql<Date>`now() + ${sql.lit(leaseMs)} * interval '1 millisecond'`,
        })
        .where('id', '=', id)
        .where('claimToken', '=', claimToken)
        .where('status', 'in', [...CLAIMED_MEDIA_OPERATION_STATUSES])
        .executeTakeFirst(),
    );

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
    const from = PROGRESS_FROM[patch.status];
    if (!from) {
      return false;
    }

    const row = await this.write((db) =>
      db
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
        // Stages only move forward (FL-43): a job checking its output is never reported as rendering
        // again, and nothing reaches validating except through the stages before it.
        .where('status', 'in', [...from])
        .returning(['id', 'ownerId'])
        .executeTakeFirst(),
    );

    this.changed(row);
    return !!row;
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
    const row = await this.write((db) =>
      db
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
        .executeTakeFirst(),
    );

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
   *
   * A result asset is part of the same guarded write (FL-43): it must be a live asset of the job's
   * owner. A worker — a remote one especially — names the asset it produced, and lineage pointing
   * at somebody else's media, or at nothing, would publish what the owner was never allowed to see.
   */
  async complete(
    id: string,
    claimToken: string,
    result: { resultAssetId: string | null; progress?: number; result?: Record<string, unknown> },
    executor?: Kysely<DB>,
  ): Promise<boolean> {
    // FL-44: a caller's transaction took the handoff guard already (publishValidated); alone, this
    // write takes it itself.
    const run = (db: Kysely<DB>) =>
      db
        .updateTable('media_operation')
        .set({
          status: MediaOperationStatus.Completed,
          resultAssetId: result.resultAssetId,
          ...(result.result && { result: result.result }),
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
        .$if(result.resultAssetId !== null, (qb) =>
          qb.where((eb) =>
            eb.exists(
              eb
                .selectFrom('asset')
                .select('asset.id')
                .where('asset.id', '=', result.resultAssetId!)
                .whereRef('asset.ownerId', '=', 'media_operation.ownerId')
                .where('asset.deletedAt', 'is', null),
            ),
          ),
        )
        .returning(['id', 'ownerId'])
        .executeTakeFirst();
    const updated = await (executor ? run(executor) : this.write(run));

    this.changed(updated);
    return !!updated;
  }

  /** Whether an asset may be adopted as this owner's result: theirs, and not deleted (FL-43). */
  async isPublishableResult(ownerId: string, assetId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('asset')
      .select('id')
      .where('id', '=', assetId)
      .where('ownerId', '=', ownerId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    return !!row;
  }

  /**
   * Adopt a validated output and complete the job as one unit (FL-43).
   *
   * The job's row is locked under its claim first, so for as long as `publish` runs nothing can
   * take the job away: not the owner's cancel, not recovery of a lapsed lease, not a pause. Then:
   *
   * - `lost`: the claim is gone or the job is no longer validating — cancelled while it was being
   *   checked, or requeued after a lapse and perhaps already running elsewhere. `publish` is never
   *   called, so a stale or cancelled worker cannot put its output where a replacement's, or the
   *   previous valid output, lives.
   * - `rejected`: `publish` declined (for example the owner discarded the work meanwhile). The job
   *   stays validating under this claim; the caller fails it.
   * - `completed`: `publish` succeeded and the job completed in the same transaction, so an adopted
   *   output and a completed job are never seen apart.
   *
   * `publish` receives the transaction and must do its database writes through it.
   */
  async publishValidated(
    id: string,
    claimToken: string,
    publish: (trx: Kysely<DB>) => Promise<boolean>,
  ): Promise<'completed' | 'rejected' | 'lost'> {
    return this.db.transaction().execute(async (trx) => {
      await lockPublicForkWrites(trx, MEDIA_OPERATION_HANDOFF_REFUSAL);
      const held = await trx
        .selectFrom('media_operation')
        .select('id')
        .where('id', '=', id)
        .where('claimToken', '=', claimToken)
        .where('status', '=', MediaOperationStatus.Validating)
        .forUpdate()
        .executeTakeFirst();
      if (!held) {
        return 'lost';
      }

      if (!(await publish(trx))) {
        return 'rejected';
      }

      if (!(await this.complete(id, claimToken, { resultAssetId: null }, trx))) {
        // Unreachable while the row is held above under the same predicates; throwing rolls the
        // publication back, so an adopted output and an unfinished job are never committed apart.
        throw new Error(`Media operation ${id} could not complete under the claim that published it`);
      }
      return 'completed';
    });
  }

  /** Move a claimed job to `validating`. The last gate before anything is published. */
  async beginValidation(id: string, claimToken: string): Promise<boolean> {
    const row = await this.write((db) =>
      db
        .updateTable('media_operation')
        .set({ status: MediaOperationStatus.Validating, heartbeatAt: sql<Date>`now()` })
        .where('id', '=', id)
        .where('claimToken', '=', claimToken)
        .where('status', 'in', [MediaOperationStatus.Preparing, MediaOperationStatus.Rendering])
        .returning(['id', 'ownerId'])
        .executeTakeFirst(),
    );

    this.changed(row);
    return !!row;
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
    options: { retry?: boolean } = {},
  ): Promise<MediaOperationFailOutcome> {
    // A failure retrying cannot help (FL-43: an edited item that left the library) is reported at once.
    const requeued =
      options.retry === false
        ? undefined
        : await this.write((db) =>
            db
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
              .returning(['id', 'ownerId'])
              .executeTakeFirst(),
          );

    if (requeued) {
      this.changed(requeued);
      return 'retrying';
    }

    const result = await this.write((db) =>
      db
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
        .returning(['id', 'ownerId'])
        .executeTakeFirst(),
    );

    this.changed(result);
    return result ? 'failed' : false;
  }

  /**
   * Hand a claimed job back to the queue on purpose, keeping everything it has recorded (FL-32).
   *
   * A bulk job does this when its pass is over and some items failed: the automatic retry of those
   * items runs on the next claim, after `delayMs`, from what the result says. It is not a retry of
   * the job itself and does not use `autoRetries`. Returns false when the claim is gone or a cancel
   * was requested; the caller then settles the cancel instead.
   *
   * `returnAttempt` gives the claim's attempt back, as `settlePause` does: an iCloud sync (FL-68)
   * that hands itself back to wait for the provider or for a backed-off item did not fail, and must
   * not use up the attempts lapse recovery counts.
   */
  async requeue(
    id: string,
    claimToken: string,
    options: { delayMs: number; returnAttempt?: boolean },
  ): Promise<boolean> {
    const result = await this.write((db) =>
      db
        .updateTable('media_operation')
        .set({
          // A pause asked for during the pass holds the job here rather than at its next claim.
          status: pausedIfRequested(),
          retryAt: nowPlus(options.delayMs),
          claimToken: null,
          claimedBy: null,
          claimExpiresAt: null,
          ...(options.returnAttempt && { attempt: sql<number>`greatest("attempt" - 1, 0)` }),
        })
        .where('id', '=', id)
        .where('claimToken', '=', claimToken)
        .where('status', 'in', WORKING_STATUSES)
        .where('cancelRequestedAt', 'is', null)
        .returning(['id', 'ownerId'])
        .executeTakeFirst(),
    );

    this.changed(result);
    return !!result;
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
  /**
   * FL-90: unfinished operations of these kinds for these Studio projects, for revocation. With
   * `ownerId`, only that account's.
   */
  async listUnfinishedForProjects(
    projectIds: readonly string[],
    kinds: readonly MediaOperationKind[],
    ownerId?: string,
  ): Promise<Array<{ id: string; ownerId: string; kind: string; projectId: string | null }>> {
    if (projectIds.length === 0 || kinds.length === 0) {
      return [];
    }
    return this.db
      .selectFrom('media_operation')
      .select(['id', 'ownerId', 'kind', 'projectId'])
      .where('projectId', 'in', [...projectIds])
      .where('kind', 'in', [...kinds])
      .$if(ownerId !== undefined, (qb) => qb.where('ownerId', '=', ownerId!))
      .where('status', 'not in', [...TERMINAL_MEDIA_OPERATION_STATUSES])
      .execute();
  }

  async requestCancel(id: string, ownerId: string, claimToken?: string): Promise<MediaOperation | undefined> {
    const row = (await this.write((db) =>
      db
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
        .$if(claimToken !== undefined, (qb) => qb.where('claimToken', '=', claimToken!))
        .where('status', 'not in', [...TERMINAL_MEDIA_OPERATION_STATUSES])
        .returningAll()
        .executeTakeFirst(),
    )) as unknown as MediaOperation | undefined;
    this.changed(row);
    return row;
  }

  /**
   * The worker holding the claim confirms the work stopped.
   *
   * Only then does the job become `cancelled`. `remoteReleasedAt` is recorded separately so an
   * acknowledged cancel whose resources are still being torn down stays visible to the cleanup
   * pass instead of looking finished.
   *
   * Guarded by the claim like every other worker write (FL-43). A cancel keeps the claim it was
   * requested under, so only the worker actually running the job can say it stopped: a worker whose
   * lease lapsed, and whose job was requeued and claimed by another since, must not settle the new
   * claim's cancel while that worker — possibly a remote one still billing — carries on.
   */
  async acknowledgeCancel(id: string, claimToken: string, options: { released: boolean }): Promise<boolean> {
    const result = await this.db
      .updateTable('media_operation')
      .set({
        status: MediaOperationStatus.Cancelled,
        cancelAcknowledgedAt: sql<Date>`now()`,
        ...(options.released && { remoteReleasedAt: sql<Date>`now()` }),
        finishedAt: sql<Date>`coalesce("finishedAt", now())`,
        claimToken: null,
        claimedBy: null,
        claimExpiresAt: null,
      })
      .where('id', '=', id)
      .where('claimToken', '=', claimToken)
      .where('status', '=', MediaOperationStatus.Cancelling)
      .returning(['id', 'ownerId'])
      .executeTakeFirst();

    this.changed(result);
    return !!result;
  }

  /**
   * Cancelled or failed jobs on a remote destination whose cleanup has not been confirmed.
   *
   * These survive owner dismissal on purpose: a cloud job nobody is watching still costs money
   * and still holds data, so the record is kept until the remote says it is gone.
   */
  getUnreleasedRemoteOperations(limit: number, kinds?: readonly MediaOperationKind[]): Promise<MediaOperation[]> {
    return (
      this.db
        .selectFrom('media_operation')
        .selectAll()
        .where('remoteJobId', 'is not', null)
        .where('remoteReleasedAt', 'is', null)
        // FL-163: a cleanup pass for one kind filters before the limit, so other kinds never crowd it out
        .$if(kinds !== undefined, (qb) => qb.where('kind', 'in', [...kinds!]))
        .where((eb) =>
          eb.or([
            eb('status', 'in', [MediaOperationStatus.Cancelling, MediaOperationStatus.Cancelled]),
            eb('status', '=', MediaOperationStatus.Failed),
          ]),
        )
        .orderBy('createdAt', 'asc')
        .limit(limit)
        .execute() as unknown as Promise<MediaOperation[]>
    );
  }

  /**
   * FL-163 review P2: record the remote job an operation started when its claim is already gone, so the
   * job is never left without a row that names it. Only fills an empty handle (or confirms the same
   * one); the cleanup pass and the next claim find the job by it.
   */
  async recordRemoteJobId(id: string, remoteJobId: string): Promise<boolean> {
    const result = await this.write((db) =>
      db
        .updateTable('media_operation')
        .set({ remoteJobId })
        .where('id', '=', id)
        .where((eb) => eb.or([eb('remoteJobId', 'is', null), eb('remoteJobId', '=', remoteJobId)]))
        .executeTakeFirst(),
    );
    return Number(result.numUpdatedRows) === 1;
  }

  /** Several jobs for a worker at once, not scoped to an owner (FL-163 settlement). */
  async getManyForWorker(ids: readonly string[]): Promise<MediaOperation[]> {
    if (ids.length === 0) {
      return [];
    }
    return (await this.db
      .selectFrom('media_operation')
      .selectAll()
      .where('id', 'in', [...ids])
      .execute()) as unknown as MediaOperation[];
  }

  /* ------------------------------------------------------------------ */
  /* Frameleaf Cloud description batches (FL-163)                        */
  /* ------------------------------------------------------------------ */

  /** Every photo in an unfinished description batch, whoever owns it. */
  async getOpenCloudDescriptionAssetIds(): Promise<Set<string>> {
    const rows = await this.db
      .selectFrom('media_operation')
      .select(sql<string>`jsonb_array_elements_text("snapshot" -> 'assetIds')`.as('assetId'))
      .where('kind', '=', MediaOperationKind.CloudDescriptionBatch)
      .where('status', 'not in', [...TERMINAL_MEDIA_OPERATION_STATUSES])
      .execute();
    return new Set(rows.map(({ assetId }) => assetId));
  }

  /**
   * What description batches admitted in [from, to) cost: each batch's settled charge once known, else
   * what the wallet holds for it. With `origin`, only batches made that way (the automatic budget).
   */
  async sumCloudDescriptionSpend(options: {
    from: Date;
    to: Date;
    origin?: 'automatic' | 'backfill';
  }): Promise<number> {
    const admittedAt = sql<Date>`("result" -> 'job' ->> 'admittedAt')::timestamptz`;
    const row = await this.db
      .selectFrom('media_operation')
      .select(
        sql<number>`coalesce(sum(coalesce(("result" ->> 'settledUsd')::double precision, ("result" -> 'job' ->> 'holdUsd')::double precision)), 0)`.as(
          'spentUsd',
        ),
      )
      .where('kind', '=', MediaOperationKind.CloudDescriptionBatch)
      .where(sql<string>`"result" -> 'job' ->> 'jobId'`, 'is not', null)
      .where(admittedAt, '>=', options.from)
      .where(admittedAt, '<', options.to)
      .$if(options.origin !== undefined, (qb) => qb.where(sql<string>`"snapshot" ->> 'origin'`, '=', options.origin!))
      .executeTakeFirstOrThrow();
    return Number(row.spentUsd);
  }

  /**
   * What the wallet holds for a destination's admitted description batches that are not settled yet
   * (FL-163 re-check P2): unfinished batches, and finished ones admitted since `since` (the budget
   * window). A hold released but never reported as settled stops counting once it leaves the window.
   */
  async sumCloudDescriptionOpenHolds(destinationId: string, since: Date): Promise<number> {
    const row = await this.db
      .selectFrom('media_operation')
      .select(sql<number>`coalesce(sum(("result" -> 'job' ->> 'holdUsd')::double precision), 0)`.as('heldUsd'))
      .where('kind', '=', MediaOperationKind.CloudDescriptionBatch)
      .where(sql<string>`"snapshot" ->> 'destinationId'`, '=', destinationId)
      .where((eb) => this.unsettledAdmission(eb, since))
      .executeTakeFirstOrThrow();
    return Number(row.heldUsd);
  }

  /** Whether an admitted description batch still waits for its settlement, bounded as the holds are. */
  async hasUnsettledCloudDescriptionJobs(since: Date): Promise<boolean> {
    const row = await this.db
      .selectFrom('media_operation')
      .select('id')
      .where('kind', '=', MediaOperationKind.CloudDescriptionBatch)
      .where((eb) => this.unsettledAdmission(eb, since))
      .limit(1)
      .executeTakeFirst();
    return !!row;
  }

  /** Admitted, not settled, and either unfinished or admitted since `since`. */
  private unsettledAdmission(eb: ExpressionBuilder<DB, 'media_operation'>, since: Date) {
    return eb.and([
      eb(sql<string>`"result" -> 'job' ->> 'jobId'`, 'is not', null),
      eb(sql<string>`"result" ->> 'settledUsd'`, 'is', null),
      eb.or([
        eb('status', 'not in', [...TERMINAL_MEDIA_OPERATION_STATUSES]),
        eb(sql<Date>`("result" -> 'job' ->> 'admittedAt')::timestamptz`, '>=', since),
      ]),
    ]);
  }

  /**
   * Finished description batches whose `POST /v2/jobs` was sent but whose job was never recorded
   * (FL-163 re-check): the cleanup pass replays their idempotency key, once their estimate expired, to
   * learn whether a job exists and stop it.
   */
  listCloudDescriptionPendingReleases(limit: number): Promise<MediaOperation[]> {
    return (
      this.db
        .selectFrom('media_operation')
        .selectAll()
        .where('kind', '=', MediaOperationKind.CloudDescriptionBatch)
        .where('status', 'in', [...TERMINAL_MEDIA_OPERATION_STATUSES])
        .where('remoteJobId', 'is', null)
        // the saved submission is the pending-release marker: written, with its key, before the POST
        .where(sql<string>`"result" -> 'submission' ->> 'attemptedAt'`, 'is not', null)
        .where(sql<string>`"result" -> 'job' ->> 'jobId'`, 'is', null)
        .orderBy('createdAt', 'asc')
        .limit(limit)
        .execute() as unknown as Promise<MediaOperation[]>
    );
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
    const row = (await this.write((db) =>
      db
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
        .executeTakeFirst(),
    )) as unknown as MediaOperation | undefined;
    this.changed(row);
    return row;
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
    const row = (await this.write((db) =>
      db
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
        .executeTakeFirst(),
    )) as unknown as MediaOperation | undefined;
    this.changed(row);
    return row;
  }

  /**
   * A worker reached a checkpoint with a pause requested and lets go of the job.
   *
   * Guarded by the claim like every worker write, and by the request itself: if the owner resumed
   * in the meantime, nothing changes and the worker is told to carry on. The job keeps everything
   * it recorded, and the attempt it was on is given back, because it did not fail.
   */
  async settlePause(id: string, claimToken: string): Promise<boolean> {
    const result = await this.write((db) =>
      db
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
        .returning(['id', 'ownerId'])
        .executeTakeFirst(),
    );

    this.changed(result);
    return !!result;
  }

  /* ------------------------------------------------------------------ */
  /* Recovery                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Reclaim jobs whose lease expired: the worker died, the server restarted, the network went.
   *
   * Four outcomes, in order of how the row should honestly read afterwards:
   *
   * - A resumable job with lost-claim resumes left returns to the queue and resumes from its
   *   checkpoints (FL-43: at most `MEDIA_OPERATION_LOST_CLAIM_RESUMES`, and never a kind that would
   *   start again from nothing — for those a lost claim is a failure straight away).
   * - One that has none left has failed, and a failure gets its one automatic retry first
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
    const paused = await this.write((db) =>
      db
        .updateTable('media_operation')
        .set({ status: MediaOperationStatus.Paused, claimToken: null, claimedBy: null, claimExpiresAt: null })
        .where('status', 'in', WORKING_STATUSES)
        .where('claimExpiresAt', 'is not', null)
        .where('claimExpiresAt', '<', sql<Date>`now()`)
        .where('pauseRequestedAt', 'is not', null)
        .where('cancelRequestedAt', 'is', null)
        .returning(['id', 'ownerId'])
        .execute(),
    );

    // The steps below also land on `paused` if a pause arrived after the step above ran: the steps
    // are separate statements, and a pause request between them must not leave a queued job with a
    // pause pending that nothing would ever settle.
    const requeued = await this.write((db) =>
      db
        .updateTable('media_operation')
        .set({ status: pausedIfRequested(), claimToken: null, claimedBy: null, claimExpiresAt: null })
        .where('status', 'in', [...CLAIMED_MEDIA_OPERATION_STATUSES])
        .where('claimExpiresAt', 'is not', null)
        .where('claimExpiresAt', '<', sql<Date>`now()`)
        .where(resumesLostClaim())
        // A cancel already requested must not be resurrected as a queued job.
        .where('cancelRequestedAt', 'is', null)
        .returning(['id', 'ownerId'])
        .execute(),
    );

    // Out of attempts is a failure, and every failure gets its one automatic retry first (FL-104).
    const retried = await this.write((db) =>
      db
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
        .where(sql<boolean>`not ${resumesLostClaim()}`)
        .where('autoRetries', '<', MEDIA_OPERATION_AUTO_RETRIES)
        .where('cancelRequestedAt', 'is', null)
        .returning(['id', 'ownerId'])
        .execute(),
    );

    const failed = await this.write((db) =>
      db
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
        .where(sql<boolean>`not ${resumesLostClaim()}`)
        .where('autoRetries', '>=', MEDIA_OPERATION_AUTO_RETRIES)
        .where('cancelRequestedAt', 'is', null)
        .returning(['id', 'ownerId'])
        .execute(),
    );

    const abandonedCancels = await this.write((db) =>
      db
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
        .returning(['id', 'ownerId'])
        .execute(),
    );

    this.changed([...paused, ...requeued, ...retried, ...failed, ...abandonedCancels]);
    return {
      requeued: requeued.length,
      retried: retried.length,
      failed: failed.length,
      abandonedCancels: abandonedCancels.length,
      paused: paused.length,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Job-queue edits (FL-43)                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Claim an edit row for the delivery of its job. Only a queued row the job queue holds is taken,
   * and only once: a second delivery of the same job, a delivery after a cancel, or one after the
   * row finished changes nothing and is told so. The retry delay is the job queue's to keep; a job
   * delivered with its row is the row's retry.
   */
  async beginJobQueueRun(
    id: string,
    leaseMs: number,
  ): Promise<{ operation: MediaOperation; claimToken: string } | undefined> {
    const claimToken = randomUUID();
    const row = await this.write((db) =>
      db
        .updateTable('media_operation')
        .set({
          status: MediaOperationStatus.Preparing,
          claimToken,
          claimedBy: JOB_QUEUE_CLAIMANT,
          claimExpiresAt: nowPlus(leaseMs),
          heartbeatAt: sql<Date>`now()`,
          startedAt: sql<Date>`coalesce("startedAt", now())`,
          attempt: sql<number>`"attempt" + 1`,
          retryAt: null,
        })
        .where('id', '=', id)
        .where('status', '=', MediaOperationStatus.Queued)
        .where('claimedBy', '=', JOB_QUEUE_CLAIMANT)
        .where('cancelRequestedAt', 'is', null)
        .where(sql<boolean>`"snapshot"->>'executor' = ${JOB_QUEUE_EXECUTOR}`)
        .returningAll()
        .executeTakeFirst(),
    );

    this.changed(row as unknown as MediaOperationChange | undefined);
    return row ? { operation: row as unknown as MediaOperation, claimToken } : undefined;
  }

  /**
   * Take the job-queue rows that have no job to run them, for dispatch: queued without a holder
   * (an automatic retry, a lapsed claim recovery put back, a manual retry) once their retry time has
   * come, and rows still waiting with their job long after they were last touched, whose job the
   * queue has evidently lost. Each is marked held by the job queue as it is taken, so two passes
   * never dispatch the same row, and a duplicate delivery is refused by `beginJobQueueRun` anyway.
   */
  async claimJobQueueDispatch(options: {
    limit: number;
    staleMs: number;
  }): Promise<Pick<MediaOperation, 'id' | 'ownerId' | 'snapshot'>[]> {
    const rows = await this.write((db) =>
      db
        .updateTable('media_operation')
        .set({ claimedBy: JOB_QUEUE_CLAIMANT })
        .where(
          'id',
          'in',
          this.db
            .selectFrom('media_operation')
            .select('id')
            .where('status', '=', MediaOperationStatus.Queued)
            .where('cancelRequestedAt', 'is', null)
            .where(sql<boolean>`"snapshot"->>'executor' = ${JOB_QUEUE_EXECUTOR}`)
            .where((eb) =>
              eb.or([
                eb.and([
                  eb('claimedBy', 'is', null),
                  eb.or([eb('retryAt', 'is', null), eb('retryAt', '<=', sql<Date>`now()`)]),
                ]),
                eb.and([eb('claimedBy', '=', JOB_QUEUE_CLAIMANT), eb('updatedAt', '<', nowPlus(-options.staleMs))]),
              ]),
            )
            .orderBy('createdAt', 'asc')
            .limit(options.limit)
            .forUpdate()
            .skipLocked(),
        )
        .returning(['id', 'ownerId', 'snapshot'])
        .execute(),
    );

    return rows as unknown as Pick<MediaOperation, 'id' | 'ownerId' | 'snapshot'>[];
  }

  /** Dispatch failed: the rows wait for the next pass instead of looking queued with a job. */
  async releaseJobQueueDispatch(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.db
      .updateTable('media_operation')
      .set({ claimedBy: null })
      .where('id', 'in', ids)
      .where('status', '=', MediaOperationStatus.Queued)
      .where('claimedBy', '=', JOB_QUEUE_CLAIMANT)
      .execute();
  }

  /** The owner's unfinished edit rows for one photo version (FL-43), so an editor cancel reaches them. */
  listActiveEditsOfRevision(ownerId: string, revisionId: string): Promise<Pick<MediaOperation, 'id' | 'status'>[]> {
    return this.db
      .selectFrom('media_operation')
      .select(['id', 'status'])
      .where('ownerId', '=', ownerId)
      .where('kind', '=', MediaOperationKind.QuickEdit)
      .where('revisionId', '=', revisionId)
      .where('status', 'not in', [...TERMINAL_MEDIA_OPERATION_STATUSES])
      .where(sql<boolean>`"snapshot"->>'executor' = ${JOB_QUEUE_EXECUTOR}`)
      .execute() as unknown as Promise<Pick<MediaOperation, 'id' | 'status'>[]>;
  }

  /** Which of these photo versions an unfinished edit row is watching (FL-43). */
  async getTrackedRevisionIds(revisionIds: string[]): Promise<Set<string>> {
    if (revisionIds.length === 0) {
      return new Set();
    }
    const rows = await this.db
      .selectFrom('media_operation')
      .select('revisionId')
      .where('kind', '=', MediaOperationKind.QuickEdit)
      .where('revisionId', 'in', revisionIds)
      .where('status', 'not in', [...TERMINAL_MEDIA_OPERATION_STATUSES])
      .where(sql<boolean>`"snapshot"->>'executor' = ${JOB_QUEUE_EXECUTOR}`)
      .execute();
    return new Set(rows.map(({ revisionId }) => revisionId as string));
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
    return this.db.transaction().execute(async (trx) => {
      await lockPublicForkWrites(trx, MEDIA_OPERATION_HANDOFF_REFUSAL);
      // The claim check and the write are one unit (FL-43): the share lock holds off recovery's
      // requeue of this row until the chunk is recorded, so a lease that lapses between the two
      // cannot let a presumed-dead worker re-plan a chunk its replacement already owns.
      if (!(await this.lockClaim(trx, operationId, claimToken))) {
        return false;
      }

      await trx
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
    });
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
    return this.db.transaction().execute(async (trx) => {
      await lockPublicForkWrites(trx, MEDIA_OPERATION_HANDOFF_REFUSAL);
      if (!(await this.lockClaim(trx, operationId, claimToken))) {
        return false;
      }

      const result = await trx
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
    });
  }

  /** Retire chunks that can no longer describe the work. Invalid chunks are never reused. */
  async invalidateCheckpointsFrom(operationId: string, sequence: number): Promise<void> {
    await this.write((db) =>
      db
        .updateTable('media_operation_checkpoint')
        .set({ state: MediaOperationCheckpointState.Invalid })
        .where('operationId', '=', operationId)
        .where('sequence', '>=', sequence)
        .execute(),
    );
  }

  /**
   * Whether this claim still holds the job, taking a share lock on the row for the rest of the
   * transaction. Every claim transfer — recovery, cancel, pause, completion — is an UPDATE of this
   * row and waits for the lock, so what the caller writes next is written under a claim that cannot
   * change underneath it.
   */
  private async lockClaim(trx: Kysely<DB>, operationId: string, claimToken: string): Promise<boolean> {
    const row = await trx
      .selectFrom('media_operation')
      .select('id')
      .where('id', '=', operationId)
      .where('claimToken', '=', claimToken)
      .where('status', 'in', [...CLAIMED_MEDIA_OPERATION_STATUSES])
      .forShare()
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
   * path: an administrator can see that eleven renders are queued on Frameleaf Cloud without learning
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
        sql<string>`count(*) filter (where "status" = any(${[...CLAIMED_MEDIA_OPERATION_STATUSES]}::text[]))`.as(
          'active',
        ),
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
