import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Selectable, Updateable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  RenderWorkerAuditEvent,
  RenderWorkerRefusalReason,
  RenderWorkerStatus,
} from 'src/enum.js';
import type { RenderWorkerAdmissionDto } from 'src/dtos/render-worker.dto.js';

import { DB } from 'src/schema/index.js';
import { MediaOperationTable } from 'src/schema/tables/media-operation.table.js';
import {
  RENDER_WORKER_LIMIT_INSTANCE_SUBJECT,
  RenderWorkerAuditTable,
  RenderWorkerLimitTable,
  RenderWorkerSessionTable,
  RenderWorkerTable,
} from 'src/schema/tables/render-worker.table.js';
import { notJobQueueExecuted } from 'src/utils/edit-operation.js';
import { CLAIMED_MEDIA_OPERATION_STATUSES, isRenderWorkerMediaOperationKind } from 'src/utils/media-operation.js';
import {
  GpuWorkingBudgetApprovalSchema,
  GpuWorkingBudgetEvidenceSchema,
  evaluateApprovedGpuWorkingBudget,
  evaluateApprovedRenderSession,
} from 'src/utils/gpu-working-budget-policy.js';
import {
  DestinationHealth,
  RenderLimits,
  evaluateSessionAdmission,
  evaluateClaimAdmission,
  evaluateRenderOutput,
  tightestLimits,
} from 'src/utils/render-admission.js';

export type RenderWorker = Omit<Selectable<RenderWorkerTable>, 'gpuMemoryBytes'> & { gpuMemoryBytes: string | null };
export type RenderWorkerSession = Omit<Selectable<RenderWorkerSessionTable>, 'gpuMemoryBytes'> & {
  gpuMemoryBytes: string | null;
};
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
  | 'gpuWorkingBudgetApproval'
>;
export type RenderWorkerSessionCreate = Omit<Insertable<RenderWorkerSessionTable>, 'id' | 'createdAt'>;
export type RenderWorkerLimitUpsert = Pick<
  Insertable<RenderWorkerLimitTable>,
  'maxConcurrentOperations' | 'maxWallClockMs' | 'maxOutputBytes'
>;
export type RenderWorkerAuditCreate = Omit<Insertable<RenderWorkerAuditTable>, 'id' | 'createdAt'>;
/** A session joined to the worker that owns it: what every worker request is authenticated as. */
export type AuthenticatedRenderWorker = {
  worker: RenderWorker;
  session: RenderWorkerSession;
};
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
// The shared int8 decoder uses Number; memory ceilings must reach policy validation losslessly.
const memoryBytes = sql<string | null>`"gpuMemoryBytes"::text`.as('gpuMemoryBytes');

/** A Postgres text array literal, every element quoted and escaped. */
const pgTextArray = (values: readonly string[]) =>
  `{${values.map((value) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', String.raw`\"`)}"`).join(',')}}`;
@Injectable()
export class RenderWorkerRepository {
  constructor(
    @InjectKysely()
    private db: Kysely<DB>,
  ) {}
  /** Execute the write in a database transaction. */
  private write<T>(query: (db: Kysely<DB>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(query);
  }
  /* ------------------------------------------------------------------ */
  /* Workers                                                             */
  /* ------------------------------------------------------------------ */
  async createWorker(worker: RenderWorkerCreate): Promise<RenderWorker> {
    return (await this.write((db) =>
      db.insertInto('render_worker').values(worker).returningAll().returning(memoryBytes).executeTakeFirstOrThrow(),
    )) as unknown as RenderWorker;
  }
  async getWorker(id: string): Promise<RenderWorker | undefined> {
    return (await this.db
      .selectFrom('render_worker')
      .selectAll()
      .select(memoryBytes)
      .where('id', '=', id)
      .executeTakeFirst()) as unknown as RenderWorker | undefined;
  }
  /** Admission lookup: the digest of the presented secret, nothing else. */
  async getWorkerBySecret(enrolmentSecret: Buffer): Promise<RenderWorker | undefined> {
    return (await this.db
      .selectFrom('render_worker')
      .selectAll()
      .select(memoryBytes)
      .where('enrolmentSecret', '=', enrolmentSecret)
      .executeTakeFirst()) as unknown as RenderWorker | undefined;
  }
  listWorkers(): Promise<RenderWorker[]> {
    return this.db
      .selectFrom('render_worker')
      .selectAll()
      .select(memoryBytes)
      .orderBy('createdAt', 'asc')
      .orderBy('id', 'asc')
      .execute() as unknown as Promise<RenderWorker[]>;
  }
  async updateWorker(id: string, patch: RenderWorkerUpdate): Promise<RenderWorker | undefined> {
    return (await this.write((db) =>
      db
        .updateTable('render_worker')
        .set(patch)
        .where('id', '=', id)
        .where('status', '=', RenderWorkerStatus.Active)
        .returningAll()
        .returning(memoryBytes)
        .executeTakeFirst(),
    )) as unknown as RenderWorker | undefined;
  }
  /** Record a successful admission and the newest report it was based on; later replays fail against it. */
  async markAdmitted(id: string, conformanceReportedAt: Date): Promise<void> {
    await this.write((db) =>
      db
        .updateTable('render_worker')
        .set({
          lastAdmittedAt: sql<Date>`now()`,
          lastSeenAt: sql<Date>`now()`,
          lastConformanceReportedAt: conformanceReportedAt,
        })
        .where('id', '=', id)
        .execute(),
    );
  }
  async markSeen(id: string): Promise<void> {
    await this.write((db) =>
      db
        .updateTable('render_worker')
        .set({ lastSeenAt: sql<Date>`now()` })
        .where('id', '=', id)
        .execute(),
    );
  }
  /**
   * Revoke a worker and every session it holds, in one statement each. The worker row stays so
   * `claimedBy` on past operations and the audit trail still resolve to a name.
   */
  async revokeWorker(id: string): Promise<RenderWorker | undefined> {
    const worker = (await this.write((db) =>
      db
        .updateTable('render_worker')
        .set({ status: RenderWorkerStatus.Revoked, revokedAt: sql<Date>`now()` })
        .where('id', '=', id)
        .where('status', '=', RenderWorkerStatus.Active)
        .returningAll()
        .returning(memoryBytes)
        .executeTakeFirst(),
    )) as unknown as RenderWorker | undefined;
    if (worker) {
      await this.revokeSessions(id);
    }
    return worker;
  }
  /* ------------------------------------------------------------------ */
  /* Sessions                                                            */
  /* ------------------------------------------------------------------ */
  async admitSession(input: {
    report: Omit<RenderWorkerAdmissionDto, 'enrolmentSecret'>;
    enrolmentSecret: Buffer;
    token: Buffer;
    ttlMs: number;
  }): Promise<
    { admitted: true; session: RenderWorkerSession } | { admitted: false; reason: RenderWorkerRefusalReason }
  > {
    const { report } = input;
    try {
      return await this.write(async (db) => {
        const worker = await db
          .selectFrom('render_worker')
          .selectAll()
          .select(memoryBytes)
          .where('id', '=', report.workerId)
          .where('enrolmentSecret', '=', input.enrolmentSecret)
          .forUpdate()
          .executeTakeFirst();
        if (!worker) return { admitted: false, reason: RenderWorkerRefusalReason.InvalidCredential };
        const approval = GpuWorkingBudgetApprovalSchema.safeParse(worker.gpuWorkingBudgetApproval);
        if (!approval.success) return { admitted: false, reason: RenderWorkerRefusalReason.GpuMemoryInsufficient };
        const lifetime = approval.data.evidence.deviceLifetimeId;
        // Claim must use this same lifetime lock before taking a session or operation lock.
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'gpu-working-budget:' + lifetime}, 0))`.execute(db);
        const previous = await db
          .selectFrom('render_worker_session')
          .selectAll()
          .select(memoryBytes)
          .where(sql<string>`"gpuWorkingBudgetEvidence"->>'deviceLifetimeId'`, '=', lifetime)
          .orderBy('id')
          .forUpdate()
          .execute();
        const {
          rows: [{ now }],
        } = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(db);
        const conformanceReportedAt = new Date(report.conformanceReportedAt);
        const admission = evaluateSessionAdmission({
          worker: {
            revoked: worker.status !== RenderWorkerStatus.Active,
            engineDigest: worker.engineDigest,
            conformanceMaxAgeMs: worker.conformanceMaxAgeMs,
            lastConformanceReportedAt: worker.lastConformanceReportedAt
              ? new Date(worker.lastConformanceReportedAt)
              : null,
          },
          report: {
            engineDigest: report.engineDigest,
            conformanceReportedAt,
            softwareRenderer: report.softwareRenderer,
          },
          now,
        });
        if (!admission.admitted) return admission;
        const expiresAt = new Date(now.getTime() + input.ttlMs);
        const budget = evaluateApprovedGpuWorkingBudget({
          worker,
          evidence: report.gpuWorkingBudgetEvidence,
          capabilities: {
            codecs: report.codecs ?? [],
            formats: report.formats ?? [],
            colorPrecision: report.colorPrecision ?? null,
          },
          reportedBytes: report.gpuMemoryBytes ?? null,
          phase: { kind: 'admission' },
          now,
          conformanceExpiresAt: new Date(conformanceReportedAt.getTime() + worker.conformanceMaxAgeMs),
          credentialExpiresAt: expiresAt,
        });
        if (!budget.valid) return { admitted: false, reason: RenderWorkerRefusalReason.GpuMemoryInsufficient };
        const workerIds = [...new Set([worker.id, ...previous.map((session) => session.workerId)])];
        const active = await db
          .selectFrom('media_operation')
          .select('id')
          .where('claimedBy', 'in', workerIds)
          .where('status', 'in', [...CLAIMED_MEDIA_OPERATION_STATUSES])
          .limit(1)
          .executeTakeFirst();
        if (active) return { admitted: false, reason: RenderWorkerRefusalReason.WorkerConcurrency };
        if (previous.length)
          await db
            .updateTable('render_worker_session')
            .set({ revokedAt: now })
            .where(
              'id',
              'in',
              previous.map((session) => session.id),
            )
            .where('revokedAt', 'is', null)
            .execute();
        const session = await db
          .insertInto('render_worker_session')
          .values({
            workerId: worker.id,
            token: input.token,
            scopes: worker.kinds.filter(isRenderWorkerMediaOperationKind),
            gpuMemoryBytes: budget.qualifiedBytes,
            gpuWorkingBudgetEvidence: GpuWorkingBudgetEvidenceSchema.parse(report.gpuWorkingBudgetEvidence),
            engineDigest: report.engineDigest,
            conformanceReportedAt,
            codecs: report.codecs ?? [],
            colorPrecision: report.colorPrecision ?? null,
            expiresAt,
          })
          .returningAll()
          .returning(memoryBytes)
          .executeTakeFirstOrThrow();
        await sql`INSERT INTO public.render_worker_session_capability ("sessionId", codecs, formats)
          VALUES (${session.id}::uuid, ${pgTextArray(report.codecs ?? [])}::text[], ${pgTextArray(report.formats ?? [])}::text[])`.execute(
          db,
        );
        await db
          .updateTable('render_worker')
          .set({ lastAdmittedAt: now, lastSeenAt: now, lastConformanceReportedAt: conformanceReportedAt })
          .where('id', '=', worker.id)
          .execute();
        await db
          .insertInto('render_worker_audit')
          .values({
            workerId: worker.id,
            event: RenderWorkerAuditEvent.Admitted,
            detail: {
              sessionId: session.id,
              gpuMemoryBytes: budget.qualifiedBytes,
              expiresAt: expiresAt.toISOString(),
            },
          })
          .execute();
        return { admitted: true, session };
      });
    } catch (error) {
      const failure = error as { code?: string; constraint_name?: string };
      if (
        failure.code === '23505' &&
        ['render_worker_session_budget_measurement_key', 'render_worker_session_budget_receipt_key'].includes(
          failure.constraint_name ?? '',
        )
      ) {
        return { admitted: false, reason: RenderWorkerRefusalReason.ConformanceReplayed };
      }
      throw error;
    }
  }

  async createSession(session: RenderWorkerSessionCreate): Promise<RenderWorkerSession> {
    return (await this.write((db) =>
      db
        .insertInto('render_worker_session')
        .values(session)
        .returningAll()
        .returning(memoryBytes)
        .executeTakeFirstOrThrow(),
    )) as unknown as RenderWorkerSession;
  }
  /**
   * FL-95: bind what the session's conformance check verified (codecs, containers) to the session.
   * Stored in `public.render_worker_session_capability`, one row per session.
   */
  async recordSessionCapabilities(
    sessionId: string,
    capabilities: {
      codecs: readonly string[];
      formats: readonly string[];
    },
  ): Promise<void> {
    const result = await sql`
      INSERT INTO public.render_worker_session_capability ("sessionId", codecs, formats)
      SELECT id, ${pgTextArray(capabilities.codecs)}::text[], ${pgTextArray(capabilities.formats)}::text[]
      FROM public.render_worker_session WHERE id = ${sessionId}::uuid AND "gpuWorkingBudgetEvidence" IS NULL
      ON CONFLICT ("sessionId") DO UPDATE SET codecs = excluded.codecs, formats = excluded.formats
      RETURNING "sessionId"
    `.execute(this.db);
    if (result.rows.length !== 1) throw new Error('Measured session capabilities are immutable or session is missing');
  }
  /** What the session proved at admission, or undefined when it proved nothing (FL-95). */
  async getSessionCapabilities(sessionId: string): Promise<
    | {
        codecs: string[];
        formats: string[];
      }
    | undefined
  > {
    const { rows } = await sql<{
      codecs: string[];
      formats: string[];
    }>`
      SELECT codecs, formats FROM public.render_worker_session_capability WHERE "sessionId" = ${sessionId}::uuid
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
      .select(memoryBytes)
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
      .select(sql<string | null>`render_worker."gpuMemoryBytes"::text`.as('gpuMemoryBytes'))
      .select([
        'render_worker_session.id as sessionId',
        'render_worker_session.token as sessionToken',
        'render_worker_session.scopes as sessionScopes',
        sql<string | null>`render_worker_session."gpuMemoryBytes"::text`.as('sessionGpuMemoryBytes'),
        'render_worker_session.gpuWorkingBudgetEvidence as sessionGpuWorkingBudgetEvidence',
        'render_worker_session.engineDigest as sessionEngineDigest',
        'render_worker_session.conformanceReportedAt as sessionConformanceReportedAt',
        'render_worker_session.codecs as sessionCodecs',
        'render_worker_session.colorPrecision as sessionColorPrecision',
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
        sessionGpuWorkingBudgetEvidence,
        sessionEngineDigest,
        sessionConformanceReportedAt,
        sessionCodecs,
        sessionColorPrecision,
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
          gpuWorkingBudgetEvidence: sessionGpuWorkingBudgetEvidence,
          engineDigest: sessionEngineDigest,
          conformanceReportedAt: sessionConformanceReportedAt,
          codecs: sessionCodecs,
          colorPrecision: sessionColorPrecision,
          expiresAt: sessionExpiresAt,
          revokedAt: sessionRevokedAt,
          lastUsedAt: sessionLastUsedAt,
          createdAt: sessionCreatedAt,
        } as unknown as RenderWorkerSession,
      }),
    );
  }
  async touchSession(id: string): Promise<void> {
    await this.write((db) =>
      db
        .updateTable('render_worker_session')
        .set({ lastUsedAt: sql<Date>`now()` })
        .where('id', '=', id)
        .execute(),
    );
  }
  async revokeSessions(workerId: string): Promise<number> {
    const result = await this.write((db) =>
      db
        .updateTable('render_worker_session')
        .set({ revokedAt: sql<Date>`now()` })
        .where('workerId', '=', workerId)
        .where('revokedAt', 'is', null)
        .executeTakeFirst(),
    );
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
    return (await this.write(async (db) => {
      const key =
        subject === RENDER_WORKER_LIMIT_INSTANCE_SUBJECT
          ? 'render-worker-limit:instance'
          : 'render-worker-owner:' + subject;
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`.execute(db);
      return db
        .insertInto('render_worker_limit')
        .values({ subject, userId, ...limit })
        .onConflict((oc) => oc.column('subject').doUpdateSet({ ...limit, userId }))
        .returningAll()
        .executeTakeFirstOrThrow();
    })) as unknown as RenderWorkerLimit;
  }
  async deleteLimit(subject: string): Promise<boolean> {
    if (subject === RENDER_WORKER_LIMIT_INSTANCE_SUBJECT) {
      // The instance default is edited, never removed; without it there would be no ceiling at all.
      return false;
    }
    const result = await this.write(async (db) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'render-worker-owner:' + subject},0))`.execute(db);
      return db.deleteFrom('render_worker_limit').where('subject', '=', subject).executeTakeFirst();
    });
    return Number(result.numDeletedRows) === 1;
  }
  /* ------------------------------------------------------------------ */
  /* Audit                                                               */
  /* ------------------------------------------------------------------ */
  async recordAudit(entry: RenderWorkerAuditCreate): Promise<void> {
    await this.write((db) => db.insertInto('render_worker_audit').values(entry).execute());
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
        // FL-43: a quick edit this server's job queue runs is never offered to a render worker.
        .where(notJobQueueExecuted())
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
    sessionId: string;
    sessionTokenHash: Buffer;
    leaseMs: number;
    expected: Pick<
      MediaOperationRow,
      | 'ownerId'
      | 'kind'
      | 'destination'
      | 'destinationDetail'
      | 'assetId'
      | 'projectId'
      | 'revisionId'
      | 'snapshot'
      | 'settings'
    >;
    destinationHealth: DestinationHealth;
    defaultInstanceLimits: RenderLimits;
  }): Promise<
    | {
        operation: MediaOperationRow;
        claimToken: string;
        claimedAt: Date;
        engineDigest: string;
        limits: RenderLimits;
      }
    | { refused: RenderWorkerRefusalReason }
    | undefined
  > {
    return this.write(async (db) => {
      const refuse = (refused: RenderWorkerRefusalReason) => ({ refused });
      const worker = await db
        .selectFrom('render_worker')
        .selectAll()
        .select(memoryBytes)
        .where('id', '=', options.workerId)
        .forUpdate()
        .executeTakeFirst();
      if (!worker) return refuse(RenderWorkerRefusalReason.InvalidCredential);
      const approval = GpuWorkingBudgetApprovalSchema.safeParse(worker.gpuWorkingBudgetApproval);
      if (!approval.success) return refuse(RenderWorkerRefusalReason.GpuMemoryInsufficient);
      const lifetime = approval.data.evidence.deviceLifetimeId;
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'gpu-working-budget:' + lifetime}, 0))`.execute(db);
      const session = await db
        .selectFrom('render_worker_session')
        .selectAll()
        .select(memoryBytes)
        .where('id', '=', options.sessionId)
        .where('workerId', '=', worker.id)
        .where('token', '=', options.sessionTokenHash)
        .forUpdate()
        .executeTakeFirst();
      if (!session) return refuse(RenderWorkerRefusalReason.InvalidCredential);
      const operation = await db
        .selectFrom('media_operation')
        .selectAll()
        .where('id', '=', options.id)
        .forUpdate()
        .executeTakeFirst();
      if (!operation) return undefined;
      // Serialize per-owner ceilings across separate workers and device lifetimes.
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'render-worker-owner:' + operation.ownerId},0))`.execute(
        db,
      );
      // This shared lock also protects the absence of an instance-limit row.
      await sql`SELECT pg_advisory_xact_lock_shared(hashtextextended('render-worker-limit:instance',0))`.execute(db);
      const limitRows = await db
        .selectFrom('render_worker_limit')
        .selectAll()
        .where('subject', 'in', [RENDER_WORKER_LIMIT_INSTANCE_SUBJECT, operation.ownerId])
        .orderBy('subject')
        .forShare()
        .execute();
      const capabilitiesResult = await sql<{ codecs: string[]; formats: string[] }>`
        SELECT codecs,formats FROM public.render_worker_session_capability WHERE "sessionId"=${session.id}::uuid`.execute(
        db,
      );
      const capabilities = capabilitiesResult.rows[0];
      const histories = await db
        .selectFrom('render_worker_session')
        .select('workerId')
        .where(sql<string>`"gpuWorkingBudgetEvidence"->>'deviceLifetimeId'`, '=', lifetime)
        .execute();
      const lifetimeWorkers = [...new Set([worker.id, ...histories.map((row) => row.workerId)])];
      const active = await db
        .selectFrom('media_operation')
        .select(['ownerId', 'claimedBy'])
        .where('status', 'in', [...CLAIMED_MEDIA_OPERATION_STATUSES])
        .where((eb) => eb.or([eb('claimedBy', 'in', lifetimeWorkers), eb('ownerId', '=', operation.ownerId)]))
        .execute();
      const {
        rows: [{ now }],
      } = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(db);
      if (
        operation.status !== MediaOperationStatus.Queued ||
        operation.cancelRequestedAt !== null ||
        (operation.retryAt && new Date(operation.retryAt) > now) ||
        operation.attempt >= operation.maxAttempts
      )
        return undefined;
      for (const key of [
        'ownerId',
        'kind',
        'destination',
        'destinationDetail',
        'assetId',
        'projectId',
        'revisionId',
        'snapshot',
        'settings',
      ] as const) {
        if (!isDeepStrictEqual(operation[key], options.expected[key]))
          return refuse(RenderWorkerRefusalReason.ManifestIncomplete);
      }
      const budget = evaluateApprovedRenderSession({ worker, session, capabilities, now });
      if (!budget.valid) return refuse(RenderWorkerRefusalReason.GpuMemoryInsufficient);
      const health = options.destinationHealth;
      const completedAt = Date.parse(approval.data.evidence.completedAt);
      // Destination health has an independent 30-second deadline, shorter than measurement freshness.
      if (
        health.destination !== worker.destination ||
        health.state !== 'available' ||
        !health.checkedAt ||
        !Number.isFinite(health.checkedAt.getTime()) ||
        health.checkedAt.getTime() < completedAt ||
        now.getTime() - health.checkedAt.getTime() > 30_000 ||
        health.checkedAt > now
      ) {
        return refuse(RenderWorkerRefusalReason.DestinationUnavailable);
      }
      if (active.some((row) => row.claimedBy !== null && lifetimeWorkers.includes(row.claimedBy)))
        return refuse(RenderWorkerRefusalReason.WorkerConcurrency);
      const numericLimits = (row: {
        maxConcurrentOperations: number;
        maxWallClockMs: number | null;
        maxOutputBytes: number | null;
      }): RenderLimits => ({
        maxConcurrentOperations: row.maxConcurrentOperations,
        maxWallClockMs: row.maxWallClockMs,
        maxOutputBytes: row.maxOutputBytes,
      });
      const instance = limitRows.find((row) => row.subject === RENDER_WORKER_LIMIT_INSTANCE_SUBJECT);
      const owner = limitRows.find((row) => row.subject === operation.ownerId);
      const ownerLimits = tightestLimits(
        instance ? numericLimits(instance) : options.defaultInstanceLimits,
        owner ? numericLimits(owner) : null,
      );
      const limits = tightestLimits(numericLimits(worker), ownerLimits);
      const decision = evaluateClaimAdmission({
        worker: {
          ...worker,
          revoked: worker.status !== RenderWorkerStatus.Active,
          gpuMemoryBytes: null,
          activeOperations: 0,
          limits: numericLimits(worker),
        },
        session: {
          ...session,
          revoked: session.revokedAt !== null,
          gpuMemoryBytes: Number(budget.qualifiedBytes),
          capabilities,
        },
        operation,
        owner: {
          activeOperations: active.filter((row) => row.ownerId === operation.ownerId).length,
          limits: ownerLimits,
        },
        destinationHealth: health,
        now,
      });
      if (!decision.admitted) return refuse(decision.reason);
      if (typeof operation.settings.format === 'string') {
        const output = evaluateRenderOutput(
          [
            {
              gpuMemoryBytes: Number(budget.qualifiedBytes),
              codecs: capabilities.codecs,
              formats: capabilities.formats,
              colorPrecision: session.colorPrecision,
              engineDigest: session.engineDigest,
            },
          ],
          operation.settings as { format: string; color: string; resolution: string },
        );
        if (!output.supported)
          return refuse(
            output.refusal === 'insufficient-memory'
              ? RenderWorkerRefusalReason.GpuMemoryInsufficient
              : RenderWorkerRefusalReason.CodecUnsupported,
          );
      }
      const claimToken = randomUUID();
      const row = await db
        .updateTable('media_operation')
        .set({
          status: MediaOperationStatus.Preparing,
          claimToken,
          claimedBy: worker.id,
          claimExpiresAt: new Date(now.getTime() + options.leaseMs),
          heartbeatAt: now,
          startedAt: operation.startedAt ?? now,
          attemptStartedAt: now,
          outputBytes: '0',
          attempt: operation.attempt + 1,
          lastAdmissionRefusalReason: null,
          lastAdmissionRefusedAt: null,
          retryAt: null,
        })
        .where('id', '=', operation.id)
        .where('status', '=', MediaOperationStatus.Queued)
        .where('cancelRequestedAt', 'is', null)
        .whereRef('attempt', '<', 'maxAttempts')
        .where((eb) => eb.or([eb('retryAt', 'is', null), eb('retryAt', '<=', now)]))
        .where(notJobQueueExecuted())
        .where(sql<boolean>`clock_timestamp() < ${new Date(budget.expiresAt)}`)
        .where(sql<boolean>`clock_timestamp() <= ${new Date(health.checkedAt.getTime() + 30_000)}`)
        .returningAll()
        .executeTakeFirst();
      return row
        ? { operation: row, claimToken, claimedAt: now, engineDigest: session.engineDigest!, limits }
        : undefined;
    });
  }
  /** Write the reason a queued job was passed over, so its owner sees why it is still queued. */
  async recordRefusal(id: string, reason: string): Promise<void> {
    await this.write((db) =>
      db
        .updateTable('media_operation')
        .set({
          lastAdmissionRefusalReason: reason,
          lastAdmissionRefusedAt: sql<Date>`now()`,
          admissionRefusals: sql<number>`"admissionRefusals" + 1`,
        })
        .where('id', '=', id)
        .where('status', '=', MediaOperationStatus.Queued)
        .execute(),
    );
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
    const result = await this.write((db) =>
      db
        .updateTable('media_operation')
        .set({ outputBytes: String(outputBytes) })
        .where('id', '=', id)
        .where('claimToken', '=', claimToken)
        .where('status', 'in', [...CLAIMED_MEDIA_OPERATION_STATUSES])
        .executeTakeFirst(),
    );
    return Number(result.numUpdatedRows) === 1;
  }
}
