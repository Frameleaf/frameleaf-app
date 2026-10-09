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
