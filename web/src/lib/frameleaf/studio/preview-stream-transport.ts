/**
 * The authorised stream signalling transport (FL-96, `STU-402`).
 *
 * Like `preview-transport.ts`, the only module in the streaming path that knows the SDK exists, on
 * the Svelte side of the host boundary, so `preview-stream.ts` can be tested without a network.
 */
import {
  answerStudioPreviewStream,
  closeStudioPreviewStream,
  getStudioPreviewStream,
  openStudioPreviewStream,
  reconnectStudioPreviewStream,
  StudioPreviewQuality as ApiStudioPreviewQuality,
  type StudioPreviewStreamDto,
} from '@frameleaf/sdk';
import type { StudioPreviewQuality } from './preview';
import { toPreviewTimeWire } from './preview';
import {
  StudioStreamTransportError,
  type StudioPreviewStreamTransport,
  type StudioStreamCloseReason,
  type StudioStreamFailure,
  type StudioStreamSession,
  type StudioStreamState,
} from './preview-stream';

const apiQuality: Record<StudioPreviewQuality, ApiStudioPreviewQuality> = {
  draft: ApiStudioPreviewQuality.Draft,
  standard: ApiStudioPreviewQuality.Standard,
  full: ApiStudioPreviewQuality.Full,
};

const statusOf = (error: unknown): number | undefined => {
  const candidate = error as { status?: unknown; response?: { status?: unknown } };
  const status = candidate?.status ?? candidate?.response?.status;
  return typeof status === 'number' ? status : undefined;
};

const bodyOf = (error: unknown): Record<string, unknown> => {
  const data = (error as { data?: unknown })?.data;
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
};

/** Turn a signalling error into something the client can act on. Unknown is `failed`, never guessed. */
export const classifyStreamError = (error: unknown): StudioStreamFailure => {
  if (globalThis.navigator && !navigator.onLine) {
    return { kind: 'offline' };
  }
  const status = statusOf(error);
  const body = bodyOf(error);
  if (status === 409) {
    switch (body.code) {
      case 'studio_preview_stale_revision': {
        return {
          kind: 'stale-revision',
          currentRevision:
            typeof body.currentRevision === 'number' && Number.isSafeInteger(body.currentRevision)
              ? body.currentRevision
              : null,
        };
      }
      case 'studio_preview_sources_refused': {
        return { kind: 'revoked' };
      }
      case 'studio_preview_stream_worker_lost': {
        return { kind: 'worker-lost' };
      }
      case 'studio_preview_stream_negotiation': {
        return { kind: 'negotiation' };
      }
      default: {
        return { kind: 'failed' };
      }
    }
  }
  if (status === 410) {
    return { kind: 'gone' };
  }
  if (status === 429) {
    return { kind: 'limit' };
  }
  if (status !== undefined && [401, 403, 404].includes(status)) {
    // The project, or this session of it, is no longer the caller's to see.
    return { kind: 'revoked' };
  }
  return { kind: 'failed' };
};

const toSession = (dto: StudioPreviewStreamDto): StudioStreamSession => ({
  id: dto.id,
  revision: dto.revision,
  state: dto.state as unknown as StudioStreamState,
  closeReason: (dto.closeReason ?? null) as StudioStreamCloseReason | null,
  currentRevision: dto.currentRevision ?? null,
  negotiation: dto.negotiation,
  offer: dto.offer ?? null,
  bounds: dto.bounds,
  keepaliveMs: dto.keepaliveMs,
});

const call = async (run: () => Promise<StudioPreviewStreamDto>): Promise<StudioStreamSession> => {
  try {
    return toSession(await run());
  } catch (error) {
    throw new StudioStreamTransportError(classifyStreamError(error));
  }
};

export const createStudioPreviewStreamTransport = (): StudioPreviewStreamTransport => ({
  open: (request) =>
    call(() =>
      openStudioPreviewStream({
        studioPreviewStreamOpenDto: {
          projectId: request.projectId,
          revision: request.revision,
          time: toPreviewTimeWire(request.at),
          quality: apiQuality[request.quality],
          viewportWidth: request.viewportWidth,
          viewportHeight: request.viewportHeight,
        },
      }),
    ),
  get: (id) => call(() => getStudioPreviewStream({ id })),
  answer: (id, negotiation, sdp) =>
    call(() => answerStudioPreviewStream({ id, studioPreviewStreamAnswerDto: { negotiation, sdp } })),
  reconnect: (id) => call(() => reconnectStudioPreviewStream({ id })),
  async close(id) {
    try {
      await closeStudioPreviewStream({ id });
    } catch {
      // Best effort: the server closes a session nobody polls within its keepalive.
    }
  },
});
