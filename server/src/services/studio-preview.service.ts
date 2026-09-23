import { ConflictException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { StudioPreviewDto, StudioPreviewRequestDto, StudioPreviewResponseDto } from 'src/dtos/studio-preview.dto.js';
import {
  CacheControl,
  MediaOperationDestination,
  MediaOperationKind,
  StudioPreviewQuality,
  StudioPreviewStatus,
} from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { StudioPreviewFrame, StudioPreviewRepository } from 'src/repositories/studio-preview.repository.js';
import {
  STUDIO_GRANT_TTL_SECONDS,
  StudioAuthorizedManifest,
  StudioResourceService,
} from 'src/services/studio-resource.service.js';
import { ImmichFileResponse } from 'src/utils/file.js';
import { rational } from 'src/utils/rational-time.js';
import {
  PREVIEW_FRAMES_PER_REVISION,
  PREVIEW_REVISIONS_PER_PROJECT,
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

/**
 * TODO(FL-89): the manifest-less seam. Delete it when Studio project storage lands.
 *
 * Everything in this file that exists only because FL-89 (Studio project storage, autosave and
 * history) has not landed is named `interim…` or refers to this interface, and nothing else
 * depends on it. Removing it is:
 *
 * 1. Delete {@link StudioProjectRevisionAuthority}, `setRevisionAuthority`,
 *    `requestWithoutManifest` and the private `interim…` methods below.
 * 2. Point `POST /studio/previews` at a project-scoped entry point that resolves the manifest
 *    server-side (FL-90's `resolveProjectResources`) and calls {@link StudioPreviewService.requestForManifest}.
 * 3. Have FL-89's revision commit call {@link StudioPreviewService.supersede}.
 *
 * Until then, a request that carries no manifest names its own graph revision digest. That is
 * safe only because nothing may *render* without a manifest: a manifest-less row records the
 * request and its durable operation, the operation's snapshot says `manifestDigest: null`, and
 * a worker with no manifest has nothing it is allowed to read, so FL-95's admission must refuse
 * it. Frame delivery does not depend on that: a manifest-less row carries no grant, and the
 * owner-scoped read plus the revision check still apply to anything published into it.
 */
export interface StudioProjectRevisionAuthority {
  /** The current revision digest, or null when the project is not readable by this account. */
  getCurrentRevisionDigest(projectId: string, ownerId: string): Promise<string | null>;
}

/** How many rows one project's eviction pass considers. Well above the per-revision cap. */
const PROJECT_SCAN_LIMIT = 500;

const asIso = (value: Date | string | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
};

const asRequiredIso = (value: Date | string): string => asIso(value) as string;

const asString = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

const toPreviewTime = (frame: StudioPreviewFrame): PreviewTime =>
  rational(Number(frame.timeNumerator), Number(frame.timeDenominator));

/**
 * Revision-bound remote preview (FL-96, `STU-402`).
 *
 * The contract in one sentence: a frame is delivered only to the account that owns the project,
 * only while the revision it was rendered for is still the revision the project is on, and only
 * with an entity tag that carries that revision, so a stale revision is *refused* rather than
 * served from anybody's cache.
 *
 * What this service deliberately does not do:
 *
 * - **It does not run anything.** A request becomes a durable media operation of kind
 *   `studio_preview` (FL-104's model) and stops there. Admission, claiming and the GPU are
 *   FL-95's (`STU-401`); this service would be wrong to decide a worker is trustworthy.
 * - **It does not resolve resources.** Enumerating them and deciding access is FL-90's
 *   (`STU-203`). This service asserts the manifest it is handed, records its digest as the
 *   binding, issues a viewer-session preview grant and re-verifies that grant on every frame.
 *   It never reads a graph, so no graph URL, local path or browser handle can travel to a
 *   worker through preview.
 * - **It does not talk to the client's SDK.** The browser reaches it only through the Svelte
 *   host; the React engine has no API dependency at all.
 */
@Injectable()
export class StudioPreviewService {
  /**
   * TODO(FL-89): part of the manifest-less seam. Left unset on purpose: without it the preview
   * store's own newest revision stands in, which is enough to make supersession, cancellation
   * and the stale-revision refusal real and testable.
   */
  private interimRevisionAuthority: StudioProjectRevisionAuthority | null = null;

  constructor(
    private logger: LoggingRepository,
    private repository: StudioPreviewRepository,
    private operations: MediaOperationRepository,
    private resources: StudioResourceService,
  ) {
    this.logger.setContext(StudioPreviewService.name);
  }

  /** TODO(FL-89): part of the manifest-less seam; see {@link StudioProjectRevisionAuthority}. */
  setRevisionAuthority(authority: StudioProjectRevisionAuthority): void {
    this.interimRevisionAuthority = authority;
  }

  /**
   * Ask for one frame against FL-90's authorized manifest. The lasting entry point.
   *
   * The manifest digest is the binding, so a frame stops being deliverable not only when the
   * graph changes but when the resolution does — when a source is trashed, unshared, relocked
   * or replaced — which a graph digest on its own cannot express. A preview grant is issued to
   * this viewer session and re-verified on every frame read.
   */
  async requestForManifest(
    auth: AuthDto,
    manifest: StudioAuthorizedManifest,
    dto: Omit<StudioPreviewRequestDto, 'projectId' | 'revisionDigest'>,
  ): Promise<StudioPreviewResponseDto> {
    const now = new Date();
    const time = this.parseTime(dto);
    this.assertViewport(dto);

    // Throws when the manifest was not issued by this process, has expired, is incomplete or
    // was altered. A preview never renders from a partial manifest: an incomplete resolution
    // means a source was refused, and a picture assembled without it would be a quietly wrong
    // frame rather than a missing one.
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
      projectId: manifest.projectId,
      revisionDigest: manifest.digest,
      time,
      dto,
      now,
      manifest,
      grant: { token: grantToken, sessionId: grantSessionId },
    });
  }

  /**
   * TODO(FL-89): part of the manifest-less seam; see {@link StudioProjectRevisionAuthority}.
   *
   * Ask for one frame naming a graph revision digest the client supplies. A request naming a
   * revision the authority has moved past is refused with the current digest attached, so the
   * editor reconciles in one round trip. The row it records can never be rendered, because its
   * operation carries no manifest.
   */
  async requestWithoutManifest(auth: AuthDto, dto: StudioPreviewRequestDto): Promise<StudioPreviewResponseDto> {
    const now = new Date();
    const time = this.parseTime(dto);
    this.assertViewport(dto);

    const revisionDigest = await this.interimResolveRequestedRevision(auth, dto);

    return this.record(auth, {
      projectId: dto.projectId,
      revisionDigest,
      time,
      dto,
      now,
      manifest: null,
      grant: null,
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
     * The FL-90 grant is checked on *every* frame request, not once at admission.
     *
     * `verifyReadGrant` re-checks the signature, the expiry, the session it was issued to and
     * the acting user, so a relocked, expired or re-resolved session stops receiving frames
     * immediately rather than at the next render. A row that carries no grant was recorded
     * before a manifest existed for it; it can never have a published frame, because nothing
     * may render without a manifest, so {@link decidePreviewDelivery} refuses it below as
     * `not-ready` without needing a second rule here.
     */
    if (frame.grantToken) {
      const verification = await this.resources.verifyReadGrant(frame.grantToken, {
        workerId: frame.grantSessionId ?? auth.session?.id ?? auth.user.id,
        auth,
      });
      if (!verification.valid) {
        await this.repository.evict([frame.id]);
        throw new ConflictException({
          message: 'This preview is no longer authorized',
          code: 'studio_preview_grant_revoked',
          reason: verification.reason,
        });
      }
    }

    const currentRevisionDigest = await this.currentRevision(frame);
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
      currentRevisionDigest,
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
      currentRevisionDigest,
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
    const [cancelled] = await this.repository.evict([frame.id]);
    await this.cancelOperation(frame, auth.user.id);
    return this.map(cancelled ?? frame);
  }

  /**
   * Supersede every preview of a project that is not on the given revision, and cancel the ones
   * still rendering.
   *
   * Public because the project service calls it the moment a revision is committed: preview
   * work for the revision the person just replaced is waste, and leaving it running means the
   * frame they are waiting for queues behind frames nobody can be shown.
   */
  async supersede(projectId: string, ownerId: string, currentRevisionDigest: string): Promise<StudioPreviewFrame[]> {
    const superseded = await this.repository.supersede(projectId, ownerId, currentRevisionDigest);

    for (const frame of superseded) {
      if (frame.status === StudioPreviewStatus.Ready) {
        continue;
      }
      await this.cancelOperation(frame, ownerId);
    }

    if (superseded.length > 0) {
      this.logger.debug(
        `Superseded ${superseded.length} preview frame(s) for project ${projectId} at revision ${currentRevisionDigest}`,
      );
    }

    return superseded;
  }

  /* ---------------------------------------------------------------- */

  /**
   * Record one request, shared by both entry points. Order matters:
   *
   * 1. Supersede and cancel everything on older revisions *before* recording the new request.
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
      projectId: string;
      revisionDigest: string;
      time: PreviewTime;
      dto: Omit<StudioPreviewRequestDto, 'projectId' | 'revisionDigest'>;
      now: Date;
      manifest: StudioAuthorizedManifest | null;
      grant: { token: string; sessionId: string } | null;
    },
  ): Promise<StudioPreviewResponseDto> {
    const { projectId, revisionDigest, time, dto, now, manifest, grant } = request;
    const ownerId = auth.user.id;

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
      projectRevision: manifest?.revision ?? null,
      grantToken: grant?.token ?? null,
      grantSessionId: grant?.sessionId ?? null,
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
      currentRevisionDigest: revisionDigest,
      supersededPreviewIds: superseded.map((row) => row.id),
    };
  }

  private async enqueue(
    frame: StudioPreviewFrame,
    binding: PreviewBinding,
    manifest: StudioAuthorizedManifest | null,
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
       * The immutable binding. `manifestDigest` is FL-90's authorized manifest: a worker with
       * no manifest has nothing it is allowed to read, which is the correct fail-closed
       * default. `cacheKey` is FL-90's own cache key, so anything the worker stores for this
       * preview stops being readable the moment the manifest is re-resolved.
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
        manifestDigest: manifest?.digest ?? null,
        projectRevision: manifest?.revision ?? null,
        resourceCacheKey: manifest ? this.resources.cacheKey(manifest) : null,
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

    if (plan.cancel.length > 0) {
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const id of plan.cancel) {
        const row = byId.get(id);
        if (row) {
          await this.cancelOperation(row, ownerId);
        }
      }
      await this.repository.evict(plan.cancel);
    }

    if (plan.evict.length > 0) {
      await this.repository.evict(plan.evict);
    }
  }

  /**
   * The revision a stored frame must still be on to be delivered.
   *
   * For a manifest-bound frame, the newest manifest digest this owner has previewed the project
   * with: every newer request supersedes the older binding, and the grant check in
   * {@link getFrame} covers access changes between requests. A frame recorded without a
   * manifest answers to the interim authority.
   */
  private async currentRevision(frame: StudioPreviewFrame): Promise<string> {
    if (!frame.grantToken) {
      return this.interimCurrentRevision(frame);
    }
    return (await this.repository.getLatestRevisionDigest(frame.projectId, frame.ownerId)) ?? frame.revisionDigest;
  }

  /* ---------------------------------------------------------------- */
  /* TODO(FL-89): manifest-less seam. Everything below this line up to  */
  /* the matching end marker goes when Studio project storage lands.    */
  /* ---------------------------------------------------------------- */

  private async interimResolveRequestedRevision(auth: AuthDto, dto: StudioPreviewRequestDto): Promise<string> {
    const authorityDigest = await this.interimRevisionAuthority?.getCurrentRevisionDigest(dto.projectId, auth.user.id);

    if (authorityDigest === null) {
      // The authority says this account cannot read the project. Same answer as "no project".
      throw new NotFoundException('Studio project not found');
    }

    if (authorityDigest && authorityDigest !== dto.revisionDigest) {
      throw new ConflictException({
        message: 'The project has moved to a newer revision',
        code: 'studio_preview_stale_revision',
        currentRevisionDigest: authorityDigest,
      });
    }

    // Without an authority, the revision the owner names is the newest one we know of, and
    // naming a different one than last time supersedes the previous one.
    return authorityDigest ?? dto.revisionDigest;
  }

  private async interimCurrentRevision(frame: StudioPreviewFrame): Promise<string> {
    const authority = await this.interimRevisionAuthority?.getCurrentRevisionDigest(frame.projectId, frame.ownerId);
    if (authority) {
      return authority;
    }

    // The newest revision this owner has asked to preview. A frame whose own revision is older
    // than that is stale, which is exactly what the refusal needs.
    return (await this.repository.getLatestRevisionDigest(frame.projectId, frame.ownerId)) ?? frame.revisionDigest;
  }

  /* ---------------------------------------------------------------- */
  /* End of the TODO(FL-89) manifest-less seam.                         */
  /* ---------------------------------------------------------------- */

  private parseTime(dto: Pick<StudioPreviewRequestDto, 'time'>): PreviewTime {
    try {
      // `rational` reduces and enforces the safe-integer invariants, so two spellings of the
      // same instant become one cache entry and a value that cannot be exact is refused here
      // rather than rounded somewhere downstream.
      return rational(Number(dto.time.numerator), Number(dto.time.denominator));
    } catch {
      throw new ConflictException({ message: 'Preview time is not an exact rational', code: 'studio_preview_bad_time' });
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
