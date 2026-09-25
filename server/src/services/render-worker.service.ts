import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { DestinationHealthProvider } from 'src/utils/render-admission.js';
import {
  RenderWorkerAdmissionDto,
  RenderWorkerAuditDto,
  RenderWorkerAuditSearchDto,
  RenderWorkerCancelAckDto,
  RenderWorkerCheckpointCompleteDto,
  RenderWorkerCheckpointPlanDto,
  RenderWorkerClaimDto,
  RenderWorkerClaimRequestDto,
  RenderWorkerCompatibilityResponseDto,
  RenderWorkerCompleteDto,
  RenderWorkerCreateDto,
  RenderWorkerCreateResponseDto,
  RenderWorkerDto,
  RenderWorkerFailDto,
  RenderWorkerHeartbeatDto,
  RenderWorkerHeartbeatResponseDto,
  RenderWorkerLimitDto,
  RenderWorkerLimitUpdateDto,
  RenderWorkerLimitsResponseDto,
  RenderWorkerProgressDto,
  RenderWorkerRemoteReferenceDto,
  RenderWorkerSessionDto,
  RenderWorkerUpdateDto,
  RenderWorkerWriteResultDto,
} from 'src/dtos/render-worker.dto.js';
import {
  AlbumUserRole,
  CacheControl,
  MediaOperationCheckpointState,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  RenderWorkerAuditEvent,
  RenderWorkerRefusalReason,
  RenderWorkerStatus,
  StudioExportRemoteReason,
} from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  MediaOperation,
  MediaOperationCheckpoint,
  MediaOperationRepository,
} from 'src/repositories/media-operation.repository.js';
import {
  AuthenticatedRenderWorker,
  RenderWorker,
  RenderWorkerAudit,
  RenderWorkerLimit,
  RenderWorkerRepository,
} from 'src/repositories/render-worker.repository.js';
import { StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { RENDER_WORKER_LIMIT_INSTANCE_SUBJECT } from 'src/schema/tables/render-worker.table.js';
import { StudioExportService } from 'src/services/studio-export.service.js';
import { StudioPreviewService } from 'src/services/studio-preview.service.js';
import { StudioAuthorizedManifest, StudioResourceService } from 'src/services/studio-resource.service.js';
import { ImmichFileResponse } from 'src/utils/file.js';
import {
  ChunkPlan,
  RENDER_WORKER_MEDIA_OPERATION_KINDS,
  StoredChunk,
  canReuseChunk,
  isRenderWorkerMediaOperationKind,
} from 'src/utils/media-operation.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import {
  AuthorizedManifest,
  DESTINATION_HEALTH_PROVIDER,
  INPUT_GRANT_TTL_MS,
  RenderLimits,
  UnknownDestinationHealthProvider,
  evaluateClaimAdmission,
  evaluateRunningLimits,
  evaluateSessionAdmission,
  isQualifiedRenderSession,
  isWorkerRefusal,
  signInputGrant,
  tightestLimits,
  verifyInputGrant,
} from 'src/utils/render-admission.js';
import { StudioDestination, isStudioDestination } from 'src/utils/studio-resources.js';

/** A session lives half a day; a worker that is still there re-admits with fresh evidence. */
export const RENDER_WORKER_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** A claim without a heartbeat for this long is presumed dead and recovered by FL-104's pass. */
export const RENDER_WORKER_LEASE_MS = 90_000;
export const RENDER_WORKER_HEARTBEAT_INTERVAL_MS = 30_000;
/** How many queued candidates admission looks at before telling the worker there is nothing. */
const CLAIM_CANDIDATES = 25;
const DEFAULT_AUDIT_TAKE = 100;

/** A stored checkpoint in the shape the reuse rules compare (FL-104). */
const asStoredChunk = (chunk: MediaOperationCheckpoint): StoredChunk => ({
  sequence: chunk.sequence,
  state: chunk.state as MediaOperationCheckpointState,
  chunkKey: chunk.chunkKey,
  inputDigest: chunk.inputDigest,
  historyDigest: chunk.historyDigest,
  configDigest: chunk.configDigest,
  seed: chunk.seed,
  timebase: chunk.timebase,
  startTicks: BigInt(chunk.startTicks as never),
  endTicks: BigInt(chunk.endTicks as never),
  requiresSequentialContext: !!chunk.requiresSequentialContext,
  outputPath: chunk.outputPath,
});

const asIso = (value: Date | string | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
};

const asRequiredIso = (value: Date | string): string => asIso(value) as string;

const asBigIntString = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

const asNumberOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const limitsOf = (row: {
  maxConcurrentOperations: number;
  maxWallClockMs: unknown;
  maxOutputBytes: unknown;
}): RenderLimits => ({
  maxConcurrentOperations: row.maxConcurrentOperations,
  maxWallClockMs: asNumberOrNull(row.maxWallClockMs),
  maxOutputBytes: asNumberOrNull(row.maxOutputBytes),
});

/** The instance default when no administrator has set one yet. */
const DEFAULT_INSTANCE_LIMITS: RenderLimits = {
  maxConcurrentOperations: 2,
  maxWallClockMs: null,
  maxOutputBytes: null,
};

const mapWorker = (worker: RenderWorker, activeOperations: number): RenderWorkerDto => ({
  id: worker.id,
  name: worker.name,
  destination: worker.destination as MediaOperationDestination,
  status: worker.status as RenderWorkerStatus,
  kinds: worker.kinds as MediaOperationKind[],
  engineDigest: worker.engineDigest,
  conformanceMaxAgeMs: worker.conformanceMaxAgeMs,
  maxConcurrentOperations: worker.maxConcurrentOperations,
  maxWallClockMs: asBigIntString(worker.maxWallClockMs),
  maxOutputBytes: asBigIntString(worker.maxOutputBytes),
  gpuMemoryBytes: asBigIntString(worker.gpuMemoryBytes),
  activeOperations,
  lastAdmittedAt: asIso(worker.lastAdmittedAt),
  lastSeenAt: asIso(worker.lastSeenAt),
  revokedAt: asIso(worker.revokedAt),
  createdAt: asRequiredIso(worker.createdAt),
  updatedAt: asRequiredIso(worker.updatedAt),
});

const mapLimit = (limit: RenderWorkerLimit): RenderWorkerLimitDto => ({
  subject: limit.subject,
  userId: limit.userId,
  maxConcurrentOperations: limit.maxConcurrentOperations,
  maxWallClockMs: asBigIntString(limit.maxWallClockMs),
  maxOutputBytes: asBigIntString(limit.maxOutputBytes),
  updatedAt: asRequiredIso(limit.updatedAt),
});

const mapAudit = (row: RenderWorkerAudit): RenderWorkerAuditDto => ({
  id: row.id,
  workerId: row.workerId,
  event: row.event as RenderWorkerAuditEvent,
  reason: (row.reason as RenderWorkerRefusalReason | null) ?? null,
  operationId: row.operationId,
  actorId: row.actorId,
  detail: row.detail ? asObject(row.detail) : null,
  createdAt: asRequiredIso(row.createdAt),
});

/**
 * What a Studio operation's immutable snapshot carries for FL-90 to re-resolve at claim time: the
 * graph (or, for a stored-revision job, only the revision to read it from), the declared imports
 * and generated files and the recorded cloud consent. A manifest is never stored on the row — it
 * is signed with a per-process secret and expires in minutes — so it is resolved again, against
 * the owner's current access, every time it is needed.
 */
type StudioSnapshotContext = {
  /** The graph, for a job that carries one. A stored-revision job carries none. */
  graph?: unknown;
  revision: number;
  /**
   * `true` for a job bound to a stored project revision (FL-89), such as a preview (FL-96): the
   * graph is read from project storage at `revision`, which is immutable once written, rather
   * than copied into every job.
   */
  stored?: unknown;
  imports?: unknown;
  generated?: unknown;
  catalog?: unknown;
  cloudConsent?: unknown;
};

const studioContextOf = (operation: MediaOperation): StudioSnapshotContext | null => {
  const snapshot = asObject(operation.snapshot);
  const studio = asObject(snapshot.studio);
  if (!operation.projectId || typeof studio.revision !== 'number') {
    return null;
  }
  if (studio.graph === undefined && studio.stored !== true) {
    return null;
  }
  return studio as StudioSnapshotContext;
};

type StudioGraphSource =
  { ok: true; graph: unknown; projectOwnerId: string } | { ok: false; refused: { key: string; reason: string } };

type ResolvedManifest =
  | { complete: true; manifest: AuthorizedManifest; studio: StudioAuthorizedManifest | null }
  | { complete: false; refused: Array<{ key: string; reason: string }> };

/**
 * A render worker only ever renders (FL-73). Bulk jobs, project bundles, enrichment plans, Library
 * Care, iCloud and Google Photos imports and physical deduplication run on this server's own
 * workers; enrolling or re-scoping a worker for one of them is refused, whatever its destination.
 */
const requireRenderKinds = (kinds: readonly MediaOperationKind[]) => {
  const refused = kinds.filter((kind) => !isRenderWorkerMediaOperationKind(kind));
  if (refused.length > 0) {
    throw new BadRequestException(
      `A render worker can only take ${RENDER_WORKER_MEDIA_OPERATION_KINDS.join(', ')}; not ${refused.join(', ')}`,
    );
  }
};

/** A worker named a result asset that is not a live asset of the job's owner (FL-43). */
export const RENDER_RESULT_NOT_OWNED = 'result_not_owned';
/** The error code a worker reports when its GPU disappears mid-job (FL-95 device loss). */
export const RENDER_DEVICE_LOST = 'device_lost';

/**
 * Authenticated renderer admission and resource limits (FL-95 `STU-401`).
 *
 * Two audiences, two rule sets:
 *
 * - An **administrator** enrols worker identities, sets ceilings and reads the audit trail. They
 *   never see a secret after creation and never see anybody's media through this service.
 * - A **worker** is admitted against evidence and then acts only through the session it was
 *   handed and the claim tokens it earned. Every write is bound to the worker identity *and* the
 *   claim token, and every input read goes through a grant signed for that claim. A worker that
 *   presents another worker's token, a stale token or a grant for a different job gets the same
 *   answer as if the operation did not exist.
 *
 * The decisions themselves are the pure functions in `src/utils/render-admission.ts`; this
 * service gathers their inputs, applies the answer and records it.
 */

@Injectable()
export class RenderWorkerService {
  private destinationHealth: DestinationHealthProvider;

  constructor(
    private logger: LoggingRepository,
    private repository: RenderWorkerRepository,
    private operations: MediaOperationRepository,
    private cryptoRepository: CryptoRepository,
    private accessRepository: AccessRepository,
    private assetRepository: AssetRepository,
    private userRepository: UserRepository,
    private studioResources: StudioResourceService,
    private studioProjects: StudioProjectRepository,
    private studioExports: StudioExportService,
    private studioPreviews: StudioPreviewService,
    @Optional() @Inject(DESTINATION_HEALTH_PROVIDER) destinationHealth?: DestinationHealthProvider,
  ) {
    this.logger.setContext(RenderWorkerService.name);
    // FL-110 registers the real provider; until then nothing is probed and nothing is claimed.
    this.destinationHealth = destinationHealth ?? new UnknownDestinationHealthProvider();
  }

  /* ------------------------------------------------------------------ */
  /* Administrator                                                       */
  /* ------------------------------------------------------------------ */

  /** FL-71 (CC-9): the render kinds with and without a qualified GPU worker right now. */
  async getCompatibility(): Promise<RenderWorkerCompatibilityResponseDto> {
    const sessions = await this.repository.listLiveSessions();
    const now = new Date();
    const qualifiedFor = (kind: MediaOperationKind) =>
      sessions.some(
        ({ worker, session }) =>
          session.scopes.includes(kind) &&
          isQualifiedRenderSession({
            worker: {
              revoked: worker.status !== RenderWorkerStatus.Active,
              engineDigest: worker.engineDigest,
              conformanceMaxAgeMs: worker.conformanceMaxAgeMs,
            },
            session: {
              revoked: session.revokedAt !== null,
              expiresAt: new Date(session.expiresAt),
              engineDigest: session.engineDigest,
              conformanceReportedAt: new Date(session.conformanceReportedAt),
              scopes: [kind],
            },
            now,
          }),
      );
    const qualified = RENDER_WORKER_MEDIA_OPERATION_KINDS.filter((kind) => qualifiedFor(kind));
    return {
      qualified: [...qualified],
      unavailable: RENDER_WORKER_MEDIA_OPERATION_KINDS.filter((kind) => !qualified.includes(kind)),
    };
  }

  async list(): Promise<RenderWorkerDto[]> {
    const workers = await this.repository.listWorkers();
    return Promise.all(
      workers.map(async (worker) => mapWorker(worker, await this.repository.countActiveForWorker(worker.id))),
    );
  }

  async get(id: string): Promise<RenderWorkerDto> {
    const worker = await this.findWorker(id);
    return mapWorker(worker, await this.repository.countActiveForWorker(worker.id));
  }

  /**
   * Enrol a worker. The secret is generated here, returned once and stored only as a digest —
   * the same shape as an API key. It is never logged.
   */
  async create(auth: AuthDto, dto: RenderWorkerCreateDto): Promise<RenderWorkerCreateResponseDto> {
    requireRenderKinds(dto.kinds);
    const enrolmentSecret = this.cryptoRepository.randomBytesAsText(32);

    const worker = await this.repository.createWorker({
      name: dto.name,
      destination: dto.destination,
      kinds: dto.kinds,
      enrolmentSecret: this.cryptoRepository.hashSha256(enrolmentSecret),
      engineDigest: dto.engineDigest ?? null,
      conformanceMaxAgeMs: dto.conformanceMaxAgeMs,
      maxConcurrentOperations: dto.maxConcurrentOperations,
      maxWallClockMs: dto.maxWallClockMs ?? null,
      maxOutputBytes: dto.maxOutputBytes ?? null,
      gpuMemoryBytes: dto.gpuMemoryBytes ?? null,
      createdBy: auth.user.id,
    });

    await this.repository.recordAudit({
      workerId: worker.id,
      event: RenderWorkerAuditEvent.Enrolled,
      actorId: auth.user.id,
      detail: { name: worker.name, destination: worker.destination, kinds: worker.kinds },
    });
    this.logger.log(`Render worker ${worker.id} (${worker.name}) enrolled for ${worker.destination}`);

    return { worker: mapWorker(worker, 0), enrolmentSecret };
  }

  async update(auth: AuthDto, id: string, dto: RenderWorkerUpdateDto): Promise<RenderWorkerDto> {
    if (dto.kinds) {
      requireRenderKinds(dto.kinds);
    }
    await this.findWorker(id);

    const updated = await this.repository.updateWorker(id, {
      name: dto.name,
      kinds: dto.kinds,
      engineDigest: dto.engineDigest,
      conformanceMaxAgeMs: dto.conformanceMaxAgeMs,
      maxConcurrentOperations: dto.maxConcurrentOperations,
      maxWallClockMs: dto.maxWallClockMs,
      maxOutputBytes: dto.maxOutputBytes,
      gpuMemoryBytes: dto.gpuMemoryBytes,
    });
    if (!updated) {
      throw new BadRequestException('A revoked worker cannot be changed');
    }

    await this.repository.recordAudit({
      workerId: id,
      event: RenderWorkerAuditEvent.Updated,
      actorId: auth.user.id,
      detail: { ...dto },
    });

    return mapWorker(updated, await this.repository.countActiveForWorker(id));
  }

  /**
   * Revoke a worker. Every session dies with it, so the next request it makes is refused and the
   * claims it holds expire into FL-104's recovery pass rather than being trusted to finish.
   */
  async revoke(auth: AuthDto, id: string): Promise<void> {
    await this.findWorker(id);

    const revoked = await this.repository.revokeWorker(id);
    if (!revoked) {
      throw new BadRequestException('This worker is already revoked');
    }

    await this.repository.recordAudit({
      workerId: id,
      event: RenderWorkerAuditEvent.Revoked,
      actorId: auth.user.id,
      detail: { name: revoked.name },
    });
    this.logger.warn(`Render worker ${id} (${revoked.name}) revoked`);
  }

  async getLimits(): Promise<RenderWorkerLimitsResponseDto> {
    const rows = await this.repository.listLimits();
    const instance = rows.find((row) => row.subject === RENDER_WORKER_LIMIT_INSTANCE_SUBJECT);

    return {
      instance: instance
        ? mapLimit(instance)
        : {
            subject: RENDER_WORKER_LIMIT_INSTANCE_SUBJECT,
            userId: null,
            ...DEFAULT_INSTANCE_LIMITS,
            maxWallClockMs: null,
            maxOutputBytes: null,
            updatedAt: new Date(0).toISOString(),
          },
      users: rows.filter((row) => row.subject !== RENDER_WORKER_LIMIT_INSTANCE_SUBJECT).map((row) => mapLimit(row)),
    };
  }

  async updateLimits(auth: AuthDto, dto: RenderWorkerLimitUpdateDto): Promise<RenderWorkerLimitDto> {
    const userId = dto.userId ?? null;
    const subject = userId ?? RENDER_WORKER_LIMIT_INSTANCE_SUBJECT;

    const limit = await this.repository.upsertLimit(subject, userId, {
      maxConcurrentOperations: dto.maxConcurrentOperations,
      maxWallClockMs: dto.maxWallClockMs,
      maxOutputBytes: dto.maxOutputBytes,
    });

    await this.repository.recordAudit({
      workerId: null,
      event: RenderWorkerAuditEvent.Updated,
      actorId: auth.user.id,
      detail: { subject, ...dto },
    });

    return mapLimit(limit);
  }

  async deleteUserLimit(auth: AuthDto, userId: string): Promise<void> {
    const deleted = await this.repository.deleteLimit(userId);
    if (!deleted) {
      throw new NotFoundException('No limit is set for this account');
    }

    await this.repository.recordAudit({
      workerId: null,
      event: RenderWorkerAuditEvent.Updated,
      actorId: auth.user.id,
      detail: { subject: userId, removed: true },
    });
  }

  async searchAudit(dto: RenderWorkerAuditSearchDto): Promise<RenderWorkerAuditDto[]> {
    const rows = await this.repository.listAudit({ workerId: dto.workerId, take: dto.take ?? DEFAULT_AUDIT_TAKE });
    return rows.map((row) => mapAudit(row));
  }

  /* ------------------------------------------------------------------ */
  /* Worker: admission                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Admit a worker and hand it a session.
   *
   * The secret is compared by digest and the worker id must match the row the digest found: a
   * valid secret presented under another worker's id is a forgery, not a typo. Every refusal is
   * audited with its reason and answered with one generic message, so a caller probing the gate
   * learns nothing about which check failed.
   */
  async admit(dto: RenderWorkerAdmissionDto): Promise<RenderWorkerSessionDto> {
    const now = new Date();
    const worker = await this.repository.getWorkerBySecret(this.cryptoRepository.hashSha256(dto.enrolmentSecret));

    if (!worker || worker.id !== dto.workerId) {
      await this.repository.recordAudit({
        workerId: worker?.id ?? dto.workerId,
        event: RenderWorkerAuditEvent.Refused,
        reason: RenderWorkerRefusalReason.InvalidCredential,
        detail: { presentedWorkerId: dto.workerId },
      });
      throw new UnauthorizedException('Worker admission refused');
    }

    const reportedAt = new Date(dto.conformanceReportedAt);
    const decision = evaluateSessionAdmission({
      worker: {
        revoked: worker.status === RenderWorkerStatus.Revoked,
        engineDigest: worker.engineDigest,
        conformanceMaxAgeMs: worker.conformanceMaxAgeMs,
        lastConformanceReportedAt: worker.lastConformanceReportedAt ? new Date(worker.lastConformanceReportedAt) : null,
      },
      report: {
        engineDigest: dto.engineDigest,
        conformanceReportedAt: reportedAt,
        softwareRenderer: dto.softwareRenderer,
      },
      now,
    });

    if (!decision.admitted) {
      await this.repository.recordAudit({
        workerId: worker.id,
        event: RenderWorkerAuditEvent.Refused,
        reason: decision.reason,
        detail: {
          engineDigest: dto.engineDigest,
          conformanceReportedAt: dto.conformanceReportedAt,
          softwareRenderer: dto.softwareRenderer,
          gpuMemoryBytes: dto.gpuMemoryBytes,
        },
      });
      this.logger.warn(`Render worker ${worker.id} refused admission: ${decision.reason}`);
      throw new UnauthorizedException('Worker admission refused');
    }

    const sessionToken = this.cryptoRepository.randomBytesAsText(32);
    const expiresAt = new Date(now.getTime() + RENDER_WORKER_SESSION_TTL_MS);

    // The GPU memory admitted is the lesser of what the check measured and what the administrator
    // qualified. A worker cannot talk its way into a bigger budget than it was enrolled with.
    const reported = asNumberOrNull(dto.gpuMemoryBytes);
    const qualified = asNumberOrNull(worker.gpuMemoryBytes);
    const gpuMemoryBytes =
      reported === null ? qualified : qualified === null ? reported : Math.min(reported, qualified);

    // FL-73: a scope saved before the render-only rule keeps only its renders in the session.
    const scopes = (worker.kinds as MediaOperationKind[]).filter((kind) => isRenderWorkerMediaOperationKind(kind));

    const created = await this.repository.createSession({
      workerId: worker.id,
      token: this.cryptoRepository.hashSha256(sessionToken),
      scopes,
      gpuMemoryBytes: gpuMemoryBytes === null ? null : String(gpuMemoryBytes),
      engineDigest: dto.engineDigest,
      conformanceReportedAt: reportedAt,
      // FL-42: what this session may render is what its conformance check verified, nothing more.
      codecs: dto.codecs ?? [],
      colorPrecision: dto.colorPrecision ?? null,
      expiresAt,
    });
    // FL-95: what the check verified travels with the session, so claims are measured against it.
    await this.repository.recordSessionCapabilities(created.id, {
      codecs: dto.codecs ?? [],
      formats: dto.formats ?? [],
    });
    await this.repository.markAdmitted(worker.id, reportedAt);
    await this.repository.recordAudit({
      workerId: worker.id,
      event: RenderWorkerAuditEvent.Admitted,
      detail: {
        engineDigest: dto.engineDigest,
        conformanceReportedAt: dto.conformanceReportedAt,
        gpuMemoryBytes: gpuMemoryBytes === null ? null : String(gpuMemoryBytes),
        codecs: dto.codecs ?? [],
        colorPrecision: dto.colorPrecision ?? null,
        formats: dto.formats ?? [],
        expiresAt: expiresAt.toISOString(),
      },
    });
    this.logger.log(`Render worker ${worker.id} (${worker.name}) admitted until ${expiresAt.toISOString()}`);

    return {
      workerId: worker.id,
      sessionToken,
      expiresAt: expiresAt.toISOString(),
      scopes,
      leaseMs: RENDER_WORKER_LEASE_MS,
      heartbeatIntervalMs: RENDER_WORKER_HEARTBEAT_INTERVAL_MS,
    };
  }

  /**
   * Resolve the session header on a worker request. Expired, revoked and unknown credentials all
   * get the same answer. The check on the worker's status is what makes revocation immediate.
   */
  async authenticate(sessionToken: string | undefined): Promise<AuthenticatedRenderWorker> {
    if (!sessionToken) {
      throw new UnauthorizedException('Worker session required');
    }

    const authenticated = await this.repository.getSessionByToken(this.cryptoRepository.hashSha256(sessionToken));
    if (!authenticated) {
      throw new UnauthorizedException('Worker session invalid');
    }

    const { worker, session } = authenticated;
    if (
      worker.status !== RenderWorkerStatus.Active ||
      session.revokedAt !== null ||
      new Date(session.expiresAt).getTime() <= Date.now()
    ) {
      throw new UnauthorizedException('Worker session invalid');
    }

    await this.repository.touchSession(session.id);
    await this.repository.markSeen(worker.id);
    return authenticated;
  }

  /* ------------------------------------------------------------------ */
  /* Worker: claims                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Claim the oldest queued operation this worker is admitted to run, or nothing.
   *
   * Candidates are looked at in queue order. A refusal about the worker (out of scope, over its
   * concurrency) ends the attempt; a refusal about the operation (its owner is at their limit, it
   * needs more GPU memory) is written on that operation and the next candidate is tried. Taking
   * the job is a conditional update, so a second worker that decided on the same candidate loses
   * the race cleanly and simply moves on.
   */
  async claim(
    sessionToken: string | undefined,
    dto: RenderWorkerClaimRequestDto,
  ): Promise<RenderWorkerClaimDto | undefined> {
    const { worker, session } = await this.authenticate(sessionToken);
    const now = new Date();

    // FL-73: a saved scope may predate the render-only rule; server-side jobs are never handed out.
    const scopes = (session.scopes as MediaOperationKind[]).filter((kind) => isRenderWorkerMediaOperationKind(kind));
    const kinds = dto.kinds ? dto.kinds.filter((kind) => scopes.includes(kind)) : scopes;
    if (kinds.length === 0) {
      throw new ForbiddenException('Requested kinds are outside this session’s scopes');
    }

    const sessionCapabilities = await this.repository.getSessionCapabilities(session.id);
    const [workerActive, instanceLimit, destinationHealth] = await Promise.all([
      this.repository.countActiveForWorker(worker.id),
      this.repository.getLimit(RENDER_WORKER_LIMIT_INSTANCE_SUBJECT),
      this.destinationHealth.check(worker.destination as MediaOperationDestination, null),
    ]);
    const workerLimits = limitsOf(worker);
    const instanceLimits = instanceLimit ? limitsOf(instanceLimit) : DEFAULT_INSTANCE_LIMITS;

    const skipped: string[] = [];
    const ownerCounts = new Map<string, number>();
    const ownerLimits = new Map<string, RenderLimits>();

    while (skipped.length < CLAIM_CANDIDATES) {
      const candidates = await this.repository.peekQueued({
        destination: worker.destination as MediaOperationDestination,
        kinds,
        excludeIds: skipped,
        take: 5,
      });
      if (candidates.length === 0) {
        return undefined;
      }

      for (const candidate of candidates) {
        if (!ownerCounts.has(candidate.ownerId)) {
          ownerCounts.set(candidate.ownerId, await this.repository.countActiveForOwner(candidate.ownerId));
          const userLimit = await this.repository.getLimit(candidate.ownerId);
          ownerLimits.set(candidate.ownerId, tightestLimits(instanceLimits, userLimit ? limitsOf(userLimit) : null));
        }

        const decision = evaluateClaimAdmission({
          worker: {
            id: worker.id,
            name: worker.name,
            destination: worker.destination as MediaOperationDestination,
            revoked: worker.status === RenderWorkerStatus.Revoked,
            kinds: worker.kinds as MediaOperationKind[],
            gpuMemoryBytes: asNumberOrNull(worker.gpuMemoryBytes),
            activeOperations: workerActive,
            limits: workerLimits,
          },
          session: {
            expiresAt: new Date(session.expiresAt),
            revoked: session.revokedAt !== null,
            scopes,
            gpuMemoryBytes: asNumberOrNull(session.gpuMemoryBytes),
            engineDigest: session.engineDigest,
            capabilities: sessionCapabilities ?? null,
          },
          operation: {
            kind: candidate.kind as MediaOperationKind,
            destination: candidate.destination as MediaOperationDestination,
            destinationDetail: candidate.destinationDetail,
            snapshot: asObject(candidate.snapshot),
            settings: asObject(candidate.settings),
          },
          owner: { activeOperations: ownerCounts.get(candidate.ownerId)!, limits: ownerLimits.get(candidate.ownerId)! },
          destinationHealth,
          now,
        });

        if (!decision.admitted) {
          await this.repository.recordAudit({
            workerId: worker.id,
            event: RenderWorkerAuditEvent.ClaimRefused,
            reason: decision.reason,
            operationId: candidate.id,
          });

          if (isWorkerRefusal(decision.reason)) {
            // Nothing else in the queue will go better for this worker right now.
            return undefined;
          }

          await this.repository.recordRefusal(candidate.id, decision.reason);
          skipped.push(candidate.id);
          continue;
        }

        // Resolve what the job may read *before* taking it. FL-90 walks the graph against the
        // owner's current access; a source that went missing, was trashed, relocked or unshared
        // since submit makes the manifest incomplete, and an incomplete manifest is not rendered.
        const resolved = await this.resolveManifest(candidate as unknown as MediaOperation, session.id);
        if (!resolved.complete) {
          await this.repository.recordAudit({
            workerId: worker.id,
            event: RenderWorkerAuditEvent.ClaimRefused,
            reason: RenderWorkerRefusalReason.ManifestIncomplete,
            operationId: candidate.id,
            detail: { refused: resolved.refused },
          });
          await this.repository.recordRefusal(candidate.id, RenderWorkerRefusalReason.ManifestIncomplete);
          skipped.push(candidate.id);
          continue;
        }

        const claimed = await this.repository.claimQueued({
          id: candidate.id,
          workerId: worker.id,
          leaseMs: RENDER_WORKER_LEASE_MS,
        });
        if (!claimed) {
          // Another worker took it between the peek and the update. Not a refusal; just gone.
          skipped.push(candidate.id);
          continue;
        }

        const operation = claimed.operation as unknown as MediaOperation;
        if (operation.kind === MediaOperationKind.StudioExport && resolved.studio) {
          // FL-106: what this claim may read is the provenance publication checks against, and a
          // remote render is an obligation to stop it until the worker confirms, from now on.
          await this.studioExports.onRenderClaimed(operation, {
            workerId: worker.id,
            engineDigest: session.engineDigest,
            entries: resolved.studio.entries,
          });
        }
        if (operation.kind === MediaOperationKind.StudioPreview) {
          // FL-96: the frame's own directory, which is the only place its output is accepted from.
          this.studioPreviews.onRenderClaimed(operation);
        }
        const checkpoints = await this.operations.getCheckpoints(operation.id);
        const manifest = resolved.studio
          ? this.studioInputs(operation, resolved.studio, worker.id, now)
          : resolved.manifest;
        // Locked and sensitive sources are rendered like any other: the owner submitted this job.
        const effective = tightestLimits(workerLimits, ownerLimits.get(candidate.ownerId));

        this.logger.log(`Render worker ${worker.id} claimed media operation ${operation.id} (${operation.kind})`);

        return {
          operationId: operation.id,
          kind: operation.kind as MediaOperationKind,
          claimToken: claimed.claimToken,
          leaseMs: RENDER_WORKER_LEASE_MS,
          projectId: operation.projectId,
          revisionId: operation.revisionId,
          snapshot: asObject(operation.snapshot),
          settings: asObject(operation.settings),
          attempt: operation.attempt,
          checkpoints: checkpoints.map((checkpoint) => ({
            id: checkpoint.id,
            sequence: checkpoint.sequence,
            state: checkpoint.state,
            chunkKey: checkpoint.chunkKey,
            timebase: checkpoint.timebase,
            startTicks: String(checkpoint.startTicks),
            endTicks: String(checkpoint.endTicks),
            requiresSequentialContext: checkpoint.requiresSequentialContext,
            sizeInBytes: asBigIntString(checkpoint.sizeInBytes),
            completedAt: asIso(checkpoint.completedAt),
          })),
          inputs: this.grantInputs(manifest, {
            claimToken: claimed.claimToken,
            sessionTokenHash: session.token,
            now,
          }),
          limits: {
            maxWallClockMs: effective.maxWallClockMs === null ? null : String(effective.maxWallClockMs),
            maxOutputBytes: effective.maxOutputBytes === null ? null : String(effective.maxOutputBytes),
          },
        };
      }
    }

    return undefined;
  }

  /**
   * Extend the lease, and while doing so check the operation is still inside its ceilings and
   * tell the worker whether the owner has asked it to stop. A limit breach fails the job here,
   * under the claim, rather than trusting the worker to notice.
   */
  async heartbeat(
    sessionToken: string | undefined,
    operationId: string,
    dto: RenderWorkerHeartbeatDto,
  ): Promise<RenderWorkerHeartbeatResponseDto> {
    const { worker } = await this.authenticate(sessionToken);
    const operation = await this.requireClaimed(worker.id, operationId, dto.claimToken);

    if (dto.outputBytes !== undefined) {
      await this.repository.recordOutputBytes(operation.id, dto.claimToken, Number(dto.outputBytes));
    }

    const refusal = await this.enforceRunningLimits(worker.id, operation, dto.outputBytes);
    if (refusal) {
      return {
        leaseExtended: false,
        leaseMs: RENDER_WORKER_LEASE_MS,
        cancelRequested: false,
        pauseRequested: false,
        refusal,
      };
    }

    // The owner paused the job (FL-104). The heartbeat is the worker's checkpoint with the server,
    // so the claim is handed back here: the lease is not extended, every later write under this
    // token is refused, and the completed chunks stay for the claim that resumes it. A job already
    // validating its output is let finish.
    if (
      operation.pauseRequestedAt &&
      operation.status !== MediaOperationStatus.Validating &&
      (await this.operations.settlePause(operation.id, dto.claimToken))
    ) {
      this.logger.log(`Render worker ${worker.id} released paused media operation ${operation.id}`);
      return {
        leaseExtended: false,
        leaseMs: RENDER_WORKER_LEASE_MS,
        cancelRequested: false,
        pauseRequested: true,
        refusal: null,
      };
    }

    const leaseExtended = await this.operations.heartbeat(operation.id, dto.claimToken, RENDER_WORKER_LEASE_MS);
    return {
      leaseExtended,
      leaseMs: RENDER_WORKER_LEASE_MS,
      cancelRequested: operation.cancelRequestedAt !== null || operation.status === MediaOperationStatus.Cancelling,
      pauseRequested: false,
      refusal: null,
    };
  }

  async progress(
    sessionToken: string | undefined,
    operationId: string,
    dto: RenderWorkerProgressDto,
  ): Promise<RenderWorkerWriteResultDto> {
    const { worker } = await this.authenticate(sessionToken);
    const operation = await this.requireClaimed(worker.id, operationId, dto.claimToken);

    if (dto.outputBytes !== undefined) {
      await this.repository.recordOutputBytes(operation.id, dto.claimToken, Number(dto.outputBytes));
    }

    const refusal = await this.enforceRunningLimits(worker.id, operation, dto.outputBytes);
    if (refusal) {
      return { accepted: false, refusal };
    }

    const total = dto.totalUnits;
    const progress =
      total && total > 0 ? Math.min(100, Math.max(0, Math.round((dto.processedUnits / total) * 10_000) / 100)) : 0;

    const accepted = await this.operations.reportProgress(operation.id, dto.claimToken, {
      status: dto.status,
      processedUnits: dto.processedUnits,
      totalUnits: dto.totalUnits,
      progress,
    });

    return { accepted, refusal: null };
  }

  async planCheckpoint(
    sessionToken: string | undefined,
    operationId: string,
    dto: RenderWorkerCheckpointPlanDto,
  ): Promise<RenderWorkerWriteResultDto> {
    const { worker } = await this.authenticate(sessionToken);
    const operation = await this.requireClaimed(worker.id, operationId, dto.claimToken);

    /**
     * FL-104: reuse is the server's decision, not the worker's. A finished chunk is kept only when
     * every digest (input, effect history, config, seed), the timebase and the range match the new
     * plan. Anything else is planned afresh, and the history after it no longer holds: every later
     * chunk, and the run of chunks before it whose filter or audio state flows into it, is
     * invalidated so the render restarts at a boundary it can legitimately begin from.
     */
    const stored = await this.operations.getCheckpoints(operation.id);
    const existing = stored.find((chunk) => chunk.sequence === dto.sequence);
    const planned: ChunkPlan = {
      sequence: dto.sequence,
      chunkKey: dto.chunkKey,
      inputDigest: dto.inputDigest,
      historyDigest: dto.historyDigest,
      configDigest: dto.configDigest,
      seed: dto.seed ?? null,
      timebase: dto.timebase,
      startTicks: BigInt(dto.startTicks),
      endTicks: BigInt(dto.endTicks),
      requiresSequentialContext: dto.requiresSequentialContext ?? false,
    };
    if (existing && canReuseChunk(asStoredChunk(existing), planned).reusable) {
      return { accepted: true, refusal: null };
    }

    const accepted = await this.operations.upsertCheckpoint(operation.id, dto.claimToken, {
      operationId: operation.id,
      sequence: dto.sequence,
      chunkKey: dto.chunkKey,
      inputDigest: dto.inputDigest,
      historyDigest: dto.historyDigest,
      configDigest: dto.configDigest,
      seed: dto.seed,
      timebase: dto.timebase,
      startTicks: dto.startTicks,
      endTicks: dto.endTicks,
      prerollTicks: dto.prerollTicks ?? '0',
      requiresSequentialContext: dto.requiresSequentialContext ?? false,
      claimToken: dto.claimToken,
    });

    if (accepted && existing) {
      let restart = dto.sequence;
      const bySequence = new Map(stored.map((chunk) => [chunk.sequence, chunk]));
      while (bySequence.get(restart - 1)?.requiresSequentialContext) {
        restart--;
      }
      // The re-planned chunk itself is pending again; everything else from the restart is invalid.
      if (restart < dto.sequence) {
        await this.operations.invalidateCheckpointsFrom(operation.id, restart);
        await this.operations.upsertCheckpoint(operation.id, dto.claimToken, {
          operationId: operation.id,
          sequence: dto.sequence,
          chunkKey: dto.chunkKey,
          inputDigest: dto.inputDigest,
          historyDigest: dto.historyDigest,
          configDigest: dto.configDigest,
          seed: dto.seed,
          timebase: dto.timebase,
          startTicks: dto.startTicks,
          endTicks: dto.endTicks,
          prerollTicks: dto.prerollTicks ?? '0',
          requiresSequentialContext: dto.requiresSequentialContext ?? false,
          claimToken: dto.claimToken,
        });
      } else if (stored.some((chunk) => chunk.sequence > dto.sequence)) {
        await this.operations.invalidateCheckpointsFrom(operation.id, dto.sequence + 1);
      }
    }

    return { accepted, refusal: null };
  }

  async completeCheckpoint(
    sessionToken: string | undefined,
    operationId: string,
    sequence: number,
    dto: RenderWorkerCheckpointCompleteDto,
  ): Promise<RenderWorkerWriteResultDto> {
    const { worker } = await this.authenticate(sessionToken);
    const operation = await this.requireClaimed(worker.id, operationId, dto.claimToken);

    const accepted = await this.operations.completeCheckpoint(operation.id, dto.claimToken, {
      sequence,
      chunkKey: dto.chunkKey,
      outputPath: dto.outputPath,
      outputChecksum: Buffer.from(dto.outputChecksum, 'hex'),
      sizeInBytes: Number(dto.sizeInBytes),
    });

    return { accepted, refusal: null };
  }

  /** Move to `validating`. Publication is a second step so a failed validation never publishes. */
  async beginValidation(
    sessionToken: string | undefined,
    operationId: string,
    dto: RenderWorkerCompleteDto,
  ): Promise<RenderWorkerWriteResultDto> {
    const { worker } = await this.authenticate(sessionToken);
    const operation = await this.requireClaimed(worker.id, operationId, dto.claimToken);

    // FL-104: output built on a chunk the server invalidated, or never saw finish, is not validated.
    const checkpoints = await this.operations.getCheckpoints(operation.id);
    if (checkpoints.some((chunk) => chunk.state !== MediaOperationCheckpointState.Complete)) {
      return { accepted: false, refusal: null };
    }

    const accepted = await this.operations.beginValidation(operation.id, dto.claimToken);
    return { accepted, refusal: null };
  }

  /**
   * Finish a validated render.
   *
   * A worker never names the asset a Studio export becomes (FL-106): it reports the file it wrote,
   * inside the directory its claim named, and the server stages it and queues its publication, which
   * re-checks access and installs the sources' privacy before anything becomes visible. Only then is
   * the render job itself completed, without a result asset. For other kinds, adoption of an output
   * belongs to their own publish paths; this only records that the claim finished.
   *
   * Any other kind may name a result, which must be a live asset of the job's owner (FL-43): a
   * worker naming anything else — another account's media, a deleted asset — is refused, and the
   * job fails with a stable code instead of publishing it as lineage.
   */
  async complete(
    sessionToken: string | undefined,
    operationId: string,
    dto: RenderWorkerCompleteDto,
  ): Promise<RenderWorkerWriteResultDto> {
    const { worker } = await this.authenticate(sessionToken);
    const operation = await this.requireClaimed(worker.id, operationId, dto.claimToken);

    if (operation.kind === MediaOperationKind.StudioExport) {
      if (dto.resultAssetId !== null) {
        throw new BadRequestException('A Studio export is published by the server; a worker cannot name its result');
      }
      if (!dto.output) {
        throw new BadRequestException('A Studio export must report the file it produced');
      }
      if (operation.status !== MediaOperationStatus.Validating) {
        return { accepted: false, refusal: null };
      }
      const staged = await this.studioExports.onRenderCompleted(operation, worker.id, {
        path: dto.output.path,
        checksum: dto.output.checksum,
        sizeInBytes: dto.output.sizeInBytes,
        contentType: dto.output.contentType,
        remoteRef: dto.output.remoteRef ?? null,
      });
      if (!staged.accepted) {
        return { accepted: false, refusal: null };
      }
      const accepted = await this.operations.complete(operation.id, dto.claimToken, { resultAssetId: null });
      if (accepted) {
        this.logger.log(`Render worker ${worker.id} completed Studio export render ${operation.id}`);
      }
      return { accepted, refusal: null };
    }

    if (operation.kind === MediaOperationKind.StudioPreview) {
      if (dto.resultAssetId !== null) {
        throw new BadRequestException('A preview frame is published by the server; a worker cannot name its result');
      }
      if (!dto.output) {
        throw new BadRequestException('A preview render must report the frame it produced');
      }
      // FL-96: the frame is published (or, when superseded meanwhile, discarded) before the job
      // completes, so the person never waits on a finished render whose frame is missing.
      const { published } = await this.studioPreviews.onRenderCompleted(operation, dto.output);
      const accepted = await this.operations.complete(operation.id, dto.claimToken, { resultAssetId: null });
      if (accepted) {
        this.logger.log(
          `Render worker ${worker.id} completed preview ${operation.id}${published ? '' : ' (superseded, discarded)'}`,
        );
      }
      return { accepted, refusal: null };
    }

    if (dto.resultAssetId && !(await this.operations.isPublishableResult(operation.ownerId, dto.resultAssetId))) {
      this.logger.warn(
        `Render worker ${worker.id} named a result for media operation ${operation.id} that is not the owner's`,
      );
      await this.operations.fail(operation.id, dto.claimToken, {
        error: 'The worker reported a result that does not belong to this account',
        errorCode: RENDER_RESULT_NOT_OWNED,
      });
      return { accepted: false, refusal: null };
    }

    const accepted = await this.operations.complete(operation.id, dto.claimToken, { resultAssetId: dto.resultAssetId });
    if (accepted) {
      this.logger.log(`Render worker ${worker.id} completed media operation ${operation.id}`);
    }

    return { accepted, refusal: null };
  }

  async fail(
    sessionToken: string | undefined,
    operationId: string,
    dto: RenderWorkerFailDto,
  ): Promise<RenderWorkerWriteResultDto> {
    const { worker } = await this.authenticate(sessionToken);
    const operation = await this.requireClaimed(worker.id, operationId, dto.claimToken);

    // The report is accepted whether the job fails outright or goes back to the queue for its one
    // automatic retry (FL-104); either way this worker's claim is spent.
    const outcome = await this.operations.fail(operation.id, dto.claimToken, {
      error: dto.error,
      errorCode: dto.errorCode,
    });
    if (dto.errorCode === RENDER_DEVICE_LOST) {
      // FL-95: the GPU the session was admitted on is gone, so its evidence no longer holds. Every
      // session of the worker ends; it is given nothing until it re-admits with a fresh check.
      const revoked = await this.repository.revokeSessions(worker.id);
      await this.repository.recordAudit({
        workerId: worker.id,
        event: RenderWorkerAuditEvent.DeviceLost,
        operationId: operation.id,
        detail: { revokedSessions: revoked },
      });
      this.logger.warn(`Render worker ${worker.id} lost its GPU; ${revoked} session(s) revoked until it re-admits`);
    }
    const accepted = outcome !== false;
    if (outcome === 'failed' && operation.kind === MediaOperationKind.StudioExport) {
      await this.studioExports.onRenderFailed(operation, { errorCode: dto.errorCode, error: dto.error });
    }
    if (outcome === 'failed' && operation.kind === MediaOperationKind.StudioPreview) {
      await this.studioPreviews.onRenderFailed(operation, dto.errorCode);
    }
    if (accepted) {
      this.logger.warn(
        `Render worker ${worker.id} failed media operation ${operation.id}: ${dto.errorCode} (${outcome === 'retrying' ? 'retrying once' : 'reported'})`,
      );
    }

    return { accepted, refusal: null };
  }

  /**
   * The worker confirms it stopped. `acknowledgeCancel` in FL-104's repository is guarded by
   * status only, so the claim and worker are checked here first; a worker cannot settle a cancel
   * on a job it does not hold.
   */
  async acknowledgeCancel(
    sessionToken: string | undefined,
    operationId: string,
    dto: RenderWorkerCancelAckDto,
  ): Promise<RenderWorkerWriteResultDto> {
    const { worker } = await this.authenticate(sessionToken);
    const operation = await this.requireClaimed(worker.id, operationId, dto.claimToken);

    if (operation.status !== MediaOperationStatus.Cancelling) {
      return { accepted: false, refusal: null };
    }

    const accepted = await this.operations.acknowledgeCancel(operation.id, dto.claimToken, { released: dto.released });
    if (accepted && operation.kind === MediaOperationKind.StudioExport) {
      await this.studioExports.onRenderCancelAcknowledged(operation, worker.id, dto.released);
    }
    return { accepted, refusal: null };
  }

  /**
   * What this worker still holds for Studio exports that it must stop or delete (FL-106): renders
   * that were cancelled or abandoned, and copies of outputs it kept. Each stays listed until the
   * worker acknowledges it, whatever happened to the owner, the project or the job meanwhile.
   */
  async listRemoteReferences(sessionToken: string | undefined): Promise<RenderWorkerRemoteReferenceDto[]> {
    const { worker } = await this.authenticate(sessionToken);
    const references = await this.studioExports.listRemoteReferences(worker.id);
    return references.map((reference) => ({
      id: reference.id,
      operationId: reference.operationId,
      reason: reference.reason as StudioExportRemoteReason,
      remoteRef: reference.remoteRef,
      requestedAt: asRequiredIso(reference.requestedAt),
    }));
  }

  /** The worker confirms a reference is gone. Another worker's reference is not found. */
  async acknowledgeRemoteReference(sessionToken: string | undefined, id: string): Promise<RenderWorkerWriteResultDto> {
    const { worker } = await this.authenticate(sessionToken);
    const accepted = await this.studioExports.acknowledgeRemoteReference(id, worker.id);
    if (!accepted) {
      throw new NotFoundException('Remote reference not found');
    }
    return { accepted, refusal: null };
  }

  /* ------------------------------------------------------------------ */
  /* Worker: inputs                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Serve one input under a grant.
   *
   * Every check must hold: the session is live; the operation is claimed by *this* worker; the
   * operation-scoped grant verifies against this operation, this claim and this session; and the
   * resource is still readable by the owner right now. For a Studio resource that last check is
   * FL-90's `verifyReadGrant`, run as the operation owner, which re-checks live access and the
   * checksum on every open. For a single-asset workload it is the owner access check. The manifest
   * is resolved again rather than trusted from the grant, so nothing the owner lost access to since
   * the claim is served even while the grant is unexpired. Locked is not "lost access": a
   * background task reads every asset the owner's job names (owner decision, September 22, 2026).
   */
  async readInput(sessionToken: string | undefined, operationId: string, grant: string): Promise<ImmichFileResponse> {
    const { worker, session } = await this.authenticate(sessionToken);

    const operation = (await this.repository.getClaimedByWorker(operationId, worker.id)) as unknown as
      MediaOperation | undefined;
    if (!operation?.claimToken) {
      throw new NotFoundException('Media operation not found');
    }

    const decision = verifyInputGrant(grant, {
      operationId: operation.id,
      binding: { claimToken: operation.claimToken, sessionTokenHash: session.token },
      now: new Date(),
    });
    if (!decision.valid) {
      throw new ForbiddenException('Input grant invalid');
    }

    const path = decision.payload.token
      ? await this.studioInputPath(operation, worker.id, session.id, decision.payload)
      : await this.assetInputPath(operation, session.id, decision.payload);

    return new ImmichFileResponse({
      path,
      contentType: mimeTypes.lookup(path),
      cacheControl: CacheControl.PrivateWithoutCache,
    });
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Resolve what an operation may read, as its owner, right now.
   *
   * Studio kinds go through FL-90: the graph in the immutable snapshot is re-resolved against the
   * owner's current access and the result must be complete. Single-asset workloads (restoration,
   * quick edit) have one source: the operation's asset, re-checked for owner access. Both run as a
   * background task for the owner, so Locked, sensitive and hidden sources the job names resolve
   * like any other: the owner chose them when they submitted the job, and a renderer that cannot
   * read them would silently produce the wrong output. User-facing exposure is unchanged; only
   * the worker, under this claim, reads them.
   */
  private async resolveManifest(operation: MediaOperation, workerSessionId: string): Promise<ResolvedManifest> {
    const studio = studioContextOf(operation);

    if (studio) {
      const destination = operation.destination;
      if (!isStudioDestination(destination)) {
        return { complete: false, refused: [{ key: 'destination', reason: 'unknown-destination' }] };
      }

      const auth = await this.ownerAuth(operation.ownerId, workerSessionId);
      if (!auth) {
        return { complete: false, refused: [{ key: 'owner', reason: 'owner-unavailable' }] };
      }

      const source = await this.studioGraphOf(operation, studio);
      if (!source.ok) {
        return { complete: false, refused: [source.refused] };
      }

      let resolution;
      try {
        resolution = await this.studioResources.resolveProjectResources(auth, {
          projectId: operation.projectId!,
          ownerId: source.projectOwnerId,
          revision: studio.revision,
          graph: source.graph,
          imports: Array.isArray(studio.imports) ? (studio.imports as never) : undefined,
          generated: Array.isArray(studio.generated) ? (studio.generated as never) : undefined,
          catalog: (studio.catalog as never) || undefined,
          destination: destination as StudioDestination,
          cloudConsent: studio.cloudConsent === true,
          backgroundRunner: true,
        });
      } catch (error: Error | any) {
        // Consent missing, graph oversized, destination unknown: FL-90 refuses to enumerate at all.
        return { complete: false, refused: [{ key: 'graph', reason: String(error?.message ?? error) }] };
      }

      if (!resolution.manifest.complete) {
        return {
          complete: false,
          refused: resolution.refused.map((item) => ({ key: item.key, reason: item.reason })),
        };
      }

      return {
        complete: true,
        studio: resolution.manifest,
        manifest: {
          operationId: operation.id,
          revisionId: operation.revisionId,
          inputs: resolution.manifest.entries
            .filter((entry) => entry.grant === 'render' && entry.path)
            .map((entry) => ({
              inputId: entry.key,
              kind: entry.kind,
              resourceId: entry.id,
              checksum: entry.checksum,
              token: null,
            })),
        },
      };
    }

    const inputs: AuthorizedManifest['inputs'] = [];
    if (operation.assetId) {
      // Elevated: a Locked source is still the owner's source. No hidden-content filter either.
      const allowed = await this.accessRepository.asset.checkOwnerAccess(
        operation.ownerId,
        new Set([operation.assetId]),
        true,
      );
      if (allowed.has(operation.assetId)) {
        inputs.push({
          inputId: 'source',
          kind: 'library-asset',
          resourceId: operation.assetId,
          checksum: null,
          token: null,
        });
      }
    }

    return {
      complete: true,
      studio: null,
      manifest: { operationId: operation.id, revisionId: operation.revisionId, inputs },
    };
  }

  /** Turn FL-90's worker-bound read grants into the inputs a claim hands out. */
  private studioInputs(
    operation: MediaOperation,
    manifest: StudioAuthorizedManifest,
    workerId: string,
    now: Date,
  ): AuthorizedManifest {
    const grants = this.studioResources.issueReadGrants(manifest, {
      workerId,
      ttlSeconds: Math.floor(INPUT_GRANT_TTL_MS / 1000),
      now,
    });
    const checksums = new Map(manifest.entries.map((entry) => [entry.key, entry.checksum]));

    return {
      operationId: operation.id,
      revisionId: operation.revisionId,
      inputs: grants.map((grant) => ({
        inputId: grant.key,
        kind: grant.kind,
        resourceId: grant.id,
        checksum: checksums.get(grant.key) ?? null,
        token: grant.token,
      })),
    };
  }

  /**
   * Redeem a Studio input: FL-90 verifies its own grant as the operation owner — signature, expiry,
   * worker binding, live access and checksum — and the manifest is resolved again to find the path
   * for resources FL-90 reports by reference only.
   */
  private async studioInputPath(
    operation: MediaOperation,
    workerId: string,
    workerSessionId: string,
    payload: { inputId: string; resourceId: string; token: string | null },
  ): Promise<string> {
    const auth = await this.ownerAuth(operation.ownerId, workerSessionId);
    if (!auth) {
      throw new NotFoundException('Input not available');
    }

    const verification = await this.studioResources.verifyReadGrant(payload.token!, {
      workerId,
      auth,
      backgroundRunner: true,
    });
    if (!verification.valid) {
      this.logger.warn(`Input grant refused on media operation ${operation.id}: ${verification.reason}`);
      throw new ForbiddenException('Input grant invalid');
    }

    const { grant } = verification;
    if (
      grant.scope !== 'render' ||
      grant.projectId !== operation.projectId ||
      grant.key !== payload.inputId ||
      grant.id !== payload.resourceId
    ) {
      throw new ForbiddenException('Input grant invalid');
    }

    if (verification.path) {
      return verification.path;
    }

    // Project-owned and deployment-owned files: FL-90 bound their access at resolve time; the path
    // comes from a fresh resolution so a re-declared or removed resource is not served from memory.
    const resolved = await this.resolveManifest(operation, workerSessionId);
    const entry = resolved.complete
      ? resolved.studio?.entries.find((candidate) => candidate.key === payload.inputId && candidate.grant === 'render')
      : undefined;
    if (!entry?.path) {
      throw new NotFoundException('Input not available');
    }

    return entry.path;
  }

  /** Redeem a single-asset input: the owner must still be able to read the asset, and own it. */
  private async assetInputPath(
    operation: MediaOperation,
    workerSessionId: string,
    payload: { inputId: string; resourceId: string },
  ): Promise<string> {
    const resolved = await this.resolveManifest(operation, workerSessionId);
    const input = resolved.complete
      ? resolved.manifest.inputs.find(
          (candidate) => candidate.inputId === payload.inputId && candidate.resourceId === payload.resourceId,
        )
      : undefined;
    if (!input) {
      throw new ForbiddenException('Input grant invalid');
    }

    const asset = await this.assetRepository.getById(input.resourceId);
    if (!asset || asset.deletedAt || asset.ownerId !== operation.ownerId) {
      throw new NotFoundException('Input not available');
    }

    return asset.originalPath;
  }

  /**
   * The operation owner as an `AuthDto`, for FL-90's resolver and verifier. The acting session is
   * the worker's, carried as an elevated session and with no hidden-content filter, so the access
   * checks include the owner's Locked, sensitive and hidden assets: a background task reads every
   * asset the owner's job names (owner decision, September 22, 2026). No shared link, so FL-90's
   * shared-link refusal never applies, and a deleted owner resolves to nothing.
   */
  private async ownerAuth(ownerId: string, workerSessionId: string): Promise<AuthDto | null> {
    const user = await this.userRepository.get(ownerId, {});
    if (!user) {
      return null;
    }

    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        isAdmin: user.isAdmin,
        quotaSizeInBytes: user.quotaSizeInBytes,
        quotaUsageInBytes: user.quotaUsageInBytes,
      },
      session: { id: workerSessionId, hasElevatedPermission: true },
    };
  }

  /**
   * The graph a Studio operation renders.
   *
   * A job that carries its graph renders that graph. A stored-revision job (FL-89) reads it from
   * project storage at the snapshot's revision, which is immutable once written, and only while
   * the operation's account may still read the project: its owner, or a member of the shared
   * space it is reviewed in (the live `album_user` row, re-read every time). A deleted project,
   * a missing revision or lost project access refuses the job rather than rendering something
   * nobody may be shown. Project-scoped resources belong to the project owner as stored, never to
   * a value the job claims.
   */
  private async studioGraphOf(operation: MediaOperation, studio: StudioSnapshotContext): Promise<StudioGraphSource> {
    if (studio.stored !== true) {
      return { ok: true, graph: studio.graph, projectOwnerId: operation.ownerId };
    }

    const project = await this.studioProjects.getById(operation.projectId!);
    if (!project) {
      return { ok: false, refused: { key: 'project', reason: 'project-missing' } };
    }
    if (project.deletedAt) {
      // Nothing is rendered from a project its owner has thrown away (FL-91, FL-106).
      return { ok: false, refused: { key: 'project', reason: 'project-trashed' } };
    }

    if (project.ownerId !== operation.ownerId && !(await this.isSpaceMember(operation.ownerId, project.spaceId))) {
      return { ok: false, refused: { key: 'project', reason: 'no-access' } };
    }

    const revision = await this.studioProjects.getRevision(project.id, studio.revision);
    const graph = revision ? asObject(revision.envelope).graph : undefined;
    if (graph === undefined) {
      return { ok: false, refused: { key: 'revision', reason: 'revision-missing' } };
    }

    return { ok: true, graph, projectOwnerId: project.ownerId };
  }

  private async isSpaceMember(userId: string, spaceId: string | null): Promise<boolean> {
    if (!spaceId) {
      return false;
    }
    const ids = new Set([spaceId]);
    const [owned, shared] = await Promise.all([
      this.accessRepository.album.checkOwnerAccess(userId, ids),
      this.accessRepository.album.checkSharedAlbumAccess(userId, ids, AlbumUserRole.Viewer),
    ]);
    return owned.has(spaceId) || shared.has(spaceId);
  }

  private grantInputs(
    manifest: AuthorizedManifest,
    binding: { claimToken: string; sessionTokenHash: Buffer; now: Date },
  ): RenderWorkerClaimDto['inputs'] {
    const expiresAt = binding.now.getTime() + INPUT_GRANT_TTL_MS;

    return manifest.inputs.map((input) => {
      const grant = signInputGrant(
        {
          operationId: manifest.operationId,
          inputId: input.inputId,
          resourceId: input.resourceId,
          token: input.token,
          expiresAt,
        },
        { claimToken: binding.claimToken, sessionTokenHash: binding.sessionTokenHash },
      );

      return {
        inputId: input.inputId,
        kind: input.kind,
        resourceId: input.resourceId,
        checksum: input.checksum,
        url: `/api/render-workers/operations/${manifest.operationId}/inputs/${grant}`,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    });
  }

  /**
   * Enforce the wall-clock and output ceilings on a claimed operation. A breach fails the job under
   * its own claim and audits it; the returned reason is what the worker is told.
   *
   * Both ceilings are per attempt. The clock runs from `attemptStartedAt`, which every claim
   * resets, and `outputBytes` is reset by the claim too, so the automatic retry an operation gets
   * after a failure is not charged for the attempt that failed. `startedAt` is only the fallback
   * for a row claimed before the column existed.
   */
  private async enforceRunningLimits(
    workerId: string,
    operation: MediaOperation,
    reportedOutputBytes: string | undefined,
  ): Promise<RenderWorkerRefusalReason | null> {
    const [worker, instanceLimit, userLimit] = await Promise.all([
      this.repository.getWorker(workerId),
      this.repository.getLimit(RENDER_WORKER_LIMIT_INSTANCE_SUBJECT),
      this.repository.getLimit(operation.ownerId),
    ]);

    const limits = tightestLimits(
      worker ? limitsOf(worker) : null,
      instanceLimit ? limitsOf(instanceLimit) : DEFAULT_INSTANCE_LIMITS,
      userLimit ? limitsOf(userLimit) : null,
    );

    const outputBytes = Math.max(Number(operation.outputBytes ?? 0), Number(reportedOutputBytes ?? 0));
    const attemptStartedAt = operation.attemptStartedAt ?? operation.startedAt;
    const decision = evaluateRunningLimits({
      startedAt: attemptStartedAt ? new Date(attemptStartedAt) : null,
      outputBytes,
      limits,
      now: new Date(),
    });
    if (decision.admitted) {
      return null;
    }

    await this.operations.fail(operation.id, operation.claimToken!, {
      error: `Stopped by the server: ${decision.reason}`,
      errorCode: decision.reason,
    });
    await this.repository.recordAudit({
      workerId,
      event: RenderWorkerAuditEvent.LimitExceeded,
      reason: decision.reason,
      operationId: operation.id,
      detail: {
        attempt: operation.attempt,
        outputBytes: String(outputBytes),
        maxOutputBytes: limits.maxOutputBytes,
        maxWallClockMs: limits.maxWallClockMs,
      },
    });
    this.logger.warn(`Media operation ${operation.id} stopped on worker ${workerId}: ${decision.reason}`);

    return decision.reason;
  }

  /**
   * The operation a worker may write to: the id it names, under the claim token it presents, held
   * by the worker its session belongs to. Anything else — another worker's token, a lapsed claim, a
   * finished job — is "not found", the same answer as a job that never existed.
   */
  private async requireClaimed(workerId: string, operationId: string, claimToken: string): Promise<MediaOperation> {
    const operation = await this.repository.getClaimed(operationId, workerId, claimToken);
    if (!operation) {
      throw new NotFoundException('Media operation not found');
    }

    return operation as unknown as MediaOperation;
  }

  private async findWorker(id: string): Promise<RenderWorker> {
    const worker = await this.repository.getWorker(id);
    if (!worker) {
      throw new NotFoundException('Render worker not found');
    }

    return worker;
  }
}
