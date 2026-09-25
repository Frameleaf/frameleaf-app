import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Selectable, Updateable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import { MediaOperationDestination, MediaOperationKind, MediaOperationStatus, RenderWorkerStatus } from 'src/enum.js';
import { canWriteFork } from 'src/repositories/fork-write-guard.js';
import { DB } from 'src/schema/index.js';
import { MediaOperationTable } from 'src/schema/tables/media-operation.table.js';
import {
  RENDER_WORKER_LIMIT_INSTANCE_SUBJECT,
  RenderWorkerAuditTable,
  RenderWorkerLimitTable,
  RenderWorkerSessionTable,
  RenderWorkerTable,
} from 'src/schema/tables/render-worker.table.js';
import { CLAIMED_MEDIA_OPERATION_STATUSES } from 'src/utils/media-operation.js';

export type RenderWorker = Selectable<RenderWorkerTable>;
export type RenderWorkerSession = Selectable<RenderWorkerSessionTable>;
export type RenderWorkerLimit = Selectable<RenderWorkerLimitTable>;
export type RenderWorkerAudit = Selectable<RenderWorkerAuditTable>;
type MediaOperationRow = Selectable<MediaOperationTable>;

export type RenderWorkerCreate = Omit<
  Insertable<RenderWorkerTable>,
  'id' | 'createdAt' | 'updatedAt' | 'updateId' | 'status' | 'revokedAt' | 'lastAdmittedAt' | 'lastSeenAt'
>;

export type RenderWorkerUpdate = Pick<
  Updateable<RenderWorkerTable>,
  | 'name'
  | 'kinds'
  | 'engineDigest'
  | 'conformanceMaxAgeMs'
  | 'maxConcurrentOperations'
  | 'maxWallClockMs'
  | 'maxOutputBytes'
  | 'gpuMemoryBytes'
>;

export type RenderWorkerSessionCreate = Omit<Insertable<RenderWorkerSessionTable>, 'id' | 'createdAt'>;

export type RenderWorkerLimitUpsert = Pick<
  Insertable<RenderWorkerLimitTable>,
  'maxConcurrentOperations' | 'maxWallClockMs' | 'maxOutputBytes'
>;

export type RenderWorkerAuditCreate = Omit<Insertable<RenderWorkerAuditTable>, 'id' | 'createdAt'>;

/** A session joined to the worker that owns it: what every worker request is authenticated as. */
export type AuthenticatedRenderWorker = { worker: RenderWorker; session: RenderWorkerSession };

/**
 * Render worker identities, sessions, limits and audit (FL-95).
 *
 * Secrets never come back out of this repository: workers and sessions are looked up by the
 * digest of what the caller presented, the way `ApiKeyRepository.getKey` does it, and the digest
 * columns are never selected into a DTO.
 *
 * The claim path here is the admitted counterpart of `MediaOperationRepository.claimNext`. That
 * method takes the oldest queued job unconditionally; admission has to look at a candidate, decide,
 * and only then take it, so this repository exposes the two halves — `peekQueued` and
 * `claimQueued` — and the service runs the decision in between. `claimQueued` is still one
 * conditional UPDATE, so two admitted workers racing for the same candidate resolve in Postgres.
 */
/** A Postgres text array literal, every element quoted and escaped. */
const pgTextArray = (values: readonly string[]) =>
  `{${values.map((value) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', String.raw`\"`)}"`).join(',')}}`;

@Injectable()
export class RenderWorkerRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /* ------------------------------------------------------------------ */
  /* Workers                                                             */
  /* ------------------------------------------------------------------ */

  async createWorker(worker: RenderWorkerCreate): Promise<RenderWorker> {
    return (await this.db
      .insertInto('render_worker')
      .values(worker)
      .returningAll()
      .executeTakeFirstOrThrow()) as unknown as RenderWorker;
  }

  async getWorker(id: string): Promise<RenderWorker | undefined> {
    return (await this.db
      .selectFrom('render_worker')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()) as unknown as RenderWorker | undefined;
  }

  /** Admission lookup: the digest of the presented secret, nothing else. */
  async getWorkerBySecret(enrolmentSecret: Buffer): Promise<RenderWorker | undefined> {
    return (await this.db
      .selectFrom('render_worker')
      .selectAll()
      .where('enrolmentSecret', '=', enrolmentSecret)
      .executeTakeFirst()) as unknown as RenderWorker | undefined;
  }

  listWorkers(): Promise<RenderWorker[]> {
    return this.db
      .selectFrom('render_worker')
      .selectAll()
      .orderBy('createdAt', 'asc')
      .orderBy('id', 'asc')
      .execute() as unknown as Promise<RenderWorker[]>;
  }

  async updateWorker(id: string, patch: RenderWorkerUpdate): Promise<RenderWorker | undefined> {
    return (await this.db
      .updateTable('render_worker')
      .set(patch)
      .where('id', '=', id)
      .where('status', '=', RenderWorkerStatus.Active)
      .returningAll()
      .executeTakeFirst()) as unknown as RenderWorker | undefined;
  }

  /** Record a successful admission and the newest report it was based on; later replays fail against it. */
  async markAdmitted(id: string, conformanceReportedAt: Date): Promise<void> {
    await this.db
      .updateTable('render_worker')
      .set({
        lastAdmittedAt: sql<Date>`now()`,
        lastSeenAt: sql<Date>`now()`,
        lastConformanceReportedAt: conformanceReportedAt,
      })
      .where('id', '=', id)
      .execute();
  }

  async markSeen(id: string): Promise<void> {
    await this.db
      .updateTable('render_worker')
      .set({ lastSeenAt: sql<Date>`now()` })
      .where('id', '=', id)
      .execute();
  }

  /**
   * Revoke a worker and every session it holds, in one statement each. The worker row stays so
   * `claimedBy` on past operations and the audit trail still resolve to a name.
   */
  async revokeWorker(id: string): Promise<RenderWorker | undefined> {
    const worker = (await this.db
      .updateTable('render_worker')
      .set({ status: RenderWorkerStatus.Revoked, revokedAt: sql<Date>`now()` })
      .where('id', '=', id)
      .where('status', '=', RenderWorkerStatus.Active)
      .returningAll()
      .executeTakeFirst()) as unknown as RenderWorker | undefined;

    if (worker) {
      await this.revokeSessions(id);
    }

    return worker;
  }

  /* ------------------------------------------------------------------ */
  /* Sessions                                                            */
  /* ------------------------------------------------------------------ */

  async createSession(session: RenderWorkerSessionCreate): Promise<RenderWorkerSession> {
    return (await this.db
      .insertInto('render_worker_session')
      .values(session)
      .returningAll()
      .executeTakeFirstOrThrow()) as unknown as RenderWorkerSession;
  }

  /**
   * FL-95: bind what the session's conformance check verified (codecs, containers) to the session.
   * Stored beside the official schema in `immich_fork`, one row per session.
   */
  async recordSessionCapabilities(
    sessionId: string,
    capabilities: { codecs: readonly string[]; formats: readonly string[] },
  ): Promise<void> {
    // Skipped while the fork schema is not writable; the session then proved nothing, so it is
    // given no job that names an output format (fail closed).
    if (!(await canWriteFork(this.db))) {
      return;
    }
    await sql`
      INSERT INTO immich_fork.render_worker_session_capability ("sessionId", codecs, formats)
      VALUES (${sessionId}::uuid, ${pgTextArray(capabilities.codecs)}::text[], ${pgTextArray(capabilities.formats)}::text[])
      ON CONFLICT ("sessionId") DO UPDATE SET codecs = excluded.codecs, formats = excluded.formats
    `.execute(this.db);
  }

  /** What the session proved at admission, or undefined when it proved nothing (FL-95). */
  async getSessionCapabilities(sessionId: string): Promise<{ codecs: string[]; formats: string[] } | undefined> {
    const { rows } = await sql<{ codecs: string[]; formats: string[] }>`
      SELECT codecs, formats FROM immich_fork.render_worker_session_capability WHERE "sessionId" = ${sessionId}::uuid
    `.execute(this.db);
    return rows[0];
  }

  /**
   * Authenticate a worker request. The join is on the digest of the presented credential, and the
   * worker must still be active: a revoked worker's unexpired session is not a session.
   */
  async getSessionByToken(token: Buffer): Promise<AuthenticatedRenderWorker | undefined> {
    const session = (await this.db
      .selectFrom('render_worker_session')
      .selectAll()
      .where('token', '=', token)
      .executeTakeFirst()) as unknown as RenderWorkerSession | undefined;

    if (!session) {
      return undefined;
    }

    const worker = await this.getWorker(session.workerId);
    return worker ? { worker, session } : undefined;
  }

  /**
   * Every session that could still render: unrevoked, unexpired and held by an active worker, with
   * that worker. Whether its evidence is still good enough is the caller's decision (FL-42).
   */
  async listLiveSessions(): Promise<AuthenticatedRenderWorker[]> {
    // One query: the worker's columns as they are, the session's aliased so the shared names
    // (id, engineDigest, gpuMemoryBytes, createdAt) do not collide.
    const rows = await this.db
      .selectFrom('render_worker_session')
      .innerJoin('render_worker', 'render_worker.id', 'render_worker_session.workerId')
      .selectAll('render_worker')
      .select([
        'render_worker_session.id as sessionId',
        'render_worker_session.token as sessionToken',
        'render_worker_session.scopes as sessionScopes',
        'render_worker_session.gpuMemoryBytes as sessionGpuMemoryBytes',
        'render_worker_session.engineDigest as sessionEngineDigest',
        'render_worker_session.conformanceReportedAt as sessionConformanceReportedAt',
        'render_worker_session.expiresAt as sessionExpiresAt',
        'render_worker_session.revokedAt as sessionRevokedAt',
        'render_worker_session.lastUsedAt as sessionLastUsedAt',
        'render_worker_session.createdAt as sessionCreatedAt',
      ])
      .where('render_worker.status', '=', RenderWorkerStatus.Active)
      .where('render_worker_session.revokedAt', 'is', null)
      .where('render_worker_session.expiresAt', '>', sql<Date>`now()`)
      .execute();

    return rows.map(
      ({
        sessionId,
        sessionToken,
        sessionScopes,
        sessionGpuMemoryBytes,
        sessionEngineDigest,
        sessionConformanceReportedAt,
        sessionExpiresAt,
        sessionRevokedAt,
        sessionLastUsedAt,
        sessionCreatedAt,
        ...worker
      }) => ({
        worker: worker as unknown as RenderWorker,
        session: {
          id: sessionId,
          workerId: worker.id,
          token: sessionToken,
          scopes: sessionScopes,
          gpuMemoryBytes: sessionGpuMemoryBytes,
          engineDigest: sessionEngineDigest,
          conformanceReportedAt: sessionConformanceReportedAt,
          expiresAt: sessionExpiresAt,
          revokedAt: sessionRevokedAt,
          lastUsedAt: sessionLastUsedAt,
          createdAt: sessionCreatedAt,
        } as unknown as RenderWorkerSession,
      }),
    );
  }

  async touchSession(id: string): Promise<void> {
    await this.db
      .updateTable('render_worker_session')
      .set({ lastUsedAt: sql<Date>`now()` })
      .where('id', '=', id)
      .execute();
  }

  async revokeSessions(workerId: string): Promise<number> {
    const result = await this.db
      .updateTable('render_worker_session')
      .set({ revokedAt: sql<Date>`now()` })
      .where('workerId', '=', workerId)
      .where('revokedAt', 'is', null)
      .executeTakeFirst();

    return Number(result.numUpdatedRows);
  }

  /* ------------------------------------------------------------------ */
  /* Limits                                                              */
  /* ------------------------------------------------------------------ */

  async getLimit(subject: string): Promise<RenderWorkerLimit | undefined> {
    return (await this.db
      .selectFrom('render_worker_limit')
      .selectAll()
      .where('subject', '=', subject)
      .executeTakeFirst()) as unknown as RenderWorkerLimit | undefined;
  }

  listLimits(): Promise<RenderWorkerLimit[]> {
    return this.db
      .selectFrom('render_worker_limit')
      .selectAll()
      .orderBy('subject', 'asc')
      .execute() as unknown as Promise<RenderWorkerLimit[]>;
  }

  /** Create or replace the ceilings for the instance default or one account. */
  async upsertLimit(
    subject: string,
    userId: string | null,
    limit: RenderWorkerLimitUpsert,
  ): Promise<RenderWorkerLimit> {
    return (await this.db
      .insertInto('render_worker_limit')
      .values({ subject, userId, ...limit })
      .onConflict((oc) => oc.column('subject').doUpdateSet({ ...limit, userId }))
      .returningAll()
      .executeTakeFirstOrThrow()) as unknown as RenderWorkerLimit;
  }

  async deleteLimit(subject: string): Promise<boolean> {
    if (subject === RENDER_WORKER_LIMIT_INSTANCE_SUBJECT) {
      // The instance default is edited, never removed; without it there would be no ceiling at all.
      return false;
    }

    const result = await this.db.deleteFrom('render_worker_limit').where('subject', '=', subject).executeTakeFirst();
    return Number(result.numDeletedRows) === 1;
  }

  /* ------------------------------------------------------------------ */
  /* Audit                                                               */
  /* ------------------------------------------------------------------ */

  async recordAudit(entry: RenderWorkerAuditCreate): Promise<void> {
    await this.db.insertInto('render_worker_audit').values(entry).execute();
  }

  listAudit(options: { workerId?: string; take: number }): Promise<RenderWorkerAudit[]> {
    return this.db
      .selectFrom('render_worker_audit')
      .selectAll()
      .$if(!!options.workerId, (qb) => qb.where('workerId', '=', options.workerId!))
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .limit(options.take)
      .execute() as unknown as Promise<RenderWorkerAudit[]>;
  }

  /* ------------------------------------------------------------------ */
  /* Operations, as a worker sees them                                   */
  /* ------------------------------------------------------------------ */

  /** Operations a worker currently holds. Counted, not listed: the figure is all admission needs. */
  async countActiveForWorker(workerId: string): Promise<number> {
    const row = await this.db
      .selectFrom('media_operation')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('claimedBy', '=', workerId)
      .where('status', 'in', [...CLAIMED_MEDIA_OPERATION_STATUSES])
      .executeTakeFirst();

    return Number(row?.count ?? 0);
  }

  /** Operations an account has claimed anywhere. The per-user ceiling is measured against this. */
  async countActiveForOwner(ownerId: string): Promise<number> {
    const row = await this.db
      .selectFrom('media_operation')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('ownerId', '=', ownerId)
      .where('status', 'in', [...CLAIMED_MEDIA_OPERATION_STATUSES])
      .executeTakeFirst();

    return Number(row?.count ?? 0);
  }

  /**
   * The oldest queued operations a worker of this destination and these kinds could take, for
   * admission to look at. Nothing is locked here; `claimQueued` is what commits.
   */
  peekQueued(options: {
    destination: MediaOperationDestination;
    kinds: readonly MediaOperationKind[];
    excludeIds: readonly string[];
    take: number;
  }): Promise<MediaOperationRow[]> {
    if (options.kinds.length === 0) {
      return Promise.resolve([]);
    }

    return (
      this.db
        .selectFrom('media_operation')
        .selectAll()
        .where('status', '=', MediaOperationStatus.Queued)
        .where('destination', '=', options.destination)
        .where('kind', 'in', [...options.kinds])
        .where('cancelRequestedAt', 'is', null)
        // A job waiting for its automatic retry is not offered before its retry time (FL-104).
        .where((eb) => eb.or([eb('retryAt', 'is', null), eb('retryAt', '<=', sql<Date>`now()`)]))
        .$if(options.excludeIds.length > 0, (qb) => qb.where('id', 'not in', [...options.excludeIds]))
        .orderBy('createdAt', 'asc')
        .orderBy('id', 'asc')
        .limit(options.take)
        .execute() as unknown as Promise<MediaOperationRow[]>
    );
  }

  /**
   * Take one specific queued job. The `status = queued` guard is what makes the race safe: two
   * admitted workers that both decided on the same candidate update the row once between them.
   *
   * A claim is also where an attempt's ceilings start from zero: `attemptStartedAt` and
   * `outputBytes` are reset, while `startedAt` keeps the first attempt's start for Activity. The
   * automatic retry every operation gets is therefore charged for its own wall clock and output
   * only, and the previous attempt's grants and writes, bound to the old claim token, stop verifying.
   */
  async claimQueued(options: {
    id: string;
    workerId: string;
    leaseMs: number;
  }): Promise<{ operation: MediaOperationRow; claimToken: string } | undefined> {
    const claimToken = randomUUID();

    const row = await this.db
      .updateTable('media_operation')
      .set({
        status: MediaOperationStatus.Preparing,
        claimToken,
        claimedBy: options.workerId,
        claimExpiresAt: sql<Date>`now() + ${sql.lit(options.leaseMs)} * interval '1 millisecond'`,
        heartbeatAt: sql<Date>`now()`,
        startedAt: sql<Date>`coalesce("startedAt", now())`,
        attemptStartedAt: sql<Date>`now()`,
        outputBytes: '0',
        attempt: sql<number>`"attempt" + 1`,
        lastAdmissionRefusalReason: null,
        lastAdmissionRefusedAt: null,
        retryAt: null,
      })
      .where('id', '=', options.id)
      .where('status', '=', MediaOperationStatus.Queued)
      .where('cancelRequestedAt', 'is', null)
      .where((eb) => eb.or([eb('retryAt', 'is', null), eb('retryAt', '<=', sql<Date>`now()`)]))
      .returningAll()
      .executeTakeFirst();

    return row ? { operation: row as unknown as MediaOperationRow, claimToken } : undefined;
  }

  /** Write the reason a queued job was passed over, so its owner sees why it is still queued. */
  async recordRefusal(id: string, reason: string): Promise<void> {
    await this.db
      .updateTable('media_operation')
      .set({
        lastAdmissionRefusalReason: reason,
        lastAdmissionRefusedAt: sql<Date>`now()`,
        admissionRefusals: sql<number>`"admissionRefusals" + 1`,
      })
      .where('id', '=', id)
      .where('status', '=', MediaOperationStatus.Queued)
      .execute();
  }

  /**
   * The operation a worker is writing to, if and only if it is the claim this worker holds.
   *
   * Three conditions, all in the query: the id, the claim token the worker was handed and the
   * worker identity the claim was issued to. A worker presenting another worker's token — leaked,
   * guessed or replayed — matches nothing, and the caller answers as if the operation did not
   * exist. This is the cross-worker boundary; every worker-facing write goes through it first.
   */
  async getClaimed(id: string, workerId: string, claimToken: string): Promise<MediaOperationRow | undefined> {
    return (await this.db
      .selectFrom('media_operation')
      .selectAll()
      .where('id', '=', id)
      .where('claimedBy', '=', workerId)
      .where('claimToken', '=', claimToken)
      .where('status', 'in', [...CLAIMED_MEDIA_OPERATION_STATUSES])
      .executeTakeFirst()) as unknown as MediaOperationRow | undefined;
  }

  /**
   * The claimed operation a worker is reading inputs for. The grant in the URL carries the claim
   * binding, so the token itself is not presented here; the worker identity still has to match.
   */
  async getClaimedByWorker(id: string, workerId: string): Promise<MediaOperationRow | undefined> {
    return (await this.db
      .selectFrom('media_operation')
      .selectAll()
      .where('id', '=', id)
      .where('claimedBy', '=', workerId)
      .where('claimToken', 'is not', null)
      .where('status', 'in', [...CLAIMED_MEDIA_OPERATION_STATUSES])
      .executeTakeFirst()) as unknown as MediaOperationRow | undefined;
  }

  /** Accumulate output bytes reported under the claim. Guarded like every other worker write. */
  async recordOutputBytes(id: string, claimToken: string, outputBytes: number): Promise<boolean> {
    const result = await this.db
      .updateTable('media_operation')
      .set({ outputBytes: String(outputBytes) })
      .where('id', '=', id)
      .where('claimToken', '=', claimToken)
      .where('status', 'in', [...CLAIMED_MEDIA_OPERATION_STATUSES])
      .executeTakeFirst();

    return Number(result.numUpdatedRows) === 1;
  }
}
