import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { OnEvent } from 'src/decorators.js';
import {
  StudioExportCreateDto,
  StudioExportCreateResponseDto,
  StudioExportListResponseDto,
  StudioExportSearchDto,
  StudioExportVersionDto,
} from 'src/dtos/studio-export.dto.js';
import {
  AssetType,
  CacheControl,
  ImmichWorker,
  JobName,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  RenderWorkerStatus,
  StudioExportRemoteReason,
  StudioExportScope,
  StudioExportVersionState,
} from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { RenderWorkerRepository } from 'src/repositories/render-worker.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import {
  PENDING_STUDIO_EXPORT_STATES,
  StudioExportPublished,
  StudioExportRefusal,
  StudioExportRefusalCode,
  StudioExportRepository,
  StudioExportSourceInput,
  StudioExportVersion,
  StudioExportVersionSource,
  isLibrarySource,
} from 'src/repositories/studio-export.repository.js';
import { StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { mapOperation } from 'src/services/media-operation.service.js';
import { StudioProjectService } from 'src/services/studio-project.service.js';
import { StudioAuthorizedEntry, StudioResourceService } from 'src/services/studio-resource.service.js';
import { getConfig } from 'src/utils/config.js';
import { ImmichFileResponse } from 'src/utils/file.js';
import { getLockedOwnerId } from 'src/utils/locked.js';
import { isNsfwHidingEnabled } from 'src/utils/misc.js';
import { evaluateRenderOutput, isQualifiedRenderSession } from 'src/utils/render-admission.js';
import {
  STUDIO_EXPORT_CONTENT_TYPES,
  STUDIO_EXPORT_LEASE_MS,
  STUDIO_EXPORT_PUBLISH_MAX_ATTEMPTS,
  STUDIO_EXPORT_SWEEP_MS,
  STUDIO_EXPORT_TICK_MS,
  StudioExportPublishSnapshot,
  isInsideFolder,
  isStudioExportContentType,
  parseStudioExportPublishSnapshot,
  studioExportFileName,
  studioExportLibraryPath,
  studioExportProjectPath,
  studioExportStagingFolder,
} from 'src/utils/studio-export.js';
import { StudioDestination, StudioRefusalReason, isStudioUuid } from 'src/utils/studio-resources.js';
import {
  STUDIO_DOLBY_TOOLS_ID,
  STUDIO_DOLBY_TOOLS_QUALIFIED,
  checkStudioRights,
  studioRightsUseFor,
} from 'src/utils/studio-rights.js';

type RunningJob = { operation: MediaOperation; claimToken: string };

/** A failure of one publication attempt. Retried once automatically, like every job (FL-104). */
class PublishError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500);

const errorCode = (error: unknown): string => {
  if (error instanceof StudioExportRefusal) {
    return `studio_export_${error.code.replaceAll('-', '_')}`;
  }
  return error instanceof PublishError ? error.code : 'studio_export_publish_failed';
};

const asIso = (value: Date | string | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
};

/** The kinds a render may reference that name a library asset by id. */
const isLibraryEntry = (entry: StudioAuthorizedEntry): boolean =>
  (entry.sourceAccess === 'owner' || entry.sourceAccess === 'shared') && !!entry.ownerId && isStudioUuid(entry.id);

/** FL-90's refusal reasons that mean the source is gone rather than no longer shared. */
const GONE_REASONS: ReadonlySet<string> = new Set([
  StudioRefusalReason.NotFound,
  StudioRefusalReason.Trashed,
  StudioRefusalReason.Offline,
]);

/** The provenance row for one manifest entry: what the render may read, and its owner. */
export const studioExportSourceOf = (entry: StudioAuthorizedEntry): StudioExportSourceInput => ({
  key: entry.key,
  kind: entry.kind,
  resourceId: entry.id,
  assetId: isLibraryEntry(entry) ? entry.id : null,
  ownerId: isLibraryEntry(entry) ? entry.ownerId : null,
  checksum: entry.checksum,
  sourceAccess: entry.sourceAccess,
});

/**
 * Studio project exports and the versions they publish (FL-106, `STU-404`).
 *
 * An export is two durable jobs and one row:
 *
 * 1. **The render** (`studio_export`, FL-95's contract). A render worker claims it, reads only what
 *    its claim was granted, writes the file into a directory named for that render and reports its
 *    checksum. It never names an asset: the complete call of a Studio export carries a file, and a
 *    worker-supplied result id is refused.
 * 2. **The publication** (`studio_export_publish`), run here, on this server. It re-reads the
 *    project, re-resolves every source for the owner as they are *now*, hashes the file again and
 *    then, in one transaction (`StudioExportRepository.publish`), installs the union of the sources'
 *    Locked and sensitive evidence on the result before it is numbered and becomes visible.
 * 3. **The version row** (`studio_export_version`), which starts with the render and records what
 *    was read, what was produced, where it went and what it inherited.
 *
 * What it guarantees:
 *
 * - **Conservative inheritance.** One Locked source locks the result, one sensitive source makes it
 *   sensitive; the first clip is not special. Locked is an `asset_lock` record, never `visibility`.
 * - **Temporary permission stays temporary.** A result made with media shared with the owner is not
 *   added to their library: it stays with the project and every download re-checks every source.
 * - **Failures lose nothing.** A failed, stale, cancelled or interrupted export never touches an
 *   earlier version; retention removes only files no published result references; originals and
 *   deduplication references are only ever read.
 * - **Pending work stops when its premise goes.** Deleting the owner, trashing the project,
 *   removing a source or a handover cancels it; what a remote destination still holds is recorded
 *   until the remote acknowledges it, whatever else is deleted.
 */
@Injectable()
export class StudioExportService {
  private tickHandle?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private stopping = false;
  private lastSweepAt = 0;
  private readonly workerId = `studio-export-${randomUUID()}`;
  /** Stands in for a session on the worker's owner auth; nothing on these paths reads it back. */
  private readonly sessionId = randomUUID();

  constructor(
    private logger: LoggingRepository,
    private repository: StudioExportRepository,
    private operations: MediaOperationRepository,
    private projects: StudioProjectRepository,
    private studio: StudioProjectService,
    private resources: StudioResourceService,
    private users: UserRepository,
    private access: AccessRepository,
    private storage: StorageRepository,
    private crypto: CryptoRepository,
    private jobs: JobRepository,
    private configRepository: ConfigRepository,
    private systemMetadata: SystemMetadataRepository,
    private renderWorkers: RenderWorkerRepository,
  ) {
    this.logger.setContext(StudioExportService.name);
  }

  /* ------------------------------------------------------------------ */
  /* Owner: submit, list, read                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Export the project's current revision. Owner only.
   *
   * The revision is resolved for this session through FL-90 first, and a source this session
   * cannot place in Studio (trashed, unshared, Locked…) refuses the export rather than rendering
   * a picture with a hole in it. The render job and its version row are created together.
   */
  async create(auth: AuthDto, projectId: string, dto: StudioExportCreateDto): Promise<StudioExportCreateResponseDto> {
    this.requireInteractive(auth);

    if (dto.requestKey) {
      const existing = await this.operations.getByRequestKey(
        auth.user.id,
        MediaOperationKind.StudioExport,
        dto.requestKey,
      );
      if (existing) {
        if (existing.projectId !== projectId) {
          throw new ConflictException('This request key was already used for another export');
        }
        const version = await this.repository.getByRenderOperation(existing.id);
        if (version) {
          return { version: this.map(await this.findOwned(auth, version.id), auth), operation: mapOperation(existing) };
        }
      }
    }

    const destination = dto.destination as unknown as StudioDestination;
    // Studio exports render at home: this server or a worker on the home network (owner prototype
    // effd05ffb7, Studio.jsx ExportDialog). Frameleaf Cloud takes restoration and smooth-motion jobs,
    // each confirmed on its own, never a Studio export.
    if (destination === StudioDestination.RunPod) {
      throw new BadRequestException({
        message: 'Studio exports render on this server or another computer on your home network.',
        code: 'studio_export_local_only',
      });
    }
    // FL-86: Dolby Vision needs the administrator-installed Dolby tools: their rights (approved by
    // the owner, FL-146) and a render worker qualified with them (FL-145), which none is yet.
    if (dto.color === 'dolby-vision') {
      const rights = checkStudioRights(STUDIO_DOLBY_TOOLS_ID, studioRightsUseFor(destination));
      if (!rights.allowed) {
        throw new ConflictException({
          message: `Dolby Vision output is not available on this server. ${rights.detail}`,
          code: 'studio_export_rights_blocked',
          resource: rights.id,
        });
      }
      if (!STUDIO_DOLBY_TOOLS_QUALIFIED) {
        throw new ConflictException({
          message:
            'Dolby Vision output is not available on this server. No render worker is qualified with the Dolby tools yet.',
          code: 'studio_export_dolby_unqualified',
          resource: rights.id,
        });
      }
    }
    const authorized = await this.studio.authorizeRevision(auth, {
      projectId,
      destination,
      cloudConsent: dto.cloudConsent === true,
    });
    if (authorized.access !== 'owner') {
      throw new ForbiddenException('Only the owner can export a Studio project');
    }
    if (dto.expectedRevision !== undefined && dto.expectedRevision !== authorized.revision.revision) {
      throw new ConflictException({
        message: 'The project has moved to a newer revision',
        code: 'studio_export_stale_revision',
        currentRevision: authorized.revision.revision,
      });
    }
    if (!authorized.manifest.complete) {
      throw new ConflictException({
        message: 'A source this project uses is not available to you',
        code: 'studio_export_sources_refused',
        refusedCount: authorized.manifest.refusedCount,
      });
    }

    const settings = { format: dto.format, color: dto.color, resolution: dto.resolution };
    await this.requireRenderableOutput(dto.destination, settings);
    const { operation, version } = await this.repository.createWithRender(
      {
        ownerId: auth.user.id,
        kind: MediaOperationKind.StudioExport,
        destination: dto.destination,
        destinationDetail: null,
        label: authorized.project.name,
        assetId: null,
        resultAssetId: null,
        retryOfId: null,
        projectId: authorized.project.id,
        revisionId: authorized.revision.digest,
        /**
         * The binding FL-95 resolves at claim time: the stored revision (immutable once written),
         * re-read from project storage and resolved for the owner as a background runner. No graph,
         * path or URL travels in the job.
         */
        snapshot: {
          kind: 'studio-export',
          projectId: authorized.project.id,
          revision: authorized.revision.revision,
          revisionDigest: authorized.revision.digest,
          manifestDigest: authorized.manifest.digest,
          requestKey: dto.requestKey ?? null,
          studio: { stored: true, revision: authorized.revision.revision, cloudConsent: dto.cloudConsent === true },
        },
        settings,
        estimate: null,
        totalUnits: null,
        maxAttempts: 3,
      },
      {
        ownerId: auth.user.id,
        projectId: authorized.project.id,
        revision: authorized.revision.revision,
        revisionDigest: authorized.revision.digest,
        destination: dto.destination,
        settings,
      },
    );

    this.logger.log(`Studio export ${version.id} queued as render ${operation.id} for project ${projectId}`);
    return { version: this.map(version, auth), operation: mapOperation(operation) };
  }

  /**
   * FL-42: an export is queued only when a live, qualified render session for the chosen destination
   * verified what it needs: GPU memory for the resolution, an encoder for the format and the colour
   * precision. Otherwise it is refused up front with a reason the person can act on (choose a
   * smaller resolution, another format or SDR, or bring a qualified worker online) instead of
   * waiting in the queue for a worker that can never take it.
   */
  private async requireRenderableOutput(
    destination: MediaOperationDestination,
    settings: { format: string; color: string; resolution: string },
  ) {
    const now = new Date();
    const sessions = await this.renderWorkers.listLiveSessions();
    const candidates = sessions
      .filter(
        ({ worker, session }) =>
          worker.destination === destination &&
          session.scopes.includes(MediaOperationKind.StudioExport) &&
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
              scopes: session.scopes,
            },
            now,
          }),
      )
      .map(({ session }) => ({
        gpuMemoryBytes: session.gpuMemoryBytes === null ? null : Number(session.gpuMemoryBytes),
        codecs: session.codecs ?? [],
        colorPrecision: session.colorPrecision,
      }));
    const verdict = evaluateRenderOutput(candidates, settings);
    if (!verdict.supported) {
      throw new ConflictException({
        message: `No qualified render worker can produce this export (${verdict.refusal})`,
        code: 'studio_export_unsupported',
        reason: verdict.refusal,
      });
    }
  }

  /** The project's exports, newest first. Owner only; a Locked result needs an unlocked session. */
  async list(auth: AuthDto, projectId: string, dto: StudioExportSearchDto): Promise<StudioExportListResponseDto> {
    this.requireInteractive(auth);
    await this.requireOwnedProject(auth, projectId);
    const { items, total } = await this.repository.listForProject(projectId, auth.user.id, {
      take: dto.take ?? 50,
      skip: dto.skip ?? 0,
      includeLocked: !!getLockedOwnerId(auth),
    });
    const sources = await this.repository.getSourcesFor(items.map((item) => item.id));
    return {
      items: items.map((item) => this.map(item, auth, sources.get(item.id) ?? [])),
      total,
    };
  }

  async get(auth: AuthDto, id: string): Promise<StudioExportVersionDto> {
    this.requireInteractive(auth);
    const version = await this.findOwned(auth, id);
    return this.map(version, auth, await this.repository.getSources(version.id));
  }

  /**
   * The file of a published `project` result.
   *
   * Every request re-checks what publication checked: the owner can still see every library
   * source, through the same access rules the library uses. Losing any of them — a share ended, a
   * partner stopped sharing, a source was trashed — makes the result unavailable, exactly like a
   * version that does not exist, so a temporary share never becomes a permanent copy. A result that
   * inherited a lock needs the owner's unlocked session, like any Locked media.
   */
  async download(auth: AuthDto, id: string): Promise<ImmichFileResponse> {
    this.requireInteractive(auth);
    const version = await this.findOwned(auth, id);
    if (
      version.state !== StudioExportVersionState.Published ||
      version.scope !== StudioExportScope.Project ||
      !version.outputPath ||
      version.outputRemovedAt
    ) {
      throw new NotFoundException('Studio export not found');
    }

    const privacy = (version.privacy ?? {}) as { lockReason?: string | null };
    if (privacy.lockReason && !getLockedOwnerId(auth)) {
      throw new NotFoundException('Studio export not found');
    }

    const sources = (await this.repository.getSources(version.id)).filter((source) => isLibrarySource(source));
    const owned = new Set(sources.filter((source) => source.ownerId === auth.user.id).map((source) => source.assetId!));
    const shared = new Set(
      sources.filter((source) => source.ownerId !== auth.user.id).map((source) => source.assetId!),
    );
    const [ownedOk, album, partner] = await Promise.all([
      this.access.asset.checkOwnerAccess(auth.user.id, owned, !!getLockedOwnerId(auth)),
      this.access.asset.checkAlbumAccess(auth.user.id, shared),
      this.access.asset.checkPartnerAccess(auth.user.id, shared),
    ]);
    const reachable = (assetId: string) =>
      owned.has(assetId) ? ownedOk.has(assetId) : album.has(assetId) || partner.has(assetId);
    if (sources.some((source) => !reachable(source.assetId!))) {
      throw new NotFoundException('Studio export not found');
    }

    return new ImmichFileResponse({
      path: version.outputPath,
      contentType: version.outputContentType ?? 'application/octet-stream',
      cacheControl: CacheControl.PrivateWithoutCache,
    });
  }

  /* ------------------------------------------------------------------ */
  /* Render contract (called by the render worker service)               */
  /* ------------------------------------------------------------------ */

  /** The directory a render worker writes one render's output into. */
  stagingFolder(operation: Pick<MediaOperation, 'ownerId' | 'id'>): string {
    return studioExportStagingFolder(operation.ownerId, operation.id);
  }

  /**
   * A render worker claimed an export: record what it may read — the provenance publication checks
   * against — and, for a remote destination, the obligation to stop it, before it starts.
   */
  async onRenderClaimed(
    operation: MediaOperation,
    claim: { workerId: string; engineDigest: string | null; entries: readonly StudioAuthorizedEntry[] },
  ): Promise<void> {
    const recorded = await this.repository.recordRenderClaim(operation.id, {
      workerId: claim.workerId,
      engineDigest: claim.engineDigest,
      sources: claim.entries.map((entry) => studioExportSourceOf(entry)),
    });
    if (!recorded) {
      this.logger.warn(`Studio export render ${operation.id} was claimed but its version is no longer rendering`);
      return;
    }
    const version = await this.repository.getByRenderOperation(operation.id);
    if (operation.destination !== MediaOperationDestination.Local) {
      await this.repository.recordRemoteReference({
        versionId: version?.id ?? null,
        operationId: operation.id,
        ownerId: operation.ownerId,
        workerId: claim.workerId,
        destination: operation.destination as MediaOperationDestination,
        remoteRef: null,
        reason: StudioExportRemoteReason.Cancel,
      });
    }
    this.storage.mkdirSync(this.stagingFolder(operation));
  }

  /**
   * A render worker reports the file it produced. The path must be inside the render's own
   * directory and name a regular file of the reported size; anything else is refused and the
   * render stays unfinished. Accepting it stages the version and queues its publication; the render
   * job itself then completes without a result asset, because only publication adopts one.
   */
  async onRenderCompleted(
    operation: MediaOperation,
    workerId: string,
    output: { path: string; checksum: string; sizeInBytes: string; contentType: string; remoteRef?: string | null },
  ): Promise<{ accepted: boolean }> {
    if (!isStudioExportContentType(output.contentType)) {
      throw new BadRequestException('Unsupported export container');
    }
    const folder = this.stagingFolder(operation);
    if (!isInsideFolder(folder, output.path)) {
      throw new BadRequestException('The output must be inside the directory this render was given');
    }
    const stat = await this.storage.stat(output.path).catch(() => null);
    if (!stat?.isFile() || String(stat.size) !== output.sizeInBytes) {
      throw new BadRequestException('The output is missing or its size does not match');
    }

    const staged = await this.repository.stage(
      operation.id,
      operation.claimToken,
      {
        path: output.path,
        checksum: Buffer.from(output.checksum, 'hex'),
        sizeInBytes: Number(output.sizeInBytes),
        contentType: output.contentType,
        remoteRef: output.remoteRef ?? null,
      },
      (version) => ({
        ownerId: version.ownerId,
        kind: MediaOperationKind.StudioExportPublish,
        destination: MediaOperationDestination.Local,
        destinationDetail: null,
        label: operation.label,
        assetId: null,
        resultAssetId: null,
        retryOfId: null,
        projectId: version.projectId,
        revisionId: version.revisionDigest,
        snapshot: {
          kind: 'studio-export-publish',
          versionId: version.id,
          renderOperationId: operation.id,
          projectId: version.projectId as string,
          revision: version.revision,
        } satisfies StudioExportPublishSnapshot as unknown as Record<string, unknown>,
        settings: version.settings,
        estimate: null,
        totalUnits: null,
        maxAttempts: STUDIO_EXPORT_PUBLISH_MAX_ATTEMPTS,
      }),
    );
    if (!staged) {
      return { accepted: false };
    }

    if (operation.destination !== MediaOperationDestination.Local) {
      await this.repository.acknowledgeRemoteCancel(operation.id, workerId);
      if (output.remoteRef) {
        await this.repository.recordRemoteReference({
          versionId: staged.version.id,
          operationId: operation.id,
          ownerId: operation.ownerId,
          workerId,
          destination: operation.destination as MediaOperationDestination,
          remoteRef: output.remoteRef,
          reason: StudioExportRemoteReason.Delete,
        });
      }
    }

    this.logger.log(`Studio export ${staged.version.id} staged; publication queued as ${staged.operation.id}`);
    return { accepted: true };
  }

  /** The render failed for good (its automatic retry spent): so does its version. */
  async onRenderFailed(operation: MediaOperation, failure: { errorCode: string; error: string }): Promise<void> {
    const version = await this.repository.getByRenderOperation(operation.id);
    if (version) {
      await this.repository.markFailed(version.id, failure);
    }
  }

  /** The worker confirmed a cancelled render stopped. A released render's obligation is settled. */
  async onRenderCancelAcknowledged(operation: MediaOperation, workerId: string, released: boolean): Promise<void> {
    const version = await this.repository.getByRenderOperation(operation.id);
    if (version) {
      await this.repository.cancel(version.id, { errorCode: 'studio_export_cancelled', error: 'Cancelled' });
    }
    if (released) {
      await this.repository.acknowledgeRemoteCancel(operation.id, workerId);
    }
  }

  listRemoteReferences(workerId: string) {
    return this.repository.listRemoteReferences(workerId);
  }

  acknowledgeRemoteReference(id: string, workerId: string) {
    return this.repository.acknowledgeRemoteReference(id, workerId);
  }

  /* ------------------------------------------------------------------ */
  /* Publication worker                                                  */
  /* ------------------------------------------------------------------ */

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  onBootstrap() {
    this.stopping = false;
    this.tickHandle ??= setInterval(() => this.tick(), STUDIO_EXPORT_TICK_MS);
    this.tick();
  }

  /** Stop taking work. A job in hand keeps its claim; the lease expiring hands it to the next worker. */
  @OnEvent({ name: 'AppShutdown' })
  async onShutdown() {
    this.stopping = true;
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = undefined;
    }
    await this.active;
  }

  /** Never overlaps itself. */
  tick() {
    if (this.active || this.stopping) {
      return;
    }
    this.active = this.drain()
      .catch((error) => this.logger.warn(`Studio export worker failed: ${errorMessage(error)}`))
      .finally(() => {
        this.active = undefined;
      });
  }

  /**
   * Work through queued publications. Lapsed claims are recovered by `MediaOperationSweepService`
   * with every other kind (FL-104).
   */
  async drain(): Promise<void> {
    await this.sweep();
    while (!this.stopping) {
      const claim = await this.operations.claimNext({
        kinds: [MediaOperationKind.StudioExportPublish],
        workerId: this.workerId,
        leaseMs: STUDIO_EXPORT_LEASE_MS,
      });
      if (!claim) {
        return;
      }
      await this.run(claim);
    }
  }

  /**
   * Run one publication. A refusal whose premise went away (owner, project, source, handoff)
   * cancels the version and settles the job as cancelled. Anything else fails the attempt through
   * the one automatic retry every job gets; only when that is spent does the version fail. Either
   * way no earlier version is touched.
   */
  async run({ operation, claimToken }: RunningJob): Promise<void> {
    const snapshot = parseStudioExportPublishSnapshot(operation.snapshot);
    const version = snapshot ? await this.repository.getById(snapshot.versionId) : undefined;
    if (!snapshot || !version || version.publishOperationId !== operation.id) {
      await this.failJob(
        operation,
        claimToken,
        new PublishError('studio_export_version_missing', 'Nothing to publish'),
      );
      return;
    }

    if (version.state === StudioExportVersionState.Published) {
      // Published by an earlier attempt whose acknowledgement was lost; finish the job only.
      await this.finishJob(operation, claimToken, version.resultAssetId);
      return;
    }
    if (version.state !== StudioExportVersionState.Staged) {
      await this.settleCancelled(operation, claimToken);
      return;
    }

    if (!(await this.operations.beginValidation(operation.id, claimToken))) {
      return;
    }

    let prepared: PreparedPublication | undefined;
    try {
      prepared = await this.prepare(version);
      const published = await this.publishAcknowledged(version, operation, claimToken, prepared);
      await this.afterPublished(published, prepared);
      await this.finishJob(operation, claimToken, published.version.resultAssetId);
      this.logger.log(
        `Studio export ${version.id} published as version ${published.version.version} (${published.privacy.scope}${
          published.privacy.lockReason ? `, locked: ${published.privacy.lockReason}` : ''
        })`,
      );
    } catch (error) {
      if (error instanceof StudioExportRefusal && error.code === 'claim-lost') {
        // A replacement claim may already be using the prepared file. Leave it in place.
        return;
      }
      if (prepared) {
        await this.restoreStaged(prepared);
      }
      if (error instanceof StudioExportRefusal && error.cancels) {
        await this.cancelVersion(version, error.code, error.message);
        await this.settleCancelled(operation, claimToken);
        return;
      }
      if (error instanceof StudioExportRefusal && error.code === 'not-staged') {
        await this.settleCancelled(operation, claimToken);
        return;
      }
      await this.failJob(operation, claimToken, error, version);
    }
  }

  /**
   * Everything that can be decided before the transaction, as the owner now: the project and its
   * stored revision, a fresh FL-90 resolution compared with what the render read, and the file,
   * hashed again and moved to where the result will live. Every refusal here happens before any
   * write; the transaction re-checks what matters under locks.
   */
  private async prepare(version: StudioExportVersion): Promise<PreparedPublication> {
    const owner = await this.ownerAuth(version.ownerId);
    if (!owner) {
      throw new StudioExportRefusal('owner-unavailable', 'The account this export belongs to is being deleted');
    }
    const project = version.projectId ? await this.projects.getById(version.projectId) : undefined;
    if (!project || project.deletedAt || project.ownerId !== version.ownerId) {
      throw new StudioExportRefusal('project-unavailable', 'The project is gone or in the trash');
    }
    const revision = await this.projects.getRevision(project.id, version.revision);
    if (!revision || revision.digest !== version.revisionDigest) {
      throw new StudioExportRefusal('project-unavailable', 'The revision this export was made from is gone');
    }

    // Current access, for the owner, as a background runner (it may read the owner's Locked media;
    // publication is what restricts the result accordingly).
    const resolution = await this.resources.resolveProjectResources(owner, {
      projectId: project.id,
      ownerId: project.ownerId,
      revision: revision.revision,
      graph: (revision.envelope as { graph?: unknown }).graph,
      destination: StudioDestination.Local,
      backgroundRunner: true,
    });
    if (!resolution.manifest.complete) {
      const gone = resolution.refused.some((item) => GONE_REASONS.has(item.reason));
      throw gone
        ? new StudioExportRefusal('source-unavailable', 'A source of this export was deleted or went offline')
        : new StudioExportRefusal('source-access-lost', 'A source of this export is no longer available to you');
    }

    const recorded = await this.repository.getSources(version.id);
    this.assertSameSources(recorded, resolution.manifest.entries);

    const expectedScope = resolution.manifest.entries.some((entry) => entry.sourceAccess === 'shared')
      ? StudioExportScope.Project
      : StudioExportScope.Library;

    const contentType = version.outputContentType ?? '';
    const container = STUDIO_EXPORT_CONTENT_TYPES[contentType];
    if (!container || !version.outputPath || !version.outputChecksum || version.outputSizeInBytes === null) {
      throw new PublishError('studio_export_output_invalid', 'The render did not report a usable file');
    }
    if (!version.renderOperationId) {
      throw new PublishError('studio_export_output_invalid', 'The render this export came from is gone');
    }
    const staging = this.stagingFolder({ ownerId: version.ownerId, id: version.renderOperationId });
    const finalPath =
      expectedScope === StudioExportScope.Library
        ? studioExportLibraryPath(version.ownerId, version.id, container.extension)
        : studioExportProjectPath(version.ownerId, version.id, container.extension);

    // An earlier attempt may have moved the file already and then stopped; accept it there too.
    const stagedPath = version.outputPath;
    const current = (await this.storage.checkFileExists(stagedPath)) ? stagedPath : finalPath;
    await this.verifyOutput(current, current === stagedPath ? staging : dirname(finalPath), version);

    if (current !== finalPath) {
      this.storage.mkdirSync(dirname(finalPath));
      await this.storage.rename(stagedPath, finalPath);
    }

    const config = await getConfig(
      { configRepo: this.configRepository, metadataRepo: this.systemMetadata, logger: this.logger },
      { withCache: true },
    );

    return {
      versionId: version.id,
      stagedPath,
      finalPath,
      stagingFolder: staging,
      expectedScope,
      nsfwHiding: isNsfwHidingEnabled(config.machineLearning),
      sources: recorded.filter((source) => isLibrarySource(source)),
      contentType,
      assetType: container.assetType,
      originalFileName: studioExportFileName(project.name, container.extension),
    };
  }

  /**
   * The render's sources and the current resolution must be the same set with the same checksums.
   * A render of sources that have changed since is stale: it is refused, never published as current.
   */
  private assertSameSources(recorded: StudioExportVersionSource[], entries: readonly StudioAuthorizedEntry[]) {
    const current = new Map(entries.map((entry) => [entry.key, entry]));
    const same =
      recorded.length === current.size &&
      recorded.every((source) => {
        const entry = current.get(source.key);
        return !!entry && entry.id === source.resourceId && entry.checksum === source.checksum;
      });
    if (!same) {
      throw new StudioExportRefusal('source-changed', 'A source of this export changed after it was rendered');
    }
  }

  /**
   * The file must be a regular file inside `folder` with every link resolved, of the recorded size
   * and SHA-256. The hash is recomputed here; the worker's report is only what it is compared with.
   */
  private async verifyOutput(path: string, folder: string, version: StudioExportVersion): Promise<void> {
    const invalid = (detail: string) => new PublishError('studio_export_output_invalid', detail);
    const real = await this.storage.realpath(path).catch(() => null);
    const realFolder = await this.storage.realpath(folder).catch(() => null);
    if (!real || !realFolder || !isInsideFolder(realFolder, real)) {
      throw invalid('The rendered file is not where this render was allowed to write');
    }
    const stat = await this.storage.stat(real).catch(() => null);
    if (!stat?.isFile() || String(stat.size) !== String(version.outputSizeInBytes)) {
      throw invalid('The rendered file is missing or its size changed');
    }
    const checksum = await this.crypto.hashFile(real, 'sha256');
    if (!version.outputChecksum || !checksum.equals(Buffer.from(version.outputChecksum))) {
      throw invalid('The rendered file does not match the checksum its render reported');
    }
  }

  /**
   * Publish, and settle an uncertain commit: when the transaction's answer is lost (the connection
   * dropped at commit), the version row says whether it committed. Published by this job means
   * published; anything else means it did not, and the error stands.
   */
  private async publishAcknowledged(
    version: StudioExportVersion,
    operation: MediaOperation,
    claimToken: string,
    prepared: PreparedPublication,
  ): Promise<StudioExportPublished> {
    return settleStudioExportPublication(this.repository, version.id, operation.id, () =>
      this.repository.publish({
        versionId: version.id,
        operationId: operation.id,
        claimToken,
        ownerId: version.ownerId,
        sources: prepared.sources,
        expectedScope: prepared.expectedScope,
        nsfwHiding: prepared.nsfwHiding,
        path: prepared.finalPath,
        checksum: Buffer.from(version.outputChecksum!),
        sizeInBytes: Number(version.outputSizeInBytes),
        contentType: prepared.contentType,
        assetType: prepared.assetType,
        originalFileName: prepared.originalFileName,
      }),
    );
  }

  private async afterPublished(published: StudioExportPublished, prepared: PreparedPublication): Promise<void> {
    if (published.reusedAssetId) {
      // The owner already had these bytes; the moved copy is referenced by nothing.
      await this.storage.unlink(prepared.finalPath).catch(() => {});
    }
    if (published.createdAssetId) {
      await this.jobs.queue({
        name: JobName.AssetExtractMetadata,
        data: { id: published.createdAssetId, source: 'upload' },
      });
    }
    await this.storage.unlinkDir(prepared.stagingFolder, { recursive: true, force: true }).catch(() => {});
  }

  /** Undo the move of an attempt that did not publish, so the retry and retention find the file. */
  private async restoreStaged(prepared: PreparedPublication): Promise<void> {
    if (prepared.finalPath === prepared.stagedPath) {
      return;
    }
    const committed = await this.repository.getById(prepared.versionId).catch(() => {});
    if (committed?.state === StudioExportVersionState.Published) {
      return;
    }
    if (await this.storage.checkFileExists(prepared.finalPath)) {
      this.storage.mkdirSync(dirname(prepared.stagedPath));
      await this.storage.rename(prepared.finalPath, prepared.stagedPath).catch((error) => {
        this.logger.warn(`Could not return ${prepared.finalPath} to staging: ${errorMessage(error)}`);
      });
    }
  }

  /**
   * Complete the publication job. The version is already published; a cancel that landed on the
   * job meanwhile has nothing left to stop, so it is acknowledged rather than left for the lease.
   */
  private async finishJob(operation: MediaOperation, claimToken: string, resultAssetId: string | null): Promise<void> {
    await this.operations.beginValidation(operation.id, claimToken);
    if (!(await this.operations.complete(operation.id, claimToken, { resultAssetId }))) {
      await this.operations.acknowledgeCancel(operation.id, claimToken, { released: true });
    }
  }

  /** A cancelled version's publication ends as cancelled too. Nothing remote is involved here. */
  private async settleCancelled(operation: MediaOperation, claimToken: string): Promise<void> {
    const cancelling = await this.operations.requestCancel(operation.id, operation.ownerId);
    if (cancelling?.status === MediaOperationStatus.Cancelling) {
      await this.operations.acknowledgeCancel(operation.id, claimToken, { released: true });
    } else if (!cancelling) {
      // Already terminal, or the claim moved on: nothing to settle.
      this.logger.debug(`Studio export publication ${operation.id} had nothing left to settle (${claimToken})`);
    }
  }

  private async failJob(
    operation: MediaOperation,
    claimToken: string,
    error: unknown,
    version?: StudioExportVersion,
  ): Promise<void> {
    const failure = { error: errorMessage(error), errorCode: errorCode(error) };
    const outcome = await this.operations.fail(operation.id, claimToken, failure);
    if (outcome === 'failed' && version) {
      await this.repository.markFailed(version.id, failure);
      this.logger.error(`Studio export ${version.id} failed to publish: ${failure.error}`);
    } else if (outcome === 'retrying') {
      this.logger.warn(`Studio export publication ${operation.id} failed and will be retried once: ${failure.error}`);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Sweep                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Cancel pending work whose premise went away, settle versions whose jobs ended elsewhere, and
   * remove files no published result references.
   */
  async sweep(now: Date = new Date()): Promise<void> {
    if (now.getTime() - this.lastSweepAt < STUDIO_EXPORT_SWEEP_MS) {
      return;
    }
    this.lastSweepAt = now.getTime();

    for (const version of await this.repository.listOrphanedWork()) {
      await this.cancelVersion(version, version.orphanReason, 'The owner, project or a source went away');
    }

    for (const version of await this.repository.listSettledWork()) {
      const failure = {
        errorCode: version.errorCode ?? 'studio_export_job_ended',
        error: version.error ?? 'The job working on this export stopped',
      };
      await (version.jobStatus === MediaOperationStatus.Failed
        ? this.repository.markFailed(version.id, failure)
        : this.repository.cancel(version.id, failure));
    }

    for (const version of await this.repository.listRemovableOutputs()) {
      if (version.outputPath) {
        await this.storage.unlink(version.outputPath).catch(() => {});
      }
      if (version.renderOperationId) {
        await this.storage
          .unlinkDir(studioExportStagingFolder(version.ownerId, version.renderOperationId), {
            recursive: true,
            force: true,
          })
          .catch(() => {});
      }
      await this.repository.markOutputRemoved(version.id);
    }
  }

  /**
   * Cancel a pending version and the jobs working on it. A claimed render goes to `cancelling` and
   * its worker is told at its next heartbeat; the obligation recorded when it was claimed stays
   * until the worker confirms. A queued job is cancelled at once.
   */
  async cancelVersion(version: StudioExportVersion, code: StudioExportRefusalCode | string, message: string) {
    if (!PENDING_STUDIO_EXPORT_STATES.includes(version.state as StudioExportVersionState)) {
      return;
    }
    const cancelled = await this.repository.cancel(version.id, {
      errorCode: `studio_export_${code.replaceAll('-', '_')}`,
      error: message,
    });
    if (!cancelled) {
      return;
    }
    for (const operationId of [version.renderOperationId, version.publishOperationId]) {
      if (operationId) {
        await this.operations.requestCancel(operationId, version.ownerId);
      }
    }
    this.logger.log(`Studio export ${version.id} cancelled: ${code}`);
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                           */
  /* ------------------------------------------------------------------ */

  private requireInteractive(auth: AuthDto): void {
    if (auth.sharedLink) {
      throw new ForbiddenException('Studio is not available through a shared link');
    }
  }

  private async requireOwnedProject(auth: AuthDto, projectId: string) {
    const project = await this.projects.getById(projectId);
    if (!project || project.ownerId !== auth.user.id) {
      throw new NotFoundException('Studio project not found');
    }
    return project;
  }

  private async findOwned(auth: AuthDto, id: string): Promise<StudioExportVersion> {
    const version = await this.repository.getForOwner(id, auth.user.id);
    if (!version) {
      throw new NotFoundException('Studio export not found');
    }
    const privacy = (version.privacy ?? {}) as { lockReason?: string | null };
    if (privacy.lockReason && !getLockedOwnerId(auth)) {
      // A Locked result exists only for its owner's unlocked session (FL-34).
      throw new NotFoundException('Studio export not found');
    }
    return version;
  }

  /** The owner as an elevated background-runner auth, or null when the account is gone. */
  private async ownerAuth(ownerId: string): Promise<AuthDto | null> {
    const user = await this.users.get(ownerId, {});
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
      session: { id: this.sessionId, hasElevatedPermission: true },
    };
  }

  /**
   * One version for its owner. A Locked result is shown only to an unlocked session; elsewhere its
   * asset id, size and privacy are left out, like any Locked media's metadata.
   */
  private map(
    version: StudioExportVersion,
    auth: AuthDto,
    sources: StudioExportVersionSource[] = [],
  ): StudioExportVersionDto {
    const privacy = (version.privacy ?? {}) as {
      lockReason?: string | null;
      sensitive?: boolean;
      includesSharedSources?: boolean;
      sourceCount?: number;
    };
    const hidden = !!privacy.lockReason && !getLockedOwnerId(auth);
    const settings = version.settings as StudioExportVersionDto['settings'];
    return {
      id: version.id,
      projectId: version.projectId,
      revision: version.revision,
      state: version.state as StudioExportVersionState,
      version: version.version,
      scope: (version.scope as StudioExportScope | null) ?? null,
      destination: version.destination as MediaOperationDestination,
      settings,
      renderOperationId: version.renderOperationId,
      publishOperationId: version.publishOperationId,
      resultAssetId: hidden ? null : version.resultAssetId,
      locked: !!privacy.lockReason,
      sensitive: privacy.sensitive === true,
      includesSharedSources:
        privacy.includesSharedSources ??
        sources.some((source) => isLibrarySource(source) && source.ownerId !== version.ownerId),
      sourceCount: privacy.sourceCount ?? sources.filter((source) => isLibrarySource(source)).length,
      sizeInBytes: hidden || version.outputSizeInBytes === null ? null : String(version.outputSizeInBytes),
      contentType: version.outputContentType,
      errorCode: version.errorCode,
      error: version.error,
      createdAt: asIso(version.createdAt)!,
      publishedAt: asIso(version.publishedAt),
      cancelledAt: asIso(version.cancelledAt),
    };
  }
}

type PreparedPublication = {
  versionId: string;
  stagedPath: string;
  finalPath: string;
  stagingFolder: string;
  expectedScope: StudioExportScope;
  nsfwHiding: boolean;
  sources: StudioExportVersionSource[];
  contentType: string;
  assetType: StudioExportPublishedAssetType;
  originalFileName: string;
};

type StudioExportPublishedAssetType = AssetType;

/**
 * Run a publication and decide what happened when its answer is lost.
 *
 * A commit whose acknowledgement never arrives may or may not have happened. The version row is the
 * authority: if it says this job published it, the publication happened and is returned as such; if
 * not, it did not, and the original error is rethrown so the attempt fails and retries. Publishing
 * twice is impossible either way, because `publish` answers a version this job already published
 * with that version.
 */
export const settleStudioExportPublication = async (
  repository: Pick<StudioExportRepository, 'getById' | 'getSources'>,
  versionId: string,
  operationId: string,
  attempt: () => Promise<StudioExportPublished>,
): Promise<StudioExportPublished> => {
  try {
    return await attempt();
  } catch (error) {
    if (error instanceof StudioExportRefusal) {
      throw error;
    }
    const committed = await repository.getById(versionId);
    if (committed?.state === StudioExportVersionState.Published && committed.publishOperationId === operationId) {
      const privacy = (committed.privacy ?? {}) as unknown as StudioExportPublished['privacy'];
      return { status: 'published', version: committed, privacy, createdAssetId: null, reusedAssetId: null };
    }
    throw error;
  }
};
