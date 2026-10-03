import { galleryRequest, galleryMedia, workflowRequest } from './workflow-api';

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@immich/sdk', () => ({
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
  await expect(galleryMedia('shoot', 'capture', 'download', 'scoped')).rejects.toThrow('Gallery access has ended');
});
