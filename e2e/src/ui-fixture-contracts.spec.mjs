import { runInNewContext } from 'node:vm';
import sharp from 'sharp';
import { expect, it, vi } from 'vitest';
import { isStudioFrameHello, STUDIO_FRAME_PROTOCOL_VERSION } from '../../web/src/lib/frameleaf/studio/frame-protocol';
import { generateTimelineData } from './ui/generators/timeline';
import { setupStudioStreamMocks } from './ui/mock-network/studio-stream-network';
import { setupTimelineMockApiRoutes, TimelineTestContext } from './ui/mock-network/timeline-network';

const routes = () => {
  const handlers = new Map();
  const context = {
    route: async (pattern, handler) => {
      handlers.set(pattern, handler);
    },
  };
  const serve = async (pattern, url, serviceWorker = true) => {
    const request = { url: () => url, serviceWorker: () => (serviceWorker ? {} : null) };
    const fulfill = vi.fn();
    const continued = vi.fn();
    await handlers.get(pattern)({ fulfill, continue: continued, request: () => request }, request);
    return { response: fulfill.mock.calls[0]?.[0], continued };
  };
  return { context, serve };
};

it('serves a manifest and editor hello compatible with the current Studio host', async () => {
  const { context, serve } = routes();
  await setupStudioStreamMocks(
    context,
    {},
    {
      revision: 3,
      webCodecs: true,
      webGpu: true,
      requests: [],
      sessions: [],
      refuseReconnect: null,
    },
  );
  const { response: manifest } = await serve(
    '**/studio-engine/manifest.json',
    'http://localhost/studio-engine/manifest.json',
  );
  expect(manifest.json.protocolVersion).toBe(STUDIO_FRAME_PROTOCOL_VERSION);
  const { response: editor } = await serve(
    '**/studio-engine/editor.html*',
    'http://localhost/studio-engine/editor.html',
  );
  const postMessage = vi.fn();
  runInNewContext(editor.body.match(/<script>([\s\S]*)<\/script>/)[1], {
    URLSearchParams,
    location: { search: '', origin: 'http://localhost' },
    window: {},
    addEventListener: () => {},
    parent: { postMessage },
  });
  const hello = postMessage.mock.calls[0][0];
  expect(isStudioFrameHello(hello)).toBe(true);
  expect(hello.protocolVersion).toBe(STUDIO_FRAME_PROTOCOL_VERSION);
  expect(hello.engineRevision).toBe(manifest.json.engineRevision);
});

it.each([
  ['thumbnail', 470, 235],
  ['preview', 1000, 500],
  ['fullsize', 4000, 2000],
])('serves %s with the fixture media dimensions', async (size, width, height) => {
  const { context, serve } = routes();
  const data = generateTimelineData({
    months: [{ year: 2025, month: 1, distribution: 'sparse', pattern: 'single-day' }],
  });
  const asset = [...data.buckets.values()].flat()[0];
  asset.id = '91617352-5b8c-4930-ae97-589421e83173';
  asset.ratio = 2;
  await setupTimelineMockApiRoutes(
    context,
    data,
    { albumAdditions: [], assetDeletions: [], assetArchivals: [], assetFavorites: [] },
    new TimelineTestContext(),
  );
  const pattern = '**/api/assets/*/thumbnail?size=*';
  const url = `http://localhost/api/assets/${asset.id}/thumbnail?size=${size}&c=zoom&edited=true&dynamicRange=auto`;
  const { response } = await serve(pattern, url);
  expect(response.status).toBe(200);
  expect(response.headers['content-type']).toBe('image/jpeg');
  expect(await sharp(response.body).metadata()).toMatchObject({ format: 'jpeg', width, height });
  const direct = await serve(pattern, url, false);
  expect(direct.continued).toHaveBeenCalledOnce();
  expect(direct.response).toBeUndefined();
  await expect(serve(pattern, url.replace(`size=${size}`, 'size=unsupported'))).rejects.toThrow(
    'Invalid URL for thumbnail endpoint',
  );
  if (size === 'fullsize') {
    await expect(serve(pattern, url.replace(asset.id, 'missing-asset'))).rejects.toThrow(
      'Missing fullsize dimensions for fixture asset',
    );
  }
});

const profileHarness = (overrides = {}) => {
  const calls = [];
  const session = {
    send: async (method, params) => {
      calls.push([method, params]);
      if (overrides[method]) return overrides[method](params);
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'observer-script' };
      if (method === 'Profiler.stop')
        return { profile: { nodes: [], startTime: 0, endTime: 10, samples: [], timeDeltas: [] } };
      if (method === 'Runtime.evaluate') return { result: { value: { entries: [], dropped: 0 } } };
      return {};
    },
    detach: async () => {
      calls.push(['detach']);
    },
  };
  const page = { context: () => ({ newCDPSession: async () => session }) };
  const attachments = [];
  const info = {
    title: 'The All header selects everything, months not yet loaded included',
    retry: 1,
    status: 'timedOut',
    expectedStatus: 'passed',
    attach: async (name, options) => {
      attachments.push({ name, ...options });
    },
  };
  return { calls, page, info, attachments };
};

it('profiles only the four terminal timeline cases on Chromium retry1', async () => {
  const { startTimelineProfile } = await import('./ui/specs/timeline/failure-profile');
  const h = profileHarness();
  for (const [retry, title, browserName] of [
    [0, h.info.title, 'chromium'],
    [2, h.info.title, 'chromium'],
    [1, 'Deep link to first bucket, drag scrubber to scroll down', 'chromium'],
    [1, h.info.title, 'firefox'],
  ])
    await (
      await startTimelineProfile(h.page, { ...h.info, retry, title }, browserName)
    )();
  expect(h.calls).toEqual([]);
  expect(h.attachments).toEqual([]);
});

it('stops profiling once, disconnects the observer, detaches and attaches failure evidence', async () => {
  const { startTimelineProfile } = await import('./ui/specs/timeline/failure-profile');
  const h = profileHarness();
  const finish = await startTimelineProfile(h.page, h.info, 'chromium');
  await finish();
  await finish();
  const methods = h.calls.map(([method]) => method);
  expect(methods.indexOf('Profiler.start')).toBeLessThan(methods.indexOf('Profiler.stop'));
  expect(methods.filter((method) => method === 'Profiler.stop')).toHaveLength(1);
  expect(methods.at(-1)).toBe('detach');
  expect(methods).toContain('Page.removeScriptToEvaluateOnNewDocument');
  expect(methods).toContain('Profiler.disable');
  expect(h.attachments.map(({ name }) => name)).toEqual(['timeline-cpu.cpuprofile', 'timeline-profile.json']);
  expect(JSON.parse(h.attachments[1].body.toString()).baselineAcceptance).toBe(false);
});

it('records UNKNOWN and detaches when the page closes, preserving the test outcome', async () => {
  const { startTimelineProfile } = await import('./ui/specs/timeline/failure-profile');
  const h = profileHarness({
    'Profiler.stop': () => {
      throw new Error('session closed');
    },
  });
  await (
    await startTimelineProfile(h.page, h.info, 'chromium')
  )();
  expect(h.calls.at(-1)[0]).toBe('detach');
  expect(JSON.parse(h.attachments.at(-1).body.toString()).errors).toContain(
    'UNKNOWN: Profiler.stop unavailable or timed out',
  );
  expect(h.info.status).toBe('timedOut');
});

it('bounds a stalled stop and excludes profiled passes from baseline acceptance', async () => {
  const { startTimelineProfile } = await import('./ui/specs/timeline/failure-profile');
  vi.useFakeTimers();
  try {
    const h = profileHarness({ 'Profiler.stop': () => new Promise(() => {}) });
    h.info.status = 'passed';
    const finish = await startTimelineProfile(h.page, h.info, 'chromium');
    const done = finish();
    await vi.advanceTimersByTimeAsync(1100);
    await done;
    expect(h.calls.at(-1)[0]).toBe('detach');
    expect(h.attachments.map(({ name }) => name)).toEqual(['timeline-profile.json']);
    expect(JSON.parse(h.attachments[0].body.toString()).baselineAcceptance).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it('does not replace the original failure when report attachment fails', async () => {
  const { startTimelineProfile } = await import('./ui/specs/timeline/failure-profile');
  const h = profileHarness();
  h.info.attach = async () => {
    throw new Error('report closed');
  };
  await expect((await startTimelineProfile(h.page, h.info, 'chromium'))()).resolves.toBeUndefined();
  expect(h.info.status).toBe('timedOut');
});

it('caps capture at 30 seconds, stops once and clears timers on final attachment', async () => {
  const { startTimelineProfile } = await import('./ui/specs/timeline/failure-profile');
  vi.useFakeTimers();
  try {
    const h = profileHarness();
    const finish = await startTimelineProfile(h.page, h.info, 'chromium');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.calls.filter(([method]) => method === 'Profiler.stop')).toHaveLength(1);
    expect(h.calls.at(-1)[0]).toBe('detach');
    await finish();
    expect(h.calls.filter(([method]) => method === 'Profiler.stop')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it('runs the injected observer, caps entries and disconnects it during cleanup', async () => {
  const { startTimelineProfile } = await import('./ui/specs/timeline/failure-profile');
  const h = profileHarness();
  const finish = await startTimelineProfile(h.page, h.info, 'chromium');
  const source = h.calls.find(([method]) => method === 'Page.addScriptToEvaluateOnNewDocument')[1].source;
  let callback;
  let disconnected = false;
  const context = {
    PerformanceObserver: class {
      constructor(cb) {
        callback = cb;
      }
      observe() {}
      takeRecords() {
        return [{ startTime: 10, duration: 80 }];
      }
      disconnect() {
        disconnected = true;
      }
    },
    setTimeout: () => 1,
    clearTimeout: () => {},
  };
  runInNewContext(source, context);
  callback({ getEntries: () => Array.from({ length: 1005 }, (_, startTime) => ({ startTime, duration: 60 })) });
  const result = context.__frameleafTimelineProfile();
  expect(result.entries).toHaveLength(1000);
  expect(result.dropped).toBe(6);
  expect(disconnected).toBe(true);
  await finish();
});

it('cleans up a failed setup and omits an oversized CPU attachment', async () => {
  const { startTimelineProfile } = await import('./ui/specs/timeline/failure-profile');
  const failed = profileHarness({
    'Profiler.start': () => {
      throw new Error('closed');
    },
  });
  await (
    await startTimelineProfile(failed.page, failed.info, 'chromium')
  )();
  expect(failed.calls.at(-1)[0]).toBe('detach');
  expect(JSON.parse(failed.attachments.at(-1).body.toString()).errors).toContain(
    'UNKNOWN: Profiler.start unavailable or timed out',
  );
  const large = profileHarness({ 'Profiler.stop': () => ({ profile: { nodes: ['x'.repeat(8 * 1024 * 1024)] } }) });
  await (
    await startTimelineProfile(large.page, large.info, 'chromium')
  )();
  expect(large.attachments.map(({ name }) => name)).toEqual(['timeline-profile.json']);
  expect(JSON.parse(large.attachments[0].body.toString()).errors).toContain(
    'UNKNOWN: CPU profile exceeds 8MiB attachment limit',
  );
});

it.each([
  'Go to a date - G',
  'The All header selects everything, months not yet loaded included',
  'Deep link to last photo, scroll up',
  'Deep link to first bucket, scroll down',
])('captures retry1 for %s', async (title) => {
  const { startTimelineProfile } = await import('./ui/specs/timeline/failure-profile');
  const h = profileHarness();
  await (
    await startTimelineProfile(h.page, { ...h.info, title }, 'chromium')
  )();
  expect(h.calls.some(([method]) => method === 'Profiler.start')).toBe(true);
  expect(h.attachments).toHaveLength(2);
});
