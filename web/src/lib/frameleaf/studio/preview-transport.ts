/**
 * The authorized preview transport (FL-96, `STU-402`).
 *
 * This is the only module in the preview path that knows the SDK exists, and it lives on the
 * Svelte side of the host boundary. The engine is handed {@link StudioPreviewView} data and
 * nothing else, so there is no route by which React reaches an endpoint, a token or a URL.
 *
 * It exists as its own file for one reason: `preview.ts` stays free of the SDK, which is what
 * lets its rules — revision binding, seek generations, caching, backpressure — be tested
 * without a network.
 */

import { cancelStudioPreview, getStudioPreview, requestStudioPreview, viewStudioPreviewFrame } from '@immich/sdk';
import type {
  StudioPreviewIntent,
  StudioPreviewQuality,
  StudioPreviewRecord,
  StudioPreviewRequestResult,
  StudioPreviewStatus,
  StudioPreviewTransport,
  StudioPreviewTransportFailure,
} from './preview';
import { toPreviewTimeWire } from './preview';

/** Carries the classified reason so the client can tell "stale" from "broken". */
export class StudioPreviewTransportError extends Error {
  constructor(readonly failure: StudioPreviewTransportFailure) {
    super(failure.kind);
    this.name = 'StudioPreviewTransportError';
  }
}

const statusOf = (error: unknown): number | undefined => {
  const candidate = error as { status?: unknown; response?: { status?: unknown } };
  const status = candidate?.status ?? candidate?.response?.status;
  return typeof status === 'number' ? status : undefined;
};

const bodyOf = (error: unknown): Record<string, unknown> => {
  const data = (error as { data?: unknown })?.data;
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
};

/**
 * Turn a transport error into a reason the client can act on.
 *
 * `409` with the stale code is the one that matters: it is the server refusing to serve a frame
 * for a revision the project has moved past, and it carries the digest the client must move to.
 * Anything it cannot classify becomes `failed`, never `stale-revision` — guessing "stale" would
 * make the client silently drop a cache it should have kept.
 */
export const classifyPreviewError = (error: unknown): StudioPreviewTransportFailure => {
  if (globalThis.navigator && globalThis.navigator.onLine === false) {
    return { kind: 'offline' };
  }

  const status = statusOf(error);
  const body = bodyOf(error);

  if (status === 409) {
    if (body.code === 'studio_preview_stale_revision') {
      return {
        kind: 'stale-revision',
        currentRevisionDigest:
          typeof body.currentRevisionDigest === 'string' ? body.currentRevisionDigest : null,
      };
    }
    return { kind: 'not-ready' };
  }

  if (status === 410) {
    return { kind: 'gone' };
  }

  if (status === 401 || status === 403 || status === 404) {
    return { kind: 'forbidden' };
  }

  return { kind: 'failed' };
};

const toRecord = (dto: {
  id: string;
  revisionDigest: string;
  status: string;
  etag: string;
  framePts: string | null;
  framePtsTimebase: string | null;
  toneMapped: boolean;
  errorCode: string | null;
}): StudioPreviewRecord => ({
  id: dto.id,
  revisionDigest: dto.revisionDigest,
  status: dto.status as StudioPreviewStatus,
  etag: dto.etag,
  framePts: dto.framePts,
  framePtsTimebase: dto.framePtsTimebase,
  toneMapped: dto.toneMapped,
  errorCode: dto.errorCode,
});

export const createStudioPreviewTransport = (): StudioPreviewTransport => ({
  async request(intent: StudioPreviewIntent, seekGeneration: number): Promise<StudioPreviewRequestResult> {
    try {
      const response = await requestStudioPreview({
        studioPreviewRequestDto: {
          projectId: intent.projectId,
          revisionDigest: intent.revisionDigest,
          time: toPreviewTimeWire(intent.time),
          quality: intent.quality as StudioPreviewQuality,
          viewportWidth: intent.viewportWidth,
          viewportHeight: intent.viewportHeight,
          seekGeneration,
        },
      });

      return {
        preview: toRecord(response.preview),
        currentRevisionDigest: response.currentRevisionDigest,
        supersededPreviewIds: response.supersededPreviewIds,
      };
    } catch (error) {
      throw new StudioPreviewTransportError(classifyPreviewError(error));
    }
  },

  async poll(previewId: string): Promise<StudioPreviewRecord> {
    try {
      return toRecord(await getStudioPreview({ id: previewId }));
    } catch (error) {
      throw new StudioPreviewTransportError(classifyPreviewError(error));
    }
  },

  async fetchFrame(previewId: string, etag: string): Promise<{ objectUrl: string; etag: string }> {
    try {
      const blob = await viewStudioPreviewFrame({ id: previewId });
      // The caller owns this URL and revokes it; the cache is what tracks that ownership.
      return { objectUrl: URL.createObjectURL(blob), etag };
    } catch (error) {
      throw new StudioPreviewTransportError(classifyPreviewError(error));
    }
  },

  async cancel(previewId: string): Promise<void> {
    try {
      await cancelStudioPreview({ id: previewId });
    } catch {
      // Best effort. The server's own retention sweep settles a preview nobody released, so a
      // failed cancel must not surface as an editor error.
    }
  },
});
