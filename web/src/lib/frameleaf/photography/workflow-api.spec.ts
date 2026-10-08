import {
  galleryFile,
  galleryLogo,
  galleryMedia,
  galleryRequest,
  watermarkPreview,
  workflowRequest,
} from './workflow-api';

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@frameleaf/sdk', () => ({
  defaults: { fetch: transport.fetch, headers: { Authorization: 'Bearer owner' } },
  getBaseUrl: () => '/custom-api',
}));

beforeEach(() => transport.fetch.mockReset());

it('uses the owner transport for CAS writes and keeps the scoped gallery session out of owner requests', async () => {
  transport.fetch.mockResolvedValue(Response.json({ revision: 'saved' }));
  await workflowRequest('shoot', '/config', 'PUT', { expectedRevision: 'loaded', config: {} });
  const [url, options] = transport.fetch.mock.calls[0];
  expect(url).toBe('/custom-api/photography/workflows/shoot/config');
  expect(options.headers.get('Authorization')).toBe('Bearer owner');
  expect(options.headers.has('X-Photography-Session')).toBe(false);
  expect(JSON.parse(options.body).expectedRevision).toBe('loaded');
});

it('guest requests carry only scoped authentication and never use library authorization', async () => {
  transport.fetch.mockResolvedValue(Response.json({ photos: [] }));
  await galleryRequest('shoot', 'scoped', '/choices', 'PUT', { expectedRevision: 'loaded', captureIds: [] });
  const [url, options] = transport.fetch.mock.calls[0];
  expect(url).toBe('/custom-api/photography/galleries/shoot/choices');
  expect(options.headers.get('X-Photography-Session')).toBe('scoped');
  expect(options.headers.has('Authorization')).toBe(false);
  expect(options.credentials).toBe('omit');
  expect(options.cache).toBe('no-store');
});

it('fetches protected pixels through the scoped route and refuses expired access before returning a blob', async () => {
  transport.fetch.mockResolvedValueOnce(new Response('jpeg', { headers: { 'Content-Type': 'image/jpeg' } }));
  expect((await galleryMedia('shoot', 'capture', 'preview', 'scoped')).type).toBe('image/jpeg');
  expect(transport.fetch.mock.calls[0][0]).toBe('/custom-api/photography/galleries/shoot/photos/capture/preview');
  transport.fetch.mockResolvedValueOnce(new Response(null, { status: 403 }));
  await expect(galleryMedia('shoot', 'capture', 'download', 'scoped')).rejects.toMatchObject({
    code: 'access_ended',
    status: 403,
  });
});

it('lets a save started as the page closes outlive it, and only when asked', async () => {
  transport.fetch.mockImplementation(async () => Response.json({ revision: 'saved' }));
  await galleryRequest('shoot', 'scoped', '/choices', 'PUT', { captureIds: [] });
  expect(transport.fetch.mock.calls[0][1]).not.toHaveProperty('keepalive');
  await galleryRequest('shoot', 'scoped', '/choices', 'PUT', { captureIds: [] }, { keepalive: true });
  expect(transport.fetch.mock.calls[1][1].keepalive).toBe(true);
  // still the guest's scoped request, never the owner's
  expect(transport.fetch.mock.calls[1][1].credentials).toBe('omit');
  expect(transport.fetch.mock.calls[1][1].headers.has('Authorization')).toBe(false);
});

it('throws a code for every refusal, never a sentence', async () => {
  const refuse = (status: number) => transport.fetch.mockResolvedValueOnce(new Response(null, { status }));
  refuse(409);
  await expect(workflowRequest('shoot')).rejects.toMatchObject({ code: 'collection_changed', status: 409 });
  refuse(429);
  await expect(galleryRequest('shoot', 'scoped')).rejects.toMatchObject({ code: 'wait', status: 429 });
  refuse(500);
  await expect(galleryRequest('shoot', 'scoped')).rejects.toMatchObject({ code: 'request_failed', status: 500 });

  const wrongType = () =>
    transport.fetch.mockResolvedValueOnce(new Response('{}', { headers: { 'Content-Type': 'application/json' } }));
  wrongType();
  await expect(galleryFile('shoot', 'scoped', '/photos/a/download', false)).rejects.toMatchObject({
    code: 'not_ready',
  });
  wrongType();
  await expect(galleryLogo('shoot', 'scoped')).rejects.toMatchObject({ code: 'logo_unavailable' });
  wrongType();
  await expect(watermarkPreview({} as never, 'portrait', 'light')).rejects.toMatchObject({
    code: 'watermark_preview',
  });
});
