import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STUDIO_STREAM_HIGH_WATER,
  StudioStreamTransportError,
  createStudioPreviewStream,
  studioStreamMessageKey,
  type StudioPreviewStreamClient,
  type StudioPreviewStreamTransport,
  type StudioStreamFailure,
  type StudioStreamSession,
  type StudioStreamView,
} from './preview-stream';
import { STUDIO_STREAM_CONTROL_LABEL, parseStudioStreamReport } from './preview-stream-protocol';
import { rational } from './rational-time';

/* A peer connection and data channel, as far as the client uses them. */

class FakeChannel extends EventTarget {
  readyState: RTCDataChannelState = 'connecting';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  sent: Array<Record<string, unknown>> = [];
  constructor(readonly label = STUDIO_STREAM_CONTROL_LABEL) {
    super();
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 'closed';
  }
  open() {
    this.readyState = 'open';
    this.dispatchEvent(new Event('open'));
  }
  report(message: Record<string, unknown>) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
  }
}

class FakeTrack {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

class FakeStream {
  constructor(readonly tracks = [new FakeTrack()]) {}
  getTracks() {
    return this.tracks;
  }
}

class FakePeer extends EventTarget {
  iceGatheringState: RTCIceGatheringState = 'complete';
  connectionState: RTCPeerConnectionState = 'new';
  localDescription: { type: string; sdp: string } | null = null;
  remote: string | null = null;
  closed = false;
  setRemoteDescription(description: { sdp: string }) {
    this.remote = description.sdp;
    return Promise.resolve();
  }
  createAnswer() {
    return Promise.resolve({ type: 'answer', sdp: `answer-to:${this.remote}` });
  }
  setLocalDescription(description: { type: string; sdp: string }) {
    this.localDescription = description;
    return Promise.resolve();
  }
  close() {
    this.closed = true;
  }
  /** What the worker's side of a connection does once it is up. */
  connect() {
    const stream = new FakeStream();
    this.dispatchEvent(Object.assign(new Event('track'), { streams: [stream], track: stream.tracks[0] }));
    const channel = new FakeChannel();
    this.dispatchEvent(Object.assign(new Event('datachannel'), { channel }));
    this.state('connected');
    channel.open();
    return { stream, channel };
  }
  state(next: RTCPeerConnectionState) {
    this.connectionState = next;
    this.dispatchEvent(new Event('connectionstatechange'));
  }
}

const BOUNDS = { maxBitrateKbps: 6000, maxWidth: 1280, maxHeight: 720, maxFrameRate: 30, maxDurationSeconds: 1800 };

const session = (overrides: Partial<StudioStreamSession> = {}): StudioStreamSession => ({
  id: 'stream-1',
  revision: 3,
  state: 'queued',
  closeReason: null,
  currentRevision: null,
  negotiation: 0,
  offer: null,
  bounds: BOUNDS,
  keepaliveMs: 5000,
  ...overrides,
});

const failure = (value: StudioStreamFailure) => new StudioStreamTransportError(value);

/** A server whose next poll answers are scripted, and which records every call. */
const fakeServer = () => {
  let current = session();
  const calls: string[] = [];
  const transport: StudioPreviewStreamTransport = {
    open: vi.fn((request) => {
      calls.push(`open r${request.revision}@${request.at.num}/${request.at.den}`);
      current = session({ revision: request.revision, id: `stream-${calls.length}` });
      return Promise.resolve(current);
    }),
    get: vi.fn(() => {
      calls.push('get');
      return Promise.resolve(current);
    }),
    answer: vi.fn((id, negotiation, sdp) => {
      calls.push(`answer n${negotiation} ${sdp}`);
      current = { ...current, state: 'answered', offer: null };
      return Promise.resolve(current);
    }),
    reconnect: vi.fn(() => {
      calls.push('reconnect');
      current = { ...current, state: 'negotiating', negotiation: current.negotiation + 1, offer: null };
      return Promise.resolve(current);
    }),
    close: vi.fn((id) => {
      calls.push(`close ${id}`);
      return Promise.resolve();
    }),
  };
  return {
    transport,
    calls,
    set(next: Partial<StudioStreamSession>) {
      current = { ...current, ...next };
    },
    get current() {
      return current;
    },
  };
};

const TARGET = {
  projectId: 'project-1',
  revision: 3,
  quality: 'standard' as const,
  viewportWidth: 1280,
  viewportHeight: 720,
};

describe('studio preview stream', () => {
  let server: ReturnType<typeof fakeServer>;
  let peers: FakePeer[];
  let views: StudioStreamView[];
  let client: StudioPreviewStreamClient;

  const latest = () => views.at(-1)!;
  const flush = async (ms = 0) => {
    await vi.advanceTimersByTimeAsync(ms);
  };

  /** Play from `at`, let a worker offer, and connect. */
  const startPlaying = async (at = rational(1, 1)) => {
    client.setTransport({ playing: true, time: at });
    await flush();
    server.set({ state: 'offered', offer: 'offer-0' });
    await flush(600);
    const peer = peers.at(-1)!;
    const connected = peer.connect();
    await flush();
    return { peer, ...connected };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    server = fakeServer();
    peers = [];
    views = [];
    client = createStudioPreviewStream({
      transport: server.transport,
      onChange: (view) => {
        views.push(view);
      },
      createPeer: () => {
        const peer = new FakePeer();
        peers.push(peer);
        return peer as unknown as RTCPeerConnection;
      },
      noWorkerTimeoutMs: 5000,
      pauseIdleMs: 10_000,
      reconnectGraceMs: 1000,
    });
    client.setTarget(TARGET);
    client.setEnabled(true);
  });

  afterEach(async () => {
    await client.dispose();
    vi.useRealTimers();
  });

  it('opens a session at the playhead on play, answers the offer and plays once the current seek reports', async () => {
    const { channel } = await startPlaying(rational(1001, 30_000));

    expect(server.calls[0]).toBe('open r3@1001/30000');
    expect(server.calls).toContain('answer n0 answer-to:offer-0');
    expect(channel.sent).toEqual([{ type: 'play', seekGeneration: 1, at: '1001/30000' }]);
    // Connected, but nothing is current until the worker reports a frame of this seek.
    expect(latest()).toMatchObject({ phase: 'seeking', live: false });
    expect(latest().stream).not.toBeNull();

    channel.report({ type: 'frame', seekGeneration: 1, revision: 3, pts: '3003', timebase: '1/90000' });
    expect(latest()).toMatchObject({
      phase: 'playing',
      live: true,
      position: { seekGeneration: 1, pts: '3003', timebase: '1/90000' },
    });
  });

  it('pauses and seeks over the channel, discarding frames from older seeks and other revisions', async () => {
    const { channel } = await startPlaying();
    channel.report({ type: 'frame', seekGeneration: 1, revision: 3, pts: '0', timebase: '1/90000' });

    client.setTransport({ playing: true, time: rational(10, 1), seek: true });
    expect(channel.sent.at(-1)).toEqual({ type: 'seek', seekGeneration: 2, at: '10/1', playing: true });
    expect(latest()).toMatchObject({ phase: 'seeking', live: false });

    // A frame still in flight from before the seek, and one from another revision: not shown.
    channel.report({ type: 'frame', seekGeneration: 1, revision: 3, pts: '90000', timebase: '1/90000' });
    channel.report({ type: 'frame', seekGeneration: 2, revision: 2, pts: '900000', timebase: '1/90000' });
    expect(latest()).toMatchObject({ phase: 'seeking', live: false, discarded: 2 });

    channel.report({ type: 'frame', seekGeneration: 2, revision: 3, pts: '900000', timebase: '1/90000' });
    expect(latest()).toMatchObject({ phase: 'playing', live: true });

    client.setTransport({ playing: false, time: rational(11, 1) });
    expect(channel.sent.at(-1)).toEqual({ type: 'pause', seekGeneration: 3, at: '11/1' });
    expect(latest()).toMatchObject({ phase: 'paused', live: false });

    // Scrubbing while paused keeps the worker where the playhead is.
    client.setTransport({ playing: false, time: rational(12, 1) });
    expect(channel.sent.at(-1)).toEqual({ type: 'seek', seekGeneration: 4, at: '12/1', playing: false });
  });

  it('applies backpressure: a congested channel sends only the newest intent', async () => {
    const { channel } = await startPlaying();
    channel.bufferedAmount = STUDIO_STREAM_HIGH_WATER + 1;
    for (let second = 2; second < 10; second++) {
      client.setTransport({ playing: true, time: rational(second, 1), seek: true });
    }
    expect(channel.sent).toHaveLength(1);

    channel.bufferedAmount = 0;
    channel.dispatchEvent(new Event('bufferedamountlow'));
    expect(channel.sent).toHaveLength(2);
    expect(channel.sent.at(-1)).toMatchObject({ type: 'seek', seekGeneration: 9, at: '9/1' });
  });

  it('keeps the session alive by polling while it plays', async () => {
    await startPlaying();
    const polls = server.calls.filter((call) => call === 'get').length;
    await flush(5000);
    expect(server.calls.filter((call) => call === 'get').length).toBeGreaterThanOrEqual(polls + 2);
  });

  it('drops the picture and the connection at once when the server closes the session as revoked', async () => {
    const { peer, stream } = await startPlaying();
    server.set({ state: 'closed', closeReason: 'revoked' });
    await flush(2000);

    expect(peer.closed).toBe(true);
    expect(stream.tracks[0].stopped).toBe(true);
    expect(latest()).toMatchObject({ phase: 'unavailable', reason: 'revoked', stream: null, live: false });
    expect(studioStreamMessageKey(latest())).toBe('frameleaf_studio_stream_revoked');
    // Nothing reconnects a revoked session.
    await flush(5000);
    expect(server.transport.reconnect).not.toHaveBeenCalled();
  });

  it('treats a poll refused for access as revoked', async () => {
    const { peer } = await startPlaying();
    vi.mocked(server.transport.get).mockRejectedValue(failure({ kind: 'revoked' }));
    await flush(2000);
    expect(peer.closed).toBe(true);
    expect(latest()).toMatchObject({ phase: 'unavailable', reason: 'revoked', stream: null });
  });

  it('reconnects a dropped connection through the server and answers the new round', async () => {
    const { peer } = await startPlaying();
    peer.state('disconnected');
    expect(latest().phase).toBe('reconnecting');
    await flush(1000);
    expect(server.transport.reconnect).toHaveBeenCalledWith('stream-1');

    server.set({ state: 'offered', offer: 'offer-1' });
    await flush(600);
    expect(server.calls).toContain('answer n1 answer-to:offer-1');
    const next = peers.at(-1)!;
    expect(next).not.toBe(peer);
    expect(peer.closed).toBe(true);
    const { channel } = next.connect();
    // The new channel is told where to be.
    expect(channel.sent).toEqual([{ type: 'play', seekGeneration: 1, at: '1/1' }]);
  });

  it('asks for a reconnect as soon as the control channel closes under it', async () => {
    const { channel } = await startPlaying();
    channel.close();
    channel.dispatchEvent(new Event('close'));
    await flush();
    expect(server.transport.reconnect).toHaveBeenCalledTimes(1);
  });

  it('gives up when the reconnect check refuses the session', async () => {
    const { peer } = await startPlaying();
    vi.mocked(server.transport.reconnect).mockRejectedValue(failure({ kind: 'revoked' }));
    peer.state('failed');
    await flush();
    expect(latest()).toMatchObject({ phase: 'unavailable', reason: 'revoked', stream: null });
  });

  it('opens a fresh session when the worker was lost while playing', async () => {
    const { peer } = await startPlaying();
    vi.mocked(server.transport.reconnect).mockRejectedValueOnce(failure({ kind: 'worker-lost' }));
    peer.state('failed');
    await flush();
    expect(server.calls.filter((call) => call.startsWith('open'))).toHaveLength(2);
    expect(latest().phase).toBe('connecting');
  });

  it('closes the session and drops the picture when the revision moves, and reopens at the new head', async () => {
    const { peer } = await startPlaying();
    client.setTarget({ ...TARGET, revision: 4 });
    expect(peer.closed).toBe(true);
    expect(server.calls).toContain('close stream-1');
    await flush();
    expect(server.calls.at(-1)).toMatch(/^open r4@/);
  });

  it('says no worker when nobody takes the session', async () => {
    client.setTransport({ playing: true, time: rational(0, 1) });
    await flush(6000);
    expect(latest()).toMatchObject({ phase: 'unavailable', reason: 'no-worker' });
    expect(server.calls).toContain('close stream-1');
  });

  it('is unavailable without WebRTC, so the panel falls back to exact frames', async () => {
    const bare = createStudioPreviewStream({
      transport: server.transport,
      onChange: (view) => {
        views.push(view);
      },
      createPeer: () => null,
    });
    bare.setTarget(TARGET);
    bare.setEnabled(true);
    bare.setTransport({ playing: true, time: rational(0, 1) });
    await flush();
    server.set({ state: 'offered', offer: 'offer-0' });
    await flush(600);
    expect(latest()).toMatchObject({ phase: 'unavailable', reason: 'unsupported' });
    await bare.dispose();
  });

  it('closes a session whose picture exceeds its bounds', async () => {
    await startPlaying();
    client.reportVideoSize(3840, 2160);
    await flush();
    expect(latest()).toMatchObject({ phase: 'unavailable', reason: 'bounds', stream: null });
  });

  it('releases a paused session after a while, and reopens on the next play', async () => {
    const { peer } = await startPlaying();
    client.setTransport({ playing: false, time: rational(2, 1) });
    await flush(10_000);
    expect(peer.closed).toBe(true);
    expect(latest().phase).toBe('off');
    client.setTransport({ playing: true, time: rational(2, 1) });
    await flush();
    expect(server.calls.findLast((call) => call.startsWith('open'))).toBe('open r3@2/1');
  });

  it('closes the session and clears everything on dispose', async () => {
    const { peer } = await startPlaying();
    await client.dispose();
    expect(peer.closed).toBe(true);
    expect(latest()).toMatchObject({ phase: 'off', stream: null });
    expect(server.calls.at(-1)).toBe('close stream-1');
  });

  it('parses only well formed worker reports', () => {
    expect(
      parseStudioStreamReport('{"type":"frame","seekGeneration":1,"revision":3,"pts":"1","timebase":"1/90000"}'),
    ).toEqual({ type: 'frame', seekGeneration: 1, revision: 3, pts: '1', timebase: '1/90000' });
    expect(
      parseStudioStreamReport('{"type":"frame","seekGeneration":1,"revision":3,"pts":1.5,"timebase":"1/90000"}'),
    ).toBeNull();
    expect(parseStudioStreamReport('{"type":"frame","seekGeneration":-1,"revision":3}')).toBeNull();
    expect(parseStudioStreamReport('not json')).toBeNull();
    expect(parseStudioStreamReport({})).toBeNull();
  });
});
