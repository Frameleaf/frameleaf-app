import { BadRequestException, ConflictException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { join } from 'node:path';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent } from 'src/decorators.js';
import { StudioPreviewDto, StudioPreviewRequestDto, StudioPreviewResponseDto } from 'src/dtos/studio-preview.dto.js';
import {
  CacheControl,
  ImmichWorker,
  MediaOperationDestination,
  MediaOperationKind,
  StorageFolder,
  StudioPreviewQuality,
  StudioPreviewStatus,
} from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { StudioPreviewFrame, StudioPreviewRepository } from 'src/repositories/studio-preview.repository.js';
import { StudioProjectService, StudioRevisionEvent } from 'src/services/studio-project.service.js';
import {
  STUDIO_GRANT_TTL_SECONDS,
  StudioAuthorizedManifest,
  StudioResourceService,
} from 'src/services/studio-resource.service.js';
import { ImmichFileResponse } from 'src/utils/file.js';
import { rational } from 'src/utils/rational-time.js';
import { isInsideFolder } from 'src/utils/studio-export.js';
import {
  PREVIEW_CONTENT_TYPES,
  PREVIEW_FRAMES_PER_REVISION,
  PREVIEW_RETENTION_MS,
  PREVIEW_REVISIONS_PER_PROJECT,
  PREVIEW_SWEEP_MS,
  PREVIEW_TOMBSTONE_MS,
  PreviewBinding,
  PreviewStatusValue,
  PreviewTime,
  decidePreviewDelivery,
  isValidPreviewViewport,
  planPreviewEviction,
  previewCacheKey,
  previewETag,
  previewExpiry,
  previewTimeKey,
} from 'src/utils/studio-preview.js';
import { StudioDestination } from 'src/utils/studio-resources.js';

/** The frame-identity part of a request: everything but the project and revision it names. */
export type StudioPreviewFrameRequest = Omit<StudioPreviewRequestDto, 'projectId' | 'revision'>;

/** How many rows one project's eviction pass considers. Well above the per-revision cap. */
const PROJECT_SCAN_LIMIT = 500;
/** How many retired frames one sweep pass removes. */
const SWEEP_BATCH = 500;

/**
 * Where a render worker writes one preview frame: a directory the server names for that frame,
 * inside the owner's private exports folder, never shared between frames.
 */
export const studioPreviewFrameFolder = (ownerId: string, frameId: string) =>
  join(StorageCore.getFolderLocation(StorageFolder.Exports, ownerId), 'studio-previews', frameId);

const previewFrameIdOf = (operation: Pick<MediaOperation, 'snapshot'>): string | null => {
  const snapshot = operation.snapshot as Record<string, unknown> | null;
  const id = snapshot?.previewFrameId;
  return typeof id === 'string' ? id : null;
};

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500);

const asIso = (value: Date | string | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
};

const asRequiredIso = (value: Date | string): string => asIso(value) as string;

const asString = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

const toPreviewTime = (frame: StudioPreviewFrame): PreviewTime =>
  rational(Number(frame.timeNumerator), Number(frame.timeDenominator));

const staleRevision = (currentRevision: number) =>
  new ConflictException({
    message: 'The project has moved to a newer revision',
    code: 'studio_preview_stale_revision',
    currentRevision,
  });

/**
 * Revision-bound remote preview (FL-96, `STU-402`), bound to stored project revisions (FL-89).
 *
 * The contract in one sentence: a frame is delivered only to the account that asked for it, only
 * while that account may still read the project, only while the stored revision it was rendered
 * for is still the project's head, and only with an entity tag that carries its binding, so a
 * stale revision is *refused* rather than served from anybody's cache.
 *
 * What this service deliberately does not do:
 *
 * - **It does not run anything.** A request becomes a durable media operation of kind
 *   `studio_preview` (FL-104's model) and stops there. Admission, claiming and the GPU are
 *   FL-95's (`STU-401`); this service would be wrong to decide a worker is trustworthy.
 * - **It does not accept a graph or a digest from the client.** The client names a project and
 *   the stored revision it is looking at. FL-89's `authorizeRevision` reads that revision from
 *   storage and FL-90 resolves it for the acting account, interactively, so Locked sources are
 *   refused here exactly as everywhere else a person looks at media. The render job carries only
 *   the project and revision; the worker re-reads the stored graph and re-resolves it as a
 *   background runner (the owner rule for backend tasks), and no graph URL, local path or browser
 *   handle ever travels to a worker through preview.
 * - **It does not talk to the client's SDK.** The browser reaches it only through the Svelte
 *   host; the React engine has no API dependency at all.
 */
@Injectable()
export class StudioPreviewService {
  private sweepHandle?: ReturnType<typeof setInterval>;
  private sweeping?: Promise<void>;

  constructor(
    private logger: LoggingRepository,
    private repository: StudioPreviewRepository,
    private operations: MediaOperationRepository,
    private resources: StudioResourceService,
    private projects: StudioProjectService,
    private storage: StorageRepository,
  ) {
    this.logger.setContext(StudioPreviewService.name);

    // A committed revision supersedes every preview of the revisions before it the moment it is
    // stored, rather than at the next request: work for a graph that no longer exists is waste,
    // and the frame the person is waiting for must not queue behind it.
    this.projects.registerRevisionListener(async (event) => {
      await this.revisionCommitted(event);
    });
  }

  /**
   * Ask for one frame of the project's current stored revision. The route's entry point.
   *
   * Refused, in this order, so the client hears the true reason:
   *
   *   1. time or viewport     — nothing is read for a request that could never be rendered
   *   2. access               — `404`, the same answer as for a project that does not exist
   *   3. revision             — `409 studio_preview_stale_revision` with the current revision
   *   4. sources              — `409 studio_preview_sources_refused` when any referenced source
   *                             is unavailable to this account (trashed, unshared, Locked…)
   */
  async request(auth: AuthDto, dto: StudioPreviewRequestDto): Promise<StudioPreviewResponseDto> {
    this.parseTime(dto);
    this.assertViewport(dto);

    // The head, not the revision the client named: a stale request is answered with the current
    // revision, and the resolution it paid for is the one the client's retry will reuse.
    const authorization = await this.projects.authorizeRevision(auth, {
      projectId: dto.projectId,
      destination: StudioDestination.Local,
    });

    const current = authorization.revision.revision;
    if (dto.revision !== current) {
      throw staleRevision(current);
    }

    if (!authorization.manifest.complete) {
      // A picture assembled without a refused source would be a quietly wrong frame rather than
      // a missing one, so the whole request is refused.
      throw new ConflictException({
        message: 'A source this project uses is not available to you',
        code: 'studio_preview_sources_refused',
        currentRevision: current,
        refusedCount: authorization.manifest.refusedCount,
      });
    }

    return this.requestForManifest(auth, authorization.manifest, {
      time: dto.time,
      quality: dto.quality,
      viewportWidth: dto.viewportWidth,
      viewportHeight: dto.viewportHeight,
      seekGeneration: dto.seekGeneration,
    });
  }

  /**
   * Ask for one frame against FL-90's authorized manifest for a stored revision.
   *
   * The manifest digest is the binding, so a frame stops being deliverable not only when the
   * revision changes but when the resolution does — when a source is trashed, unshared, relocked
   * or replaced — which a revision number on its own cannot express. A preview grant is issued
   * to this viewer session and re-verified on every frame read.
   */
  async requestForManifest(
    auth: AuthDto,
    manifest: StudioAuthorizedManifest,
    dto: StudioPreviewFrameRequest,
  ): Promise<StudioPreviewResponseDto> {
    const now = new Date();
    const time = this.parseTime(dto);
    this.assertViewport(dto);

    // Throws when the manifest was not issued by this process, has expired, is incomplete or
    // was altered. A preview never renders from a partial manifest.
    this.resources.assertAuthorizedManifest(manifest, { now });
    if (manifest.userId !== auth.user.id) {
      // Somebody else's resolution answers exactly like a project that does not exist.
      throw new NotFoundException('Studio project not found');
    }

    /**
     * The grant names the manifest, the revision and this session. A session id rather than a
     * worker id, because the thing redeeming it is the browser that asked for the picture.
     */
    const grantSessionId = auth.session?.id ?? auth.user.id;
    const grantToken = this.resources.issuePreviewGrant(manifest, {
      workerId: grantSessionId,
      ttlSeconds: STUDIO_GRANT_TTL_SECONDS,
      now,
    });

    return this.record(auth, {
      time,
      dto,
      now,
      manifest,
      grant: { token: grantToken, sessionId: grantSessionId },
    });
  }

  /** Status of one preview. Owner-scoped; a frame that is not yours is not found. */
  async get(auth: AuthDto, id: string): Promise<StudioPreviewDto> {
    return this.map(await this.findOwned(auth, id));
  }

  /**
   * The frame itself.
   *
   * The refusal ladder is in {@link decidePreviewDelivery} so it can be read and tested without
   * a database. Note that the revision check runs *before* the conditional-request check: a
   * `304` on a superseded frame would leave a stale picture on screen, which is the single
   * outcome this endpoint exists to prevent.
   */
  async getFrame(
    auth: AuthDto,
    id: string,
    options: { ifNoneMatch?: string },
  ): Promise<{ file: ImmichFileResponse; etag: string } | { notModified: true; etag: string }> {
    const frame = await this.findOwned(auth, id);

    /**
     * Project storage is the revision authority, and it is asked on every frame. A reviewer who
     * left the space, or a project that was deleted, stops receiving frames here and the stored
     * frame is dropped; the answer is the same `404` as for a frame that never existed.
     */
    const head = await this.projects.getReadableRevision(frame.projectId, auth.user.id);
    if (head === null) {
      await this.dropFrames([frame]);
      throw new NotFoundException('Preview frame not found');
    }

    /**
     * The FL-90 grant is checked on *every* frame request, not once at admission.
     *
     * `verifyReadGrant` re-checks the signature, the expiry, the session it was issued to and
     * the acting user, so an expired or re-resolved session stops receiving frames immediately
     * rather than at the next render.
     */
    if (frame.grantToken) {
      const verification = await this.resources.verifyReadGrant(frame.grantToken, {
        workerId: frame.grantSessionId ?? auth.session?.id ?? auth.user.id,
        auth,
      });
      if (!verification.valid) {
        await this.dropFrames([frame]);
        throw new ConflictException({
          message: 'This preview is no longer authorized',
          code: 'studio_preview_grant_revoked',
          reason: verification.reason,
        });
      }
    }

    /**
     * Current only when the frame was rendered for the stored head *and* for the newest
     * resolution this account has previewed it with. A row that carries no grant or no revision
     * was recorded before previews were bound to project storage and can never be current.
     */
    const onHead = !!frame.grantToken && frame.projectRevision !== null && Number(frame.projectRevision) === head;
    const currentBinding = onHead
      ? ((await this.repository.getLatestRevisionDigest(frame.projectId, frame.ownerId)) ?? frame.revisionDigest)
      : null;

    const binding: PreviewBinding = {
      ownerId: frame.ownerId,
      projectId: frame.projectId,
      revisionDigest: frame.revisionDigest,
      time: toPreviewTime(frame),
      quality: frame.quality,
      viewportWidth: frame.viewportWidth,
      viewportHeight: frame.viewportHeight,
    };
    const etag = previewETag(binding);

    const decision = decidePreviewDelivery({
      status: frame.status as PreviewStatusValue,
      revisionDigest: frame.revisionDigest,
      currentRevisionDigest: currentBinding,
      framePath: frame.framePath,
      expiresAt: frame.expiresAt ? new Date(frame.expiresAt as unknown as string) : null,
      now: new Date(),
      ifNoneMatch: options.ifNoneMatch,
      etag,
    });

    if (decision.deliver) {
      // Recency drives eviction, so the read has to record itself.
      await this.repository.markAccessed(frame.id, new Date());
      return {
        etag,
        file: new ImmichFileResponse({
          path: frame.framePath as string,
          contentType: frame.contentType ?? 'image/png',
          // A preview frame is private and bound to a revision that can be superseded at any
          // moment, so the browser must revalidate rather than reuse it on its own authority.
          cacheControl: CacheControl.PrivateWithoutCache,
        }),
      };
    }

    if (decision.outcome === 'not-modified') {
      return { notModified: true, etag };
    }

    if (decision.outcome === 'evicted' || decision.outcome === 'expired') {
      throw new GoneException({ message: 'This preview frame is no longer stored', code: decision.code });
    }

    throw new ConflictException({
      message:
        decision.outcome === 'stale-revision'
          ? 'The project has moved to a newer revision'
          : decision.outcome === 'failed'
            ? 'This preview could not be rendered'
            : 'This preview frame is still rendering',
      code: decision.code,
      currentRevision: head,
    });
  }

  /**
   * Cancel a preview the client no longer wants.
   *
   * Marked evicted rather than deleted: the client may still hold the id, and "gone" is a truer
   * answer than "not found". The durable operation is cancelled so the worker actually stops.
   * Asking for the same frame again revives the row and renders it afresh.
   */
  async cancel(auth: AuthDto, id: string): Promise<StudioPreviewDto> {
    const frame = await this.findOwned(auth, id);
    const [cancelled] = await this.dropFrames([frame]);
    await this.cancelOperation(frame, auth.user.id);
    return this.map(cancelled ?? frame);
  }

  /**
   * FL-89's revision listener: a stored revision was committed.
   *
   * Supersedes every live preview of the project rendered for an earlier revision — the owner's
   * and every reviewer's — and cancels the ones still rendering. Each account's frames are bound
   * to its own resolution digest, so this keys on the stored revision number, which names them
   * all; the event's graph digest would match none of them.
   */
  async revisionCommitted(event: Pick<StudioRevisionEvent, 'projectId' | 'revision'>): Promise<StudioPreviewFrame[]> {
    const superseded = await this.repository.supersedeBeforeRevision(event.projectId, event.revision);

    for (const frame of superseded) {
      if (frame.status === StudioPreviewStatus.Ready) {
        continue;
      }
      await this.cancelOperation(frame, frame.ownerId);
    }

    if (superseded.length > 0) {
      this.logger.debug(
        `Superseded ${superseded.length} preview frame(s) for project ${event.projectId} at revision ${event.revision}`,
      );
    }

    return superseded;
  }

  /* ---------------------------------------------------------------- */
  /* Render worker publication (FL-95 claims, this service publishes)    */
  /* ---------------------------------------------------------------- */

  /** A worker claimed a preview: give it the frame's own directory to write into. */
  onRenderClaimed(operation: Pick<MediaOperation, 'ownerId' | 'snapshot'>): string | null {
    const frameId = previewFrameIdOf(operation);
    if (!frameId) {
      return null;
    }
    const folder = studioPreviewFrameFolder(operation.ownerId, frameId);
    this.storage.mkdirSync(folder);
    return folder;
  }

  /**
   * A worker reports the frame it rendered. The file must be an image inside the frame's own
   * directory with the reported size. Publication is guarded on the frame still awaiting this
   * operation's render for the binding it was asked for, so a frame superseded, cancelled or
   * revoked in the meantime is discarded instead of shown; the render itself still completes.
   */
  async onRenderCompleted(
    operation: Pick<MediaOperation, 'id' | 'ownerId' | 'snapshot'>,
    output: { path: string; checksum: string; sizeInBytes: string; contentType: string },
  ): Promise<{ published: boolean }> {
    const frameId = previewFrameIdOf(operation);
    if (!frameId) {
      throw new BadRequestException('This operation names no preview frame');
    }
    if (!PREVIEW_CONTENT_TYPES.includes(output.contentType)) {
      throw new BadRequestException('A preview frame must be a PNG, JPEG or WebP image');
    }
    const folder = studioPreviewFrameFolder(operation.ownerId, frameId);
    if (!isInsideFolder(folder, output.path)) {
      throw new BadRequestException('The frame must be inside the directory this render was given');
    }
    const stat = await this.storage.stat(output.path).catch(() => null);
    if (!stat?.isFile() || String(stat.size) !== output.sizeInBytes) {
      throw new BadRequestException('The frame is missing or its size does not match');
    }

    const frame = await this.repository.getForOwner(frameId, operation.ownerId);
    const now = new Date();
    const published =
      !!frame &&
      frame.operationId === operation.id &&
      (await this.repository.publish(frame.id, frame.revisionDigest, {
        framePath: output.path,
        contentType: output.contentType,
        sizeInBytes: output.sizeInBytes,
        frameChecksum: Buffer.from(output.checksum, 'hex'),
        // The worker renders the exact instant the frame was requested for (FL-93 rational time).
        framePts: frame.timeNumerator,
        framePtsTimebase: `1/${frame.timeDenominator}`,
        toneMapped: false,
        readyAt: now,
        expiresAt: previewExpiry(now),
      }));
    if (!published) {
      await this.removeFiles(folder);
    }
    return { published };
  }

  /** The render failed for good (its automatic retry is spent): the frame says so, and its files go. */
  async onRenderFailed(operation: Pick<MediaOperation, 'ownerId' | 'snapshot'>, errorCode: string): Promise<void> {
    const frameId = previewFrameIdOf(operation);
    if (!frameId) {
      return;
    }
    await this.repository.markFailed(frameId, errorCode);
    await this.removeFiles(studioPreviewFrameFolder(operation.ownerId, frameId));
  }

  /* ---------------------------------------------------------------- */
  /* Revocation (FL-90) and retention                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Stop every live preview of these projects now: frames are evicted with their files and renders
   * still in flight are cancelled. With `ownerId`, only that account's previews stop.
   */
  async revokeForProjects(projectIds: readonly string[], ownerId?: string): Promise<number> {
    const frames = await this.repository.listLiveForProjects(projectIds, ownerId);
    for (const frame of frames) {
      if (frame.status !== StudioPreviewStatus.Ready) {
        await this.cancelOperation(frame, frame.ownerId);
      }
    }
    await this.dropFrames(frames);
    return frames.length;
  }

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  onBootstrap() {
    this.sweepHandle ??= setInterval(() => void this.sweep(), PREVIEW_SWEEP_MS);
    void this.sweep();
  }

  @OnEvent({ name: 'AppShutdown' })
  async onShutdown() {
    if (this.sweepHandle) {
      clearInterval(this.sweepHandle);
      this.sweepHandle = undefined;
    }
    await this.sweeping;
  }

  /**
   * The retention sweep. Never overlaps itself. Removes the files of ready frames past their
   * expiry and of superseded or failed frames nobody can be shown, then deletes old tombstones.
   */
  sweep(now = new Date()): Promise<void> {
    this.sweeping ??= this.sweepOnce(now)
      .catch((error) => this.logger.warn(`Studio preview retention sweep failed: ${errorMessage(error)}`))
      .finally(() => {
        this.sweeping = undefined;
      });
    return this.sweeping;
  }

  private async sweepOnce(now: Date): Promise<void> {
    const retired = await this.repository.listRetired(now, new Date(now.getTime() - PREVIEW_RETENTION_MS), SWEEP_BATCH);
    await this.dropFrames(retired);
    const removed = await this.repository.deleteEvictedBefore(
      new Date(now.getTime() - PREVIEW_TOMBSTONE_MS),
      SWEEP_BATCH,
    );
    if (retired.length > 0 || removed > 0) {
      this.logger.debug(`Preview retention: ${retired.length} frame(s) evicted, ${removed} tombstone(s) removed`);
    }
  }

  /** Evict rows and remove their files. The row stays as a tombstone so the answer is "gone". */
  private async dropFrames(frames: readonly StudioPreviewFrame[]): Promise<StudioPreviewFrame[]> {
    if (frames.length === 0) {
      return [];
    }
    const evicted = await this.repository.evict(frames.map((frame) => frame.id));
    for (const frame of frames) {
      await this.removeFiles(studioPreviewFrameFolder(frame.ownerId, frame.id));
    }
    return evicted;
  }

  private async removeFiles(folder: string): Promise<void> {
    await this.storage.unlinkDir(folder, { recursive: true, force: true }).catch((error) => {
      this.logger.warn(`Could not remove preview files at ${folder}: ${errorMessage(error)}`);
    });
  }

  /* ---------------------------------------------------------------- */

  /**
   * Supersede one account's previews of a project that are not on the given binding, and cancel
   * the ones still rendering. Within a stored revision this is how a re-resolution (a new
   * manifest after the old one expired, or after access changed) retires the older binding.
   */
  private async supersede(projectId: string, ownerId: string, currentBinding: string): Promise<StudioPreviewFrame[]> {
    const superseded = await this.repository.supersede(projectId, ownerId, currentBinding);

    for (const frame of superseded) {
      if (frame.status === StudioPreviewStatus.Ready) {
        continue;
      }
      await this.cancelOperation(frame, ownerId);
    }

    return superseded;
  }

  /**
   * Record one request. Order matters:
   *
   * 1. Supersede and cancel everything on older bindings *before* recording the new request.
   *    A GPU rendering a frame nobody can be shown is worse than an idle one, and the person is
   *    waiting for the frame they are looking at now.
   * 2. Record the request, sharing an existing live row for the same key rather than starting a
   *    second render of an identical frame.
   * 3. Create the durable operation, only if this request is the one that created or revived
   *    the row, so two concurrent requests cannot start two renders.
   * 4. Evict, last, so a fresh request is never the thing that gets evicted.
   */
  private async record(
    auth: AuthDto,
    request: {
      time: PreviewTime;
      dto: StudioPreviewFrameRequest;
      now: Date;
      manifest: StudioAuthorizedManifest;
      grant: { token: string; sessionId: string };
    },
  ): Promise<StudioPreviewResponseDto> {
    const { time, dto, now, manifest, grant } = request;
    const ownerId = auth.user.id;
    const projectId = manifest.projectId;
    const revisionDigest = manifest.digest;

    const known = await this.repository.getLatestRevisionDigest(projectId, ownerId);
    const superseded =
      known && known !== revisionDigest ? await this.supersede(projectId, ownerId, revisionDigest) : [];

    const binding: PreviewBinding = {
      ownerId,
      projectId,
      revisionDigest,
      time,
      quality: dto.quality,
      viewportWidth: dto.viewportWidth,
      viewportHeight: dto.viewportHeight,
    };

    const { frame, created } = await this.repository.upsert({
      ownerId,
      projectId,
      revisionDigest,
      projectRevision: manifest.revision,
      grantToken: grant.token,
      grantSessionId: grant.sessionId,
      cacheKey: previewCacheKey(binding),
      timeNumerator: String(time.num) as never,
      timeDenominator: String(time.den) as never,
      quality: dto.quality,
      viewportWidth: dto.viewportWidth,
      viewportHeight: dto.viewportHeight,
      operationId: null,
      seekGeneration: String(dto.seekGeneration ?? 0) as never,
      framePath: null,
      contentType: null,
      sizeInBytes: null,
      frameChecksum: null,
      framePts: null,
      framePtsTimebase: null,
      toneMapped: false,
      errorCode: null,
      readyAt: null,
      expiresAt: previewExpiry(now),
    });

    const recorded = created ? await this.enqueue(frame, binding, manifest) : frame;

    await this.evict(projectId, ownerId, revisionDigest, now);

    return {
      preview: this.map(recorded),
      currentRevision: manifest.revision,
      supersededPreviewIds: superseded.map((row) => row.id),
    };
  }

  private async enqueue(
    frame: StudioPreviewFrame,
    binding: PreviewBinding,
    manifest: StudioAuthorizedManifest,
  ): Promise<StudioPreviewFrame> {
    const operation = await this.operations.create({
      ownerId: binding.ownerId,
      kind: MediaOperationKind.StudioPreview,
      // Preview runs where the project's worker runs. The destination is immutable for the life
      // of the job and is never promoted to the cloud by a local GPU going away.
      destination: MediaOperationDestination.Local,
      destinationDetail: null,
      label: `Preview ${previewTimeKey(binding.time)}`,
      assetId: null,
      resultAssetId: null,
      retryOfId: null,
      projectId: binding.projectId,
      revisionId: binding.revisionDigest,
      /**
       * The immutable binding. `manifestDigest` is FL-90's authorized manifest and `cacheKey` is
       * FL-90's own cache key, so anything the worker stores for this preview stops being
       * readable the moment the manifest is re-resolved.
       *
       * `studio` is what FL-95's renderer resolves at claim time. It names the *stored* revision
       * and carries no graph: the worker reads the graph from project storage (immutable once
       * written) and resolves it as a background runner for the account that asked, so Locked
       * sources the owner's job names resolve for the backend task while every interactive read
       * keeps refusing them. Access is always decided for the operation's own account, and the
       * worker re-checks that it may still read the project before it reads the graph.
       */
      snapshot: {
        kind: 'studio-preview',
        projectId: binding.projectId,
        revisionDigest: binding.revisionDigest,
        time: previewTimeKey(binding.time),
        quality: binding.quality,
        viewportWidth: frame.viewportWidth,
        viewportHeight: frame.viewportHeight,
        previewFrameId: frame.id,
        manifestDigest: manifest.digest,
        projectRevision: manifest.revision,
        resourceCacheKey: this.resources.cacheKey(manifest),
        studio: {
          stored: true,
          revision: manifest.revision,
          cloudConsent: false,
        },
      },
      settings: {
        quality: binding.quality,
        viewportWidth: frame.viewportWidth,
        viewportHeight: frame.viewportHeight,
      },
      estimate: null,
      maxAttempts: 1,
    });

    const marked = await this.repository.markRendering(frame.id, operation.id);
    if (!marked) {
      // The row left `pending` between the write and now — superseded by a newer revision or
      // cancelled. The operation must not run for a frame nobody can be shown.
      await this.cancelOperation({ ...frame, operationId: operation.id }, binding.ownerId);
      return frame;
    }

    return { ...frame, operationId: operation.id, status: StudioPreviewStatus.Rendering };
  }

  private async cancelOperation(frame: StudioPreviewFrame, ownerId: string): Promise<void> {
    if (!frame.operationId) {
      return;
    }

    try {
      await this.operations.requestCancel(frame.operationId, ownerId);
    } catch (error) {
      // A preview the person has already been told is stale must not be resurrected by a
      // cancellation that failed; the operation's own recovery sweep settles it.
      this.logger.warn(`Could not cancel preview operation ${frame.operationId}: ${error}`);
    }
  }

  private async evict(projectId: string, ownerId: string, currentRevisionDigest: string, now: Date): Promise<void> {
    const rows = await this.repository.listForProject(projectId, ownerId, PROJECT_SCAN_LIMIT);

    const recent = [...new Set(rows.map((row) => row.revisionDigest))]
      .filter((digest) => digest !== currentRevisionDigest)
      .slice(0, Math.max(0, PREVIEW_REVISIONS_PER_PROJECT - 1));

    const plan = planPreviewEviction(
      rows.map((row) => ({
        id: row.id,
        revisionDigest: row.revisionDigest,
        status: row.status as PreviewStatusValue,
        lastAccessedAt: new Date(row.lastAccessedAt as unknown as string),
        expiresAt: row.expiresAt ? new Date(row.expiresAt as unknown as string) : null,
      })),
      {
        currentRevisionDigest,
        now,
        recentRevisionDigests: recent,
        framesPerRevision: PREVIEW_FRAMES_PER_REVISION,
      },
    );

    const byId = new Map(rows.map((row) => [row.id, row]));
    const rowsOf = (ids: readonly string[]) => ids.flatMap((id) => byId.get(id) ?? []);
    if (plan.cancel.length > 0) {
      for (const row of rowsOf(plan.cancel)) {
        await this.cancelOperation(row, ownerId);
      }
      await this.dropFrames(rowsOf(plan.cancel));
    }

    if (plan.evict.length > 0) {
      await this.dropFrames(rowsOf(plan.evict));
    }
  }

  private parseTime(dto: Pick<StudioPreviewRequestDto, 'time'>): PreviewTime {
    try {
      // `rational` reduces and enforces the safe-integer invariants, so two spellings of the
      // same instant become one cache entry and a value that cannot be exact is refused here
      // rather than rounded somewhere downstream.
      return rational(Number(dto.time.numerator), Number(dto.time.denominator));
    } catch {
      throw new ConflictException({
        message: 'Preview time is not an exact rational',
        code: 'studio_preview_bad_time',
      });
    }
  }

  private assertViewport(dto: { viewportWidth: number; viewportHeight: number }): void {
    if (!isValidPreviewViewport(dto.viewportWidth, dto.viewportHeight)) {
      throw new ConflictException({ message: 'Unsupported preview viewport', code: 'studio_preview_bad_viewport' });
    }
  }

  private async findOwned(auth: AuthDto, id: string): Promise<StudioPreviewFrame> {
    const frame = await this.repository.getForOwner(id, auth.user.id);
    if (!frame) {
      // Somebody else's frame and a frame that never existed answer identically on purpose.
      throw new NotFoundException('Preview frame not found');
    }
    return frame;
  }

  private map(frame: StudioPreviewFrame): StudioPreviewDto {
    const time = toPreviewTime(frame);
    return {
      id: frame.id,
      projectId: frame.projectId,
      revision: Number(frame.projectRevision ?? 0),
      revisionDigest: frame.revisionDigest,
      time: { numerator: String(time.num), denominator: String(time.den) },
      quality: frame.quality as StudioPreviewQuality,
      viewportWidth: frame.viewportWidth,
      viewportHeight: frame.viewportHeight,
      status: frame.status as StudioPreviewStatus,
      operationId: frame.operationId,
      seekGeneration: String(frame.seekGeneration ?? 0),
      etag: previewETag({
        ownerId: frame.ownerId,
        projectId: frame.projectId,
        revisionDigest: frame.revisionDigest,
        time,
        quality: frame.quality,
        viewportWidth: frame.viewportWidth,
        viewportHeight: frame.viewportHeight,
      }),
      framePts: asString(frame.framePts),
      framePtsTimebase: frame.framePtsTimebase,
      sizeInBytes: asString(frame.sizeInBytes),
      contentType: frame.contentType,
      toneMapped: frame.toneMapped,
      errorCode: frame.errorCode,
      requestedAt: asRequiredIso(frame.requestedAt as unknown as Date),
      readyAt: asIso(frame.readyAt as unknown as Date | null),
      expiresAt: asIso(frame.expiresAt as unknown as Date | null),
    };
  }
}
