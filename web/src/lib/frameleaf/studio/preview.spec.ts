import { describe, expect, it, vi } from 'vitest';
import {
  StudioPreviewCache,
  createStudioPreviewClient,
  isStudioPreviewAnswerCurrent,
  parseStudioPreviewTime,
  sameStudioPreviewIntent,
  studioPreviewKey,
  studioPreviewMessageKey,
  studioPreviewTimeAtFrame,
  studioPreviewTimeKey,
  toPreviewTimeWire,
  unsavedStudioPreviewView,
  type StudioPreviewFrameView,
  type StudioPreviewIntent,
  type StudioPreviewRecord,
  type StudioPreviewTransport,
  type StudioPreviewTransportFailure,
} from './preview';
import { rational, FRAME_RATE_NTSC_30 } from './rational-time';

const intent = (overrides: Partial<StudioPreviewIntent> = {}): StudioPreviewIntent => ({
  projectId: 'project-1',
  revision: 1,
  time: rational(1001, 30_000),
  quality: 'standard',
  viewportWidth: 1920,
  viewportHeight: 1080,
  ...overrides,
});

const record = (overrides: Partial<StudioPreviewRecord> = {}): StudioPreviewRecord => ({
  id: 'preview-1',
  revision: 1,
  status: 'ready',
  etag: '"rev-rev-a-abc"',
  framePts: '3003',
  framePtsTimebase: '1/90000',
  toneMapped: false,
  errorCode: null,
  ...overrides,
});

const transportError = (failure: StudioPreviewTransportFailure) => Object.assign(new Error(failure.kind), { failure });

const frameView = (overrides: Partial<StudioPreviewFrameView> = {}): StudioPreviewFrameView => ({
  previewId: 'preview-1',
  revision: 1,
  time: rational(1001, 30_000),
  quality: 'standard',
  objectUrl: 'blob:a',
  framePts: null,
  framePtsTimebase: null,
  toneMapped: false,
  ...overrides,
});

/** A transport that answers immediately, so no timer is involved in the ordinary path. */
const stubTransport = (overrides: Partial<StudioPreviewTransport> = {}): StudioPreviewTransport => {
  let counter = 0;
  return {
    request: vi.fn(async (asked: StudioPreviewIntent) => ({
      preview: record({ id: `preview-${++counter}`, revision: asked.revision }),
      currentRevision: asked.revision,
      supersededPreviewIds: [],
    })),
    poll: vi.fn(async () => record()),
    fetchFrame: vi.fn(async (previewId: string, etag: string) => ({ objectUrl: `blob:${previewId}`, etag })),
    cancel: vi.fn(async () => {}),
    ...overrides,
  };
};

describe('rational preview time', () => {
  it('gives the same key to the same instant written differently', () => {
    // FL-93's `rational` reduces, so 2002/60000 and 1001/30000 are one cache entry, not two.
    expect(studioPreviewTimeKey(rational(2002, 60_000))).toBe(studioPreviewTimeKey(rational(1001, 30_000)));
  });

  it('round-trips through the stored spelling', () => {
    expect(parseStudioPreviewTime('1001/30000')).toEqual(rational(1001, 30_000));
    expect(parseStudioPreviewTime('0.5')).toBeNull();
  });

  it('builds an exact time from a frame at an NTSC cadence', () => {
    // Frame 30 at 30000/1001 is exactly 1001/1000 seconds; no float expresses that.
    expect(studioPreviewTimeAtFrame(30, FRAME_RATE_NTSC_30)).toEqual(rational(1001, 1000));
  });

  it('puts the rational on the wire as decimal strings, not as a float', () => {
    expect(toPreviewTimeWire(rational(1001, 30_000))).toEqual({ numerator: '1001', denominator: '30000' });
  });
});

describe('preview identity', () => {
  it('treats the same instant written differently as one frame', () => {
    expect(sameStudioPreviewIntent(intent(), intent({ time: rational(2002, 60_000) }))).toBe(true);
  });

  it.each([
    ['project', intent({ projectId: 'project-2' })],
    ['revision', intent({ revision: 2 })],
    ['time', intent({ time: rational(1002, 30_000) })],
    ['quality', intent({ quality: 'full' as const })],
    ['viewport', intent({ viewportWidth: 1280 })],
  ])('treats a different %s as a different frame', (_name, other) => {
    expect(studioPreviewKey(other)).not.toBe(studioPreviewKey(intent()));
  });
});

describe('studioPreviewMessageKey', () => {
  it('has no message for a working preview', () => {
    expect(studioPreviewMessageKey('ready')).toBeNull();
    expect(studioPreviewMessageKey('idle')).toBeNull();
  });

  it('names each honest state separately', () => {
    // `stale` and `rendering` must never collapse into one message: they mean opposite things.
    expect(studioPreviewMessageKey('rendering')).toBe('frameleaf_studio_preview_rendering');
    expect(studioPreviewMessageKey('stale')).toBe('frameleaf_studio_preview_stale');
    expect(studioPreviewMessageKey('unavailable')).toBe('frameleaf_studio_preview_unavailable');
  });

  it('says an unsaved draft has nothing to preview rather than that a render failed', () => {
    const view = unsavedStudioPreviewView();

    expect(view.phase).toBe('unavailable');
    expect(view.messageKey).toBe('frameleaf_studio_preview_unsaved');
    expect(view.frame).toBeNull();
    expect(view.currentRevision).toBeNull();
  });
});

describe('isStudioPreviewAnswerCurrent', () => {
  it('accepts an answer for the current revision and seek', () => {
    expect(isStudioPreviewAnswerCurrent({ revision: 1, seekGeneration: 3 }, { revision: 1, seekGeneration: 3 })).toBe(
      true,
    );
  });

  it('discards an answer from an older seek', () => {
    expect(isStudioPreviewAnswerCurrent({ revision: 1, seekGeneration: 2 }, { revision: 1, seekGeneration: 3 })).toBe(
      false,
    );
  });

  it('discards an answer from a superseded revision even at the current seek', () => {
    expect(isStudioPreviewAnswerCurrent({ revision: 1, seekGeneration: 3 }, { revision: 2, seekGeneration: 3 })).toBe(
      false,
    );
  });
});

describe('StudioPreviewCache', () => {
  it('returns a frame for the same instant written differently', () => {
    const cache = new StudioPreviewCache({ release: vi.fn() });
    cache.set(intent(), frameView());

    expect(cache.get(intent({ time: rational(2002, 60_000) }))).toBeDefined();
  });

  it('never returns a frame across revisions', () => {
    const cache = new StudioPreviewCache({ release: vi.fn() });
    cache.set(intent(), frameView());

    expect(cache.get(intent({ revision: 2 }))).toBeUndefined();
  });

  it('releases a whole revision in one step', () => {
    const release = vi.fn();
    const cache = new StudioPreviewCache({ release });
    cache.set(intent(), frameView({ objectUrl: 'blob:a' }));
    cache.set(intent({ time: rational(2) }), frameView({ objectUrl: 'blob:b' }));

    cache.dropRevision(1);

    expect(release.mock.calls.map(([url]) => url).sort((a, b) => a.localeCompare(b))).toEqual(['blob:a', 'blob:b']);
    expect(cache.size).toBe(0);
  });

  it('keeps a protected object URL alive when its bucket goes', () => {
    // The frame still being painted must survive its own revision being dropped.
    const release = vi.fn();
    const cache = new StudioPreviewCache({ release });
    cache.set(intent(), frameView({ objectUrl: 'blob:onscreen' }));

    cache.dropRevision(1, new Set(['blob:onscreen']));

    expect(release).not.toHaveBeenCalled();
  });

  it('evicts the least recently used frame past the cap', () => {
    const release = vi.fn();
    const cache = new StudioPreviewCache({ maxFramesPerRevision: 2, release });
    const first = intent({ time: rational(1) });
    const second = intent({ time: rational(2) });
    const third = intent({ time: rational(3) });

    cache.set(first, frameView({ objectUrl: 'blob:1' }));
    cache.set(second, frameView({ objectUrl: 'blob:2' }));
    // Reading the first makes it the most recent, so the second is the one given up.
    cache.get(first);
    cache.set(third, frameView({ objectUrl: 'blob:3' }));

    expect(release).toHaveBeenCalledWith('blob:2');
    expect(cache.get(first)).toBeDefined();
    expect(cache.get(third)).toBeDefined();
  });

  it('keeps only the revision it is told to', () => {
    const release = vi.fn();
    const cache = new StudioPreviewCache({ release });
    cache.set(intent(), frameView({ objectUrl: 'blob:a' }));
    cache.set(intent({ revision: 2 }), frameView({ revision: 2, objectUrl: 'blob:b' }));

    cache.keepOnly(2);

    expect(cache.revisions()).toEqual([2]);
    expect(release).toHaveBeenCalledWith('blob:a');
  });
});

describe('createStudioPreviewClient', () => {
  const clientOptions = (transport: StudioPreviewTransport, release = vi.fn()) => ({
    transport,
    release,
    wait: () => Promise.resolve(),
    pollIntervalMs: 0,
  });

  it('reports rendering, then the frame', async () => {
    const transport = stubTransport();
    const phases: string[] = [];
    const client = createStudioPreviewClient({
      ...clientOptions(transport),
      onChange: (view) => void phases.push(view.phase),
    });

    client.request(intent());
    await client.idle();

    expect(phases).toEqual(['rendering', 'ready']);
    expect(client.view().frame?.objectUrl).toBe('blob:preview-1');
  });

  it('serves a repeated seek from the cache without asking again', async () => {
    const transport = stubTransport();
    const client = createStudioPreviewClient(clientOptions(transport));

    client.request(intent());
    await client.idle();
    client.request(intent({ time: rational(2002, 60_000) }));
    await client.idle();

    expect(transport.request).toHaveBeenCalledTimes(1);
    expect(client.view().phase).toBe('ready');
  });

  it('runs one request at a time and keeps only the newest seek', async () => {
    let resolveFirst: (() => void) | undefined;
    const transport = stubTransport({
      request: vi.fn(async (asked: StudioPreviewIntent) => {
        if (!resolveFirst) {
          await new Promise<void>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return {
          preview: record({ id: `preview-${asked.time.num}`, revision: asked.revision }),
          currentRevision: asked.revision,
          supersededPreviewIds: [],
        };
      }),
    });
    const client = createStudioPreviewClient(clientOptions(transport));

    client.request(intent({ time: rational(1) }));
    // Three more seeks while the first is still running: only the last survives.
    client.request(intent({ time: rational(2) }));
    client.request(intent({ time: rational(3) }));
    client.request(intent({ time: rational(4) }));
    resolveFirst?.();
    await client.idle();

    expect(transport.request).toHaveBeenCalledTimes(2);
    expect(client.view().frame?.previewId).toBe('preview-4');
  });

  it('does not paint an answer whose revision the server says is superseded', async () => {
    const transport = stubTransport({
      request: vi.fn(async () => ({
        preview: record(),
        currentRevision: 2,
        supersededPreviewIds: [],
      })),
    });
    const client = createStudioPreviewClient(clientOptions(transport));

    client.request(intent());
    await client.idle();

    expect(client.view().phase).toBe('stale');
    expect(client.view().frame).toBeNull();
    expect(client.view().currentRevision).toBe(2);
    expect(transport.fetchFrame).not.toHaveBeenCalled();
  });

  it('turns a stale-revision refusal into the stale state with the current revision', async () => {
    const transport = stubTransport({
      request: vi.fn(async () => {
        throw transportError({ kind: 'stale-revision', currentRevision: 2 });
      }),
    });
    const client = createStudioPreviewClient(clientOptions(transport));

    client.request(intent());
    await client.idle();

    expect(client.view().phase).toBe('stale');
    expect(client.view().currentRevision).toBe(2);
  });

  it('demotes the frame on screen to a labelled stale frame rather than dropping it silently', async () => {
    const transport = stubTransport();
    const client = createStudioPreviewClient(clientOptions(transport));

    client.request(intent());
    await client.idle();
    client.revisionAdvanced(2);

    const view = client.view();
    expect(view.phase).toBe('stale');
    expect(view.frame).toBeNull();
    expect(view.staleFrame?.objectUrl).toBe('blob:preview-1');
  });

  it('keeps the stale frame usable and releases it once a current frame arrives', async () => {
    const release = vi.fn();
    const transport = stubTransport();
    const client = createStudioPreviewClient(clientOptions(transport, release));

    client.request(intent());
    await client.idle();
    client.revisionAdvanced(2);

    // Still alive while it is the thing on screen.
    expect(release).not.toHaveBeenCalledWith('blob:preview-1');

    client.request(intent({ revision: 2 }));
    await client.idle();

    expect(client.view().phase).toBe('ready');
    expect(client.view().staleFrame).toBeNull();
    expect(release).toHaveBeenCalledWith('blob:preview-1');
  });

  it('does not announce a stale picture when the revision advances before anything was shown', async () => {
    const transport = stubTransport();
    const client = createStudioPreviewClient(clientOptions(transport));

    client.revisionAdvanced(3);

    expect(client.view().phase).toBe('idle');
    expect(client.view().messageKey).toBeNull();
    expect(client.view().currentRevision).toBe(3);
  });

  it('neither paints nor caches a frame that finishes after the stored revision advanced', async () => {
    const release = vi.fn();
    let finishRequest: (() => void) | undefined;
    const transport = stubTransport({
      request: vi.fn(async (asked: StudioPreviewIntent) => {
        await new Promise<void>((resolve) => {
          finishRequest = resolve;
        });
        return {
          preview: record({ id: 'preview-late', revision: asked.revision, status: 'pending' }),
          currentRevision: asked.revision,
          supersededPreviewIds: [],
        };
      }),
    });
    const client = createStudioPreviewClient(clientOptions(transport, release));

    client.request(intent({ revision: 1 }));
    // Autosave stored revision 2 while revision 1's frame was still being asked for.
    client.revisionAdvanced(2);
    finishRequest?.();
    await client.idle();

    expect(client.view().phase).toBe('stale');
    expect(client.view().frame).toBeNull();
    expect(transport.fetchFrame).not.toHaveBeenCalled();
    // The server-side render is released rather than left running for a graph nobody sees.
    expect(transport.cancel).toHaveBeenCalledWith('preview-late');
  });

  it('drops a seek still queued for the old revision when the revision advances', async () => {
    let finishFirst: (() => void) | undefined;
    const transport = stubTransport({
      request: vi.fn(async (asked: StudioPreviewIntent) => {
        if (!finishFirst) {
          await new Promise<void>((resolve) => {
            finishFirst = resolve;
          });
        }
        return {
          preview: record({ id: `preview-${asked.time.num}`, revision: asked.revision }),
          currentRevision: asked.revision,
          supersededPreviewIds: [],
        };
      }),
    });
    const client = createStudioPreviewClient(clientOptions(transport));

    client.request(intent({ time: rational(1) }));
    client.request(intent({ time: rational(2) }));
    client.revisionAdvanced(2);
    finishFirst?.();
    await client.idle();

    // Only the first, already in flight, reached the server; the queued seek was dropped.
    expect(transport.request).toHaveBeenCalledTimes(1);
  });

  it('drops every cached frame of a revision that is superseded', async () => {
    const transport = stubTransport();
    const client = createStudioPreviewClient(clientOptions(transport));

    client.request(intent());
    await client.idle();
    client.request(intent({ revision: 2 }));
    await client.idle();

    // Asking for the old frame again must render, not hit the cache.
    client.request(intent({ revision: 1 }));
    await client.idle();

    expect(transport.request).toHaveBeenCalledTimes(3);
  });

  it('polls a rendering preview and paints it when it is ready', async () => {
    let polls = 0;
    const transport = stubTransport({
      request: vi.fn(async () => ({
        preview: record({ status: 'pending' }),
        currentRevision: 1,
        supersededPreviewIds: [],
      })),
      poll: vi.fn(async () => {
        polls += 1;
        return record({ status: polls < 3 ? 'rendering' : 'ready' });
      }),
    });
    const client = createStudioPreviewClient(clientOptions(transport));

    client.request(intent());
    await client.idle();

    expect(polls).toBe(3);
    expect(client.view().phase).toBe('ready');
  });

  it('reports an exhausted poll budget as unavailable, never as a blank ready', async () => {
    const transport = stubTransport({
      request: vi.fn(async () => ({
        preview: record({ status: 'rendering' }),
        currentRevision: 1,
        supersededPreviewIds: [],
      })),
      poll: vi.fn(async () => record({ status: 'rendering' })),
    });
    const client = createStudioPreviewClient({ ...clientOptions(transport), maxPolls: 2 });

    client.request(intent());
    await client.idle();

    expect(client.view().phase).toBe('unavailable');
    expect(client.view().frame).toBeNull();
  });

  it('reports a failed render as unavailable and keeps its code for diagnostics', async () => {
    const transport = stubTransport({
      request: vi.fn(async () => ({
        preview: record({ status: 'failed', errorCode: 'worker_lost' }),
        currentRevision: 1,
        supersededPreviewIds: [],
      })),
    });
    const client = createStudioPreviewClient(clientOptions(transport));

    client.request(intent());
    await client.idle();

    expect(client.view().phase).toBe('unavailable');
    expect(client.view().errorCode).toBe('worker_lost');
  });

  it('drops every cached frame, of every revision, when access is revoked', async () => {
    const release = vi.fn();
    let revoked = false;
    const transport = stubTransport({
      fetchFrame: vi.fn(async (previewId: string, etag: string) => {
        if (revoked) {
          throw transportError({ kind: 'forbidden' });
        }
        return { objectUrl: `blob:${previewId}`, etag };
      }),
    });
    const client = createStudioPreviewClient(clientOptions(transport, release));

    client.request(intent());
    await client.idle();
    revoked = true;
    client.request(intent({ time: rational(2, 1) }));
    await client.idle();

    expect(client.view().phase).toBe('unavailable');
    expect(client.view().errorCode).toBe('forbidden');
    expect(client.view().frame).toBeNull();
    expect(client.view().staleFrame).toBeNull();
    expect(release).toHaveBeenCalledWith('blob:preview-1');

    // Nothing is served from the cache afterwards, not even the frame that was on screen.
    client.request(intent());
    await client.idle();
    expect(transport.request).toHaveBeenCalledTimes(3);
  });

  it('releases every frame and cancels open previews on dispose', async () => {
    const release = vi.fn();
    const transport = stubTransport();
    const client = createStudioPreviewClient(clientOptions(transport, release));

    client.request(intent());
    await client.idle();
    await client.dispose();

    expect(transport.cancel).toHaveBeenCalledWith('preview-1');
    expect(release).toHaveBeenCalledWith('blob:preview-1');
    expect(client.view().phase).toBe('idle');
  });

  it('stops requesting after dispose', async () => {
    const transport = stubTransport();
    const client = createStudioPreviewClient(clientOptions(transport));

    await client.dispose();
    client.request(intent());
    await client.idle();

    expect(transport.request).not.toHaveBeenCalled();
  });
});
