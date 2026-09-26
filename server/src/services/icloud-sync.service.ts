import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { IEntityJob } from 'src/types.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import {
  ICloudAuthDto,
  ICloudConnectionCreateDto,
  ICloudConnectionResponseDto,
  ICloudConnectionUpdateDto,
  ICloudConnectionsResponseDto,
  ICloudControlDto,
  ICloudInventoryResponseDto,
} from 'src/dtos/icloud-sync.dto.js';
import {
  AssetType,
  ImmichWorker,
  JobName,
  JobStatus,
  MediaOperationKind,
  MediaOperationStatus,
  NotificationLevel,
  Permission,
  QueueName,
} from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { CronRepository } from 'src/repositories/cron.repository.js';
import {
  ICloudConnection,
  ICloudLibrary,
  ICloudResource,
  ICloudRunTrigger,
  ICloudSyncRepository,
} from 'src/repositories/icloud-sync.repository.js';
import {
  ICloudPage,
  ICloudTransportError,
  ICloudTransportRepository,
} from 'src/repositories/icloud-transport.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  MediaOperation,
  MediaOperationRepository,
  type MediaOperationWriteState,
} from 'src/repositories/media-operation.repository.js';
import { ICloudAlbumService } from 'src/services/icloud-album.service.js';
import { ICloudMetadataService } from 'src/services/icloud-metadata.service.js';
import { ICloudRelationsService } from 'src/services/icloud-relations.service.js';
import { ICloudStagingService } from 'src/services/icloud-staging.service.js';
import { MediaRecoveryService } from 'src/services/media-recovery.service.js';
import { checkAccess, requireElevatedPermission } from 'src/utils/access.js';
import { isActiveMediaOperation } from 'src/utils/media-operation.js';

/** How often an idle worker looks for queued runs. A control also nudges it through the job queue. */
const ICLOUD_TICK_MS = 15_000;
/** The claim on a run. Renewed after every step and by a heartbeat while a long transfer runs. */
export const ICLOUD_LEASE_MS = 10 * 60_000;
const ICLOUD_HEARTBEAT_MS = 60_000;
/** How long a run that is only waiting for backed-off items or staging space hands itself back for. */
export const ICLOUD_IDLE_WAIT_MS = 5 * 60_000;
/** The longest a run waits for the provider before its claim is taken again. */
const ICLOUD_MAX_WAIT_MS = 24 * 60 * 60_000;
/**
 * Idle waits in a row before a run that cannot move is reported (a day of five-minute waits): the
 * staging budget stays full, or every remaining item is stuck on its own back-off. Any step that
 * makes progress starts the count again.
 */
export const ICLOUD_MAX_IDLE_WAITS = 288;
/** How long a run waits while its owner is signing in again, without spending an attempt. */
export const ICLOUD_SIGN_IN_WAIT_MS = 30_000;
/** Runs one worker process drives at once, so one large first import does not hold up the rest. */
const ICLOUD_PARALLEL_RUNS = 2;
/** Connections one account may keep, matching the design's Add connection limit. */
export const ICLOUD_MAX_CONNECTIONS = 20;

/** Resource statuses still owed work. Everything else is settled, one way or another. */
const OPEN_RESOURCE_STATUSES = ['pending', 'retry', 'staging', 'validated', 'promoted', 'committed'];
const AWAITING_AUTH_STATES = new Set(['awaiting-2fa', 'awaiting-device-approval', 'reauthentication-required']);
/** Failures that are the account's to fix; the connection has already told its owner about them. */
const SIGN_IN_CODES = new Set([
  'two_factor_required',
  'device_approval_required',
  'reauthentication_required',
  'icloud_authenticating',
  'icloud_sign_in_required',
  'icloud_disconnected',
]);

type StepOutcome = 'more' | 'idle' | 'done';
type Claim = { operation: MediaOperation; claimToken: string };

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const asIso = (value: unknown): string | null => {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value as string);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const failureCode = (error: unknown) =>
  error instanceof ICloudTransportError ? error.code : 'icloud_operation_failed';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The stable code for a connection that cannot run, translated by the client. */
export const connectionStateCode = (connection: Pick<ICloudConnection, 'state' | 'lastError'>, fallback?: string) => {
  switch (connection.state) {
    case 'awaiting-2fa': {
      return 'two_factor_required';
    }
    case 'awaiting-device-approval': {
      return 'device_approval_required';
    }
    case 'reauthentication-required': {
      return 'reauthentication_required';
    }
    case 'authenticating': {
      return 'icloud_authenticating';
    }
    case 'disconnected': {
      return 'icloud_disconnected';
    }
    case 'paused': {
      return 'icloud_sign_in_required';
    }
    default: {
      return connection.lastError ?? fallback ?? 'icloud_operation_failed';
    }
  }
};

/** A run as the connection page shows it. The same row is what Activity shows. */
export const mapICloudRun = (operation: MediaOperation) => {
  const status = operation.status as MediaOperationStatus;
  // One rule with Activity: a delayed queued run that has spent its automatic retry is retrying;
  // one that has not failed is waiting out the provider or its items' back-off.
  const queuedWithDelay = status === MediaOperationStatus.Queued && !!operation.retryAt;
  const retried = (operation.autoRetries ?? 0) > 0;
  return {
    id: operation.id,
    status,
    progress: Number(operation.progress ?? 0),
    processedUnits: Number(operation.processedUnits ?? 0),
    totalUnits:
      operation.totalUnits === null || operation.totalUnits === undefined ? null : Number(operation.totalUnits),
    retrying: queuedWithDelay && retried,
    waiting: queuedWithDelay && !retried,
    pauseRequested: !!operation.pauseRequestedAt && status !== MediaOperationStatus.Paused,
    errorCode: operation.errorCode,
    startedAt: asIso(operation.startedAt),
    finishedAt: asIso(operation.finishedAt),
    createdAt: asIso(operation.createdAt) ?? new Date(0).toISOString(),
  };
};

/**
 * iCloud Photos connections and their runs (FL-68).
 *
 * A connection holds the owner's choices and an encrypted Apple session that is written and never
 * read back out. A run is a durable media operation (`icloud_sync`): the same row Activity and the
 * notifications panel show, with the same lease, pause, cancel and one automatic retry every
 * background operation gets. The connection's own tables are the run's checkpoints — inventory
 * cursors, leased resources and staged files — so any claim of the run carries on where the last
 * one stopped, and a repeated step never imports an item twice.
 *
 * Reconciliation never overwrites an original or deletes local media: an item deleted in iCloud
 * stays here and is listed for review, a copy is only repaired onto a new file, and a hidden iCloud
 * item arrives Locked through a lock record.
 */
@Injectable()
export class ICloudSyncService {
  private tickHandle?: ReturnType<typeof setInterval>;
  private readonly lanes = new Set<Promise<void>>();
  private stopping = false;
  private readonly workerId = `icloud-${randomUUID()}`;

  constructor(
    private repository: ICloudSyncRepository,
    private transport: ICloudTransportRepository,
    private staging: ICloudStagingService,
    private recovery: MediaRecoveryService,
    private jobs: JobRepository,
    private cron: CronRepository,
    private albums: ICloudAlbumService,
    private relations: ICloudRelationsService,
    private access: AccessRepository,
    private metadata: ICloudMetadataService,
    private operations: MediaOperationRepository,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(ICloudSyncService.name);
  }

  private async owned(auth: AuthDto, id: string): Promise<ICloudConnection> {
    if (!auth.session || auth.sharedLink || auth.apiKey) {
      throw new ForbiddenException('A signed-in web session is required');
    }
    const connection = await this.repository.get(id, auth.user.id);
    if (!connection) {
      throw new NotFoundException();
    }
    return connection;
  }

  private async response(connection: ICloudConnection): Promise<ICloudConnectionResponseDto> {
    const run = await this.repository.latestOperation(connection.id, connection.ownerId);
    return {
      id: connection.id,
      label: connection.label,
      state: connection.state,
      authenticated: !!connection.encryptedSession,
      config: connection.config,
      lastError: connection.lastError,
      nextRunAt: this.nextRunAt(connection, run),
      counts: {
        ...(await this.repository.counts(connection.id)),
        awaiting_auth: AWAITING_AUTH_STATES.has(connection.state) ? 1 : 0,
      },
      run: run ? mapICloudRun(run) : null,
    };
  }

  /** When the schedule will queue the next run, by the same rule `dueConnections` applies. */
  private nextRunAt(connection: ICloudConnection, run: MediaOperation | undefined): string | null {
    if (connection.state !== 'connected' || !connection.encryptedSession) {
      return null;
    }
    if (run && isActiveMediaOperation(run.status as MediaOperationStatus)) {
      return null;
    }
    const backoff = connection.nextRunAt ? new Date(connection.nextRunAt).getTime() : 0;
    const last = run ? new Date((run.finishedAt ?? run.createdAt) as unknown as string).getTime() : 0;
    const interval = run ? last + connection.config.intervalHours * 3_600_000 : 0;
    return new Date(Math.max(backoff, interval, Date.now())).toISOString();
  }

  async list(auth: AuthDto): Promise<ICloudConnectionsResponseDto> {
    if (!auth.session) {
      throw new ForbiddenException();
    }
    const connections = await this.repository.list(auth.user.id);
    return {
      enabled: this.transport.enabled(),
      connections: await Promise.all(connections.map((row) => this.response(row))),
    };
  }

  async create(auth: AuthDto, dto: ICloudConnectionCreateDto): Promise<ICloudConnectionResponseDto> {
    if (!auth.session) {
      throw new ForbiddenException();
    }
    if (!this.transport.enabled()) {
      throw new BadRequestException('icloud_disabled');
    }
    await this.staging.root();
    this.checkLimits(dto.config);
    if (dto.config.includeHidden) {
      requireElevatedPermission(auth);
    }
    const created = await this.repository.create(auth.user.id, dto.label, dto.config, ICLOUD_MAX_CONNECTIONS);
    if (!created) {
      throw new BadRequestException('icloud_connection_limit');
    }
    return this.response(created);
  }

  private checkLimits(config: ICloudConnection['config']) {
    const limit = Number(process.env.IMMICH_ICLOUD_MAX_STAGING_BYTES ?? 100 * 1024 ** 3);
    const concurrency = Number(process.env.IMMICH_ICLOUD_MAX_CONCURRENCY ?? 4);
    if (
      !Number.isSafeInteger(limit) ||
      limit < config.stagingBytes ||
      !Number.isSafeInteger(concurrency) ||
      concurrency < config.concurrency
    ) {
      throw new BadRequestException('icloud_admin_limit_exceeded');
    }
  }

  async update(auth: AuthDto, id: string, dto: ICloudConnectionUpdateDto): Promise<ICloudConnectionResponseDto> {
    const connection = await this.owned(auth, id);
    const config = dto.config ? { ...connection.config, ...dto.config } : undefined;
    if (config) {
      if (config.includeHidden) {
        requireElevatedPermission(auth);
      }
      this.checkLimits(config);
    }
    await this.repository.update(id, auth.user.id, { ...dto, config });
    return this.response((await this.repository.get(id, auth.user.id))!);
  }

  /**
   * One explicit sign-in step: password, verification code, device approval or a session check.
   *
   * The Apple ID, password and code are used for this request only. The provider's session is
   * encrypted before it is stored and is never returned, logged or put into an error; the answer
   * is the connection's state, so the client knows which step to ask for next.
   */
  async authenticate(
    auth: AuthDto,
    id: string,
    dto: ICloudAuthDto,
    secure: boolean,
  ): Promise<ICloudConnectionResponseDto> {
    await this.owned(auth, id);
    if (!secure) {
      throw new BadRequestException('icloud_requires_https');
    }
    if (!(await this.repository.admitAuth(id, auth.user.id))) {
      throw new BadRequestException('icloud_auth_rate_limited');
    }
    await this.repository.update(id, auth.user.id, { state: 'authenticating', lastError: null });
    try {
      await this.repository.withSession(id, auth.user.id, async (connection) => {
        const session =
          dto.action === 'login' ? undefined : await this.transport.decodeSession(id, connection.encryptedSession);
        const result = await this.transport.authenticate(dto, session);
        return {
          value: undefined,
          state: result.state,
          encryptedSession: await this.transport.encodeSession(id, result.session),
        };
      });
      await this.repository.update(id, auth.user.id, { lastError: null, nextRunAt: null });
      const connection = await this.repository.get(id, auth.user.id);
      if (connection?.state === 'connected') {
        // Signing in is the owner asking for a sync; an unfinished run simply carries on.
        await this.queue(connection, 'authenticated').catch((error) =>
          this.logger.warn(`iCloud connection ${id}: run not queued after sign-in: ${message(error)}`),
        );
      }
    } catch (error) {
      await this.failure(id, auth.user.id, error);
    }
    return this.response((await this.repository.get(id, auth.user.id))!);
  }

  /**
   * The connection page's run controls. Each acts on the connection's one unfinished run, which is
   * the same durable operation Activity pauses, resumes and cancels; the answer is what its row says.
   */
  async control(auth: AuthDto, id: string, dto: ICloudControlDto): Promise<ICloudConnectionResponseDto> {
    const connection = await this.owned(auth, id);
    const active = await this.repository.latestOperation(id, auth.user.id, { activeOnly: true });
    switch (dto.action) {
      case 'pause': {
        if (!active) {
          throw new BadRequestException('icloud_no_active_run');
        }
        if (active.status !== MediaOperationStatus.Paused) {
          const paused = await this.operations.requestPause(active.id, auth.user.id, [MediaOperationKind.ICloudSync]);
          if (!paused) {
            throw new BadRequestException('icloud_run_not_pausable');
          }
        }
        break;
      }
      case 'resume': {
        if (active) {
          if (active.status === MediaOperationStatus.Paused || active.pauseRequestedAt) {
            await this.operations.resume(active.id, auth.user.id);
            this.nudge(id);
          }
        } else {
          // A connection the first release's Pause control left `paused`, session intact.
          await this.queue(connection, 'manual');
        }
        break;
      }
      case 'cancel': {
        if (!active) {
          throw new BadRequestException('icloud_no_active_run');
        }
        const cancelled = await this.operations.requestCancel(active.id, auth.user.id);
        if (cancelled?.status === MediaOperationStatus.Cancelled) {
          await this.repository.endRun(id, 'cancelled');
        }
        break;
      }
      case 'run': {
        await this.queue(connection, 'manual');
        break;
      }
      case 'retry': {
        const latest = await this.repository.latestOperation(id, auth.user.id);
        const retryOfId =
          latest && [MediaOperationStatus.Failed, MediaOperationStatus.Cancelled].includes(latest.status)
            ? latest.id
            : null;
        await this.queue(connection, 'retry', retryOfId);
        break;
      }
      case 'rescan': {
        await this.queue(connection, 'rescan');
        break;
      }
    }
    return this.response((await this.repository.get(id, auth.user.id))!);
  }

  /** Queue a run through the one locked path, turning a refusal into a stable code for the client. */
  private async queue(connection: ICloudConnection, trigger: ICloudRunTrigger, retryOfId: string | null = null) {
    const queued = await this.repository.queueOperation(connection.id, connection.ownerId, { trigger, retryOfId });
    switch (queued.outcome) {
      case 'created':
      case 'existing': {
        this.nudge(connection.id);
        return queued.operation;
      }
      case 'busy': {
        throw new BadRequestException('icloud_run_active');
      }
      case 'not-ready': {
        throw new BadRequestException('icloud_sign_in_required');
      }
      case 'not-due': {
        return;
      }
      default: {
        throw new NotFoundException();
      }
    }
  }

  /** Wake a worker now instead of at its next tick. Losing the nudge only costs the tick delay. */
  private nudge(id: string) {
    void this.jobs.queue({ name: JobName.ICloudSync, data: { id } }).catch(() => {});
  }

  /**
   * Disconnect: stop the run, forget the Apple session and stop scheduling. Imported photos stay.
   */
  async disconnect(auth: AuthDto, id: string): Promise<void> {
    await this.owned(auth, id);
    // Disconnected first, under the connection's lock: `queueOperation` takes the same lock and
    // refuses a disconnected connection, so no run can be queued after this. The run read next is
    // then the last one there will be.
    await this.repository.disconnect(id, auth.user.id);
    const active = await this.repository.latestOperation(id, auth.user.id, { activeOnly: true });
    if (active) {
      const cancelled = await this.operations.requestCancel(active.id, auth.user.id);
      if (cancelled?.status === MediaOperationStatus.Cancelled) {
        await this.repository.endRun(id, 'cancelled');
      }
    }
  }

  /**
   * Remove a disconnected connection and everything it recorded about the source. Photos it
   * imported are ordinary assets in the owner's library and are not touched.
   */
  async remove(auth: AuthDto, id: string): Promise<void> {
    await this.owned(auth, id);
    const result = await this.repository.remove(id, auth.user.id, async (resources: ICloudResource[]) => {
      for (const resource of resources) {
        await this.staging.cleanup(resource);
      }
    });
    switch (result) {
      case 'removed': {
        return;
      }
      case 'still-connected': {
        throw new BadRequestException('icloud_disconnect_first');
      }
      case 'busy': {
        throw new BadRequestException('icloud_run_active');
      }
      case 'in-flight': {
        throw new BadRequestException('icloud_remove_in_flight');
      }
      default: {
        throw new NotFoundException();
      }
    }
  }

  async inventory(auth: AuthDto, id: string): Promise<ICloudInventoryResponseDto> {
    await this.owned(auth, id);
    const inventory = await this.repository.inventory(id);
    const receipts = await this.repository.receipts(id, auth.user.id);
    const allowed = await checkAccess(this.access, {
      auth,
      permission: Permission.AssetRead,
      ids: receipts.map(({ assetId }) => assetId),
    });
    const review = await this.repository.reviewItems(id, auth.user.id, auth.session?.hasElevatedPermission === true);
    return {
      libraries: inventory.libraries.map(({ id, fields }) => ({
        id,
        name: fields.zoneID.zoneName,
        area: fields.area === 'shared' ? ('shared' as const) : ('private' as const),
        supported: true,
      })),
      albums: inventory.albums,
      recent: receipts.filter(({ assetId }) => allowed.has(assetId)),
      review,
      complete: !!(await this.repository.checkpoint(id, 'inventory-complete').then((result) => result?.complete)),
    };
  }

  /* ------------------------------------------------------------------ */
  /* Schedule and worker                                                 */
  /* ------------------------------------------------------------------ */

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  async onBootstrap(): Promise<void> {
    this.stopping = false;
    // The worker runs even when the connector is switched off, so a queued run ends honestly.
    this.tickHandle ??= setInterval(() => this.tick(), ICLOUD_TICK_MS);
    if (this.transport.enabled()) {
      await this.schedule().catch((error) => this.logger.warn(`iCloud schedule failed: ${message(error)}`));
      this.cron.create({
        name: 'icloud-sync',
        expression: '*/5 * * * *',
        onTick: () => {
          void this.schedule().catch(() => {});
        },
      });
    }
    this.tick();
  }

  /** Stop taking runs. A run in hand keeps its claim; when the lease lapses the next worker resumes it. */
  @OnEvent({ name: 'AppShutdown' })
  async onShutdown(): Promise<void> {
    this.stopping = true;
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = undefined;
    }
    await Promise.allSettled(this.lanes);
  }

  private async schedule(): Promise<void> {
    for (const { id, ownerId } of await this.repository.dueConnections()) {
      await this.repository.queueOperation(id, ownerId, { trigger: 'schedule' });
    }
    this.tick();
  }

  /** The job queue only nudges the worker now; the run itself is the durable media operation. */
  @OnJob({ name: JobName.ICloudSync, queue: QueueName.BackgroundTask })
  handleSync(): Promise<JobStatus> {
    this.tick();
    return Promise.resolve(JobStatus.Success);
  }

  /** Keep up to `ICLOUD_PARALLEL_RUNS` lanes draining the queue. Never overlaps itself beyond that. */
  tick(): void {
    while (!this.stopping && this.lanes.size < ICLOUD_PARALLEL_RUNS) {
      const lane: Promise<void> = this.drain()
        .catch((error) => this.logger.warn(`iCloud sync worker failed: ${message(error)}`))
        .finally(() => {
          this.lanes.delete(lane);
        });
      this.lanes.add(lane);
    }
  }

  /**
   * Claim and drive runs until none is waiting. Lapsed claims are not recovered here: the one media
   * operation sweep returns them to the queue, or gives them their automatic retry, for every kind.
   */
  async drain(): Promise<void> {
    while (!this.stopping) {
      const claim = await this.operations.claimNext({
        kinds: [MediaOperationKind.ICloudSync],
        workerId: this.workerId,
        leaseMs: ICLOUD_LEASE_MS,
      });
      if (!claim) {
        return;
      }
      try {
        await this.run(claim.operation, claim.claimToken);
      } catch (error) {
        this.logger.error(`iCloud sync run ${claim.operation.id} failed: ${message(error)}`);
        await this.fail(claim, 'icloud_operation_failed');
      }
    }
  }

  /**
   * Drive one claimed run: a step at a time — one inventory page, a few transfers, a reconciliation
   * batch — recording real counts after each, until the connection has nothing left to do.
   *
   * Between steps the row decides: a cancel ends the run, a pause hands it back, a lost claim stops
   * this worker writing. A provider back-off or items waiting on their own back-off hand the run
   * back with a delay, without spending an attempt. A failure goes through the one automatic retry
   * every operation gets; on that retry a connection stopped by an operational error is opened again
   * once, so the retry is a real second attempt. A connection that needs its account (a new code,
   * device approval, a password) fails the run with that reason; the connection has told its owner.
   */
  async run(operation: MediaOperation, claimToken: string): Promise<void> {
    const claim: Claim = { operation, claimToken };
    const { id, ownerId } = operation;
    const snapshot = asObject(operation.snapshot);
    const recordedIdle = Number(asObject(operation.result).idleWaits ?? 0);
    let idleWaits = Number.isSafeInteger(recordedIdle) && recordedIdle > 0 ? recordedIdle : 0;
    const connectionId = typeof snapshot.connectionId === 'string' ? snapshot.connectionId : undefined;
    if (!connectionId) {
      await this.fail(claim, 'icloud_snapshot_invalid');
      return;
    }

    let connection = await this.repository.get(connectionId, ownerId);
    if (!connection || connection.lastError === 'owner_removed') {
      await this.fail(claim, 'icloud_connection_unavailable');
      return;
    }
    if (!this.transport.enabled()) {
      await this.settle(claim, connectionId, 'icloud_disabled');
      return;
    }
    if (connection.state === 'authenticating') {
      // The owner is signing in again right now; the answer decides, not this claim.
      await this.wait(claim, connectionId, ICLOUD_SIGN_IN_WAIT_MS, idleWaits);
      return;
    }
    if (connection.state === 'error' && (operation.autoRetries ?? 0) > 0 && connection.encryptedSession) {
      await this.repository.update(connectionId, ownerId, { state: 'connected', lastError: null });
      connection = (await this.repository.get(connectionId, ownerId)) ?? connection;
    }
    if (connection.state !== 'connected') {
      await this.settle(claim, connectionId, connectionStateCode(connection));
      return;
    }

    const started = await this.operations.reportProgress(id, claimToken, {
      status: MediaOperationStatus.Rendering,
      processedUnits: Number(operation.processedUnits ?? 0),
      totalUnits:
        operation.totalUnits === null || operation.totalUnits === undefined ? null : Number(operation.totalUnits),
      progress: Number(operation.progress ?? 0),
    });
    if (!started) {
      // Cancelled between the claim and here, or the claim is already gone.
      await this.acknowledgeCancel(claim, connectionId);
      return;
    }

    await this.repository.startRun(connection);
    const heartbeat = setInterval(() => {
      void this.operations.heartbeat(id, claimToken, ICLOUD_LEASE_MS).catch(() => {});
    }, ICLOUD_HEARTBEAT_MS);
    try {
      for (;;) {
        if (this.stopping) {
          // Keep the claim; the lease lapsing hands the run to the next worker at these checkpoints.
          return;
        }
        const current = await this.repository.get(connectionId, ownerId);
        if (current?.state === 'authenticating') {
          await this.wait(claim, connectionId, ICLOUD_SIGN_IN_WAIT_MS, idleWaits);
          return;
        }
        if (!current || current.state !== 'connected') {
          await this.settle(
            claim,
            connectionId,
            current ? connectionStateCode(current) : 'icloud_connection_unavailable',
          );
          return;
        }

        let outcome: StepOutcome;
        try {
          outcome = await this.step(current);
        } catch (error) {
          const code = failureCode(error);
          await this.failure(connectionId, ownerId, error);
          const after = await this.repository.get(connectionId, ownerId);
          if (after?.state === 'connected') {
            // A rate limit, a timeout or a reset change token: wait out the connection's back-off.
            const until = after.nextRunAt ? new Date(after.nextRunAt).getTime() - Date.now() : ICLOUD_IDLE_WAIT_MS;
            await this.wait(claim, connectionId, until, idleWaits);
            return;
          }
          await this.settle(claim, connectionId, after ? connectionStateCode(after, code) : code);
          return;
        }

        if (outcome === 'idle') {
          idleWaits += 1;
          if (idleWaits > ICLOUD_MAX_IDLE_WAITS) {
            await this.settle(claim, connectionId, 'icloud_sync_stalled');
            return;
          }
          await this.wait(claim, connectionId, ICLOUD_IDLE_WAIT_MS, idleWaits);
          return;
        }

        idleWaits = 0;
        const written = await this.record(claim, connectionId, outcome === 'done' ? 'complete' : 'syncing', 0);
        if (!(await this.proceed(claim, connectionId, written))) {
          return;
        }
        if (outcome === 'more') {
          continue;
        }

        await this.repository.completeRun(current);
        if (
          (await this.operations.beginValidation(id, claimToken)) &&
          (await this.operations.complete(id, claimToken, { resultAssetId: null }))
        ) {
          this.logger.log(`iCloud sync run ${id} finished`);
          return;
        }
        await this.acknowledgeCancel(claim, connectionId);
        return;
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  /** One unit of work. Every part of it is safe to repeat: leases, checkpoints and receipts decide. */
  private async step(connection: ICloudConnection): Promise<StepOutcome> {
    const { id } = connection;
    const inventoryComplete = await this.enumerate(connection);
    const resources: ICloudResource[] = [];
    for (let i = 0; i < connection.config.concurrency; i++) {
      const resource = await this.repository.claim(id, connection.config.stagingBytes);
      if (!resource) {
        break;
      }
      resources.push(resource);
    }
    // Every transfer settles before the step ends, so none is left running behind a stopped run.
    const settled = await Promise.allSettled(resources.map((resource) => this.transfer(connection, resource)));
    const rejected = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (rejected) {
      throw rejected.reason;
    }
    const albumsComplete = inventoryComplete && (await this.albums.reconcile(id, connection.ownerId));
    const relationsComplete = albumsComplete && (await this.relations.reconcile(id, connection.ownerId));
    const metadataComplete = relationsComplete && (await this.metadata.reconcile(id, connection.ownerId));
    if (resources.length > 0 || !inventoryComplete || !albumsComplete || !relationsComplete || !metadataComplete) {
      return 'more';
    }
    return (await this.repository.hasPending(id)) ? 'idle' : 'done';
  }

  /** Real counts onto the run's row, and the lease renewed. The answer says whether to carry on. */
  private async record(claim: Claim, connectionId: string, phase: string, idleWaits: number) {
    const counts = await this.repository.counts(connectionId);
    const total = counts.resources ?? 0;
    const open = OPEN_RESOURCE_STATUSES.reduce((sum, status) => sum + (counts[status] ?? 0), 0);
    const processed = Math.max(0, total - open);
    return this.operations.setBulkResult(claim.operation.id, claim.claimToken, {
      result: { phase, counts, idleWaits },
      processedUnits: processed,
      totalUnits: total,
      progress: total > 0 ? (processed / total) * 100 : 0,
      leaseMs: ICLOUD_LEASE_MS,
    });
  }

  /** Whether the run may carry on after a write: not cancelled, not paused, claim still ours. */
  private async proceed(
    claim: Claim,
    connectionId: string,
    written: MediaOperationWriteState | undefined,
  ): Promise<boolean> {
    const { id } = claim.operation;
    if (!written) {
      this.logger.warn(`iCloud sync run ${id}: claim lost, stopping`);
      return false;
    }
    if (written.status === MediaOperationStatus.Cancelling || written.cancelRequestedAt) {
      await this.acknowledgeCancel(claim, connectionId);
      this.logger.log(`iCloud sync run ${id} cancelled by its owner`);
      return false;
    }
    if (written.pauseRequestedAt && (await this.operations.settlePause(id, claim.claimToken))) {
      this.logger.log(`iCloud sync run ${id} paused by its owner`);
      return false;
    }
    return true;
  }

  private async acknowledgeCancel(claim: Claim, connectionId: string): Promise<void> {
    if (await this.operations.acknowledgeCancel(claim.operation.id, claim.claimToken, { released: false })) {
      await this.repository.endRun(connectionId, 'cancelled');
    }
  }

  /** Hand the run back for `delayMs` without spending an attempt: it is waiting, not failing. */
  private async wait(claim: Claim, connectionId: string, delayMs: number, idleWaits: number): Promise<void> {
    const written = await this.record(claim, connectionId, 'waiting', idleWaits);
    if (!(await this.proceed(claim, connectionId, written))) {
      return;
    }
    const delay = Math.min(ICLOUD_MAX_WAIT_MS, Math.max(0, Math.round(delayMs)));
    if (
      !(await this.operations.requeue(claim.operation.id, claim.claimToken, { delayMs: delay, returnAttempt: true }))
    ) {
      await this.acknowledgeCancel(claim, connectionId);
    }
  }

  /** Stop with a failure, unless the owner cancelled or paused first. */
  private async settle(claim: Claim, connectionId: string, code: string): Promise<void> {
    const recorded = Number(asObject(claim.operation.result).idleWaits ?? 0);
    const written = await this.record(claim, connectionId, 'stopped', Number.isSafeInteger(recorded) ? recorded : 0);
    if (!(await this.proceed(claim, connectionId, written))) {
      return;
    }
    await this.fail(claim, code);
  }

  /**
   * Report a failure. The first one puts the run back in the queue for its automatic retry; the
   * second is reported, and its owner is told unless the reason is the account, which the connection
   * has already told them about. The code is all that is recorded: a provider's message never is.
   */
  private async fail(claim: Claim, code: string): Promise<void> {
    const outcome = await this.operations.fail(claim.operation.id, claim.claimToken, { error: code, errorCode: code });
    const connectionId = asObject(claim.operation.snapshot).connectionId;
    if (outcome === 'failed' && typeof connectionId === 'string') {
      // The run record ends with the run; the next run starts a fresh inventory pass.
      await this.repository.endRun(connectionId, 'failed').catch(() => {});
    }
    if (outcome === 'failed' && !SIGN_IN_CODES.has(code)) {
      await this.repository
        .notify(
          claim.operation.ownerId,
          NotificationLevel.Error,
          'iCloud Photos sync stopped',
          `The sync of “${claim.operation.label}” stopped after an automatic retry. Open Utilities → iCloud Photos to review it and try again. Photos already imported are unchanged.`,
        )
        .catch(() => {});
    }
  }

  /** One inventory page or one keyset materialization batch per step. */
  private async enumerate(connection: ICloudConnection): Promise<boolean> {
    return this.repository.withSession(connection.id, connection.ownerId, async (current, db) => {
      if (current.state !== 'connected') {
        return { value: false };
      }
      let encryptedSession = current.encryptedSession!;
      const page = async (
        kind: 'libraries' | 'albums' | 'assets' | 'changes' | 'memberships',
        scope: string,
        libraryKey: string,
        library?: ICloudLibrary,
        albumId?: string,
      ): Promise<boolean> => {
        const checkpoint = await this.repository.checkpoint(current.id, scope, db);
        if (checkpoint?.complete) {
          return true;
        }
        const response: ICloudPage = await this.transport.inventory({
          session: await this.transport.decodeSession(current.id, encryptedSession),
          kind,
          library,
          albumId,
          cursor: checkpoint?.cursor,
        });
        encryptedSession = await this.transport.encodeSession(current.id, response.session);
        let records = response.records;
        switch (kind) {
          case 'libraries': {
            records = records.map((raw) => {
              const zone = raw as unknown as ICloudLibrary;
              if (!zone.zoneID?.zoneName || !['private', 'shared'].includes(zone.area)) {
                throw new Error('icloud_library_invalid');
              }
              const id = createHash('sha256')
                .update(
                  JSON.stringify([
                    zone.area,
                    zone.zoneID.zoneName,
                    zone.zoneID.ownerRecordName ?? '',
                    zone.zoneID.zoneType ?? '',
                  ]),
                )
                .digest('hex');
              return { recordName: id, recordType: 'Library', fields: zone as unknown as Record<string, unknown> };
            });

            break;
          }
          case 'albums': {
            await this.repository.saveAlbums(current.id, libraryKey, records, db);

            break;
          }
          case 'memberships': {
            const snapshotId = checkpoint?.snapshotId ?? randomUUID();
            // Initialize a stable snapshot before any page can mark memberships absent.
            if (!checkpoint) {
              await this.repository.initializeCheckpoint(current.id, scope, snapshotId, db);
            }
            await this.repository.saveMembershipPage(
              current.id,
              libraryKey,
              albumId!,
              records,
              snapshotId,
              response.complete,
              db,
            );

            break;
          }
          // No default
        }
        await this.repository.savePage(
          current.id,
          scope,
          libraryKey,
          records,
          response.nextCursor,
          response.complete,
          db,
        );
        return false;
      };
      if (!(await page('libraries', 'libraries', ''))) {
        return { value: false, encryptedSession };
      }
      const inventory = await this.repository.inventory(current.id, db);
      for (const { id: libraryKey, fields: library } of inventory.libraries) {
        if (current.config.libraries.length > 0 && !current.config.libraries.includes(libraryKey)) {
          continue;
        }
        if (!(await page('albums', `albums:${libraryKey}`, libraryKey, library))) {
          return { value: false, encryptedSession };
        }
        if (!(await page('assets', `assets:${libraryKey}`, libraryKey, library))) {
          return { value: false, encryptedSession };
        }
        if (!(await page('changes', `changes:${libraryKey}`, libraryKey, library))) {
          return { value: false, encryptedSession };
        }
        for (const album of inventory.albums) {
          if (album.libraryId !== libraryKey) {
            continue;
          }
          if (current.config.albums.length > 0 && !current.config.albums.includes(album.id)) {
            continue;
          }
          const sourceId = album.id.slice(libraryKey.length + 1);
          if (!(await page('memberships', `memberships:${album.id}`, libraryKey, library, sourceId))) {
            return { value: false, encryptedSession };
          }
        }
        if (!(await this.repository.materialize(current, libraryKey, library, db))) {
          return { value: false, encryptedSession };
        }
      }
      await this.repository.savePage(current.id, 'inventory-complete', '', [], null, true, db);
      return { value: true, encryptedSession };
    });
  }

  private async transfer(connection: ICloudConnection, resource: ICloudResource): Promise<void> {
    try {
      if (resource.status !== 'committed') {
        const authority = {
          resourceId: resource.id,
          leaseToken: resource.leaseToken!,
          ownerId: connection.ownerId,
          includeHidden: connection.config.includeHidden,
        };
        const reused = await this.recovery.verifyMapped(authority);
        if (reused && reused.outcome !== 'reused') {
          await this.repository.finish(resource, reused.outcome, reused.reason ?? null);
          return;
        }
        if (!reused) {
          const path = await this.staging.download(connection, resource);
          const type = resource.source.type;
          if (type !== AssetType.Image && type !== AssetType.Video) {
            await this.repository.finish(resource, 'unsupported', 'media_type_unsupported');
            return;
          }
          const result = await this.recovery.reconcile({
            ...authority,
            stagedPath: path,
            originalFileName:
              typeof resource.source.originalFileName === 'string' ? resource.source.originalFileName : resource.id,
            type,
            sourceHidden: resource.source.isHidden === true,
            sourceCreatedAt:
              typeof resource.source.fileCreatedAt === 'string' ? new Date(resource.source.fileCreatedAt) : undefined,
          });
          if (!['imported', 'reused', 'repaired-missing', 'repaired-corrupt'].includes(result.outcome)) {
            await this.repository.finish(resource, result.outcome, result.reason ?? null);
            return;
          }
        }
      }
      const committed = await this.repository.resource(resource.id);
      if (committed?.status !== 'committed') {
        return;
      }
      for (const job of committed.pendingJobs) {
        if (job.name === JobName.AssetExtractMetadata || job.name === JobName.AssetGenerateThumbnails) {
          const data: IEntityJob = { id: job.data.id };
          if (job.data.source === 'upload') {
            data.source = job.data.source;
          }
          if ('notify' in job.data && typeof job.data.notify === 'boolean') {
            data.notify = job.data.notify;
          }
          await this.jobs.queue({ name: job.name, data });
        } else {
          throw new Error('icloud_outbox_job_invalid');
        }
      }
      await this.repository.clearOutbox(resource);
      await this.repository.finalize(resource, () => this.staging.cleanup(committed));
    } catch (error) {
      const reason = error instanceof ICloudTransportError ? error.code : 'icloud_transfer_failed';
      const current = await this.repository.resource(resource.id);
      await this.repository.finish(resource, current?.status === 'committed' ? 'committed' : 'retry', reason);
      if (error instanceof ICloudTransportError && error.code === 'resource_changed') {
        await this.repository.refreshResource(resource);
        return;
      }
      if (error instanceof ICloudTransportError) {
        throw error;
      }
    }
  }

  private async failure(id: string, ownerId: string, error: unknown): Promise<void> {
    const code = failureCode(error);
    if (code === 'invalid_change_token') {
      await this.repository.invalidateCursor(id, ownerId);
      return;
    }
    if (['rate_limited', 'icloud_transport_failed', 'icloud_transport_timeout'].includes(code)) {
      await this.repository.defer(id, ownerId, code);
      return;
    }
    const state =
      code === 'reauthentication_required'
        ? 'reauthentication-required'
        : code === 'device_approval_required'
          ? 'awaiting-device-approval'
          : 'error';
    await this.repository.block(id, ownerId, state, code);
  }
}
