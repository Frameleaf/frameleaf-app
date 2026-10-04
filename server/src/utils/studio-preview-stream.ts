/**
 * Bounded WebRTC playback of a stored Studio revision (FL-96, `STU-402`): the rules.
 *
 * The exact-frame path (`studio-preview.ts`) answers "what does this instant look like". A stream
 * answers "play from here": the render worker encodes the revision and sends it to the browser
 * over WebRTC, and the browser drives it (play, pause, seek) over a data channel. The server is
 * never on the media path. It authorises the session, relays the offer and the answer, bounds what
 * may be sent, and stops the session when access, the revision or the worker goes.
 *
 * Framework-free, like `studio-preview.ts`: the service and its tests import the same rules.
 *
 * ## The signalling record
 *
 * A session is a `studio_preview_stream` media operation, so the claim, lease, heartbeat and
 * cancellation are FL-104's and FL-95's. Its mutable `result` column holds the signalling record
 * ({@link StreamSignal}). Non-trickle ICE: each side sends one complete description with its
 * candidates, so a negotiation is exactly one offer and one answer.
 *
 * - `negotiation` numbers the offer/answer round. A reconnect starts the next round; an offer or
 *   answer for any other round is refused, so a late message can never pair with the wrong peer.
 * - `offer.attempt` is the claim attempt that offered. A worker that takes the session over after
 *   recovery offers afresh rather than inheriting its predecessor's description.
 */
import { MediaOperationStatus } from 'src/enum.js';

/** The browser must show it is still there this often; the host polls at a third of it. */
export const STREAM_KEEPALIVE_MS = 5000;
/** A session nobody has polled for this long is closed: the tab, the network or the person went. */
export const STREAM_IDLE_MS = 20_000;
/** Hard bound on one session. Playing on reconnects into a new one, re-authorised. */
export const STREAM_MAX_DURATION_MS = 30 * 60 * 1000;
/** Open sessions one account may hold at once, across projects and tabs. */
export const STREAM_MAX_PER_ACCOUNT = 2;
/** A session description is a few kilobytes; anything near this is not one. */
export const STREAM_MAX_SDP_BYTES = 64 * 1024;

export type StreamQuality = 'draft' | 'standard' | 'full';

export type StreamBounds = {
  maxBitrateKbps: number;
  maxWidth: number;
  maxHeight: number;
  maxFrameRate: number;
  maxDurationSeconds: number;
};

const QUALITY_BOUNDS: Record<StreamQuality, { kbps: number; width: number; height: number; fps: number }> = {
  draft: { kbps: 1500, width: 1280, height: 720, fps: 30 },
  standard: { kbps: 6000, width: 1920, height: 1080, fps: 30 },
  full: { kbps: 12_000, width: 3840, height: 2160, fps: 60 },
};

/**
 * What a session may send. Never larger than the viewport that asked, never above the quality's
 * cap. The worker honours these, the server writes the bitrate into the answer it relays, and the
 * browser closes a session whose picture exceeds them.
 */
export const streamBounds = (quality: StreamQuality, viewportWidth: number, viewportHeight: number): StreamBounds => {
  const cap = QUALITY_BOUNDS[quality];
  return {
    maxBitrateKbps: cap.kbps,
    maxWidth: Math.min(cap.width, viewportWidth),
    maxHeight: Math.min(cap.height, viewportHeight),
    maxFrameRate: cap.fps,
    maxDurationSeconds: STREAM_MAX_DURATION_MS / 1000,
  };
};

/* ------------------------------------------------------------------ */
/* Session descriptions                                                 */
/* ------------------------------------------------------------------ */

type Section = { kind: string; lines: string[] };

const sectionsOf = (sdp: string): { session: string[]; media: Section[] } => {
  const lines = sdp.split(/\r?\n/).filter((line) => line.length > 0);
  const session: string[] = [];
  const media: Section[] = [];
  for (const line of lines) {
    if (line.startsWith('m=')) {
      media.push({ kind: line.slice(2).split(' ', 1)[0], lines: [line] });
    } else if (media.length > 0) {
      media.at(-1)!.lines.push(line);
    } else {
      session.push(line);
    }
  }
  return { session, media };
};

const joinSdp = (session: string[], media: Section[]) =>
  [...session, ...media.flatMap((section) => section.lines), ''].join('\r\n');

const direction = (section: Section) =>
  section.lines.find((line) => /^a=(sendonly|recvonly|sendrecv|inactive)$/.test(line))?.slice(2) ?? 'sendrecv';

const looksLikeSdp = (sdp: string) =>
  typeof sdp === 'string' && sdp.length > 0 && sdp.length <= STREAM_MAX_SDP_BYTES && sdp.startsWith('v=0');

/**
 * The shape a preview offer must have: video the worker only sends, one data channel for control,
 * and nothing else. No audio, and nothing the browser could be asked to send back.
 */
export const isValidOfferSdp = (sdp: string): boolean => {
  if (!looksLikeSdp(sdp)) {
    return false;
  }
  const { media } = sectionsOf(sdp);
  const video = media.filter((section) => section.kind === 'video');
  const application = media.filter((section) => section.kind === 'application');
  return (
    video.length === 1 &&
    application.length === 1 &&
    media.length === 2 &&
    video.every((section) => direction(section) === 'sendonly')
  );
};

/** The browser's answer: one receive-only/inactive video and one control channel, with no other media. */
export const isValidAnswerSdp = (sdp: string): boolean => {
  if (!looksLikeSdp(sdp)) {
    return false;
  }
  const { media } = sectionsOf(sdp);
  const video = media.filter((section) => section.kind === 'video');
  const application = media.filter((section) => section.kind === 'application');
  return (
    video.length === 1 &&
    application.length === 1 &&
    media.length === 2 &&
    video.every((section) => ['recvonly', 'inactive'].includes(direction(section)))
  );
};

/**
 * Write the session's bitrate bound into every video section. In the answer the server relays this
 * is the receiver's limit, which a compliant sender may not exceed (RFC 3890 `TIAS`, and `AS` for
 * the browsers that read only that), whatever the worker was configured with.
 */
export const capVideoBitrate = (sdp: string, kbps: number): string => {
  const { session, media } = sectionsOf(sdp);
  for (const section of media) {
    if (section.kind !== 'video') {
      continue;
    }
    const lines = section.lines.filter((line) => !line.startsWith('b=AS:') && !line.startsWith('b=TIAS:'));
    // `b=` follows `i=` and `c=` in a media section (RFC 8866 §5).
    let at = 1;
    while (at < lines.length && (lines[at].startsWith('i=') || lines[at].startsWith('c='))) {
      at++;
    }
    lines.splice(at, 0, `b=AS:${kbps}`, `b=TIAS:${kbps * 1000}`);
    section.lines = lines;
  }
  return joinSdp(session, media);
};

/* ------------------------------------------------------------------ */
/* The signalling record                                                */
/* ------------------------------------------------------------------ */

export const STREAM_CLOSE_REASONS = [
  /** The person closed it, or opened another stream of the same project. */
  'closed',
  'superseded',
  /** Access to the project or a source ended: trashed, deleted, Locked, unshared. */
  'revoked',
  /** A newer revision was stored; the stream showed a graph that no longer exists. */
  'stale-revision',
  /** Its bound or its keepalive ran out. */
  'expired',
  /** The worker holding it stopped answering. */
  'worker-lost',
  'failed',
] as const;

export type StreamCloseReason = (typeof STREAM_CLOSE_REASONS)[number];

export type StreamSignal = {
  negotiation: number;
  offer: { sdp: string; negotiation: number; attempt: number } | null;
  answer: { sdp: string; negotiation: number } | null;
  keepaliveAt: string | null;
  closeReason: StreamCloseReason | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const nonNegativeInteger = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Read the record back, keeping only what is well formed and belongs to the current round. */
export const readStreamSignal = (result: unknown): StreamSignal => {
  const record = isRecord(result) ? result : {};
  const negotiation = nonNegativeInteger(record.negotiation) ?? 0;

  const offerValue = isRecord(record.offer) ? record.offer : null;
  const offerAttempt = nonNegativeInteger(offerValue?.attempt);
  const offer =
    offerValue && typeof offerValue.sdp === 'string' && offerValue.negotiation === negotiation && offerAttempt !== null
      ? { sdp: offerValue.sdp, negotiation, attempt: offerAttempt }
      : null;

  const answerValue = isRecord(record.answer) ? record.answer : null;
  const answer =
    answerValue && typeof answerValue.sdp === 'string' && answerValue.negotiation === negotiation
      ? { sdp: answerValue.sdp, negotiation }
      : null;

  const keepaliveAt =
    typeof record.keepaliveAt === 'string' && !Number.isNaN(Date.parse(record.keepaliveAt)) ? record.keepaliveAt : null;
  const closeReason = STREAM_CLOSE_REASONS.includes(record.closeReason as StreamCloseReason)
    ? (record.closeReason as StreamCloseReason)
    : null;

  return { negotiation, offer, answer, keepaliveAt, closeReason };
};

/* ------------------------------------------------------------------ */
/* Session state                                                        */
/* ------------------------------------------------------------------ */

export type StreamState = 'queued' | 'negotiating' | 'offered' | 'answered' | 'closed';

type StreamOperation = {
  status: MediaOperationStatus | string;
  attempt: number;
  claimExpiresAt: Date | string | null;
};

const CLAIMED = new Set<string>([
  MediaOperationStatus.Preparing,
  MediaOperationStatus.Rendering,
  MediaOperationStatus.Validating,
]);
const OPEN = new Set<string>([MediaOperationStatus.Queued, ...CLAIMED]);

export const isOpenStream = (operation: Pick<StreamOperation, 'status'>) => OPEN.has(operation.status);

/**
 * Where the session is. `queued` waits for a worker; `negotiating` has one but no offer for this
 * round from this claim; `offered` waits for the browser's answer; `answered` is up to the peers.
 */
export const streamState = (operation: StreamOperation, signal: StreamSignal, now: Date): StreamState => {
  if (!isOpenStream(operation)) {
    return 'closed';
  }
  if (!CLAIMED.has(operation.status) || streamWorkerLost(operation, now)) {
    return operation.status === MediaOperationStatus.Queued ? 'queued' : 'negotiating';
  }
  if (!signal.offer || signal.offer.attempt !== operation.attempt) {
    return 'negotiating';
  }
  return signal.answer ? 'answered' : 'offered';
};

/**
 * The worker holding the session is gone: its lease lapsed, or recovery already put a session that
 * had been claimed back in the queue. A stream cannot resume where a lost worker stopped — the
 * browser's peer is gone with it — so the session closes and the browser opens a fresh one.
 */
export const streamWorkerLost = (operation: StreamOperation, now: Date): boolean => {
  if (operation.status === MediaOperationStatus.Queued) {
    return operation.attempt > 0;
  }
  if (!CLAIMED.has(operation.status)) {
    return false;
  }
  if (!operation.claimExpiresAt) {
    return true;
  }
  return new Date(operation.claimExpiresAt).getTime() <= now.getTime();
};

/** Why an open session should close now, if it should: its keepalive or its bound ran out. */
export const streamCloseReason = (input: {
  createdAt: Date | string;
  signal: StreamSignal;
  now: Date;
}): StreamCloseReason | null => {
  const now = input.now.getTime();
  const created = new Date(input.createdAt).getTime();
  const lastSeen = input.signal.keepaliveAt ? Date.parse(input.signal.keepaliveAt) : created;
  if (now - lastSeen > STREAM_IDLE_MS || now - created > STREAM_MAX_DURATION_MS) {
    return 'expired';
  }
  return null;
};
