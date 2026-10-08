import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import type { Transaction } from 'kysely';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { DB } from 'src/schema/index.js';
import type { RenderArtifact } from 'src/utils/render-artifact.js';
import { StorageCore } from 'src/cores/storage.core.js';
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
  MlWorkload,
  PushEventType,
  RenderWorkerStatus,
  StorageFolder,
  StudioExportRemoteReason,
  StudioExportScope,
  StudioExportVersionState,
} from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
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
  StudioExportVisibility,
  StudioPublicationFollowups,
  StudioSourceMediaFacts,
  isLibrarySource,
} from 'src/repositories/studio-export.repository.js';
import { StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { AssetRestorationService } from 'src/services/asset-restoration.service.js';
import { mapOperation } from 'src/services/media-operation.service.js';
import { StudioProjectService } from 'src/services/studio-project.service.js';
import { StudioAuthorizedEntry, StudioResourceService } from 'src/services/studio-resource.service.js';
import {
  assertOwnerRestoreFile,
  assertOwnerRestorePath,
  captureOwnerRestoreFile,
} from 'src/utils/cloud-backup-owner-path.js';
import { getConfig } from 'src/utils/config.js';
import { assertExecutionActive, settleOperationExecution } from 'src/utils/execution-signal.js';
import { ImmichFileResponse } from 'src/utils/file.js';
import { pushJobData } from 'src/utils/frameleaf-push.js';
import { getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { getLockedOwnerId } from 'src/utils/locked.js';
import { isNsfwHidingEnabled } from 'src/utils/misc.js';
import { settleOperationStop, withOperationExecution } from 'src/utils/operation-execution.js';
import { RenderOutputRequest, evaluateRenderOutput, isQualifiedRenderSession } from 'src/utils/render-admission.js';
import { openRenderArtifact } from 'src/utils/render-artifact.js';
import {
  StudioExportContract,
  StudioExportImageContractSchema,
  StudioExportImageError,
  StudioExportMastering,
  StudioExportMasteringError,
  StudioExportRange,
  buildStudioExportContract,
  declareStudioTiming,
  findStudioExportOutputMismatch,
  findStudioExportRangeMismatch,
  parseStudioExportContract,
  resolveStudioExportTiming,
  studioMediaSources,
} from 'src/utils/studio-export-contract.js';
import {
  STUDIO_EXPORT_CONTENT_TYPES,
  STUDIO_EXPORT_LEASE_MS,
  STUDIO_EXPORT_PUBLISH_MAX_ATTEMPTS,
  STUDIO_EXPORT_SWEEP_MS,
  STUDIO_EXPORT_TICK_MS,
  StudioExportPublishSnapshot,
  StudioExportSmoothMotion,
  isInsideFolder,
  isStudioExportContentType,
  isStudioPhotoFormat,
  parseStudioExportPublishSnapshot,
  parseStudioExportSmoothMotion,
  studioExportFileName,
  studioExportLibraryPath,
  studioExportProjectPath,
  studioExportStagingFolder,
} from 'src/utils/studio-export.js';
import { isManagedStudioExportPath } from 'src/utils/studio-managed-paths.js';
import { canonicalJson } from 'src/utils/studio-project.js';
import { StudioDestination, StudioRefusalReason, isStudioUuid } from 'src/utils/studio-resources.js';
import {
  STUDIO_DOLBY_TOOLS_ID,
  STUDIO_DOLBY_TOOLS_QUALIFIED,
  checkStudioRights,
  studioRightsUseFor,
} from 'src/utils/studio-rights.js';
import { sealStudioSidecar, sidecarSealOf } from 'src/utils/studio-subtitle-sidecar.js';
import { StudioTimingError } from 'src/utils/studio-timing.js';

type RunningJob = { operation: MediaOperation; claimToken: string };

export type StudioExportCreateOptions = {
  /**
   * Keep the published result with its project, out of the library, even when every source is the
   * owner's (FL-194). The owner can save it to the library later; until then it is removed with
   * the project.
   */
  retainInProject?: boolean;
};

const isRetainedInProject = (snapshot: unknown): boolean =>
  !!snapshot && typeof snapshot === 'object' && (snapshot as { retain?: unknown }).retain === 'project';

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
    private media: MediaRepository,
    private restorations: AssetRestorationService,
    private mlDestinations: MlDestinationRepository,
    private events: EventRepository,
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
  async create(
    auth: AuthDto,
    projectId: string,
    dto: StudioExportCreateDto,
    options: StudioExportCreateOptions = {},
  ): Promise<StudioExportCreateResponseDto> {
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
    if (destination === StudioDestination.FrameleafCloud) {
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
    // FL-280: refuse a caller who is not the owner before resolving any source for them
    await this.requireOwnedProject(auth, projectId);
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

    const settings = {
      format: dto.format,
      color: dto.color,
      resolution: dto.resolution,
      quality: dto.quality ?? 'high',
      ...(dto.subtitleMode !== undefined && { subtitleMode: dto.subtitleMode }),
      ...(dto.range && { range: dto.range }),
      audio: dto.audio ?? 'preserve',
      ...(dto.mastering !== undefined && { mastering: structuredClone(dto.mastering) }),
    };
    if (isStudioPhotoFormat(dto.format)) {
      if (dto.subtitleMode !== undefined || (dto.audio !== undefined && dto.audio !== 'preserve'))
        throw new BadRequestException('Still exports do not support subtitle or audio settings');
      if (dto.resolution !== 'original' || dto.smoothMotion || (dto.quality !== undefined && dto.quality !== 'high'))
        throw new BadRequestException('Still exports use original document dimensions, high quality and no motion');
      if (dto.format !== 'sdr-jpeg' && process.env.FRAMELEAF_HDR_IMAGES !== 'experimental')
        throw new ConflictException({
          code: 'studio_export_hdr_unavailable',
          message: 'HDR still export is unavailable',
        });
    } else if (dto.resolution === 'original') {
      throw new BadRequestException('Original document dimensions are available for still exports');
    }
    const smoothMotion = await this.requireSmoothMotion(dto.smoothMotion);
    await this.requireRenderableOutput(dto.destination, settings);
    const { timing, contract } = await this.declareOutput(
      authorized.envelope.graph,
      authorized.manifest.entries,
      settings,
    );
    let subtitleSeal;
    if (dto.subtitleMode === 'sidecar') {
      if (dto.format !== 'mp4-h264' || dto.color !== 'preserve')
        throw new BadRequestException('Sidecar requires local MP4/H.264 output');
      try {
        subtitleSeal = sealStudioSidecar(
          authorized.envelope.graph as Record<string, unknown>,
          {
            revisionDigest: authorized.revision.digest,
            manifestDigest: authorized.manifest.digest,
            engineDigest: authorized.envelope.engineRevision,
          },
          dto.range,
        );
      } catch {
        throw new ConflictException({
          code: 'studio_export_sidecar_unsupported',
          message: 'The caption timeline cannot be exported as a durable SRT',
        });
      }
      contract.subtitles = subtitleSeal;
    }
    const sealedSettings = { ...settings, ...(subtitleSeal && { subtitleSeal }) };
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
          sourceEpochs: authorized.manifest.sourceEpochs,
          requestKey: dto.requestKey ?? null,
          studio: { stored: true, revision: authorized.revision.revision, cloudConsent: dto.cloudConsent === true },
          // FL-93 / FL-102: the cadence and source timing the worker renders on, and the precision
          // and audio its result must have. Publication holds the result to the contract.
          timing,
          contract,
          ...(subtitleSeal && { engineDigest: subtitleSeal.engineDigest }),
          ...(options.retainInProject && { retain: 'project' }),
          // FL-162: Smooth motion is its own job on the published video, never part of this render.
          ...(smoothMotion && { smoothMotion }),
        },
        settings: sealedSettings,
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
        settings: sealedSettings,
      },
    );

    this.logger.log(`Studio export ${version.id} queued as render ${operation.id} for project ${projectId}`);
    return { version: this.map(version, auth), operation: mapOperation(operation) };
  }

  /**
   * FL-93 / FL-102: what the export declares before it renders. The project's exact cadence and the
   * output cadence decision, every video source's timing map, and the precision and audio the
   * result must have, all from the stored graph and what the library has read of each source. A
   * project with no exact frame rate, or a video source whose timing has not been read yet, is
   * refused rather than rendered onto a grid nobody chose.
   */
  private async declareOutput(
    graph: unknown,
    entries: readonly StudioAuthorizedEntry[],
    settings: {
      format: string;
      color: string;
      audio: 'preserve' | 'stereo';
      mastering?: StudioExportMastering;
      range?: StudioExportRange;
    },
  ): Promise<{ timing: ReturnType<typeof resolveStudioExportTiming>; contract: StudioExportContract }> {
    const facts: StudioSourceMediaFacts[] = await this.repository.getSourceMediaFacts(studioMediaSources(entries).ids);
    try {
      const timing = declareStudioTiming(graph, entries, facts);
      if (settings.range && timing.decision.mode !== 'convert') {
        throw new StudioTimingError(
          'Frame ranges require rendered output at the declared cadence; timestamp passthrough is unsupported.',
        );
      }
      return { timing, contract: buildStudioExportContract(settings, graph, facts) };
    } catch (error) {
      if (error instanceof StudioTimingError) {
        throw new ConflictException({ message: error.message, code: 'studio_export_timing_unknown' });
      }
      if (error instanceof StudioExportImageError) {
        throw new ConflictException({ message: error.message, code: 'studio_export_image_unsupported' });
      }
      if (error instanceof StudioExportMasteringError) {
        throw new ConflictException({ message: error.message, code: 'studio_export_mastering_unknown' });
      }
      throw error;
    }
  }

  /**
   * FL-42: an export is queued only when a live, qualified render session for the chosen destination
   * verified what it needs: GPU memory for the resolution, an encoder for the format and the colour
   * precision. Otherwise it is refused up front with a reason the person can act on (choose a
   * smaller resolution, another format or SDR, or bring a qualified worker online) instead of
   * waiting in the queue for a worker that can never take it.
   */
  private async requireRenderableOutput(destination: MediaOperationDestination, settings: RenderOutputRequest) {
    const now = new Date();
    const sessions = await this.renderWorkers.listLiveSessions();
    const qualified = sessions.filter(
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
    );
    const candidates = await Promise.all(
      qualified.map(async ({ worker, session }) => {
        // FL-95 stores writer/container proof beside the session, keyed by its admitted id.
        // Read the same record as claim admission; never infer a muxer from the session's codecs.
        const capabilities = await this.renderWorkers.getSessionCapabilities(session.id);
        return {
          gpuMemoryBytes: session.gpuMemoryBytes === null ? null : Number(session.gpuMemoryBytes),
          codecs: capabilities?.codecs ?? [],
          formats: capabilities?.formats ?? [],
          colorPrecision: session.colorPrecision,
          engineDigest:
            worker.engineDigest && worker.engineDigest === session.engineDigest ? session.engineDigest : null,
        };
      }),
    );
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
      visibility: this.visibility(auth),
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
    // FL-326: partners hold their own copies, so another owner's source is reached only through an album
    const [ownedOk, album] = await Promise.all([
      this.access.asset.checkOwnerAccess(auth.user.id, owned, !!getLockedOwnerId(auth)),
      this.access.asset.checkAlbumAccess(auth.user.id, shared),
    ]);
    const reachable = (assetId: string) => (owned.has(assetId) ? ownedOk.has(assetId) : album.has(assetId));
    if (sources.some((source) => !reachable(source.assetId!))) {
      throw new NotFoundException('Studio export not found');
    }

    return new ImmichFileResponse({
      path: version.outputPath,
      contentType: version.outputContentType ?? 'application/octet-stream',
      cacheControl: CacheControl.PrivateWithoutCache,
    });
  }
  /** The SRT sibling never has a public capability. Every read boundary refreshes session privacy. */
  async subtitle(auth: AuthDto, id: string, range?: string) {
    if (!auth.session?.id || auth.apiKey || auth.sharedLink) throw new NotFoundException('Studio export not found');
    const unavailable = () => new NotFoundException('Studio export not found');
    const read = <T>(action: (version: StudioExportVersion) => Promise<T>) =>
      this.repository.withSubtitleAccess(id, auth.user.id, auth.session!.id, action).catch(() => {
        throw unavailable();
      });
    const version = await read((version) => Promise.resolve(version));
    const path = version.subtitlePath!;
    if (!isManagedStudioExportPath({ ...version, outputPath: path })) throw unavailable();
    const size = Number(version.subtitleSizeInBytes);
    let start = 0,
      end = size - 1;
    if (range !== undefined) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || !size || (!match[1] && !match[2])) throw new HttpException('Range not satisfiable', 416);
      if (match[1]) {
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start)
          throw new HttpException('Range not satisfiable', 416);
      } else {
        const suffix = Number(match[2]);
        if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new HttpException('Range not satisfiable', 416);
        start = Math.max(0, size - suffix);
      }
    }
    const check = async () =>
      read((current) => {
        if (
          current.subtitlePath !== path ||
          !current.subtitleChecksum?.equals(version.subtitleChecksum!) ||
          String(current.subtitleSizeInBytes) !== String(version.subtitleSizeInBytes)
        )
          throw unavailable();
        return Promise.resolve();
      });
    const stream = await openRenderArtifact(
      dirname(path),
      { outputPath: path, outputChecksum: version.subtitleChecksum!, sizeInBytes: size },
      check,
      { publishedName: basename(path), ...(size && { start, end }), checkEachChunk: true },
    ).catch(() => {
      throw unavailable();
    });
    return {
      stream,
      size,
      length: size ? end - start + 1 : 0,
      range: range === undefined ? null : `bytes ${start}-${end}/${size}`,
    };
  }

  /**
   * Save a result that was kept with its project to the owner's library (FL-194).
   *
   * Only on the owner's request, only for a published `project` result whose file is still there,
   * and only when every source is the owner's own: a result made with media shared with them stays
   * with its project, so a temporary share never becomes a permanent copy. The file is moved to an
   * ordinary upload path and adopted in one transaction that re-checks the sources and installs
   * their Locked and sensitive evidence on the new asset, exactly as publication does. A refusal
   * puts the file back where it was.
   */
  async saveToLibrary(auth: AuthDto, id: string): Promise<StudioExportVersionDto> {
    this.requireInteractive(auth);
    const version = await this.findOwned(auth, id);
    const sources = (await this.repository.getSources(version.id)).filter((source) => isLibrarySource(source));
    if (version.state === StudioExportVersionState.Published && version.scope === StudioExportScope.Library) {
      return this.map(version, auth, sources);
    }
    const container = STUDIO_EXPORT_CONTENT_TYPES[version.outputContentType ?? ''];
    if (
      version.state !== StudioExportVersionState.Published ||
      version.scope !== StudioExportScope.Project ||
      !version.outputPath ||
      version.outputRemovedAt ||
      !version.outputChecksum ||
      version.outputSizeInBytes === null ||
      !container
    ) {
      throw new ConflictException({ message: 'This export has no file to save', code: 'studio_export_not_saveable' });
    }
    if (sources.some((source) => source.ownerId !== auth.user.id)) {
      throw new ConflictException({
        message: 'A result made with media shared with you stays with its project',
        code: 'studio_export_source_access_lost',
      });
    }

    const project = version.projectId ? await this.projects.getById(version.projectId) : undefined;
    const keptPath = version.outputPath;
    const finalPath = studioExportLibraryPath(version.ownerId, version.id, container.extension);
    this.storage.mkdirSync(dirname(finalPath));
    await this.storage.rename(keptPath, finalPath);

    let saved: Awaited<ReturnType<StudioExportRepository['saveToLibrary']>>;
    try {
      saved = await this.repository.saveToLibrary({
        versionId: version.id,
        ownerId: version.ownerId,
        sources,
        nsfwHiding: await this.nsfwHiding(),
        path: finalPath,
        checksum: Buffer.from(version.outputChecksum),
        sizeInBytes: Number(version.outputSizeInBytes),
        contentType: version.outputContentType!,
        assetType: container.assetType,
        originalFileName: studioExportFileName(
          `${project?.name ?? ''}${container.assetType === AssetType.Image ? '_still' : ''}`,
          container.extension,
        ),
      });
    } catch (error) {
      await this.storage.rename(finalPath, keptPath).catch((restoreError) => {
        this.logger.warn(`Could not return ${finalPath} to ${keptPath}: ${errorMessage(restoreError)}`);
      });
      if (error instanceof StudioExportRefusal) {
        throw new ConflictException({ message: error.message, code: errorCode(error) });
      }
      throw error;
    }

    if (saved.reusedAssetId) {
      // The owner already had these bytes; the moved copy is referenced by nothing.
      await this.storage.unlink(finalPath).catch(() => {});
    }
    if (saved.createdAssetId) {
      await this.jobs.queue({
        name: JobName.AssetExtractMetadata,
        data: { id: saved.createdAssetId, source: 'upload' },
      });
    }
    this.logger.log(`Studio export ${version.id} saved to the library as ${saved.version.resultAssetId}`);
    return this.map(saved.version, auth, sources);
  }

  /* ------------------------------------------------------------------ */
  /* Render contract (called by the render worker service)               */
  /* ------------------------------------------------------------------ */

  /** The directory a render worker writes one render's output into. */
  stagingFolder(operation: Pick<MediaOperation, 'ownerId' | 'id'>): string {
    return studioExportStagingFolder(operation.ownerId, operation.id);
  }
  /** Retirement is admitted in the same replan transaction; FileDelete still rechecks every reference. */
  async retireArtifacts(
    tx: Transaction<DB> | undefined,
    operation: Pick<MediaOperation, 'ownerId' | 'id'>,
    paths: string[],
  ): Promise<void> {
    const folder = this.stagingFolder(operation);
    for (const path of paths) {
      if (!isInsideFolder(folder, path) || !/\/[a-f0-9-]{36}\.artifact$/.test(path))
        throw new BadRequestException('Paired retirement path is not server-staged');
    }
    if (paths.length > 0) {
      const intent = { name: JobName.FileDelete, data: { files: paths } } as const;
      if (tx) await this.jobs.queueInTransaction(tx, intent);
      else await this.jobs.queue(intent);
    }
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
      sources: claim.entries.map((entry) => {
        const source = studioExportSourceOf(entry);
        return {
          ...source,
          sourceEpoch:
            (operation.snapshot.sourceEpochs as { assetId: string; epoch: string }[] | undefined)?.find(
              (row) => row.assetId === source.assetId,
            )?.epoch ?? null,
        };
      }),
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

  /** Bind uploaded/recovered bytes to the same authorized sources recorded for the render. */
  async verifyRenderSources(operation: MediaOperation, entries: readonly StudioAuthorizedEntry[]): Promise<void> {
    const version = await this.repository.getByRenderOperation(operation.id);
    if (!version || version.revisionDigest !== operation.revisionId) {
      throw new BadRequestException('Export version no longer matches the render');
    }
    this.assertSameSources(await this.repository.getSources(version.id), entries);
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
    output: {
      path: string;
      checksum: string;
      sizeInBytes: string;
      contentType: string;
      remoteRef?: string | null;
      subtitle?: RenderArtifact;
    },
    requireActiveClaim = false,
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
        subtitle: output.subtitle,
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
          contract: parseStudioExportContract((operation.snapshot as { contract?: unknown } | null)?.contract),
          smoothMotion: parseStudioExportSmoothMotion(
            (operation.snapshot as { smoothMotion?: unknown } | null)?.smoothMotion,
          ),
          sourceEpochs: operation.snapshot.sourceEpochs,
          ...(isRetainedInProject(operation.snapshot) && { retain: 'project' }),
        } satisfies StudioExportPublishSnapshot as unknown as Record<string, unknown>,
        settings: version.settings,
        estimate: null,
        totalUnits: null,
        maxAttempts: STUDIO_EXPORT_PUBLISH_MAX_ATTEMPTS,
      }),
      requireActiveClaim,
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
  async run(job: RunningJob): Promise<void> {
    return withOperationExecution(
      {
        renew: () =>
          this.operations.heartbeat(job.operation.id, job.claimToken, STUDIO_EXPORT_LEASE_MS, {
            requireActiveClaim: true,
          }),
        stopped: () => this.stopping,
      },
      () => this.runClaim(job),
    );
  }

  private async runClaim({ operation, claimToken }: RunningJob): Promise<void> {
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
      // Resume accepted intents, including a commit whose acknowledgement was lost.
      if (!(await this.operations.beginValidation(operation.id, claimToken, true))) return;
      try {
        await this.resumePublished(version, operation, claimToken, snapshot);
      } catch (error) {
        if (
          !(await settleOperationStop(this.operations, operation, claimToken)) &&
          !(error instanceof StudioExportRefusal && error.code === 'claim-lost')
        ) {
          await this.failJob(operation, claimToken, error);
        }
      }
      return;
    }
    if (version.state !== StudioExportVersionState.Staged) {
      await this.settleCancelled(operation, claimToken);
      return;
    }

    if (!(await this.operations.beginValidation(operation.id, claimToken, true))) {
      return;
    }

    let prepared: PreparedPublication | undefined;
    let published: StudioExportPublished | undefined;
    try {
      prepared = await this.prepare(version, snapshot.retain === 'project', snapshot.contract ?? null);
      assertExecutionActive();
      published = await this.publishAcknowledged(version, operation, claimToken, prepared);
      // Cleanup only touches staging or the unused duplicate, never the accepted original.
      await this.afterPublished(published, prepared);
      await this.resumePublished(published.version, operation, claimToken, snapshot);
      this.logger.log(
        `Studio export ${version.id} published as version ${published.version.version} (${published.privacy.scope}${
          published.privacy.lockReason ? `, locked: ${published.privacy.lockReason}` : ''
        })`,
      );
    } catch (error) {
      if (await settleOperationStop(this.operations, operation, claimToken)) {
        if (prepared?.sanitized && !published) await this.storage.unlink(prepared.finalPath).catch(() => {});
        return;
      }
      if (published) {
        // The operation owns the sole retry budget. Its durable intents survive this failure.
        if (!(error instanceof StudioExportRefusal && error.code === 'claim-lost')) {
          await this.failJob(operation, claimToken, error);
        }
        return;
      }
      if (error instanceof StudioExportRefusal && error.code === 'claim-lost') {
        // Photo attempts own unique paths; a replacement claim cannot be using this one.
        if (prepared?.sanitized) await this.storage.unlink(prepared.finalPath).catch(() => {});
        return;
      }
      if (prepared) {
        await this.restoreStaged(prepared, operation, claimToken);
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
  private async prepare(
    version: StudioExportVersion,
    retainInProject: boolean,
    contract: StudioExportContract | null,
  ): Promise<PreparedPublication> {
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
      imports: await this.projects.listImportDeclarations(project.id),
      generated: await this.projects.listGeneratedResources(project.id),
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

    // A render the owner asked to keep with its project (FL-194) stays out of the library until they
    // save it there; one made with shared media always does.
    const expectedScope =
      retainInProject || resolution.manifest.entries.some((entry) => entry.sourceAccess === 'shared')
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
    const seal = sidecarSealOf(version.settings);
    if (seal) {
      const derived = sealStudioSidecar(
        (revision.envelope as { graph: Record<string, unknown> }).graph,
        {
          revisionDigest: version.revisionDigest,
          manifestDigest: seal.manifestDigest,
          engineDigest: seal.engineDigest,
        },
        { inPoint: seal.inPoint, outPoint: seal.outPoint },
      );
      if (
        canonicalJson(derived) !== canonicalJson(seal) ||
        canonicalJson(contract?.subtitles) !== canonicalJson(seal) ||
        version.engineDigest !== seal.engineDigest ||
        !version.subtitlePath ||
        !version.subtitleChecksum ||
        String(version.subtitleSizeInBytes) !== seal.sizeInBytes ||
        version.subtitleChecksum.toString('hex') !== seal.expectedSrtSha256
      )
        throw new StudioExportRefusal(
          'output-rejected',
          'The required subtitle sibling has no matching immutable authority',
        );
    }
    const photo = isStudioPhotoFormat((version.settings as { format?: unknown }).format);
    if (photo && !contract?.image)
      throw new StudioExportRefusal('output-rejected', 'The still export has no matching image contract');
    const outputId = photo ? `${version.id}-${randomUUID()}` : version.id;
    const finalPath =
      expectedScope === StudioExportScope.Library
        ? studioExportLibraryPath(version.ownerId, outputId, container.extension)
        : studioExportProjectPath(version.ownerId, outputId, container.extension);

    // An earlier attempt may have moved the file already and then stopped; accept it there too.
    let stagedPath = version.outputPath;
    const current = (await this.storage.checkFileExists(stagedPath)) ? stagedPath : finalPath;
    await this.verifyOutput(current, current === stagedPath ? staging : dirname(finalPath), version);
    await this.verifyContract(current, version, contract);
    let pair: PreparedPublication['pair'];
    if (seal) {
      const subtitleFinalPath = studioExportProjectPath(version.ownerId, version.id, '.srt');
      const files = [
        {
          stagedPath: version.outputPath!,
          currentPath: current,
          finalPath,
          checksum: version.outputChecksum!,
          size: String(version.outputSizeInBytes),
        },
        {
          stagedPath: version.subtitlePath!,
          currentPath: (await this.storage.checkFileExists(version.subtitlePath!))
            ? version.subtitlePath!
            : subtitleFinalPath,
          finalPath: subtitleFinalPath,
          checksum: version.subtitleChecksum!,
          size: seal.sizeInBytes,
        },
      ];
      pair = [];
      for (const file of files) {
        await assertOwnerRestorePath([staging, dirname(file.finalPath)], file.currentPath);
        const evidence = await captureOwnerRestoreFile(file.currentPath, async (path) =>
          (await this.crypto.hashFile(path, 'sha256')).toString('hex'),
        );
        if (
          !evidence.identity ||
          evidence.sha256 !== file.checksum.toString('hex') ||
          String(evidence.size) !== file.size
        )
          throw new StudioExportRefusal('output-rejected', 'A required paired file is missing or changed');
        // Never overwrite another inode, even if it reports the same digest.
        if (file.currentPath !== file.finalPath) await assertOwnerRestoreFile(file.finalPath, null);
        pair.push({ ...file, identity: evidence.identity });
      }
    }
    const nsfwHiding = await this.nsfwHiding();
    let sanitized: { checksum: Buffer; sizeInBytes: number } | undefined;
    if (photo && contract?.image) {
      // A worker's file is never published without server-side privacy processing. Keep its
      // immutable artifact for retry; each server attempt owns a distinct canonical still.
      stagedPath = join(staging, `canonical-${randomUUID()}${container.extension}`);
      this.storage.mkdirSync(staging);
      assertExecutionActive();
      try {
        if (contract.image.dynamicRange === 'hdr') {
          await this.media.generateHdrRenditions(
            current,
            [{ path: stagedPath, dynamicRange: 'hdr', format: contract.image.format === 'hdr-heic' ? 'heic' : 'jpeg' }],
            undefined,
            undefined,
            Buffer.from(version.outputChecksum),
          );
        } else {
          await this.media.writeStrippedStill(current, stagedPath, 'jpeg', 'srgb');
        }
        await this.verifyContract(stagedPath, version, contract);
        const stat = await this.storage.stat(stagedPath);
        if (!stat.isFile() || Number(stat.size) <= 0 || Number(stat.size) > 32 * 1024 * 1024)
          throw new StudioExportRefusal('output-rejected', 'The sanitized still exceeds the publication size limit');
        sanitized = { checksum: await this.crypto.hashFile(stagedPath, 'sha256'), sizeInBytes: Number(stat.size) };
        assertExecutionActive();
      } catch (error) {
        await this.storage.unlink(stagedPath).catch(() => {});
        throw error;
      }
    }

    if (!pair && current !== finalPath) {
      this.storage.mkdirSync(dirname(finalPath));
      assertExecutionActive();
      try {
        await this.storage.rename(stagedPath, finalPath);
      } catch (error) {
        if (sanitized) await this.storage.unlink(stagedPath).catch(() => {});
        throw error;
      }
    }

    return {
      versionId: version.id,
      pair,
      ...(sanitized && { sanitized }),
      stagedPath,
      finalPath,
      stagingFolder: staging,
      expectedScope,
      retainInProject,
      nsfwHiding,
      sources: recorded.filter((source) => isLibrarySource(source)),
      contentType,
      assetType: container.assetType,
      originalFileName: studioExportFileName(`${project.name}${photo ? '_still' : ''}`, container.extension),
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
   * FL-102: the file is probed here, on this server, and held to what the export promised: the bit
   * codec, depth and transfer of its format and colour, the source audio layout and rate (or the chosen
   * stereo downmix), and audio that ends with the picture. An export submitted before the contract
   * existed is still held to the precision its settings promise.
   */
  private async verifyContract(
    path: string,
    version: StudioExportVersion,
    contract: StudioExportContract | null,
  ): Promise<void> {
    const settings = version.settings as {
      format: string;
      color: string;
      range?: StudioExportRange;
      mastering?: StudioExportMastering;
    };
    const range = contract?.range;
    if (
      (settings.range || range) &&
      (!settings.range ||
        !range ||
        settings.range.inPoint !== range.inPoint ||
        settings.range.outPoint !== range.outPoint)
    ) {
      throw new StudioExportRefusal('output-rejected', 'The render has no matching frame range contract');
    }
    if (isStudioPhotoFormat(settings.format)) {
      const parsed = StudioExportImageContractSchema.safeParse(contract?.image);
      const image = parsed.success ? parsed.data : null;
      if (
        !image ||
        image.format !== settings.format ||
        version.outputContentType !== (image.format === 'hdr-heic' ? 'image/heic' : 'image/jpeg')
      )
        throw new StudioExportRefusal('output-rejected', 'The still file has no matching output contract');
      const encoding = await this.media.inspectImageEncoding(path);
      const dimensions = encoding.width && encoding.height ? encoding : await this.media.getImageMetadata(path);
      if (
        dimensions.width !== image.width ||
        dimensions.height !== image.height ||
        encoding.dynamicRange !== image.dynamicRange ||
        (image.dynamicRange === 'hdr' && !encoding.reconstructionAvailable) ||
        (image.format === 'hdr-heic'
          ? encoding.container !== 'heif' ||
            encoding.codec !== 'hevc' ||
            (encoding.bitDepth ?? 0) < 10 ||
            encoding.transfer !== 16
          : encoding.container !== 'jpeg')
      )
        throw new StudioExportRefusal(
          'output-rejected',
          'The encoded still does not preserve its declared dimensions, format and dynamic range',
        );
      return;
    }
    const expected = contract ?? buildStudioExportContract(settings, null, []);
    const probe = await this.media.probe(path).catch(() => null);
    if (!probe) {
      throw new StudioExportRefusal('output-rejected', 'The rendered file could not be read as video');
    }
    const [video] = probe.videoStreams;
    const mastering =
      expected.video.mastering && video
        ? await this.media.probeHdrMastering(path, video.index).catch(() => [])
        : undefined;
    const mismatch = findStudioExportOutputMismatch(expected, { ...probe, mastering }, settings.format);
    if (mismatch) {
      throw new StudioExportRefusal('output-rejected', mismatch);
    }
    if (range) {
      const video = probe.videoStreams[0];
      const packets = await this.media.probePackets(path, video.index).catch(() => null);
      const rangeMismatch = findStudioExportRangeMismatch(range, video, packets);
      if (rangeMismatch) throw new StudioExportRefusal('output-rejected', rangeMismatch);
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
    const syncDirectories = async (from: string, to: string) => {
      const source = dirname(from);
      const folders = new Set([source]);
      // Retry directories may already exist after an interrupted mkdir; persist their entries too.
      for (let folder = dirname(to); ; folder = dirname(folder)) {
        folders.add(folder);
        if (folder === source || source.startsWith(folder + sep) || folder === dirname(folder)) break;
      }
      for (const folder of folders) {
        const directory = await open(folder, constants.O_RDONLY);
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    };
    if (prepared.pair)
      prepared.files = {
        paths: prepared.pair.flatMap((file) => [file.stagedPath, file.finalPath]),
        move: async () => {
          for (const file of prepared.pair!) {
            await assertOwnerRestoreFile(file.currentPath, file.identity, file.currentPath === file.finalPath);
            const measured = await captureOwnerRestoreFile(file.currentPath, async (path) =>
              (await this.crypto.hashFile(path, 'sha256')).toString('hex'),
            );
            await assertOwnerRestoreFile(file.currentPath, file.identity, file.currentPath === file.finalPath);
            if (
              !measured.identity ||
              measured.sha256 !== file.checksum.toString('hex') ||
              String(measured.size) !== file.size
            )
              throw new StudioExportRefusal('output-rejected', 'A required paired file changed after authority waits');
            if (file.currentPath !== file.finalPath) {
              await assertOwnerRestoreFile(file.finalPath, null);
              this.storage.mkdirSync(dirname(file.finalPath));
              await this.storage.rename(file.currentPath, file.finalPath);
              file.currentPath = file.finalPath;
            }
            await syncDirectories(file.stagedPath, file.finalPath);
            await assertOwnerRestoreFile(file.finalPath, file.identity, true);
          }
        },
        rollback: async () => {
          const errors: unknown[] = [];
          for (const file of prepared.pair!.toReversed()) {
            try {
              if (file.currentPath === file.stagedPath) continue;
              await assertOwnerRestoreFile(file.currentPath, file.identity, true);
              await assertOwnerRestoreFile(file.stagedPath, null);
              this.storage.mkdirSync(dirname(file.stagedPath));
              await this.storage.rename(file.currentPath, file.stagedPath);
              file.currentPath = file.stagedPath;
              await syncDirectories(file.finalPath, file.stagedPath);
              await assertOwnerRestoreFile(file.stagedPath, file.identity, true);
            } catch (error) {
              errors.push(error);
            }
          }
          if (errors.length > 0) throw new AggregateError(errors, 'Paired file recovery is pending');
        },
      };
    return settleStudioExportPublication(
      this.repository,
      version.id,
      operation.id,
      () =>
        this.repository.publish(
          {
            versionId: version.id,
            operationId: operation.id,
            claimToken,
            ownerId: version.ownerId,
            sources: prepared.sources,
            expectedScope: prepared.expectedScope,
            retainInProject: prepared.retainInProject,
            nsfwHiding: prepared.nsfwHiding,
            path: prepared.finalPath,
            checksum: prepared.sanitized?.checksum ?? Buffer.from(version.outputChecksum!),
            sizeInBytes: prepared.sanitized?.sizeInBytes ?? Number(version.outputSizeInBytes),
            contentType: prepared.contentType,
            assetType: prepared.assetType,
            originalFileName: prepared.originalFileName,
            ...(prepared.pair && {
              subtitle: {
                outputPath: prepared.pair[1].finalPath,
                outputChecksum: Buffer.from(prepared.pair[1].checksum),
                sizeInBytes: Number(prepared.pair[1].size),
              },
              files: prepared.files,
            }),
          },
          (tx, assetId) => this.schedulePublishedMetadata(tx, assetId),
          (tx, published, label) => this.schedulePublishedNotification(tx, published, label),
        ),
      prepared.pair
        ? (committed) =>
            committed.subtitlePath === prepared.pair![1].finalPath &&
            committed.subtitleChecksum?.equals(prepared.pair![1].checksum) === true &&
            String(committed.subtitleSizeInBytes) === prepared.pair![1].size &&
            !committed.subtitleRemovedAt &&
            committed.outputChecksum?.equals(prepared.pair![0].checksum) === true &&
            String(committed.outputSizeInBytes) === prepared.pair![0].size &&
            (committed.outputPath === prepared.pair![0].finalPath || !!committed.resultAssetId)
        : undefined,
    );
  }

  private async afterPublished(published: StudioExportPublished, prepared: PreparedPublication): Promise<void> {
    if (published.reusedAssetId) {
      // The owner already had these bytes; the moved copy is referenced by nothing.
      await this.storage.unlink(prepared.finalPath).catch(() => {});
    }
    await this.storage.unlinkDir(prepared.stagingFolder, { recursive: true, force: true }).catch(() => {});
  }

  private schedulePublishedMetadata(tx: Transaction<DB>, assetId: string): Promise<void> {
    return this.jobs.queueInTransaction(tx, {
      name: JobName.AssetExtractMetadata,
      data: { id: assetId, source: 'upload' },
    });
  }

  private schedulePublishedNotification(
    tx: Transaction<DB>,
    version: StudioExportVersion,
    label: string,
  ): Promise<void> {
    return this.jobs.queueInTransaction(tx, {
      name: JobName.PushDeliver,
      data: {
        notice: {
          type: PushEventType.RenderFinished,
          userIds: [version.ownerId],
          title: 'Render finished',
          body: `${label.trim() || 'Your Studio export'} is ready`,
          systemTemplate: label.trim()
            ? { version: 1, key: 'studio-export-ready-named', args: { label: label.trim() } }
            : { version: 1, key: 'studio-export-ready', args: {} },
          data: {
            versionId: version.id,
            projectId: version.projectId,
            status: 'published',
            ...pushJobData(
              version.renderOperationId
                ? { id: version.renderOperationId, type: 'media-operation', actions: [] }
                : null,
            ),
          },
          assetIds: version.resultAssetId ? [version.resultAssetId] : [],
        },
      },
    });
  }

  private async resumePublished(
    version: StudioExportVersion,
    operation: MediaOperation,
    claimToken: string,
    snapshot: StudioExportPublishSnapshot,
  ): Promise<void> {
    const followups = await this.repository.publicationFollowups(
      operation.id,
      claimToken,
      (tx, assetId) => this.schedulePublishedMetadata(tx, assetId),
      (tx, published, label) => this.schedulePublishedNotification(tx, published, label),
    );
    let needsAttention = !followups;
    if (followups) {
      for (const effect of ['smoothMotion'] as const) {
        const state = followups[effect];
        if (state === 'accepted') continue;
        if (state !== 'pending') {
          needsAttention = true;
          if (state === 'dispatching') {
            await this.repository.transitionPublicationFollowup(
              operation.id,
              claimToken,
              effect,
              state,
              'needs_attention',
            );
          }
          continue;
        }
        assertExecutionActive();
        if (
          !(await this.repository.transitionPublicationFollowup(
            operation.id,
            claimToken,
            effect,
            'pending',
            'dispatching',
          ))
        ) {
          throw new StudioExportRefusal('claim-lost', 'The publication follow-up claim changed');
        }
        let accepted = false;
        let receipt: StudioPublicationFollowups['smoothMotionReceipt'];
        try {
          assertExecutionActive();
          if (snapshot.smoothMotion && version.resultAssetId) {
            // Destination and factor are the immutable user request. No replacement or paid fallback.
            const queued = await this.restorations.queueExportSmoothMotion({
              ownerId: version.ownerId,
              assetId: version.resultAssetId,
              exportName: operation.label,
              ...snapshot.smoothMotion,
            });
            if (queued?.id && queued.previewOperationId) {
              receipt = { restorationId: queued.id, operationId: queued.previewOperationId };
              accepted = true;
            }
          }
          assertExecutionActive();
        } catch (error) {
          accepted = false;
          this.logger.warn(`Studio export ${version.id} ${effect} needs attention: ${errorMessage(error)}`);
        }
        const next = accepted ? 'accepted' : 'needs_attention';
        if (
          !(await this.repository.transitionPublicationFollowup(
            operation.id,
            claimToken,
            effect,
            'dispatching',
            next,
            receipt,
          ))
        ) {
          throw new StudioExportRefusal('claim-lost', 'The publication follow-up acknowledgement lost its claim');
        }
        needsAttention ||= !accepted;
      }
    }
    needsAttention ||= !!followups && followups.notification !== 'accepted';
    if (needsAttention) {
      await this.repository.publicationNeedsAttention(operation.id, claimToken);
      await this.operations.fail(
        operation.id,
        claimToken,
        {
          errorCode: 'studio_export_followup_needs_attention',
          error:
            'Your export is published. A notification or requested Smooth motion could not be confirmed. Check the export and its Enhance panel before starting another request.',
        },
        { retry: false },
      );
    } else {
      await this.finishJob(operation, claimToken, version.resultAssetId);
    }
    await settleOperationExecution();
  }

  /** The Smooth motion asked for with an export: a destination that exists and may run interpolation. */
  private async requireSmoothMotion(
    requested: StudioExportCreateDto['smoothMotion'],
  ): Promise<StudioExportSmoothMotion | null> {
    if (!requested) {
      return null;
    }
    const destination = await this.mlDestinations.getById(requested.destinationId);
    if (!destination?.enabled || !destination.workloads.includes(MlWorkload.Interpolation)) {
      throw new BadRequestException({
        message: 'That destination does not run Smooth motion',
        code: 'studio_export_smooth_motion_destination',
      });
    }
    return { factor: requested.factor, destinationId: destination.id };
  }

  /** Undo the move of an attempt that did not publish, so the retry and retention find the file. */
  private async restoreStaged(
    prepared: PreparedPublication,
    operation?: MediaOperation,
    claimToken?: string,
  ): Promise<void> {
    if (prepared.files) {
      if (!operation || !claimToken) throw new Error('Paired recovery requires the publication claim');
      await this.repository.restorePublicationFiles(
        { versionId: prepared.versionId, operationId: operation.id, claimToken, sources: prepared.sources },
        prepared.files,
      );
      return;
    }
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
    await this.operations.beginValidation(operation.id, claimToken, true);
    if (!(await this.operations.complete(operation.id, claimToken, { resultAssetId }, undefined, true))) {
      await this.operations.acknowledgeCancel(operation.id, claimToken, { released: true });
    }
  }

  /**
   * FL-228: tell the owner's devices that the render finished. The result is offered as the preview;
   * the push service drops it when the published item is Locked or sensitive (FL-212/FL-213). A
   * failure to notify never touches the export.
   */
  private async notifyRenderFinished(
    version: StudioExportVersion,
    status: 'published' | 'failed',
    resultAssetId: string | null,
    label: string | null,
  ): Promise<void> {
    const name = label?.trim() || 'Your Studio export';
    try {
      await this.events.emit('PushNotify', {
        type: PushEventType.RenderFinished,
        userIds: [version.ownerId],
        title: status === 'published' ? 'Render finished' : 'Render failed',
        body: status === 'published' ? `${name} is ready` : `${name} could not be finished`,
        systemTemplate: label?.trim()
          ? {
              version: 1,
              key: status === 'published' ? 'studio-export-ready-named' : 'studio-export-failed-named',
              args: { label: name },
            }
          : { version: 1, key: status === 'published' ? 'studio-export-ready' : 'studio-export-failed', args: {} },
        // native apps: a failed render offers Retry (`POST /media-operations/{job}/retry`)
        data: {
          versionId: version.id,
          projectId: version.projectId,
          status,
          ...pushJobData(
            version.renderOperationId
              ? {
                  id: version.renderOperationId,
                  type: 'media-operation',
                  actions: status === 'failed' ? ['retry'] : [],
                }
              : null,
          ),
        },
        assetIds: resultAssetId ? [resultAssetId] : [],
      });
    } catch (error) {
      this.logger.warn(`Could not announce Studio export ${version.id}: ${errorMessage(error)}`);
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
      await this.notifyRenderFinished(version, 'failed', null, operation.label);
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
      try {
        await this.repository.markOutputRemoved(
          version.id,
          async (current) => {
            const path = version.role === 'subtitle' ? current.subtitlePath : current.outputPath;
            const checksum = version.role === 'subtitle' ? current.subtitleChecksum : current.outputChecksum;
            const size = version.role === 'subtitle' ? current.subtitleSizeInBytes : current.outputSizeInBytes;
            if (!path || !isManagedStudioExportPath({ ...current, outputPath: path }))
              throw new Error('Studio export cleanup path is not a declared managed file');
            await assertOwnerRestorePath([StorageCore.getFolderLocation(StorageFolder.Exports, current.ownerId)], path);
            const evidence = await captureOwnerRestoreFile(path, async (path) =>
              (await this.crypto.hashFile(path, 'sha256')).toString('hex'),
            );
            if (
              evidence.identity &&
              ((checksum && evidence.sha256 !== checksum.toString('hex')) ||
                (size !== null && evidence.size !== BigInt(size)))
            )
              throw new Error('Studio export cleanup file identity changed');
            await assertOwnerRestoreFile(path, evidence.identity);
            await this.storage.unlink(path);
          },
          version.role,
        );
      } catch (error) {
        this.logger.warn(`Could not remove Studio export ${version.id}; its cleanup will retry: ${error}`);
      }
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

  /** The owner's own project: `404` for anyone who cannot see it, `403` for a reviewer (FL-112). */
  private requireOwnedProject(auth: AuthDto, projectId: string) {
    return this.studio.requireOwnedProject(auth, projectId, 'Only the owner can export a Studio project');
  }

  private async findOwned(auth: AuthDto, id: string): Promise<StudioExportVersion> {
    // A Locked result, or one whose source is hidden from the session now, exists only for a session
    // that may see it (FL-34, FL-195 follow-up): its file, download, library save and share with it.
    const version = await this.repository.getForOwner(id, auth.user.id, this.visibility(auth));
    const privacy = (version?.privacy ?? {}) as { lockReason?: string | null };
    if (!version || (privacy.lockReason && !getLockedOwnerId(auth))) {
      throw new NotFoundException('Studio export not found');
    }
    return version;
  }

  /** How a version is judged for this session (`StudioExportVisibility`). */
  private visibility(auth: AuthDto): StudioExportVisibility {
    return { ...getHiddenContentQueryOptions(auth), revealed: !!getLockedOwnerId(auth) };
  }

  private async nsfwHiding(): Promise<boolean> {
    const config = await getConfig(
      { configRepo: this.configRepository, metadataRepo: this.systemMetadata, logger: this.logger },
      { withCache: true },
    );
    return isNsfwHidingEnabled(config.machineLearning);
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
    const { subtitleSeal: _privateSubtitleSeal, ...publicSettings } = version.settings;
    const settings = publicSettings as StudioExportVersionDto['settings'];
    const seal = sidecarSealOf(version.settings);
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
      ...(seal && {
        subtitle: hidden
          ? null
          : {
              codec: 'srt' as const,
              required: true as const,
              cueCount: seal.cueCount,
              sizeInBytes: seal.sizeInBytes,
              sha256: seal.expectedSrtSha256,
              available:
                version.state === StudioExportVersionState.Published &&
                !!version.subtitlePath &&
                !version.subtitleRemovedAt,
            },
      }),
      errorCode: version.errorCode,
      error: version.error,
      createdAt: asIso(version.createdAt)!,
      publishedAt: asIso(version.publishedAt),
      cancelledAt: asIso(version.cancelledAt),
    };
  }
}

type PreparedPublication = {
  pair?: {
    stagedPath: string;
    currentPath: string;
    finalPath: string;
    checksum: Buffer;
    size: string;
    identity: string;
  }[];
  files?: { paths: readonly string[]; move: () => Promise<void>; rollback: () => Promise<void> };
  sanitized?: { checksum: Buffer; sizeInBytes: number };
  versionId: string;
  stagedPath: string;
  finalPath: string;
  stagingFolder: string;
  expectedScope: StudioExportScope;
  retainInProject: boolean;
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
  matches?: (committed: StudioExportVersion) => boolean,
): Promise<StudioExportPublished> => {
  try {
    return await attempt();
  } catch (error) {
    if (error instanceof StudioExportRefusal) {
      throw error;
    }
    const committed = await repository.getById(versionId);
    if (
      committed?.state === StudioExportVersionState.Published &&
      committed.publishOperationId === operationId &&
      (!matches || matches(committed))
    ) {
      const privacy = (committed.privacy ?? {}) as unknown as StudioExportPublished['privacy'];
      return { status: 'published', version: committed, privacy, createdAssetId: null, reusedAssetId: null };
    }
    throw error;
  }
};
