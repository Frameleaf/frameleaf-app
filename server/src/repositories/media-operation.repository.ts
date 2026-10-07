import { ConflictException, Injectable } from '@nestjs/common';
import { ExpressionBuilder, Insertable, Kysely, Selectable, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import type { PostgresError } from 'postgres';
import {
  DatabaseLock,
  MediaOperationCheckpointState,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
} from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { publicationTransaction } from 'src/queue/transaction.js';
import { DB } from 'src/schema/index.js';
import { MediaOperationCheckpointTable, MediaOperationTable } from 'src/schema/tables/media-operation.table.js';
import { anyUuid, isLockedAsset } from 'src/utils/database.js';
import { JOB_QUEUE_CLAIMANT, JOB_QUEUE_EXECUTOR, notJobQueueExecuted } from 'src/utils/edit-operation.js';
import {
  CLAIMED_MEDIA_OPERATION_STATUSES,
  MEDIA_OPERATION_AUTO_RETRIES,
  MEDIA_OPERATION_AUTO_RETRY_DELAY_MS,
  PAUSABLE_MEDIA_OPERATION_STATUSES,
  SAFE_MEDIA_OPERATION_REPLAY_KINDS,
  TERMINAL_MEDIA_OPERATION_STATUSES,
} from 'src/utils/media-operation.js';
import { canonicalJson } from 'src/utils/studio-project.js';

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
/** Only audited local compute can replay without confirmation of an external side effect. */
const safeAutomaticReplay = () => sql<boolean>`("kind" = any(${[...SAFE_MEDIA_OPERATION_REPLAY_KINDS]}::text[])
  and "destination" = ${MediaOperationDestination.Local} and "remoteJobId" is null)`;

/** Queue-owned operations cannot recover before their execution owner has been fenced. */
const executionOwnerSettled = () => sql<boolean>`("claimedBy" is distinct from 'job-queue' or not exists (
  select 1 from public.job j where j.state = 'active' and j.data->>'operationId' = media_operation.id::text
))`;
/** Statuses with no worker attached: a cancel settles them at once. */
const UNCLAIMED_STATUSES = [MediaOperationStatus.Queued, MediaOperationStatus.Paused];
/** A row whose state changed: who to tell, and which job (FL-43 `on_media_operation_update`). */
export type MediaOperationChange = {
  id: string;
  ownerId: string;
};
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
/** FL-162: one confirmed Frameleaf Cloud job, as a person's monthly spend counts it. */
export type CloudMlJobSpendRow = {
  status: MediaOperationStatus;
  remoteJobId: string | null;
  result: unknown;
  holdUsd: number | null;
  settledUsd: number | null;
};
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
  constructor(
    @InjectKysely()
    private db: Kysely<DB>,
  ) {}
  /** Execute the write in a database transaction. */
  private write<T>(query: (db: Kysely<DB>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(query);
  }
  /**
   * Be told about rows whose status, stage or progress changed through this repository (FL-43).
   * The owner's open Activity pages are nudged to ask again; nothing about the job travels with it.
   */
  onChange(listener: (changes: MediaOperationChange[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed<T extends Partial<MediaOperationChange> | undefined>(rows: T | T[], executor?: Kysely<DB>): void {
    const changes = (Array.isArray(rows) ? rows : [rows]).filter(
      (row): row is T & MediaOperationChange => !!row?.id && !!row?.ownerId,
    );
    if (changes.length === 0) {
      return;
    }
    const context = queueExecution.getStore();
    // An external transaction owns its commit. Without its queue observer scope, keep the
    // durable update silent rather than announce a change that can still roll back.
    if (executor?.isTransaction && !(context && Object.is(executor, publicationTransaction.getStore()))) return;
    if (context && publicationTransaction.getStore()) {
      (context.afterCommit ??= []).push(() => Promise.resolve(this.changed(changes)));
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
  /** Serialize command submission with the project's edit lease and saves, including duplicate requests. */
  async createStudioReverseCommand(
    operation: MediaOperationCreate,
    binding: {
      requestKey: string;
      clientId: string;
      revision: number;
    },
  ): Promise<MediaOperation> {
    const row = await this.db.transaction().execute(async (tx) => {
      const project = await tx
        .selectFrom('studio_project')
        .selectAll()
        .where('id', '=', operation.projectId!)
        .where('ownerId', '=', operation.ownerId)
        .where('deletedAt', 'is', null)
        .where('archivedAt', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!project || operation.kind !== MediaOperationKind.StudioReverseConform) {
        throw new ConflictException('The reverse-conform project is unavailable');
      }
      const existing = await tx
        .selectFrom('media_operation')
        .selectAll()
        .where('projectId', '=', project.id)
        .where('ownerId', '=', operation.ownerId)
        .where('kind', '=', MediaOperationKind.StudioReverseConform)
        .where(sql<string>`"snapshot"->>'requestKey'`, '=', binding.requestKey)
        .executeTakeFirst();
      if (existing) {
        if (canonicalJson(existing.snapshot) !== canonicalJson(operation.snapshot)) {
          throw new ConflictException('This reverse-conform request key was already used for another command');
        }
        return existing;
      }
      const held = await tx
        .selectFrom('studio_project')
        .select('id')
        .where('id', '=', project.id)
        .where('currentRevision', '=', binding.revision)
        .where('leaseHolderId', '=', operation.ownerId)
        .where('leaseClientId', '=', binding.clientId)
        .where('leaseExpiresAt', '>', sql<Date>`clock_timestamp()`)
        .executeTakeFirst();
      if (!held) {
        throw new ConflictException('The reverse-conform revision or edit lease changed');
      }
      return tx.insertInto('media_operation').values(operation).returningAll().executeTakeFirstOrThrow();
    });
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
  async list(options: MediaOperationListOptions): Promise<{
    items: MediaOperation[];
    total: number;
  }> {
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
   * FL-164: `alsoKinds` makes other kinds exclusive with it too (a cloud backup run and a cloud restore
   * both use the bucket, so neither starts while the other is unfinished); they must use the same lock.
   */
  async createExclusive(
    operation: MediaOperationCreate,
    lock: DatabaseLock,
    options: {
      alsoKinds?: readonly MediaOperationKind[];
    } = {},
  ): Promise<
    | {
        created: MediaOperation;
      }
    | {
        active: {
          id: string;
          ownerId: string;
          fingerprint: string | null;
        };
      }
  > {
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(${lock})`.execute(trx);
      const active = await trx
        .selectFrom('media_operation')
        .select(['id', 'ownerId'])
        .select(sql<string | null>`"snapshot"->>'fingerprint'`.as('fingerprint'))
        .where('kind', 'in', [operation.kind, ...(options.alsoKinds ?? [])])
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
    subject: {
      key: string;
      value: string;
      lock: DatabaseLock;
    },
    executor?: Transaction<DB>,
  ): Promise<
    | {
        created: MediaOperation;
      }
    | {
        active: MediaOperation;
      }
  > {
    const create = async (trx: Transaction<DB>) => {
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
    };
    return executor ? create(executor) : this.db.transaction().execute(create);
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
  /**
   * FL-168: every unfinished job of these kinds, whoever submitted it (queued, paused, running or
   * already cancelling), oldest first. For a server-wide stop such as turning cloud processing off.
   */
  async listUnfinishedOfKinds(kinds: readonly MediaOperationKind[]): Promise<
    Array<{
      id: string;
      ownerId: string;
      kind: MediaOperationKind;
      status: MediaOperationStatus;
    }>
  > {
    if (kinds.length === 0) {
      return [];
    }
    return (await this.db
      .selectFrom('media_operation')
      .select(['id', 'ownerId', 'kind', 'status'])
      .where('kind', 'in', [...kinds])
      .where('status', 'not in', [...TERMINAL_MEDIA_OPERATION_STATUSES])
      .orderBy('createdAt', 'asc')
      .execute()) as unknown as Array<{
      id: string;
      ownerId: string;
      kind: MediaOperationKind;
      status: MediaOperationStatus;
    }>;
  }
  async getActiveOfKind(kind: MediaOperationKind): Promise<
    | {
        id: string;
        fingerprint: string | null;
      }
    | undefined
  > {
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
  async createRetry(
    operation: MediaOperationCreate & {
      retryOfId: string;
    },
  ): Promise<{
    operation: MediaOperation;
    created: boolean;
  }> {
    // A consumer owns one terminal admission and its directory. Copying its snapshot would
    // create a new worker using that retired frame ID, bypassing fresh Studio authorization.
    // Read the original server allocation, not an arbitrary flag on the caller's retry payload.
    const scoped = await this.db
      .selectFrom('media_operation')
      .select('id')
      .where('id', '=', operation.retryOfId)
      .where('ownerId', '=', operation.ownerId)
      .where('kind', '=', MediaOperationKind.StudioPreview)
      .where(
        sql<boolean>`("snapshot" ? 'consumerRequestId' OR EXISTS (
        SELECT 1 FROM studio_preview_frame f WHERE f."operationId" = "media_operation"."id"
        AND f."ownerId" = "media_operation"."ownerId" AND f."cacheKey" LIKE 'fl279c1:%'
      ))`,
      )
      .executeTakeFirst();
    if (scoped) {
      throw new ConflictException('Request a new consumer preview from Studio');
    }
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
    holdBack?: {
      kinds: readonly MediaOperationKind[];
      destinationIds: readonly string[];
    };
  }): Promise<
    | {
        operation: MediaOperation;
        claimToken: string;
      }
    | undefined
  > {
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
  async heartbeat(
    id: string,
    claimToken: string,
    leaseMs: number,
    options: { requireActiveClaim?: boolean } = {},
  ): Promise<boolean> {
    const result = await this.write((db) =>
      db
        .updateTable('media_operation')
        .set({
          heartbeatAt: sql<Date>`now()`,
          claimExpiresAt: sql<Date>`now() + ${sql.lit(leaseMs)} * interval '1 millisecond'`,
        })
        .where('id', '=', id)
        .where('claimToken', '=', claimToken)
        .where('claimExpiresAt', '>', sql<Date>`clock_timestamp()`)
        .$if(options.requireActiveClaim === true, (qb) =>
          qb.where('cancelRequestedAt', 'is', null).where('pauseRequestedAt', 'is', null),
        )
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
    patch: {
      status: MediaOperationStatus;
      processedUnits: number;
      totalUnits: number | null;
      progress: number;
    },
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
    executor?: Kysely<DB>,
    requireActiveClaim = false,
  ): Promise<MediaOperationWriteState | undefined> {
    const write = (db: Kysely<DB>) =>
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
        .where('claimExpiresAt', '>', sql<Date>`clock_timestamp()`)
        .where('status', 'in', [...CLAIMED_MEDIA_OPERATION_STATUSES])
        .$if(requireActiveClaim, (qb) =>
          qb
            .where('status', '=', MediaOperationStatus.Rendering)
            .where('cancelRequestedAt', 'is', null)
            .where('pauseRequestedAt', 'is', null),
        )
        .returning(['status', 'cancelRequestedAt', 'pauseRequestedAt'])
        .executeTakeFirst();
    const row = await (executor ? write(executor) : this.write(write));
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
    result: {
      resultAssetId: string | null;
      progress?: number;
      result?: Record<string, unknown>;
    },
    executor?: Kysely<DB>,
    requireActiveClaim = false,
  ): Promise<boolean> {
    // Use the caller's publication transaction when supplied; otherwise open a transaction here.
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
        .$if(requireActiveClaim, (qb) =>
          qb
            .where('claimExpiresAt', '>', sql<Date>`clock_timestamp()`)
            .where('cancelRequestedAt', 'is', null)
            .where('pauseRequestedAt', 'is', null),
        )
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
    publish: (trx: Transaction<DB>) => Promise<boolean>,
  ): Promise<'completed' | 'rejected' | 'lost'> {
    return this.db.transaction().execute(async (trx) => {
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
  async beginValidation(
    id: string,
    claimToken: string,
    requireActiveClaim = false,
    executor?: Kysely<DB>,
  ): Promise<boolean> {
    const write = (db: Kysely<DB>) =>
      db
        .updateTable('media_operation')
        .set({ status: MediaOperationStatus.Validating, heartbeatAt: sql<Date>`now()` })
        .where('id', '=', id)
        .where('claimToken', '=', claimToken)
        .where('status', 'in', [MediaOperationStatus.Preparing, MediaOperationStatus.Rendering])
        .$if(requireActiveClaim, (qb) =>
          qb
            .where('claimExpiresAt', '>', sql<Date>`clock_timestamp()`)
            .where('cancelRequestedAt', 'is', null)
            .where('pauseRequestedAt', 'is', null),
        )
        .returning(['id', 'ownerId'])
        .executeTakeFirst();
    const row = await (executor ? write(executor) : this.write(write));
    this.changed(row, executor);
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
    failure: {
      error: string;
      errorCode: string;
    },
    options: {
      retry?: boolean;
      executor?: Kysely<DB>;
    } = {},
  ): Promise<MediaOperationFailOutcome> {
    const write = <T>(query: (db: Kysely<DB>) => Promise<T>) =>
      options.executor ? query(options.executor) : this.write(query);
    // A failure retrying cannot help (FL-43: an edited item that left the library) is reported at once.
    const requeued =
      options.retry === false
        ? undefined
        : await write((db) =>
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
              .where(safeAutomaticReplay())
              .where('autoRetries', '<', MEDIA_OPERATION_AUTO_RETRIES)
              .returning(['id', 'ownerId'])
              .executeTakeFirst(),
          );
    if (requeued) {
      this.changed(requeued, options.executor);
      return 'retrying';
    }
    const result = await write((db) =>
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
    this.changed(result, options.executor);
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
   *
   * `settled` publishes related durable state while the successful UPDATE still holds
   * the operation row lock. Lock order is operation row, then any state
   * lock taken by the callback; callers must not enter with a state lock already held.
   */
  async requeue(
    id: string,
    claimToken: string,
    options: { delayMs: number; returnAttempt?: boolean },
    settled?: (trx: Transaction<DB>) => Promise<void>,
    executor?: Transaction<DB>,
  ): Promise<boolean> {
    const requeue = async (trx: Transaction<DB>) => {
      const row = await trx
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
        .executeTakeFirst();
      if (row) await settled?.(trx);
      return row;
    };
    const result = await (executor ? requeue(executor) : this.db.transaction().execute(requeue));
    this.changed(result, executor);
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
  ): Promise<
    Array<{
      id: string;
      ownerId: string;
      kind: string;
      projectId: string | null;
    }>
  > {
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
  /**
   * Merge into an open preview stream's signalling record (FL-96). Guarded in the WHERE clause:
   * only an unfinished `studio_preview_stream`, and with `negotiation` only while the record is
   * still on that round, so an offer, an answer and a reconnect racing each other resolve in
   * Postgres and the loser updates nothing.
   */
  async mergeStreamSignal(
    id: string,
    patch: Record<string, unknown>,
    expect: {
      negotiation?: number;
    } = {},
  ): Promise<MediaOperation | undefined> {
    return (await this.write((db) =>
      db
        .updateTable('media_operation')
        .set({
          result: sql<
            Record<string, unknown>
          >`coalesce("result", '{}'::jsonb) || ${JSON.stringify(patch)}::text::jsonb`,
        })
        .where('id', '=', id)
        .where('kind', '=', MediaOperationKind.StudioPreviewStream)
        .where('status', 'not in', [...TERMINAL_MEDIA_OPERATION_STATUSES])
        .$if(expect.negotiation !== undefined, (qb) =>
          qb.where(sql<boolean>`coalesce(("result"->>'negotiation')::int, 0) = ${expect.negotiation!}`),
        )
        .returningAll()
        .executeTakeFirst(),
    )) as unknown as MediaOperation | undefined;
  }
  /** An account's open preview streams, oldest first (FL-96 session limits). */
  async listOpenStreams(ownerId: string): Promise<
    Array<{
      id: string;
      projectId: string | null;
    }>
  > {
    return this.db
      .selectFrom('media_operation')
      .select(['id', 'projectId'])
      .where('ownerId', '=', ownerId)
      .where('kind', '=', MediaOperationKind.StudioPreviewStream)
      .where('status', 'not in', [...TERMINAL_MEDIA_OPERATION_STATUSES])
      .where('cancelRequestedAt', 'is', null)
      .orderBy('createdAt', 'asc')
      .execute();
  }
  async requestCancel(
    id: string,
    ownerId: string,
    claimToken?: string,
    queuedOnly = false,
  ): Promise<MediaOperation | undefined> {
    const row = await this.db
      .transaction()
      .execute((tx) => this.requestCancelWithin(tx, id, ownerId, claimToken, queuedOnly));
    this.notifyCancellation(row);
    return row;
  }
  /** Caller owns the transaction; cancellation notification follows its commit. */
  async requestCancelWithin(
    tx: Transaction<DB>,
    id: string,
    ownerId: string,
    claimToken?: string,
    queuedOnly = false,
  ): Promise<MediaOperation | undefined> {
    return (
      (await tx
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
        // Unsafe edit executors may start between the owner's read and this write.
        .$if(queuedOnly, (qb) => qb.where('status', '=', MediaOperationStatus.Queued).where('claimToken', 'is', null))
        .where('status', 'not in', [...TERMINAL_MEDIA_OPERATION_STATUSES])
        .returningAll()
        .executeTakeFirst()) as unknown as MediaOperation | undefined
    );
  }
  notifyCancellation(row: MediaOperation | undefined): void {
    this.changed(row);
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
  async acknowledgeCancel(
    id: string,
    claimToken: string,
    options: {
      released: boolean;
      executor?: Kysely<DB>;
    },
  ): Promise<boolean> {
    const result = await (options.executor ?? this.db)
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
      // Scoped previews require a live claim at the actual ACK write, not an earlier service read.
      // The stored frame catches a missing/malformed discriminator; it cannot fall back to legacy.
      .where(
        sql<boolean>`("kind" <> ${MediaOperationKind.StudioPreview} OR (
        NOT ("snapshot" ? 'consumerRequestId') AND NOT EXISTS (
          SELECT 1 FROM studio_preview_frame f WHERE f."operationId" = "media_operation"."id"
          AND f."cacheKey" LIKE 'fl279c1:%'
        )
      ) OR (
        "claimExpiresAt" > clock_timestamp() AND EXISTS (
          SELECT 1 FROM studio_preview_frame f WHERE f."operationId" = "media_operation"."id"
          AND f."ownerId" = "media_operation"."ownerId"
          AND f.id::text = "media_operation"."snapshot"->>'previewFrameId'
          AND f."cacheKey" LIKE 'fl279c1:%'
          AND split_part(f."cacheKey", ':', 2) = "media_operation"."snapshot"->>'consumerRequestId'
        )
      ))`,
      )
      .returning(['id', 'ownerId'])
      .executeTakeFirst();
    this.changed(result, options.executor);
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
  /**
   * FL-162: finished Frameleaf Cloud jobs whose cloud job was admitted but whose settled cost is not
   * recorded yet, oldest first. The settle pass reads each one's cost once and writes it to the result;
   * `maxReads` bounds how often a job whose cost never comes is asked about, and only jobs finished
   * since `since` are asked about at all.
   */
  listCloudMlJobsAwaitingCost(options: { limit: number; maxReads: number; since: Date }): Promise<MediaOperation[]> {
    return this.db
      .selectFrom('media_operation')
      .selectAll()
      .where('kind', '=', MediaOperationKind.CloudMlJob)
      .where('status', 'in', [...TERMINAL_MEDIA_OPERATION_STATUSES])
      .where('remoteJobId', 'is not', null)
      .where('finishedAt', '>=', options.since)
      .where(sql<string>`"result" ->> 'cost'`, 'is', null)
      .where(sql<number>`coalesce(("result" ->> 'costReads')::int, 0)`, '<', options.maxReads)
      .orderBy('finishedAt', 'asc')
      .limit(options.limit)
      .execute() as unknown as Promise<MediaOperation[]>;
  }
  /**
   * FL-162: finished cloud ML jobs whose cloud job was never acknowledged. A job is acknowledged only
   * after its result is published, so a crash or a failed `DELETE` between the two leaves it here for
   * the cleanup pass, which acknowledges it; nothing is cancelled.
   */
  listUnacknowledgedCloudMlJobs(limit: number): Promise<MediaOperation[]> {
    return (
      this.db
        .selectFrom('media_operation')
        .selectAll()
        .where('kind', '=', MediaOperationKind.CloudMlJob)
        .where('status', '=', MediaOperationStatus.Completed)
        .where('remoteJobId', 'is not', null)
        .where('remoteReleasedAt', 'is', null)
        // the least-tried first, so a job the cloud keeps refusing never holds up the others
        .orderBy(sql`coalesce(("result" ->> 'ackAttempts')::int, 0)`, 'asc')
        .orderBy('finishedAt', 'asc')
        .limit(limit)
        .execute() as unknown as Promise<MediaOperation[]>
    );
  }
  /**
   * FL-162: the Frameleaf Cloud jobs one person confirmed since `since`, with what each was settled at
   * (its accounting row), its hold, and enough of its state to count a job still running.
   */
  async listCloudMlJobSpend(userId: string, since: Date): Promise<CloudMlJobSpendRow[]> {
    const rows = await this.db
      .selectFrom('media_operation')
      .leftJoin('ml_workload_accounting', (join) =>
        join
          .on(sql<boolean>`"ml_workload_accounting"."jobId" = "media_operation"."id"::text`)
          .on('ml_workload_accounting.jobName', '=', MediaOperationKind.CloudMlJob),
      )
      .select([
        'media_operation.status',
        'media_operation.remoteJobId',
        'media_operation.result',
        sql<number | null>`("media_operation"."snapshot" -> 'approved' ->> 'holdUsd')::double precision`.as('holdUsd'),
        'ml_workload_accounting.costUsd as settledUsd',
      ])
      .where('media_operation.kind', '=', MediaOperationKind.CloudMlJob)
      .where(sql<boolean>`"media_operation"."snapshot" -> 'consent' ->> 'acceptedBy' = ${userId}`)
      // this month's jobs, and any earlier one still holding the AI Wallet
      .where((eb) =>
        eb.or([
          eb('media_operation.createdAt', '>=', since),
          eb('media_operation.status', 'not in', [...TERMINAL_MEDIA_OPERATION_STATUSES]),
        ]),
      )
      .execute();
    return rows as unknown as CloudMlJobSpendRow[];
  }
  /** FL-162: the snapshots of unfinished cloud ML jobs, for the prepared inputs they still need. */
  async listUnfinishedCloudMlJobSnapshots(): Promise<unknown[]> {
    const rows = await this.db
      .selectFrom('media_operation')
      .select('snapshot')
      .where('kind', '=', MediaOperationKind.CloudMlJob)
      .where('status', 'not in', [...TERMINAL_MEDIA_OPERATION_STATUSES])
      .execute();
    return rows.map((row) => row.snapshot);
  }
  /**
   * FL-162: cloud ML jobs cancelled before anything was sent (no cloud job), which the cleanup pass has
   * not put right yet: a cancel of a job no worker held lands without a step, so its version and its
   * prepared files are reconciled afterwards.
   */
  listUnreconciledCancelledCloudMlJobs(options: { limit: number; since: Date }): Promise<MediaOperation[]> {
    return this.db
      .selectFrom('media_operation')
      .selectAll()
      .where('kind', '=', MediaOperationKind.CloudMlJob)
      .where('status', '=', MediaOperationStatus.Cancelled)
      .where('remoteJobId', 'is', null)
      .where('finishedAt', '>=', options.since)
      .where(sql<string>`coalesce("result" ->> 'reconciled', 'false')`, '=', 'false')
      .orderBy('finishedAt', 'asc')
      .limit(options.limit)
      .execute() as unknown as Promise<MediaOperation[]>;
  }
  /**
   * FL-162: create a job together with the rows it binds, in one transaction. `bind` writes those rows
   * with the transaction it is given and answers with the job to insert; `after` runs in the same
   * transaction once the job exists. Either everything lands or nothing does.
   */
  async createWithin<T>(
    bind: (trx: Transaction<DB>) => Promise<{
      operation: MediaOperationCreate;
      value: T;
    }>,
    after: (trx: Transaction<DB>, created: MediaOperation, value: T) => Promise<void>,
  ): Promise<{
    operation: MediaOperation;
    value: T;
  }> {
    const done = await this.db.transaction().execute(async (trx) => {
      const { operation, value } = await bind(trx);
      const created = (await trx
        .insertInto('media_operation')
        .values(operation)
        .returningAll()
        .executeTakeFirstOrThrow()) as unknown as MediaOperation;
      await after(trx, created, value);
      return { operation: created, value };
    });
    this.changed(done.operation as unknown as MediaOperationChange);
    return done;
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
   * A lost claim consumes the same single retry as a handler failure. Only audited local work
   * is replayable. Remote identity and checkpoints survive; unsafe work settles for attention.
   * Queue-backed claims wait for the queue owner to fence its execution before recovery.
   * Cancellation and a requested pause take precedence over retry.
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
        .where(executionOwnerSettled())
        .where('pauseRequestedAt', 'is not', null)
        .where('cancelRequestedAt', 'is', null)
        .returning(['id', 'ownerId'])
        .execute(),
    );
    // The steps below also land on `paused` if a pause arrived after the step above ran: the steps
    // are separate statements, and a pause request between them must not leave a queued job with a
    // pause pending that nothing would ever settle.
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
        .where(executionOwnerSettled())
        .where(safeAutomaticReplay())
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
        .where(executionOwnerSettled())
        .where((eb) =>
          eb.or([eb('autoRetries', '>=', MEDIA_OPERATION_AUTO_RETRIES), sql<boolean>`not ${safeAutomaticReplay()}`]),
        )
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
        .where(executionOwnerSettled())
        .where('cancelRequestedAt', 'is not', null)
        .returning(['id', 'ownerId'])
        .execute(),
    );
    this.changed([...paused, ...retried, ...failed, ...abandonedCancels]);
    return {
      requeued: 0,
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
  ): Promise<
    | {
        operation: MediaOperation;
        claimToken: string;
      }
    | undefined
  > {
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
    chunk: {
      sequence: number;
      chunkKey: string;
      outputPath: string;
      outputChecksum: Buffer;
      sizeInBytes: number;
    },
    verifiedArtifact = false,
  ): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      if (!(await this.lockClaim(trx, operationId, claimToken, verifiedArtifact))) {
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
        .$if(verifiedArtifact, (qb) => qb.where('state', '=', MediaOperationCheckpointState.Pending))
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
  private async lockClaim(
    trx: Kysely<DB>,
    operationId: string,
    claimToken: string,
    requireActive = false,
  ): Promise<boolean> {
    const row = await trx
      .selectFrom('media_operation')
      .select('id')
      .where('id', '=', operationId)
      .where('claimToken', '=', claimToken)
      .$if(requireActive, (qb) =>
        qb
          .where('claimExpiresAt', '>', sql<Date>`clock_timestamp()`)
          .where('cancelRequestedAt', 'is', null)
          .where('pauseRequestedAt', 'is', null),
      )
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
