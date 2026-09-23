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
import { ImmichFileResponse } from 'src/utils/file.js';
import {
  PREVIEW_FRAMES_PER_REVISION,
  PREVIEW_REVISIONS_PER_PROJECT,
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
 * Where "the project is on revision X" comes from.
 *
 * Studio project storage is owned by a story still in flight, so this story defines the seam
 * rather than importing a service that does not exist yet. When the project service lands it
 * implements this interface and is provided under {@link STUDIO_PROJECT_REVISION_AUTHORITY};
 * nothing in this file changes. Until then the fallback below treats the newest revision the
 * owner has asked to preview as the current one, which is enough to make supersession,
 * cancellation and the stale-revision refusal real and testable.
 */
export interface StudioProjectRevisionAuthority {
  /** The current revision digest, or null when the project is not readable by this account. */
  getCurrentRevisionDigest(projectId: string, ownerId: string): Promise<string | null>;
}

export const STUDIO_PROJECT_REVISION_AUTHORITY = Symbol('StudioProjectRevisionAuthority');

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

const toPreviewTime = (frame: StudioPreviewFrame): PreviewTime => ({
  numerator: BigInt(frame.timeNumerator as unknown as string | number),
  denominator: BigInt(frame.timeDenominator as unknown as string | number),
});

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
 * - **It does not resolve resources.** The enumerated, revision-bound read grant is FL-90's
 *   (`STU-203`). The snapshot carries a `resourceManifestId` slot and nothing else, so no graph
 *   URL, local path or browser handle can travel to a worker through preview.
 * - **It does not talk to the client's SDK.** The browser reaches it only through the Svelte
 *   host; the React engine has no API dependency at all.
 */
@Injectable()
export class StudioPreviewService {
  /**
   * Set by the module when the project service exists. Left unset here on purpose: an unset
   * authority falls back to the preview store's own newest revision rather than failing closed
   * on a project nobody can read yet.
   */
  private revisionAuthority: StudioProjectRevisionAuthority | null = null;

  constructor(
    private logger: LoggingRepository,
    private repository: StudioPreviewRepository,
    private operations: MediaOperationRepository,
  ) {
    this.logger.setContext(StudioPreviewService.name);
  }

  /** Supplied by the owning module once FL-91's project service exists. */
  setRevisionAuthority(authority: StudioProjectRevisionAuthority): void {
    this.revisionAuthority = authority;
  }

  /**
   * Ask for one frame.
   *
   * Order matters:
   *
   * 1. Resolve the current revision. A request naming a revision the project has moved past is
   *    refused with the current digest attached, so the editor reconciles in one round trip.
   * 2. Supersede and cancel everything on older revisions *before* recording the new request.
   *    A GPU rendering a frame nobody can be shown is worse than an idle one, and the person is
   *    waiting for the frame they are looking at now.
   * 3. Record the request, sharing an existing row for the same key rather than starting a
   *    second render of an identical frame.
   * 4. Create the durable operation, if this request is the one that created the row.
   * 5. Evict, last, so a fresh request is never the thing that gets evicted.
   */
  async request(auth: AuthDto, dto: StudioPreviewRequestDto): Promise<StudioPreviewResponseDto> {
    const time = this.parseTime(dto);

    if (!isValidPreviewViewport(dto.viewportWidth, dto.viewportHeight)) {
      throw new ConflictException({ message: 'Unsupported preview viewport', code: 'studio_preview_bad_viewport' });
    }

    const now = new Date();
    const known = await this.repository.getLatestRevisionDigest(dto.projectId, auth.user.id);
    const authorityDigest = await this.revisionAuthority?.getCurrentRevisionDigest(dto.projectId, auth.user.id);

    if (authorityDigest === null) {
      // The authority says this account cannot read the project. Same answer as "no project".
      throw new NotFoundException('Studio project not found');
    }

    // Without the authority, the newest revision anybody asked about is the newest we know of,
    // and a request naming a *newer* one advances it.
    const currentRevisionDigest = authorityDigest ?? dto.revisionDigest;

    if (authorityDigest && authorityDigest !== dto.revisionDigest) {
      throw new ConflictException({
        message: 'The project has moved to a newer revision',
        code: 'studio_preview_stale_revision',
        currentRevisionDigest: authorityDigest,
      });
    }

    const superseded =
      known && known !== currentRevisionDigest
        ? await this.supersede(dto.projectId, auth.user.id, currentRevisionDigest)
        : [];

    const binding = {
      projectId: dto.projectId,
      revisionDigest: currentRevisionDigest,
      time,
      quality: dto.quality,
      viewportWidth: dto.viewportWidth,
      viewportHeight: dto.viewportHeight,
    };
    const cacheKey = previewCacheKey(binding);

    const frame = await this.repository.upsert({
      ownerId: auth.user.id,
      projectId: dto.projectId,
      revisionDigest: currentRevisionDigest,
      cacheKey,
      timeNumerator: time.numerator.toString() as never,
      timeDenominator: time.denominator.toString() as never,
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

    const withOperation = frame.operationId ? frame : await this.enqueue(auth, frame, binding);

    await this.evict(dto.projectId, auth.user.id, currentRevisionDigest, now);

    return {
      preview: this.map(withOperation),
      currentRevisionDigest,
      supersededPreviewIds: superseded.map((row) => row.id),
    };
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
    const currentRevisionDigest = await this.currentRevision(frame);
    const binding = {
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
   * Marked superseded rather than deleted: the client may still hold the id, and "the revision
   * moved on" is a truer answer than "not found". The durable operation is cancelled so the
   * worker actually stops.
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

  private async enqueue(
    auth: AuthDto,
    frame: StudioPreviewFrame,
    binding: { projectId: string; revisionDigest: string; time: PreviewTime; quality: string },
  ): Promise<StudioPreviewFrame> {
    const operation = await this.operations.create({
      ownerId: auth.user.id,
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
       * The immutable binding. `resourceManifestId` is the slot FL-90's authorized manifest
       * fills; it is null here, and a worker with no manifest has nothing it is allowed to
       * read, which is the correct fail-closed default.
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
        resourceManifestId: null,
      },
      settings: {
        quality: binding.quality,
        viewportWidth: frame.viewportWidth,
        viewportHeight: frame.viewportHeight,
      },
      estimate: null,
      maxAttempts: 1,
    });

    await this.repository.markRendering(frame.id, operation.id);
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

  private async currentRevision(frame: StudioPreviewFrame): Promise<string> {
    const authority = await this.revisionAuthority?.getCurrentRevisionDigest(frame.projectId, frame.ownerId);
    if (authority) {
      return authority;
    }

    // Fallback authority: the newest revision this owner has asked to preview. A frame whose
    // own revision is older than that is stale, which is exactly what the refusal needs.
    return (await this.repository.getLatestRevisionDigest(frame.projectId, frame.ownerId)) ?? frame.revisionDigest;
  }

  private parseTime(dto: StudioPreviewRequestDto): PreviewTime {
    const denominator = BigInt(dto.time.denominator);
    if (denominator === 0n) {
      throw new ConflictException({ message: 'Preview time denominator must not be zero', code: 'studio_preview_bad_time' });
    }
    return { numerator: BigInt(dto.time.numerator), denominator };
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
      time: { numerator: time.numerator.toString(), denominator: time.denominator.toString() },
      quality: frame.quality as StudioPreviewQuality,
      viewportWidth: frame.viewportWidth,
      viewportHeight: frame.viewportHeight,
      status: frame.status as StudioPreviewStatus,
      operationId: frame.operationId,
      seekGeneration: String(frame.seekGeneration ?? 0),
      etag: previewETag({
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
