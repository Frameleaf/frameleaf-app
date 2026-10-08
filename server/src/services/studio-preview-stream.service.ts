import {
  BadRequestException,
  ConflictException,
  GoneException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  RenderWorkerStreamOfferDto,
  RenderWorkerStreamSignalDto,
  StudioPreviewStreamAnswerDto,
  StudioPreviewStreamDto,
  StudioPreviewStreamOpenDto,
} from 'src/dtos/studio-preview-stream.dto.js';
import { MediaOperationDestination, MediaOperationKind, MediaOperationStatus, StudioPreviewQuality } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { StudioProjectService, StudioRevisionEvent } from 'src/services/studio-project.service.js';
import { StudioResourceService } from 'src/services/studio-resource.service.js';
import { RationalError, formatRational, rational } from 'src/utils/rational-time.js';
import {
  STREAM_KEEPALIVE_MS,
  STREAM_MAX_DURATION_MS,
  STREAM_MAX_PER_ACCOUNT,
  StreamBounds,
  StreamCloseReason,
  StreamSignal,
  capVideoBitrate,
  isOpenStream,
  isValidAnswerSdp,
  isValidOfferSdp,
  readStreamSignal,
  streamBounds,
  streamCloseReason,
  streamState,
  streamWorkerLost,
} from 'src/utils/studio-preview-stream.js';
import { StudioDestination } from 'src/utils/studio-resources.js';

/** The recovery pass's code for a claim whose worker stopped heartbeating (FL-104). */
const LEASE_EXPIRED = 'lease_expired';

type StreamSnapshot = {
  projectRevision: number;
  start: { numerator: string; denominator: string };
  bounds: StreamBounds;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const snapshotOf = (operation: Pick<MediaOperation, 'snapshot'>): StreamSnapshot => {
  const snapshot = isRecord(operation.snapshot) ? operation.snapshot : {};
  const stream = isRecord(snapshot.stream) ? snapshot.stream : {};
  return {
    projectRevision: Number(snapshot.projectRevision),
    start: stream.start as StreamSnapshot['start'],
    bounds: stream.bounds as StreamBounds,
  };
};

/** Why a stream the server did not close itself is closed, from the operation's own record. */
const impliedCloseReason = (operation: Pick<MediaOperation, 'status' | 'errorCode'>): StreamCloseReason => {
  switch (operation.status) {
    case MediaOperationStatus.Failed: {
      return operation.errorCode === LEASE_EXPIRED ? 'worker-lost' : 'failed';
    }
    case MediaOperationStatus.Completed: {
      return 'expired';
    }
    default: {
      return 'closed';
    }
  }
};

const staleRevision = (currentRevision: number) =>
  new ConflictException({
    message: 'The project has moved to a newer revision',
    code: 'studio_preview_stale_revision',
    currentRevision,
  });

/**
 * Bounded WebRTC playback of a stored Studio revision (FL-96, `STU-402`).
 *
 * The exact-frame preview (`StudioPreviewService`) shows one instant, rendered and fetched over
 * HTTP. This service lets the browser *play*: a render worker encodes the stored revision and
 * streams it over WebRTC to the browser that asked, and the browser drives it — play, pause, seek —
 * over the peer connection's data channel. The server is never on the media path. It:
 *
 * - **authorises** the session exactly as a frame request is authorised: the caller's stored head,
 *   resolved for the caller (FL-89, FL-90), Locked sources refused;
 * - **relays** one offer and one answer per negotiation, refusing any description that is not a
 *   send-only video with one control channel, and writing its bitrate bound into the answer;
 * - **bounds** it: bitrate, resolution, frame rate and duration by quality, two open sessions per
 *   account, one per project, a keepalive the browser must keep up;
 * - **stops** it the moment access, the revision or the worker goes, through the same hooks that
 *   stop frames and renders (`StudioRevocationService`, FL-89's revision listener).
 *
 * A session is a durable `studio_preview_stream` media operation, so claims, leases, heartbeats and
 * cancellation are FL-95's and FL-104's, and a worker that stops answering is recovered like any
 * other. The session never resumes on another worker: its peer is gone with the old one, so a
 * reconnect closes it as `worker-lost` and the browser opens a new one.
 *
 * The React editor never reaches this service; the Svelte host is the only caller holding
 * credentials, as for every other Studio route.
 */
@Injectable()
export class StudioPreviewStreamService {
  constructor(
    private logger: LoggingRepository,
    private operations: MediaOperationRepository,
    private projects: StudioProjectService,
    private resources: StudioResourceService,
  ) {
    this.logger.setContext(StudioPreviewStreamService.name);

    // A stored revision ends every stream of the ones before it at once: the picture belongs to a
    // graph that no longer exists. The browser opens a new session at the new head.
    this.projects.registerRevisionListener(async (event) => {
      await this.revisionCommitted(event);
    });
  }

  /* ---------------------------------------------------------------- */
  /* Browser side                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Open a session of the project's current stored revision.
   *
   * Refused, in this order: a start time that is not a rational; no access (`404`); a superseded
   * revision (`409 studio_preview_stale_revision`); an unavailable source
   * (`409 studio_preview_sources_refused`); and more open sessions than one account may hold
   * (`429 studio_preview_stream_limit`). An open session of the same project by the same account
   * is superseded rather than counted: one tab plays one project.
   */
  async open(auth: AuthDto, dto: StudioPreviewStreamOpenDto): Promise<StudioPreviewStreamDto> {
    const start = this.parseTime(dto.time);

    const authorization = await this.projects.authorizeRevision(auth, {
      projectId: dto.projectId,
      destination: StudioDestination.Local,
    });
    const current = authorization.revision.revision;
    if (dto.revision !== current) {
      throw staleRevision(current);
    }
    const manifest = authorization.manifest;
    if (!manifest.complete) {
      throw new ConflictException({
        message: 'A source this project uses is not available to you',
        code: 'studio_preview_sources_refused',
        currentRevision: current,
        refusedCount: manifest.refusedCount,
      });
    }

    const open = await this.operations.listOpenStreams(auth.user.id);
    const sameProject = open.filter((stream) => stream.projectId === dto.projectId);
    for (const stream of sameProject) {
      await this.closeById(stream.id, auth.user.id, 'superseded');
    }
    if (open.length - sameProject.length >= STREAM_MAX_PER_ACCOUNT) {
      throw new HttpException(
        {
          message: 'Too many preview streams are open for this account',
          code: 'studio_preview_stream_limit',
          limit: STREAM_MAX_PER_ACCOUNT,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const bounds = streamBounds(dto.quality as StudioPreviewQuality, dto.viewportWidth, dto.viewportHeight);
    const now = new Date();
    const operation = await this.operations.create({
      ownerId: auth.user.id,
      kind: MediaOperationKind.StudioPreviewStream,
      // Streams run where the project's renders run, never promoted to the cloud.
      destination: MediaOperationDestination.Local,
      destinationDetail: null,
      label: `Playback from ${formatRational(start)}`,
      assetId: null,
      resultAssetId: null,
      retryOfId: null,
      projectId: dto.projectId,
      revisionId: manifest.digest,
      /**
       * The immutable binding, shaped like a preview's so FL-95's claim resolves it the same way:
       * `studio` names the stored revision and carries no graph; the worker reads the graph from
       * project storage and re-resolves it for this account.
       */
      snapshot: {
        kind: 'studio-preview-stream',
        projectId: dto.projectId,
        projectRevision: manifest.revision,
        manifestDigest: manifest.digest,
        sourceEpochs: manifest.sourceEpochs,
        resourceCacheKey: this.resources.cacheKey(manifest),
        studio: { stored: true, revision: manifest.revision, cloudConsent: false },
        stream: { start: dto.time, bounds, quality: dto.quality },
      },
      settings: { quality: dto.quality, viewportWidth: dto.viewportWidth, viewportHeight: dto.viewportHeight },
      estimate: null,
      result: { negotiation: 0, keepaliveAt: now.toISOString() },
      // A lost stream is not retried: the browser's peer went with the worker.
      maxAttempts: 1,
    });

    this.logger.debug(`Opened preview stream ${operation.id} of project ${dto.projectId} at revision ${current}`);
    return this.map(operation, now);
  }

  /**
   * The session, as the browser polls it. Polling is the keepalive, and every poll re-checks that
   * the caller may still read the project and that the session's revision is still the head: lost
   * access closes it and answers `404`, like a frame; a newer head closes it as `stale-revision`.
   */
  async get(auth: AuthDto, id: string): Promise<StudioPreviewStreamDto> {
    const operation = await this.findOwned(auth, id);
    const now = new Date();
    if (!isOpenStream(operation)) {
      return this.map(operation, now);
    }

    const snapshot = snapshotOf(operation);
    const head = await this.projects.getReadableRevision(operation.projectId!, auth.user.id);
    if (head === null) {
      await this.close(operation, 'revoked');
      throw new NotFoundException('Preview stream not found');
    }
    if (head !== snapshot.projectRevision) {
      const closed = await this.close(operation, 'stale-revision');
      return this.map(closed ?? operation, now, { currentRevision: head });
    }

    const touched = await this.operations.mergeStreamSignal(operation.id, { keepaliveAt: now.toISOString() });
    return this.map(touched ?? operation, now);
  }

  /** The browser's answer to this round's offer. Written back with the server's bitrate bound. */
  async answer(auth: AuthDto, id: string, dto: StudioPreviewStreamAnswerDto): Promise<StudioPreviewStreamDto> {
    const operation = await this.findOwned(auth, id);
    const now = new Date();
    this.assertOpen(operation);
    if (!isValidAnswerSdp(dto.sdp)) {
      throw new BadRequestException({
        message: 'The answer must receive one video, keep one control channel and send no video',
        code: 'studio_preview_stream_invalid_answer',
      });
    }

    const signal = readStreamSignal(operation.result);
    if (streamState(operation, signal, now) !== 'offered' || dto.negotiation !== signal.negotiation) {
      throw new ConflictException({
        message: 'This answer is for a negotiation that is not waiting for one',
        code: 'studio_preview_stream_negotiation',
        negotiation: signal.negotiation,
      });
    }

    const { bounds } = snapshotOf(operation);
    const answered = await this.operations.mergeStreamSignal(
      operation.id,
      {
        answer: { sdp: capVideoBitrate(dto.sdp, bounds.maxBitrateKbps), negotiation: signal.negotiation },
        keepaliveAt: now.toISOString(),
      },
      { negotiation: signal.negotiation },
    );
    if (!answered) {
      throw new ConflictException({
        message: 'This answer is for a negotiation that is not waiting for one',
        code: 'studio_preview_stream_negotiation',
      });
    }
    return this.map(answered, now);
  }

  /**
   * Reconnect after the peer connection dropped. Resumes only once the session is re-validated
   * from scratch: project access and the stored head, a complete resolution of every source for the
   * caller *now* (a source trashed, relocked or unshared meanwhile closes the session), and the
   * worker's lease. Then the next negotiation starts and the worker offers again with an ICE
   * restart. Any failure closes the session with its reason, so nothing half-authorised plays on.
   */
  async reconnect(auth: AuthDto, id: string): Promise<StudioPreviewStreamDto> {
    const operation = await this.findOwned(auth, id);
    const now = new Date();
    this.assertOpen(operation);
    const snapshot = snapshotOf(operation);

    let authorization;
    try {
      authorization = await this.projects.authorizeRevision(auth, {
        projectId: operation.projectId!,
        destination: StudioDestination.Local,
      });
    } catch (error) {
      await this.close(operation, 'revoked');
      throw error;
    }

    const current = authorization.revision.revision;
    if (current !== snapshot.projectRevision) {
      await this.close(operation, 'stale-revision');
      throw staleRevision(current);
    }
    if (!authorization.manifest.complete) {
      await this.close(operation, 'revoked');
      throw new ConflictException({
        message: 'A source this project uses is not available to you',
        code: 'studio_preview_sources_refused',
        currentRevision: current,
        refusedCount: authorization.manifest.refusedCount,
      });
    }

    if (streamWorkerLost(operation, now)) {
      await this.close(operation, 'worker-lost');
      throw new ConflictException({
        message: 'The render worker playing this stream is gone',
        code: 'studio_preview_stream_worker_lost',
      });
    }

    const signal = readStreamSignal(operation.result);
    if (operation.status === MediaOperationStatus.Queued) {
      // No worker has taken it yet; there is nothing to renegotiate.
      return this.map(operation, now);
    }

    const next = await this.operations.mergeStreamSignal(
      operation.id,
      { negotiation: signal.negotiation + 1, offer: null, answer: null, keepaliveAt: now.toISOString() },
      { negotiation: signal.negotiation },
    );
    if (!next) {
      // Closed, or another reconnect won the race; either way the browser reads the session again.
      return this.map(await this.findOwned(auth, id), now);
    }
    this.logger.debug(`Preview stream ${operation.id} renegotiating (round ${signal.negotiation + 1})`);
    return this.map(next, now);
  }

  /** The person closed the player, or left. The worker stops on its next poll. */
  async closeOwned(auth: AuthDto, id: string): Promise<StudioPreviewStreamDto> {
    const operation = await this.findOwned(auth, id);
    const closed = isOpenStream(operation) ? await this.close(operation, 'closed') : undefined;
    return this.map(closed ?? operation, new Date());
  }

  /* ---------------------------------------------------------------- */
  /* Worker side (called by RenderWorkerService under a verified claim)  */
  /* ---------------------------------------------------------------- */

  /**
   * What the worker holding the session must do now. Closes a session whose browser stopped
   * keeping it alive or that reached its bound, and starts a fresh negotiation for a claim that took
   * over a session another claim had offered on.
   */
  async workerSignal(operation: MediaOperation): Promise<RenderWorkerStreamSignalDto> {
    this.assertStream(operation);
    const now = new Date();
    const snapshot = snapshotOf(operation);
    let signal = readStreamSignal(operation.result);

    const shouldClose =
      isOpenStream(operation) && !operation.cancelRequestedAt
        ? streamCloseReason({ createdAt: operation.createdAt as unknown as Date, signal, now })
        : null;
    if (shouldClose) {
      await this.close(operation, shouldClose);
      signal = { ...signal, closeReason: shouldClose };
    }

    const closing = !!shouldClose || !isOpenStream(operation) || !!operation.cancelRequestedAt;
    if (closing) {
      return {
        close: true,
        closeReason: signal.closeReason ?? impliedCloseReason(operation),
        revision: snapshot.projectRevision,
        negotiation: signal.negotiation,
        offerNeeded: false,
        answer: null,
        start: snapshot.start,
        bounds: snapshot.bounds,
      };
    }

    if (signal.offer && signal.offer.attempt !== operation.attempt) {
      // Another claim's description answers nothing for this one.
      const next = await this.operations.mergeStreamSignal(
        operation.id,
        { negotiation: signal.negotiation + 1, offer: null, answer: null },
        { negotiation: signal.negotiation },
      );
      signal = readStreamSignal(next?.result ?? operation.result);
    }

    const offered = !!signal.offer && signal.offer.attempt === operation.attempt;
    return {
      close: false,
      closeReason: null,
      revision: snapshot.projectRevision,
      negotiation: signal.negotiation,
      offerNeeded: !offered,
      answer: offered ? (signal.answer?.sdp ?? null) : null,
      start: snapshot.start,
      bounds: snapshot.bounds,
    };
  }

  /** The worker's offer for the current round. One per round per claim; the first one stands. */
  async workerOffer(operation: MediaOperation, dto: RenderWorkerStreamOfferDto): Promise<{ accepted: boolean }> {
    this.assertStream(operation);
    if (!isValidOfferSdp(dto.sdp)) {
      throw new BadRequestException({
        message: 'A preview offer must send one video and open one control channel, and nothing else',
        code: 'studio_preview_stream_invalid_offer',
      });
    }
    if (!isOpenStream(operation) || operation.cancelRequestedAt) {
      return { accepted: false };
    }
    const signal = readStreamSignal(operation.result);
    if (dto.negotiation !== signal.negotiation || (signal.offer && signal.offer.attempt === operation.attempt)) {
      return { accepted: false };
    }
    const offered = await this.operations.mergeStreamSignal(
      operation.id,
      { offer: { sdp: dto.sdp, negotiation: signal.negotiation, attempt: operation.attempt }, answer: null },
      { negotiation: signal.negotiation },
    );
    return { accepted: !!offered };
  }

  /* ---------------------------------------------------------------- */
  /* Revocation                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Stop every open stream of these projects now (`StudioRevocationService`): a source trashed,
   * deleted or moved to Locked, or a member leaving a space. With `ownerId`, only that account's.
   * Interactive playback never reads Locked media, so unlike an export a stream stops on relock.
   */
  async revokeForProjects(projectIds: readonly string[], ownerId?: string): Promise<number> {
    const open = await this.operations.listUnfinishedForProjects(
      projectIds,
      [MediaOperationKind.StudioPreviewStream],
      ownerId,
    );
    let stopped = 0;
    for (const stream of open) {
      if (await this.closeById(stream.id, stream.ownerId, 'revoked')) {
        stopped++;
      }
    }
    return stopped;
  }

  /** FL-89's revision listener: streams of any earlier revision close, for every account. */
  async revisionCommitted(event: Pick<StudioRevisionEvent, 'projectId' | 'revision'>): Promise<number> {
    const open = await this.operations.listUnfinishedForProjects(
      [event.projectId],
      [MediaOperationKind.StudioPreviewStream],
    );
    let stopped = 0;
    for (const { id } of open) {
      const operation = await this.operations.getForWorker(id);
      if (operation && snapshotOf(operation).projectRevision < event.revision) {
        await this.close(operation, 'stale-revision');
        stopped++;
      }
    }
    return stopped;
  }

  /* ---------------------------------------------------------------- */

  private async closeById(id: string, ownerId: string, reason: StreamCloseReason): Promise<boolean> {
    const operation = await this.operations.getForOwner(id, ownerId);
    if (!operation || !isOpenStream(operation)) {
      return false;
    }
    await this.close(operation, reason);
    return true;
  }

  /** Record why, then cancel: an unclaimed session ends at once, a claimed one when its worker stops. */
  private async close(
    operation: Pick<MediaOperation, 'id' | 'ownerId'>,
    reason: StreamCloseReason,
  ): Promise<MediaOperation | undefined> {
    await this.operations.mergeStreamSignal(operation.id, { closeReason: reason });
    try {
      return await this.operations.requestCancel(operation.id, operation.ownerId);
    } catch (error) {
      // The worker's next signal poll still reads the close reason and stops.
      this.logger.warn(`Could not cancel preview stream ${operation.id}: ${error}`);
      return undefined;
    }
  }

  private async findOwned(auth: AuthDto, id: string): Promise<MediaOperation> {
    const operation = await this.operations.getForOwner(id, auth.user.id);
    if (!operation || operation.kind !== MediaOperationKind.StudioPreviewStream || !operation.projectId) {
      throw new NotFoundException('Preview stream not found');
    }
    return operation;
  }

  private assertStream(operation: MediaOperation) {
    if (operation.kind !== MediaOperationKind.StudioPreviewStream) {
      throw new BadRequestException('This operation is not a preview stream');
    }
  }

  private assertOpen(operation: MediaOperation) {
    if (isOpenStream(operation) && !operation.cancelRequestedAt) {
      return;
    }

    const signal = readStreamSignal(operation.result);
    throw new GoneException({
      message: 'This preview stream has ended',
      code: 'studio_preview_stream_closed',
      closeReason: signal.closeReason ?? impliedCloseReason(operation),
    });
  }

  private parseTime(time: { numerator: string; denominator: string }) {
    try {
      const value = rational(Number(time.numerator), Number(time.denominator));
      if (value.num < 0) {
        throw new RationalError('negative');
      }
      return value;
    } catch {
      throw new BadRequestException('Stream start must be a non-negative exact rational time');
    }
  }

  private map(operation: MediaOperation, now: Date, extra: { currentRevision?: number } = {}): StudioPreviewStreamDto {
    const signal: StreamSignal = readStreamSignal(operation.result);
    const snapshot = snapshotOf(operation);
    const cancelled = !!operation.cancelRequestedAt;
    const state = cancelled ? 'closed' : streamState(operation, signal, now);
    return {
      id: operation.id,
      projectId: operation.projectId!,
      revision: snapshot.projectRevision,
      state,
      closeReason: state === 'closed' ? (signal.closeReason ?? impliedCloseReason(operation)) : null,
      currentRevision: extra.currentRevision ?? null,
      negotiation: signal.negotiation,
      offer: state === 'offered' ? signal.offer!.sdp : null,
      start: snapshot.start,
      bounds: snapshot.bounds,
      keepaliveMs: STREAM_KEEPALIVE_MS,
      expiresAt: new Date(
        new Date(operation.createdAt as unknown as Date).getTime() + STREAM_MAX_DURATION_MS,
      ).toISOString(),
    };
  }
}
