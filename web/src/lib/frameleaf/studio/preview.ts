/**
 * The Studio preview client (FL-96, `STU-402`).
 *
 * The React engine cannot ask the server for a frame. It has no token, no API base URL and no
 * SDK (FL-88's boundary), so a preview leaves the engine the same way every other change does:
 * as a `preview.request` command envelope on the bridge. This module is what the Svelte host
 * runs when that envelope arrives, and the frame comes back to the engine as *data* on the next
 * `StudioHostContext` update — `preview-ready` is a context change, not a callback into React.
 *
 * What it guarantees:
 *
 * - **Every frame is bound to a revision.** The cache is keyed by revision digest first. When
 *   the revision advances the whole bucket is dropped in one step, so there is no path by which
 *   a frame rendered for the previous graph is painted for the current one.
 * - **Stale answers are discarded, not painted.** Each request carries a monotonic seek
 *   generation. A response whose generation is behind the newest one, or whose revision is no
 *   longer current, is dropped — including one that is already in flight when the person scrubs
 *   again.
 * - **Backpressure.** One request is in flight at a time. A seek while one is running replaces
 *   the pending intent rather than queueing, so a drag across the timeline produces the frames
 *   the person stopped on, not one request per pixel.
 * - **Honest states.** `rendering`, `stale` and `unavailable` are reported as themselves. There
 *   is no state that shows an old frame while implying it is current: when the client knows the
 *   picture is out of date it says `stale` and keeps the old frame only as an explicitly
 *   labelled `staleFrame`.
 *
 * Transport-agnostic on purpose. This story implements the authenticated exact-frame path,
 * which is the one every browser has; a streamed playback transport plugs in behind the same
 * {@link StudioPreviewTransport} without the engine or this cache changing.
 */

import { formatRational, frameStartTime, tryParseRational } from './rational-time';
import type { StudioTime } from './commands';

/* ------------------------------------------------------------------ */
/* Time                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Exact time on the sequence timeline, in seconds (FL-93's `StudioTime`).
 *
 * Rational, never float seconds: a preview at 1001/30000 must address the same frame the
 * export does, and `1/30000` is already wrong in the 17th digit as a double. All the
 * arithmetic below is FL-93's, so the host, the engine and the transcode services agree on
 * what "this frame" means rather than each rounding their own way.
 */
export type StudioPreviewTime = StudioTime;

/**
 * Canonical text form, e.g. `1001/30000`.
 *
 * `rational()` already reduces and puts the sign on the numerator, so two spellings of the
 * same instant — `2002/60000` and `1001/30000` — produce the same key rather than each
 * triggering a render.
 */
export const studioPreviewTimeKey = (time: StudioPreviewTime): string => formatRational(time);

/** Parse the stored `num/den` spelling. Returns null rather than guessing. */
export const parseStudioPreviewTime = (value: string): StudioPreviewTime | null => tryParseRational(value);

/** The exact start time of a frame at a rational cadence. No float seconds anywhere. */
export const studioPreviewTimeAtFrame = (index: number, frameRate: StudioTime): StudioPreviewTime =>
  frameStartTime(index, frameRate);

/** The wire form: FL-93's rationals travel as `{ numerator, denominator }` decimal strings. */
export const toPreviewTimeWire = (time: StudioPreviewTime) => ({
  numerator: String(time.num),
  denominator: String(time.den),
});

/* ------------------------------------------------------------------ */
/* Identity                                                             */
/* ------------------------------------------------------------------ */

export type StudioPreviewQuality = 'draft' | 'standard' | 'full';

/** Everything that identifies one frame. The viewport is identity, not a rendering hint. */
export interface StudioPreviewIntent {
  projectId: string;
  revisionDigest: string;
  time: StudioPreviewTime;
  quality: StudioPreviewQuality;
  viewportWidth: number;
  viewportHeight: number;
}

/**
 * The client-side cache key.
 *
 * A plain join rather than a digest: this key never leaves the browser and never becomes a
 * database column, and the `\u0000` separator cannot appear in a revision digest or a quality
 * tier. The server computes its own key from the same components.
 */
export const studioPreviewKey = (intent: StudioPreviewIntent): string =>
  [
    intent.projectId,
    intent.revisionDigest,
    studioPreviewTimeKey(intent.time),
    intent.quality,
    String(intent.viewportWidth),
    String(intent.viewportHeight),
  ].join('\u0000');

export const sameStudioPreviewIntent = (a: StudioPreviewIntent, b: StudioPreviewIntent): boolean =>
  studioPreviewKey(a) === studioPreviewKey(b);

/* ------------------------------------------------------------------ */
/* Transport                                                            */
/* ------------------------------------------------------------------ */

export type StudioPreviewStatus = 'pending' | 'rendering' | 'ready' | 'superseded' | 'failed' | 'evicted';

/** What the server says about a requested frame. The shape the SDK call is mapped into. */
export interface StudioPreviewRecord {
  id: string;
  revisionDigest: string;
  status: StudioPreviewStatus;
  etag: string;
  /** Frame identity: the delivered picture's own PTS in its timebase. */
  framePts: string | null;
  framePtsTimebase: string | null;
  /** The frame is an explicitly tone-mapped SDR rendering; never the colour authority. */
  toneMapped: boolean;
  errorCode: string | null;
}

export interface StudioPreviewRequestResult {
  preview: StudioPreviewRecord;
  currentRevisionDigest: string;
  supersededPreviewIds: string[];
}

export type StudioPreviewTransportFailure =
  | { kind: 'stale-revision'; currentRevisionDigest: string | null }
  | { kind: 'gone' }
  | { kind: 'not-ready' }
  | { kind: 'forbidden' }
  | { kind: 'offline' }
  | { kind: 'failed' };

/**
 * The authorized calls, supplied by the Svelte host.
 *
 * This interface is the whole reason the engine has no client API dependency: the only thing
 * that knows how to reach the server is the host object passed in here, and it is never handed
 * to the engine.
 */
export interface StudioPreviewTransport {
  request(intent: StudioPreviewIntent, seekGeneration: number): Promise<StudioPreviewRequestResult>;
  /** Fetch the bytes. Returns an object URL the caller owns and must revoke. */
  fetchFrame(previewId: string, etag: string): Promise<{ objectUrl: string; etag: string }>;
  /** Poll one preview's state while it renders. */
  poll(previewId: string): Promise<StudioPreviewRecord>;
  /** Release a preview the client no longer wants, so the worker stops. */
  cancel(previewId: string): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* The view the host renders and the engine receives                    */
/* ------------------------------------------------------------------ */

/**
 * The honest state set.
 *
 * `stale` is deliberately distinct from `rendering`: they look the same to an impatient person
 * but mean opposite things. `rendering` says the picture on screen is being produced; `stale`
 * says the picture on screen belongs to a graph that no longer exists and a new one has to be
 * asked for. Conflating them is how an editor ends up grading against the wrong frame.
 */
export type StudioPreviewPhase = 'idle' | 'rendering' | 'ready' | 'stale' | 'unavailable';

export interface StudioPreviewFrameView {
  previewId: string;
  revisionDigest: string;
  time: StudioPreviewTime;
  quality: StudioPreviewQuality;
  objectUrl: string;
  framePts: string | null;
  framePtsTimebase: string | null;
  toneMapped: boolean;
}

export interface StudioPreviewView {
  phase: StudioPreviewPhase;
  /** The frame to paint. Null unless `phase` is `ready`. */
  frame: StudioPreviewFrameView | null;
  /**
   * The last frame from a revision that has been superseded. Present only while `phase` is
   * `stale`, and the host must label it as out of date rather than pass it off as current.
   */
  staleFrame: StudioPreviewFrameView | null;
  /** i18n key for the current non-ready state. */
  messageKey: string | null;
  /** Stable code behind `unavailable`, for diagnostics. Never the primary message. */
  errorCode: string | null;
  /** The revision the server last reported, so the host can reconcile the project. */
  currentRevisionDigest: string | null;
  /** Monotonic; the newest seek the client has issued. */
  seekGeneration: number;
}

export const idleStudioPreviewView = (): StudioPreviewView => ({
  phase: 'idle',
  frame: null,
  staleFrame: null,
  messageKey: null,
  errorCode: null,
  currentRevisionDigest: null,
  seekGeneration: 0,
});

const messageKeys: Record<Exclude<StudioPreviewPhase, 'idle' | 'ready'>, string> = {
  rendering: 'frameleaf_studio_preview_rendering',
  stale: 'frameleaf_studio_preview_stale',
  unavailable: 'frameleaf_studio_preview_unavailable',
};

export const studioPreviewMessageKey = (phase: StudioPreviewPhase): string | null =>
  phase === 'idle' || phase === 'ready' ? null : messageKeys[phase];

/**
 * Whether an answer that has just arrived is still worth painting.
 *
 * Both conditions matter and neither implies the other: a response can carry the current
 * generation while its revision has been superseded (the person edited without seeking), and it
 * can carry the current revision while its generation is behind (the person scrubbed on).
 */
export const isStudioPreviewAnswerCurrent = (
  answer: { revisionDigest: string; seekGeneration: number },
  now: { revisionDigest: string; seekGeneration: number },
): boolean => answer.revisionDigest === now.revisionDigest && answer.seekGeneration >= now.seekGeneration;

/* ------------------------------------------------------------------ */
/* The revision-keyed frame cache                                       */
/* ------------------------------------------------------------------ */

export interface StudioPreviewCacheOptions {
  /** Frames kept per revision before the least recently used are released. */
  maxFramesPerRevision?: number;
  /** Called for every object URL the cache lets go of. */
  release?: (objectUrl: string) => void;
}

/**
 * Frames the host holds, bucketed by revision.
 *
 * Bucketing is what makes revision binding cheap and total: dropping a revision releases every
 * frame belonging to it in one call, with no chance of one surviving because a key collided.
 * Within a bucket, eviction is least-recently-used, because scrubbing back and forth over one
 * second should keep those frames and lose the ones passed through once.
 */
export class StudioPreviewCache {
  private readonly buckets = new Map<string, Map<string, StudioPreviewFrameView>>();
  private readonly maxFramesPerRevision: number;
  private readonly release: (objectUrl: string) => void;

  constructor(options: StudioPreviewCacheOptions = {}) {
    this.maxFramesPerRevision = options.maxFramesPerRevision ?? 60;
    this.release =
      options.release ?? ((objectUrl: string) => globalThis.URL?.revokeObjectURL?.(objectUrl));
  }

  get size(): number {
    let total = 0;
    for (const bucket of this.buckets.values()) {
      total += bucket.size;
    }
    return total;
  }

  revisions(): string[] {
    return [...this.buckets.keys()];
  }

  /** Reading a frame also marks it most recently used, which is why it re-inserts. */
  get(intent: StudioPreviewIntent): StudioPreviewFrameView | undefined {
    const bucket = this.buckets.get(intent.revisionDigest);
    if (!bucket) {
      return undefined;
    }

    const key = studioPreviewKey(intent);
    const frame = bucket.get(key);
    if (frame) {
      bucket.delete(key);
      bucket.set(key, frame);
    }
    return frame;
  }

  set(intent: StudioPreviewIntent, frame: StudioPreviewFrameView): void {
    let bucket = this.buckets.get(intent.revisionDigest);
    if (!bucket) {
      bucket = new Map();
      this.buckets.set(intent.revisionDigest, bucket);
    }

    const key = studioPreviewKey(intent);
    const previous = bucket.get(key);
    if (previous && previous.objectUrl !== frame.objectUrl) {
      this.release(previous.objectUrl);
    }

    bucket.delete(key);
    bucket.set(key, frame);

    // Map iteration order is insertion order, so the first key is the least recently used.
    while (bucket.size > this.maxFramesPerRevision) {
      const oldest = bucket.keys().next();
      if (oldest.done) {
        break;
      }
      const evicted = bucket.get(oldest.value);
      bucket.delete(oldest.value);
      if (evicted) {
        this.release(evicted.objectUrl);
      }
    }
  }

  /**
   * Release one revision's frames. Called the moment the revision is superseded.
   *
   * `protectedUrls` is not an optimisation. The frame the host is painting right now belongs to
   * the revision being dropped, and revoking its object URL would blank the workspace mid-edit.
   * Its entry leaves the cache with everything else; the caller becomes responsible for
   * revoking that one URL when it stops showing it.
   */
  dropRevision(revisionDigest: string, protectedUrls: ReadonlySet<string> = new Set()): void {
    const bucket = this.buckets.get(revisionDigest);
    if (!bucket) {
      return;
    }
    for (const frame of bucket.values()) {
      if (!protectedUrls.has(frame.objectUrl)) {
        this.release(frame.objectUrl);
      }
    }
    this.buckets.delete(revisionDigest);
  }

  /** Keep only the given revision. Everything else goes, including a stray future one. */
  keepOnly(revisionDigest: string, protectedUrls: ReadonlySet<string> = new Set()): void {
    for (const digest of [...this.buckets.keys()]) {
      if (digest !== revisionDigest) {
        this.dropRevision(digest, protectedUrls);
      }
    }
  }

  clear(): void {
    for (const digest of [...this.buckets.keys()]) {
      this.dropRevision(digest);
    }
  }
}

/* ------------------------------------------------------------------ */
/* The client                                                           */
/* ------------------------------------------------------------------ */

export interface StudioPreviewClientOptions {
  transport: StudioPreviewTransport;
  /** Notified on every view change. The host turns this into the context the engine receives. */
  onChange?: (view: StudioPreviewView) => void;
  maxFramesPerRevision?: number;
  /** Attempts to poll a rendering preview before giving up. */
  maxPolls?: number;
  /** Injected in tests. */
  wait?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  release?: (objectUrl: string) => void;
}

export interface StudioPreviewClient {
  /** Ask for a frame. Returns the seek generation the request was issued under. */
  request(intent: StudioPreviewIntent): number;
  /** The current view. Safe to read at any time. */
  view(): StudioPreviewView;
  /** Tell the client the project moved to a new revision, outside of a preview request. */
  revisionAdvanced(revisionDigest: string): void;
  /** Release everything: cached object URLs, the pending intent and any in-flight request. */
  dispose(): Promise<void>;
  /** Settles once no request is in flight. Test affordance; the host never needs it. */
  idle(): Promise<void>;
}

const defaultWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export const createStudioPreviewClient = (options: StudioPreviewClientOptions): StudioPreviewClient => {
  const release = options.release ?? ((objectUrl: string) => globalThis.URL?.revokeObjectURL?.(objectUrl));
  const cache = new StudioPreviewCache({ maxFramesPerRevision: options.maxFramesPerRevision, release });
  const wait = options.wait ?? defaultWait;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const maxPolls = options.maxPolls ?? 40;

  let view = idleStudioPreviewView();
  let seekGeneration = 0;
  /** The intent the person is currently looking at; what "current" means for a late answer. */
  let currentIntent: StudioPreviewIntent | null = null;
  /** The intent to run next. Replaced, never queued: that is the backpressure. */
  let pending: StudioPreviewIntent | null = null;
  let running: Promise<void> | null = null;
  let disposed = false;
  /**
   * The one object URL that outlives its cache bucket: the frame still on screen when its
   * revision was superseded. The cache no longer owns it, so this is what makes it revocable.
   */
  let retainedStaleUrl: string | null = null;
  /** Previews this client started and has not released, so `dispose` can stop the workers. */
  const openPreviewIds = new Set<string>();

  const publish = (next: Partial<StudioPreviewView>) => {
    view = { ...view, ...next, seekGeneration };
    options.onChange?.(view);
  };

  const setPhase = (phase: StudioPreviewPhase, extra: Partial<StudioPreviewView> = {}) => {
    publish({ phase, messageKey: studioPreviewMessageKey(phase), ...extra });
  };

  const releaseRetained = () => {
    if (retainedStaleUrl) {
      release(retainedStaleUrl);
      retainedStaleUrl = null;
    }
  };

  /**
   * Drop every cached revision that is not the given one, keeping the frame on screen alive.
   *
   * Returns the frame that was being shown, now detached from the cache, so the caller can hand
   * it back as an explicitly labelled `staleFrame`. Exactly one such frame is retained at a
   * time: a second supersession releases the first, so scrubbing through several edits does not
   * accumulate object URLs.
   */
  const pruneTo = (currentRevisionDigest: string): StudioPreviewFrameView | null => {
    const outgoing = view.frame ?? view.staleFrame;
    const keep = outgoing && outgoing.revisionDigest !== currentRevisionDigest ? outgoing : null;

    const previouslyRetained = retainedStaleUrl;
    cache.keepOnly(currentRevisionDigest, new Set(keep ? [keep.objectUrl] : []));

    retainedStaleUrl = keep?.objectUrl ?? null;
    if (previouslyRetained && previouslyRetained !== retainedStaleUrl) {
      release(previouslyRetained);
    }

    return keep;
  };

  /**
   * The revision moved on.
   *
   * Everything for the old revision is released at once. The frame that was on screen is
   * demoted to `staleFrame`: the host may keep showing it so the workspace does not flash, but
   * the phase says `stale`, so it is presented as out of date rather than as the current
   * picture. `frame` is null, because nothing current exists to paint.
   */
  const supersede = (currentRevisionDigest: string) => {
    const staleFrame = pruneTo(currentRevisionDigest);
    setPhase('stale', { frame: null, staleFrame, currentRevisionDigest, errorCode: null });
  };

  const failure = (code: string) => {
    setPhase('unavailable', { frame: null, errorCode: code });
  };

  const failureOf = (error: unknown): StudioPreviewTransportFailure['kind'] =>
    (error as { failure?: StudioPreviewTransportFailure })?.failure?.kind ?? 'failed';

  const staleDigestOf = (error: unknown, fallback: string): string => {
    const reason = (error as { failure?: StudioPreviewTransportFailure })?.failure;
    return reason?.kind === 'stale-revision' ? (reason.currentRevisionDigest ?? fallback) : fallback;
  };

  const run = async (intent: StudioPreviewIntent, generation: number): Promise<void> => {
    let result: StudioPreviewRequestResult;
    try {
      result = await options.transport.request(intent, generation);
    } catch (error) {
      if (failureOf(error) === 'stale-revision') {
        supersede(staleDigestOf(error, intent.revisionDigest));
      } else {
        failure(failureOf(error));
      }
      return;
    }

    if (disposed) {
      return;
    }

    // The server is the authority on which revision is current. If it disagrees with the one
    // we asked about, nothing rendered for ours can be painted.
    if (result.currentRevisionDigest !== intent.revisionDigest) {
      supersede(result.currentRevisionDigest);
      return;
    }

    // Frames the request superseded are unreachable now; release them before anything else so a
    // later paint cannot find one.
    pruneTo(result.currentRevisionDigest);

    let record = result.preview;
    openPreviewIds.add(record.id);

    for (let attempt = 0; record.status !== 'ready' && attempt < maxPolls; attempt++) {
      if (record.status === 'superseded') {
        supersede(result.currentRevisionDigest);
        return;
      }
      if (record.status === 'failed' || record.status === 'evicted') {
        failure(record.errorCode ?? record.status);
        return;
      }

      // A newer seek arrived while this one was rendering: stop paying for a frame nobody will
      // look at rather than finishing it first.
      if (generation < seekGeneration) {
        void options.transport.cancel(record.id).catch(() => {});
        openPreviewIds.delete(record.id);
        return;
      }

      await wait(pollIntervalMs);
      if (disposed) {
        return;
      }

      try {
        record = await options.transport.poll(record.id);
      } catch (error) {
        if (failureOf(error) === 'stale-revision') {
          supersede(staleDigestOf(error, result.currentRevisionDigest));
        } else {
          failure(failureOf(error));
        }
        return;
      }
    }

    if (record.status !== 'ready') {
      // Never a blank "ready" with no picture: an exhausted poll budget is `unavailable`.
      failure(record.errorCode ?? 'timeout');
      return;
    }

    let frameBytes: { objectUrl: string; etag: string };
    try {
      frameBytes = await options.transport.fetchFrame(record.id, record.etag);
    } catch (error) {
      if (failureOf(error) === 'stale-revision') {
        supersede(staleDigestOf(error, result.currentRevisionDigest));
      } else {
        failure(failureOf(error));
      }
      return;
    }

    const frame: StudioPreviewFrameView = {
      previewId: record.id,
      revisionDigest: record.revisionDigest,
      time: intent.time,
      quality: intent.quality,
      objectUrl: frameBytes.objectUrl,
      framePts: record.framePts,
      framePtsTimebase: record.framePtsTimebase,
      toneMapped: record.toneMapped,
    };

    if (disposed) {
      release(frame.objectUrl);
      return;
    }

    // Cached even when it is no longer the frame being shown: scrubbing back to it must not
    // cost another render.
    cache.set(intent, frame);

    const now = {
      revisionDigest: currentIntent?.revisionDigest ?? intent.revisionDigest,
      seekGeneration,
    };
    if (!isStudioPreviewAnswerCurrent({ revisionDigest: record.revisionDigest, seekGeneration: generation }, now)) {
      // Arrived too late to paint. It is in the cache, so scrubbing back to it is free.
      return;
    }

    releaseRetained();
    setPhase('ready', {
      frame,
      staleFrame: null,
      errorCode: null,
      currentRevisionDigest: result.currentRevisionDigest,
    });
  };

  const pump = () => {
    if (running || !pending || disposed) {
      return;
    }

    const intent = pending;
    const generation = seekGeneration;
    pending = null;

    running = run(intent, generation)
      .catch(() => failure('failed'))
      .finally(() => {
        running = null;
        pump();
      });
  };

  return {
    request(intent) {
      if (disposed) {
        return seekGeneration;
      }

      seekGeneration += 1;
      currentIntent = intent;

      if (view.currentRevisionDigest && view.currentRevisionDigest !== intent.revisionDigest) {
        // The host advanced the project between seeks; the old bucket goes before a new frame
        // arrives, so nothing from the previous graph can be painted for this one.
        pruneTo(intent.revisionDigest);
      }

      const cached = cache.get(intent);
      if (cached) {
        releaseRetained();
        setPhase('ready', {
          frame: cached,
          staleFrame: null,
          errorCode: null,
          currentRevisionDigest: intent.revisionDigest,
        });
        return seekGeneration;
      }

      setPhase('rendering', { frame: null, errorCode: null, currentRevisionDigest: intent.revisionDigest });
      pending = intent;
      pump();
      return seekGeneration;
    },

    view: () => view,

    revisionAdvanced(revisionDigest) {
      if (revisionDigest === view.currentRevisionDigest) {
        return;
      }
      supersede(revisionDigest);
    },

    async dispose() {
      disposed = true;
      pending = null;
      try {
        await running;
      } catch {
        // A failure during teardown must not keep the route from leaving.
      }
      for (const id of openPreviewIds) {
        void options.transport.cancel(id).catch(() => {});
      }
      openPreviewIds.clear();
      releaseRetained();
      cache.clear();
      view = idleStudioPreviewView();
    },

    async idle() {
      while (running || pending) {
        await running;
        pump();
      }
    },
  };
};
