/**
 * Streamed Studio playback (FL-96, `STU-402`): the host's WebRTC client.
 *
 * The exact-frame preview (`preview.ts`) shows the paused playhead. This plays: the render worker
 * encodes the stored revision and streams it to this browser over WebRTC, and the editor's own
 * transport — play, pause, seek — drives it over the peer connection's data channel. Decoding is
 * the browser's media stack, never WebCodecs and never a local HEVC decoder, so the controls work
 * in Safari, Firefox and Chromium builds that have neither.
 *
 * The host owns it, not the engine. Signalling needs credentials, which only the host holds (the
 * engine has no API dependency, FL-88); a `MediaStream` cannot cross the editor frame's message
 * channel; and privacy on revoke must not depend on the engine cooperating. The host renders the
 * picture in its own server preview panel and tears everything down itself.
 *
 * What it guarantees:
 *
 * - **Bound to one stored revision.** A session plays the revision it was opened for. When the
 *   target revision moves, the session is closed and the picture dropped at once; playing on opens
 *   a new session at the new head.
 * - **Stale frames are discarded.** Every intent carries a monotonic seek generation. The picture
 *   is hidden (`seeking`) until the worker reports a frame of the current generation and revision;
 *   reports from an older seek or another revision are dropped.
 * - **Backpressure.** Only the newest intent matters. While the channel is not open, or its buffer
 *   is above the high-water mark, a new intent replaces the pending one instead of queueing.
 * - **Bounded.** The server bounds bitrate, resolution, frame rate and duration; a picture larger
 *   than the bound closes the session. A paused session is released after a while.
 * - **Privacy on revoke.** A session the server closes as revoked — or any poll that finds the
 *   project unreadable — stops the peer connection, drops the stream and never reconnects it.
 * - **Reconnect only after validation.** A dropped connection asks the server to reconnect; the
 *   server re-checks access, the head, every source and the worker's lease before the next
 *   negotiation starts, and closes the session otherwise.
 * - **Honest fallback.** Without `RTCPeerConnection`, without a worker, or after a failure the view
 *   is `unavailable` with its reason, and the panel falls back to exact frames while paused.
 */
import type { StudioPreviewQuality } from './preview';
import {
  STUDIO_STREAM_CONTROL_LABEL,
  parseStudioStreamReport,
  type StudioStreamIntent,
  type StudioStreamReport,
} from './preview-stream-protocol';
import type { Rational } from './rational-time';
import { formatRational } from './rational-time';

/* ------------------------------------------------------------------ */
/* Transport                                                            */
/* ------------------------------------------------------------------ */

export type StudioStreamState = 'queued' | 'negotiating' | 'offered' | 'answered' | 'closed';
export type StudioStreamCloseReason =
  'closed' | 'superseded' | 'revoked' | 'stale-revision' | 'expired' | 'worker-lost' | 'failed';

export interface StudioStreamBounds {
  maxBitrateKbps: number;
  maxWidth: number;
  maxHeight: number;
  maxFrameRate: number;
  maxDurationSeconds: number;
}

/** A session as the server reports it. */
export interface StudioStreamSession {
  id: string;
  revision: number;
  state: StudioStreamState;
  closeReason: StudioStreamCloseReason | null;
  currentRevision: number | null;
  negotiation: number;
  offer: string | null;
  bounds: StudioStreamBounds;
  keepaliveMs: number;
}

export interface StudioStreamOpenRequest {
  projectId: string;
  revision: number;
  at: Rational;
  quality: StudioPreviewQuality;
  viewportWidth: number;
  viewportHeight: number;
}

export type StudioStreamFailure =
  | { kind: 'stale-revision'; currentRevision: number | null }
  | { kind: 'revoked' }
  | { kind: 'worker-lost' }
  | { kind: 'limit' }
  | { kind: 'gone' }
  | { kind: 'negotiation' }
  | { kind: 'offline' }
  | { kind: 'failed' };

export class StudioStreamTransportError extends Error {
  constructor(readonly failure: StudioStreamFailure) {
    super(failure.kind);
    this.name = 'StudioStreamTransportError';
  }
}

/** The authorised calls, supplied by the Svelte host (`preview-stream-transport.ts`). */
export interface StudioPreviewStreamTransport {
  open(request: StudioStreamOpenRequest): Promise<StudioStreamSession>;
  /** Poll the session; this is also its keepalive. */
  get(id: string): Promise<StudioStreamSession>;
  answer(id: string, negotiation: number, sdp: string): Promise<StudioStreamSession>;
  reconnect(id: string): Promise<StudioStreamSession>;
  close(id: string): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* View                                                                 */
/* ------------------------------------------------------------------ */

export type StudioStreamPhase =
  'off' | 'connecting' | 'seeking' | 'playing' | 'paused' | 'reconnecting' | 'unavailable';

export type StudioStreamUnavailableReason =
  | 'unsupported'
  | 'no-worker'
  | 'revoked'
  | 'stale-revision'
  | 'worker-lost'
  | 'limit'
  | 'offline'
  | 'bounds'
  | 'failed';

export interface StudioStreamView {
  phase: StudioStreamPhase;
  /** The received stream. Null whenever nothing may be shown. */
  stream: MediaStream | null;
  /** True only while the picture is confirmed current: the newest seek, the bound revision. */
  live: boolean;
  reason: StudioStreamUnavailableReason | null;
  /** The last accepted frame report. */
  position: { seekGeneration: number; pts: string; timebase: string } | null;
  /** Worker reports discarded as stale since the session opened, for diagnostics and tests. */
  discarded: number;
}

export const offStudioStreamView = (): StudioStreamView => ({
  phase: 'off',
  stream: null,
  live: false,
  reason: null,
  position: null,
  discarded: 0,
});

/** The i18n key for what the panel should say, if anything. */
export const studioStreamMessageKey = (view: StudioStreamView): string | null => {
  switch (view.phase) {
    case 'connecting': {
      return 'frameleaf_studio_stream_connecting';
    }
    case 'seeking': {
      return 'frameleaf_studio_stream_seeking';
    }
    case 'reconnecting': {
      return 'frameleaf_studio_stream_reconnecting';
    }
    case 'unavailable': {
      switch (view.reason) {
        case 'revoked': {
          return 'frameleaf_studio_stream_revoked';
        }
        case 'no-worker':
        case 'worker-lost': {
          return 'frameleaf_studio_stream_no_worker';
        }
        case 'unsupported': {
          return 'frameleaf_studio_stream_unsupported';
        }
        default: {
          return 'frameleaf_studio_stream_unavailable';
        }
      }
    }
    default: {
      return null;
    }
  }
};

/* ------------------------------------------------------------------ */
/* Client                                                               */
/* ------------------------------------------------------------------ */

export interface StudioStreamTarget {
  projectId: string;
  /** The stored revision (FL-89). */
  revision: number;
  quality: StudioPreviewQuality;
  viewportWidth: number;
  viewportHeight: number;
}

export interface StudioTransportState {
  playing: boolean;
  time: Rational;
  /** The playhead jumped (a seek), rather than advanced by playing. */
  seek?: boolean;
}

export interface StudioPreviewStreamOptions {
  transport: StudioPreviewStreamTransport;
  onChange: (view: StudioStreamView) => void;
  /** Null when this browser has no WebRTC; the view is then `unavailable: unsupported`. */
  createPeer?: () => RTCPeerConnection | null;
  /** A session no worker has taken after this long is given up (`no-worker`). */
  noWorkerTimeoutMs?: number;
  /** A session paused this long is released so the worker is free. */
  pauseIdleMs?: number;
  /** A dropped connection is given this long to recover by itself before reconnecting. */
  reconnectGraceMs?: number;
  /** How long to wait for ICE gathering before answering with what there is. */
  iceGatheringTimeoutMs?: number;
}

export interface StudioPreviewStreamClient {
  setTarget(target: StudioStreamTarget | null): void;
  setEnabled(enabled: boolean): void;
  setTransport(state: StudioTransportState): void;
  setOnline(online: boolean): void;
  reportVideoSize(width: number, height: number): void;
  view(): StudioStreamView;
  dispose(): Promise<void>;
}

/** An intent before it is numbered. */
type StudioStreamIntentInput =
  { type: 'play'; at: string } | { type: 'pause'; at: string } | { type: 'seek'; at: string; playing: boolean };

/** Above this the channel is congested: newer intents replace the pending one. */
export const STUDIO_STREAM_HIGH_WATER = 16 * 1024;
/** Sessions that end while playing are reopened at most this many times in a row. */
const REOPEN_BUDGET = 2;

const defaultPeer = (): RTCPeerConnection | null =>
  typeof RTCPeerConnection === 'function'
    ? // Host candidates only: render workers are on the home network (FL-161), and no TURN relay
      // carries a private picture through somebody else's server.
      new RTCPeerConnection({ iceServers: [] })
    : null;

const sameTarget = (a: StudioStreamTarget | null, b: StudioStreamTarget | null) =>
  a?.projectId === b?.projectId && a?.revision === b?.revision;

const failureOf = (error: unknown): StudioStreamFailure =>
  error instanceof StudioStreamTransportError ? error.failure : { kind: 'failed' };

export const createStudioPreviewStream = (options: StudioPreviewStreamOptions): StudioPreviewStreamClient => {
  const createPeer = options.createPeer ?? defaultPeer;
  const noWorkerTimeoutMs = options.noWorkerTimeoutMs ?? 15_000;
  const pauseIdleMs = options.pauseIdleMs ?? 30_000;
  const reconnectGraceMs = options.reconnectGraceMs ?? 1500;
  const iceGatheringTimeoutMs = options.iceGatheringTimeoutMs ?? 3000;

  let view = offStudioStreamView();
  let target: StudioStreamTarget | null = null;
  let enabled = false;
  let online = true;
  let disposed = false;
  let transportState: StudioTransportState | null = null;

  let generation = 0;
  /** The newest intent. Only it is ever sent; older ones are superseded, not queued. */
  let intent: StudioStreamIntent | null = null;
  let intentSent = false;

  let session: StudioStreamSession | null = null;
  /** Bumps whenever the session is replaced, so an answer for an older one is ignored. */
  let epoch = 0;
  let opening = false;
  let openedAt = 0;
  let answeredNegotiation = -1;
  let negotiating = false;
  let reopenBudget = REOPEN_BUDGET;

  let peer: RTCPeerConnection | null = null;
  let channel: RTCDataChannel | null = null;
  let stream: MediaStream | null = null;

  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let pauseTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const publish = (patch: Partial<StudioStreamView>) => {
    view = { ...view, ...patch };
    view.stream = stream && !['off', 'unavailable'].includes(view.phase) ? stream : null;
    view.live = view.phase === 'playing' && view.stream !== null;
    options.onChange(view);
  };

  const clearTimer = (timer: ReturnType<typeof setTimeout> | null) => {
    if (timer) {
      clearTimeout(timer);
    }
    return null;
  };

  /* -------------------------------- peer ------------------------------- */

  const teardownPeer = () => {
    const outgoing = peer;
    peer = null;
    channel?.close();
    channel = null;
    for (const track of stream?.getTracks() ?? []) {
      track.stop();
    }
    stream = null;
    outgoing?.close();
    reconnectTimer = clearTimer(reconnectTimer);
  };

  const sendIntent = () => {
    if (!intent || intentSent || !channel || channel.readyState !== 'open') {
      return;
    }
    if (channel.bufferedAmount > STUDIO_STREAM_HIGH_WATER) {
      // Wait for the buffer to drain; a newer intent meanwhile replaces this one.
      return;
    }
    channel.send(JSON.stringify(intent));
    intentSent = true;
  };

  const onReport = (report: StudioStreamReport) => {
    if (!target || report.revision !== target.revision || !intent || report.seekGeneration < intent.seekGeneration) {
      publish({ discarded: view.discarded + 1 });
      return;
    }
    if (report.type === 'ended') {
      publish({ phase: 'paused' });
      return;
    }
    const position = { seekGeneration: report.seekGeneration, pts: report.pts, timebase: report.timebase };
    publish({
      position,
      phase: intent.type === 'pause' || (intent.type === 'seek' && !intent.playing) ? 'paused' : 'playing',
    });
  };

  const attachChannel = (next: RTCDataChannel) => {
    if (next.label !== STUDIO_STREAM_CONTROL_LABEL) {
      next.close();
      return;
    }
    channel = next;
    next.bufferedAmountLowThreshold = STUDIO_STREAM_HIGH_WATER / 2;
    next.addEventListener('open', () => {
      // A fresh channel has not been told anything, whatever the old one was sent.
      intentSent = false;
      sendIntent();
    });
    next.addEventListener('bufferedamountlow', () => sendIntent());
    // The worker went away (or the network did): the control channel closes long before ICE gives
    // up, so it is the quicker signal to ask the server for a reconnect.
    next.addEventListener('close', () => {
      if (channel === next) {
        scheduleReconnect(0);
      }
    });
    next.addEventListener('message', (event: MessageEvent) => {
      if (channel !== next) {
        return;
      }
      const report = parseStudioStreamReport(event.data);
      if (report) {
        onReport(report);
      }
    });
    if (next.readyState === 'open') {
      intentSent = false;
      sendIntent();
    }
  };

  const iceComplete = (connection: RTCPeerConnection) =>
    new Promise<void>((resolve) => {
      if (connection.iceGatheringState === 'complete') {
        resolve();
        return;
      }
      const timer = setTimeout(done, iceGatheringTimeoutMs);
      function done() {
        clearTimeout(timer);
        connection.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
      function check() {
        if (connection.iceGatheringState === 'complete') {
          done();
        }
      }
      connection.addEventListener('icegatheringstatechange', check);
    });

  const negotiate = async (current: StudioStreamSession) => {
    if (negotiating || !current.offer) {
      return;
    }
    negotiating = true;
    const at = epoch;
    try {
      teardownPeer();
      const connection = createPeer();
      if (!connection) {
        giveUp('unsupported');
        return;
      }
      peer = connection;
      connection.addEventListener('track', (event: RTCTrackEvent) => {
        if (peer !== connection) {
          return;
        }
        stream = event.streams[0] ?? new MediaStream([event.track]);
        publish({});
      });
      connection.addEventListener('datachannel', (event: RTCDataChannelEvent) => {
        if (peer === connection) {
          attachChannel(event.channel);
        }
      });
      connection.addEventListener('connectionstatechange', () => {
        if (peer !== connection) {
          return;
        }
        if (connection.connectionState === 'failed' || connection.connectionState === 'disconnected') {
          scheduleReconnect(connection.connectionState === 'failed' ? 0 : reconnectGraceMs);
        } else if (connection.connectionState === 'connected') {
          reconnectTimer = clearTimer(reconnectTimer);
        }
      });

      await connection.setRemoteDescription({ type: 'offer', sdp: current.offer });
      await connection.setLocalDescription(await connection.createAnswer());
      await iceComplete(connection);
      if (at !== epoch || peer !== connection || !connection.localDescription) {
        return;
      }
      const answered = await options.transport.answer(current.id, current.negotiation, connection.localDescription.sdp);
      if (at !== epoch) {
        return;
      }
      answeredNegotiation = current.negotiation;
      session = answered;
      if (view.phase === 'reconnecting' || view.phase === 'connecting') {
        publish({ phase: intent?.type === 'pause' ? 'paused' : 'seeking' });
      }
    } catch (error) {
      if (at === epoch) {
        await handleFailure(failureOf(error));
      }
    } finally {
      negotiating = false;
    }
  };

  /* ------------------------------ session ------------------------------ */

  const stopPolling = () => {
    pollTimer = clearTimer(pollTimer);
  };

  const schedulePoll = () => {
    stopPolling();
    if (!session || disposed) {
      return;
    }
    // A third of the keepalive while it is live; faster while negotiating, so connecting is quick.
    const settled = session.state === 'answered';
    const delay = settled ? Math.max(500, Math.floor(session.keepaliveMs / 3)) : 500;
    pollTimer = setTimeout(() => void poll(), delay);
  };

  const dropSession = (notifyServer: boolean) => {
    const outgoing = session;
    epoch++;
    session = null;
    opening = false;
    answeredNegotiation = -1;
    stopPolling();
    pauseTimer = clearTimer(pauseTimer);
    teardownPeer();
    if (notifyServer && outgoing) {
      void options.transport.close(outgoing.id).catch(() => undefined);
    }
  };

  const giveUp = (reason: StudioStreamUnavailableReason): void => {
    dropSession(reason !== 'revoked');
    publish({ phase: 'unavailable', reason, position: null });
  };

  const onSession = async (next: StudioStreamSession) => {
    session = next;
    if (next.state === 'closed') {
      await onClosed(next.closeReason ?? 'closed');
      return;
    }
    if (next.state === 'queued' && Date.now() - openedAt > noWorkerTimeoutMs) {
      giveUp('no-worker');
      return;
    }
    if (next.state === 'offered' && next.negotiation > answeredNegotiation) {
      void negotiate(next);
    }
    schedulePoll();
  };

  const poll = async () => {
    const current = session;
    if (!current || disposed) {
      return;
    }
    const at = epoch;
    try {
      const next = await options.transport.get(current.id);
      if (at === epoch) {
        await onSession(next);
      }
    } catch (error) {
      if (at === epoch) {
        await handleFailure(failureOf(error));
      }
    }
  };

  const onClosed = async (reason: StudioStreamCloseReason) => {
    const wasPlaying = intent?.type !== 'pause' && transportState?.playing === true;
    dropSession(false);
    switch (reason) {
      case 'revoked': {
        publish({ phase: 'unavailable', reason: 'revoked', position: null });
        return;
      }
      case 'stale-revision': {
        // The host moves the target to the new head, which reopens if still playing.
        publish({ phase: 'unavailable', reason: 'stale-revision', position: null });
        return;
      }
      case 'expired':
      case 'worker-lost': {
        if (wasPlaying && reopenBudget > 0) {
          reopenBudget--;
          await ensureSession();
          return;
        }
        publish({
          phase: reason === 'worker-lost' ? 'unavailable' : 'off',
          reason: reason === 'worker-lost' ? 'worker-lost' : null,
        });
        return;
      }
      case 'failed': {
        publish({ phase: 'unavailable', reason: 'failed', position: null });
        return;
      }
      default: {
        // Closed here, or superseded by another tab playing the same project.
        publish({ phase: 'off', reason: null, position: null });
      }
    }
  };

  const handleFailure = async (failure: StudioStreamFailure) => {
    switch (failure.kind) {
      case 'revoked': {
        giveUp('revoked');
        return;
      }
      case 'stale-revision': {
        giveUp('stale-revision');
        return;
      }
      case 'worker-lost':
      case 'gone': {
        await onClosed('worker-lost');
        return;
      }
      case 'limit': {
        giveUp('limit');
        return;
      }
      case 'offline': {
        // Keep the session; `setOnline(true)` reconnects it.
        publish({ phase: 'reconnecting' });
        return;
      }
      default: {
        giveUp('failed');
      }
    }
  };

  const ensureSession = async () => {
    if (session || opening || disposed || !enabled || !target || !transportState) {
      return;
    }
    if (typeof RTCPeerConnection !== 'function' && !options.createPeer) {
      publish({ phase: 'unavailable', reason: 'unsupported' });
      return;
    }
    opening = true;
    const at = epoch;
    const bound = target;
    publish({ phase: 'connecting', reason: null, position: null, discarded: 0 });
    try {
      const opened = await options.transport.open({
        projectId: bound.projectId,
        revision: bound.revision,
        at: transportState.time,
        quality: bound.quality,
        viewportWidth: bound.viewportWidth,
        viewportHeight: bound.viewportHeight,
      });
      if (at !== epoch || disposed) {
        void options.transport.close(opened.id).catch(() => undefined);
        return;
      }
      opening = false;
      openedAt = Date.now();
      await onSession(opened);
    } catch (error) {
      opening = false;
      if (at === epoch) {
        await handleFailure(failureOf(error));
      }
    }
  };

  const scheduleReconnect = (delay: number) => {
    if (reconnectTimer || !session) {
      return;
    }
    publish({ phase: 'reconnecting' });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void reconnect();
    }, delay);
  };

  const reconnect = async () => {
    const current = session;
    if (!current || disposed || !online) {
      return;
    }
    const at = epoch;
    try {
      const next = await options.transport.reconnect(current.id);
      if (at === epoch) {
        // The new round's offer arrives on the next poll.
        await onSession(next);
      }
    } catch (error) {
      if (at === epoch) {
        await handleFailure(failureOf(error));
      }
    }
  };

  /* ------------------------------ intents ------------------------------ */

  const setIntent = (next: StudioStreamIntentInput) => {
    generation++;
    intent = { ...next, seekGeneration: generation } as StudioStreamIntent;
    intentSent = false;
    sendIntent();
  };

  const armPauseRelease = () => {
    pauseTimer = clearTimer(pauseTimer);
    pauseTimer = setTimeout(() => {
      pauseTimer = null;
      if (intent?.type === 'pause' || (intent?.type === 'seek' && !intent.playing)) {
        dropSession(true);
        publish({ phase: 'off', position: null });
      }
    }, pauseIdleMs);
  };

  return {
    setTarget(next) {
      if (sameTarget(target, next)) {
        target = next;
        return;
      }
      target = next;
      reopenBudget = REOPEN_BUDGET;
      if (session || opening) {
        // The picture belongs to the previous revision: gone at once, not after a round trip.
        dropSession(true);
        publish({ phase: 'off', reason: null, position: null });
      } else if (view.phase === 'unavailable' && view.reason === 'stale-revision') {
        publish({ phase: 'off', reason: null });
      }
      if (next && transportState?.playing) {
        setIntent({ type: 'play', at: formatRational(transportState.time) });
        void ensureSession();
      }
    },

    setEnabled(next) {
      enabled = next;
      if (!next) {
        dropSession(true);
        publish({ phase: 'off', reason: null, position: null });
      } else if (transportState?.playing) {
        void ensureSession();
      }
    },

    setTransport(state) {
      const previous = transportState;
      transportState = state;
      const at = formatRational(state.time);
      if (state.playing && !previous?.playing) {
        reopenBudget = REOPEN_BUDGET;
        pauseTimer = clearTimer(pauseTimer);
        setIntent({ type: 'play', at });
        if (session && view.phase !== 'reconnecting') {
          publish({ phase: 'seeking' });
        }
        // A new play is a new request: the server authorises it afresh (only a browser without
        // WebRTC stays unavailable).
        if (view.phase === 'unavailable' && view.reason !== 'unsupported') {
          publish({ phase: 'off', reason: null });
        }
        void ensureSession();
        return;
      }
      if (!state.playing && previous?.playing) {
        setIntent({ type: 'pause', at });
        if (session) {
          publish({ phase: 'paused' });
          armPauseRelease();
        }
        return;
      }
      if (state.seek || (!state.playing && previous && at !== formatRational(previous.time))) {
        if (!session) {
          return;
        }
        setIntent({ type: 'seek', at, playing: state.playing });
        if (state.playing) {
          publish({ phase: 'seeking' });
        } else {
          armPauseRelease();
        }
      }
    },

    setOnline(next) {
      const wasOffline = !online;
      online = next;
      if (next && wasOffline && session) {
        scheduleReconnect(0);
      }
    },

    reportVideoSize(width, height) {
      if (!session) {
        return;
      }
      // A little slack for encoder alignment (16-pixel macroblocks).
      if (width > session.bounds.maxWidth + 16 || height > session.bounds.maxHeight + 16) {
        giveUp('bounds');
      }
    },

    view: () => view,

    dispose() {
      if (!disposed) {
        dropSession(true);
        disposed = true;
        intent = null;
        publish({ phase: 'off', reason: null, position: null });
      }
      return Promise.resolve();
    },
  };
};
